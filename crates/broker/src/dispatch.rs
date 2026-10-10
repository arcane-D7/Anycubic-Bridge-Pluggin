//! Internal typed dispatch gate for approved device-control actions
//! (S9.18-003 security follow-up).
//!
//! This is a *gate*, not a transport: it revalidates the frozen request,
//! consumes the one-use [`ApprovalAuthority`] approval exactly once, and only
//! then hands the *typed* payload to an injected [`ControlTransport`]. The
//! broker itself contains no device/network endpoint, and the default adapter
//! [`UnavailableTransport`] reports unavailable so an approval is **never
//! burned when no real transport is wired**.
//!
//! Ordering guarantees (every denial happens before any transport dispatch):
//! 1. Domain revalidation first — action allowlist, bounded target (length
//!    *and* no whitespace), bounded payload bytes, then a **closed typed
//!    payload** ([`DevicePayload`]) with `serde(deny_unknown_fields)` and
//!    explicit numeric windows. Nothing is silently clamped and no unknown
//!    field survives: a malformed request is refused and the approval stays
//!    pending (zero transport calls).
//! 2. [`ApprovalAuthority::consume`] once against the frozen envelope, with
//!    **every binding context field** (session/revision/artifact/material)
//!    passed through from the request — nothing is dropped. Any denial
//!    (expired/revoked/context-changed/token mismatch) ⇒ zero transport
//!    calls.
//! 3. Exactly one [`ControlTransport::dispatch`] call whose outcome is the
//!    typed [`TransportOutcome`] (Ack / Refused / Timeout / Indeterminate) —
//!    never inferred from a boolean. Timeout/Indeterminate raise
//!    [`DispatchError::TransportTimeout`] / [`DispatchError::IndeterminateOutcome`]
//!    *after* the consumption; the approval is already spent, so no retry is
//!    ever attempted.
//!
//! Payload integrity note: an approval is bound to the SHA-256 digest of the
//! *exact* JSON [`Value`] it was issued over. [`DevicePayload::parse`] only
//! reads that value at dispatch time — it never normalizes or re-serializes —
//! so the digest consumed is always the digest issued, and writers receive a
//! closed, validated struct instead of raw JSON.
//!
//! The gate is a broker-internal Rust API: no MCP tool or Tauri command wires
//! it. The runtime production surface exposes no backend writer — this is the
//! trusted seam for a future internal dispatch flow.

use std::fmt;

use auth_service::Principal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::approval::{ApprovalAuthority, ApprovalError, ConsumeContext, MAX_IDENTIFIER_LEN};

/// Closed set of device-control actions the gate understands. The variants
/// are deliberately fine-grained (one variant per typed payload): broad
/// `Ace`/`Light` variants were dropped so no action can smuggle an
/// off-schema payload under a generic name. Serialization is snake_case
/// (stable wire names, also the approval `action` binding); anything outside
/// the allowlist is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceControlAction {
    Nozzle,
    Bed,
    PartFan,
    Speed,
    LightSetEnabled,
    LightBrightness,
    AceDry,
    AceAutoFeed,
    AceBindSlot,
}

impl DeviceControlAction {
    /// Every known action — the default full allowlist and canonical set.
    pub const ALL: [DeviceControlAction; 9] = [
        DeviceControlAction::Nozzle,
        DeviceControlAction::Bed,
        DeviceControlAction::PartFan,
        DeviceControlAction::Speed,
        DeviceControlAction::LightSetEnabled,
        DeviceControlAction::LightBrightness,
        DeviceControlAction::AceDry,
        DeviceControlAction::AceAutoFeed,
        DeviceControlAction::AceBindSlot,
    ];

    /// Stable wire name (also the approval `action` binding).
    pub fn name(self) -> &'static str {
        match self {
            DeviceControlAction::Nozzle => "nozzle",
            DeviceControlAction::Bed => "bed",
            DeviceControlAction::PartFan => "part_fan",
            DeviceControlAction::Speed => "speed",
            DeviceControlAction::LightSetEnabled => "light_set_enabled",
            DeviceControlAction::LightBrightness => "light_brightness",
            DeviceControlAction::AceDry => "ace_dry",
            DeviceControlAction::AceAutoFeed => "ace_auto_feed",
            DeviceControlAction::AceBindSlot => "ace_bind_slot",
        }
    }

    /// Parse a wire name; unknown names return `None` (allowlist refusal).
    /// The old coarse names (`fan_speed`, `light`, `ace`) are intentionally
    /// NOT accepted — callers must name the precise typed action.
    pub fn from_name(s: &str) -> Option<DeviceControlAction> {
        match s {
            "nozzle" => Some(DeviceControlAction::Nozzle),
            "bed" => Some(DeviceControlAction::Bed),
            "part_fan" => Some(DeviceControlAction::PartFan),
            "speed" => Some(DeviceControlAction::Speed),
            "light_set_enabled" => Some(DeviceControlAction::LightSetEnabled),
            "light_brightness" => Some(DeviceControlAction::LightBrightness),
            "ace_dry" => Some(DeviceControlAction::AceDry),
            "ace_auto_feed" => Some(DeviceControlAction::AceAutoFeed),
            "ace_bind_slot" => Some(DeviceControlAction::AceBindSlot),
            _ => None,
        }
    }
}

/// Upper bound for a serialized control payload (bytes). The typed parser
/// ([`DevicePayload::parse`]) is *stricter* than this bound.
pub const MAX_PAYLOAD_BYTES: usize = 4096;

/// Typed payload validation failure — a *category*, never echoed secrets or
/// raw values. `Range(field)` names the static field whose window was
/// violated; `Shape` covers unknown/missing fields and wrong JSON types
/// (including fractional/negative numbers on integer-bound fields).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadError {
    Shape,
    Range(&'static str),
}

impl fmt::Display for PayloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PayloadError::Shape => f.write_str("payload shape invalid"),
            PayloadError::Range(field) => write!(f, "payload field `{field}` out of range"),
        }
    }
}

/// Numeric windows (mirror `NOZZLE_TARGET_MIN/MAX_C` in the editor control
/// contract — the editor clamps, the gate *rejects*).
pub(crate) const NOZZLE_MAX_C: f64 = 320.0;
pub(crate) const BED_MAX_C: f64 = 120.0;
pub(crate) const FAN_MAX_PCT: f64 = 100.0;
pub(crate) const BRIGHTNESS_MAX_PCT: u8 = 100;
pub(crate) const ACE_BOX_MAX: u8 = 9;
pub(crate) const ACE_SLOT_MAX: u8 = 9;
pub(crate) const DRYER_TARGET_MAX_C: u8 = 80;
pub(crate) const DRYER_DURATION_MAX_MIN: u16 = 1440;

/// `temps.setNozzle` envelope args: `{"nozzle": °C}` (0–320).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NozzlePayload {
    pub nozzle: f64,
}

impl NozzlePayload {
    pub fn validate(self) -> Result<Self, PayloadError> {
        if !self.nozzle.is_finite() || !(0.0..=NOZZLE_MAX_C).contains(&self.nozzle) {
            return Err(PayloadError::Range("nozzle"));
        }
        Ok(self)
    }
}

/// `temps.setBed` envelope args: `{"bed": °C}` (0–120).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BedPayload {
    pub bed: f64,
}

impl BedPayload {
    pub fn validate(self) -> Result<Self, PayloadError> {
        if !self.bed.is_finite() || !(0.0..=BED_MAX_C).contains(&self.bed) {
            return Err(PayloadError::Range("bed"));
        }
        Ok(self)
    }
}

/// `fan_set` envelope args: `{"fan": "part", "speed_pct": %}` (0–100). The
/// fan target is a closed enum — anything but `"part"` is a shape error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartFanTarget {
    Part,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartFanPayload {
    pub fan: PartFanTarget,
    pub speed_pct: f64,
}

impl PartFanPayload {
    pub fn validate(self) -> Result<Self, PayloadError> {
        if !self.speed_pct.is_finite() || !(0.0..=FAN_MAX_PCT).contains(&self.speed_pct) {
            return Err(PayloadError::Range("speed_pct"));
        }
        Ok(self)
    }
}

/// Closed speed modes with the exact wire numbers used by `print_update`
/// (`SPEED_MODE_NUM` in the editor control contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeedMode {
    Silent,
    Standard,
    Sport,
}

impl SpeedMode {
    pub const WIRE_SILENT: u8 = 1;
    pub const WIRE_STANDARD: u8 = 2;
    pub const WIRE_SPORT: u8 = 3;

    pub fn wire(self) -> u8 {
        match self {
            SpeedMode::Silent => SpeedMode::WIRE_SILENT,
            SpeedMode::Standard => SpeedMode::WIRE_STANDARD,
            SpeedMode::Sport => SpeedMode::WIRE_SPORT,
        }
    }
}

/// `print_update` envelope args: `{"print_speed_mode": 1|2|3}` — integer
/// only; fractional/negative/unknown values are refused, never clamped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeedPayload {
    pub print_speed_mode: u8,
}

impl SpeedPayload {
    pub fn mode(self) -> Result<SpeedMode, PayloadError> {
        match self.print_speed_mode {
            1 => Ok(SpeedMode::Silent),
            2 => Ok(SpeedMode::Standard),
            3 => Ok(SpeedMode::Sport),
            _ => Err(PayloadError::Range("print_speed_mode")),
        }
    }
}

/// `light_control` envelope args for `lights.setEnabled`: `{"on": bool}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LightEnabledPayload {
    pub on: bool,
}

/// `light_control` envelope args for `lights.setBrightness`: the editor
/// always pairs the brightness with the light being on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LightBrightnessPayload {
    pub on: bool,
    pub brightness: u8,
}

impl LightBrightnessPayload {
    pub fn validate(self) -> Result<Self, PayloadError> {
        if !self.on {
            return Err(PayloadError::Range("on"));
        }
        if self.brightness > BRIGHTNESS_MAX_PCT {
            return Err(PayloadError::Range("brightness"));
        }
        Ok(self)
    }
}

/// `ace_dry` envelope args. `remain_time` must be exactly 0 (the editor sends
/// it as a constant; anything else is off-canonical and refused).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AceDryPayload {
    pub box_id: u8,
    pub stop: bool,
    pub target_temp: u8,
    pub duration_min: u16,
    pub remain_time: u8,
}

impl AceDryPayload {
    pub fn validate(self) -> Result<Self, PayloadError> {
        if self.box_id > ACE_BOX_MAX {
            return Err(PayloadError::Range("box_id"));
        }
        if self.target_temp > DRYER_TARGET_MAX_C {
            return Err(PayloadError::Range("target_temp"));
        }
        if self.duration_min > DRYER_DURATION_MAX_MIN {
            return Err(PayloadError::Range("duration_min"));
        }
        if self.remain_time != 0 {
            return Err(PayloadError::Range("remain_time"));
        }
        Ok(self)
    }
}

/// `ace_auto_feed` envelope args.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AceAutoFeedPayload {
    pub box_id: u8,
    pub enabled: bool,
}

impl AceAutoFeedPayload {
    pub fn validate(self) -> Result<Self, PayloadError> {
        if self.box_id > ACE_BOX_MAX {
            return Err(PayloadError::Range("box_id"));
        }
        Ok(self)
    }
}

/// `ace_set_slot` envelope args — **manual bind only**. The ACE stays
/// `edit_status: 1` because this path never forges an RFID tag: the
/// consumable's tag state is owned by the local spool registry, and a
/// wire-level `edit_status` field is rejected by `deny_unknown_fields`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AceBindSlotPayload {
    pub box_id: u8,
    pub slot_index: u8,
    pub material_type: String,
    pub color: [u8; 3],
}

impl AceBindSlotPayload {
    pub fn validate(self) -> Result<Self, PayloadError> {
        if self.box_id > ACE_BOX_MAX {
            return Err(PayloadError::Range("box_id"));
        }
        if self.slot_index > ACE_SLOT_MAX {
            return Err(PayloadError::Range("slot_index"));
        }
        if self.material_type.is_empty() || self.material_type.len() > MAX_IDENTIFIER_LEN {
            return Err(PayloadError::Range("material_type"));
        }
        Ok(self)
    }
}

/// The closed, validated payload handed to a [`ControlTransport`]. A writer
/// receives only this — never the raw approval JSON. Constructed exclusively
/// by [`DevicePayload::parse`] from the exact digest-bound [`Value`].
#[derive(Debug, Clone, PartialEq)]
pub enum DevicePayload {
    Nozzle(NozzlePayload),
    Bed(BedPayload),
    PartFan(PartFanPayload),
    Speed(SpeedPayload),
    LightSetEnabled(LightEnabledPayload),
    LightBrightness(LightBrightnessPayload),
    AceDry(AceDryPayload),
    AceAutoFeed(AceAutoFeedPayload),
    AceBindSlot(AceBindSlotPayload),
}

impl DevicePayload {
    /// Strictly parse + validate the frozen `value` for `action`. Rejects
    /// unknown/missing fields, wrong JSON types, non-finite or out-of-range
    /// numbers, and fractional/negative integers. **Read-only** on `value` —
    /// the digest-bound approval payload is never normalized here, so the
    /// consumed digest is always the issued digest.
    pub fn parse(
        action: DeviceControlAction,
        value: &Value,
    ) -> Result<DevicePayload, PayloadError> {
        fn typed<T>(v: &Value) -> Result<T, PayloadError>
        where
            T: for<'de> Deserialize<'de>,
        {
            serde_json::from_value(v.clone()).map_err(|_| PayloadError::Shape)
        }
        match action {
            DeviceControlAction::Nozzle => typed::<NozzlePayload>(value)?
                .validate()
                .map(DevicePayload::Nozzle),
            DeviceControlAction::Bed => typed::<BedPayload>(value)?
                .validate()
                .map(DevicePayload::Bed),
            DeviceControlAction::PartFan => typed::<PartFanPayload>(value)?
                .validate()
                .map(DevicePayload::PartFan),
            DeviceControlAction::Speed => {
                let p = typed::<SpeedPayload>(value)?;
                // `mode` both range-checks the int and maps to the closed enum.
                p.mode()?;
                Ok(DevicePayload::Speed(p))
            }
            DeviceControlAction::LightSetEnabled => {
                Ok(DevicePayload::LightSetEnabled(
                    typed::<LightEnabledPayload>(value)?,
                ))
            }
            DeviceControlAction::LightBrightness => typed::<LightBrightnessPayload>(value)?
                .validate()
                .map(DevicePayload::LightBrightness),
            DeviceControlAction::AceDry => typed::<AceDryPayload>(value)?
                .validate()
                .map(DevicePayload::AceDry),
            DeviceControlAction::AceAutoFeed => typed::<AceAutoFeedPayload>(value)?
                .validate()
                .map(DevicePayload::AceAutoFeed),
            DeviceControlAction::AceBindSlot => typed::<AceBindSlotPayload>(value)?
                .validate()
                .map(DevicePayload::AceBindSlot),
        }
    }

    /// The action this payload belongs to (inverse of [`DevicePayload::parse`]).
    pub fn action(&self) -> DeviceControlAction {
        match self {
            DevicePayload::Nozzle(_) => DeviceControlAction::Nozzle,
            DevicePayload::Bed(_) => DeviceControlAction::Bed,
            DevicePayload::PartFan(_) => DeviceControlAction::PartFan,
            DevicePayload::Speed(_) => DeviceControlAction::Speed,
            DevicePayload::LightSetEnabled(_) => DeviceControlAction::LightSetEnabled,
            DevicePayload::LightBrightness(_) => DeviceControlAction::LightBrightness,
            DevicePayload::AceDry(_) => DeviceControlAction::AceDry,
            DevicePayload::AceAutoFeed(_) => DeviceControlAction::AceAutoFeed,
            DevicePayload::AceBindSlot(_) => DeviceControlAction::AceBindSlot,
        }
    }

    /// Serialize the *validated* payload back to JSON (writer convenience).
    /// Not used for the approval digest, which is always the frozen `Value`.
    pub fn to_value(&self) -> Value {
        match self {
            DevicePayload::Nozzle(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::Bed(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::PartFan(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::Speed(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::LightSetEnabled(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::LightBrightness(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::AceDry(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::AceAutoFeed(p) => serde_json::to_value(p).unwrap_or_default(),
            DevicePayload::AceBindSlot(p) => serde_json::to_value(p).unwrap_or_default(),
        }
    }
}

/// Approval binding context carried by a request. Every `Some` field is
/// transmitted to [`ApprovalAuthority::consume`] — the gate never drops a
/// binding (the pre-hardening code passed `None` for all four).
///
/// `device_snapshot_ms` + `project_id` carry the S9.18-003 trusted snapshot
/// and project anchors: set ONLY from a backend-resolved [`DeviceContext`]
/// when the caller is a verified device writer; generic job lanes keep None.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestContext {
    pub session_ref: Option<String>,
    pub revision: Option<u64>,
    pub artifact: Option<String>,
    pub material: Option<String>,
    pub device_snapshot_ms: Option<i64>,
    pub project_id: Option<String>,
}

/// Frozen, digest-bound control request. `action` is the closed-set enum;
/// `payload` is the exact JSON `Value` the approval was issued over (its
/// canonical SHA-256 digest is the binding). The typed, validated projection
/// is derived **at dispatch time** by [`DevicePayload::parse`] — the gate
/// never hands arbitrary raw JSON to a transport, and a caller cannot bypass
/// validation by constructing `payload` by hand. `target` and `principal`
/// are opaque references resolved by the caller from the current
/// authenticated session (never parsed from raw JSON).
#[derive(Debug, Clone)]
pub struct DeviceControlRequest {
    pub action: DeviceControlAction,
    pub target: String,
    pub payload: Value,
    pub principal: Principal,
    /// Approval binding context — passed in full to `consume` (never `None`-ed).
    pub context: RequestContext,
}

/// Typed transport outcome — the adapter reports what actually happened; the
/// gate never infers acceptance from a boolean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportOutcome {
    /// The transport accepted the request. This is an *acknowledgment of
    /// acceptance only* — no physical effect or end-state is claimed.
    Ack,
    /// The transport deterministically refused, with a reason.
    Refused(String),
    /// The transport did not answer in time.
    Timeout,
    /// The outcome cannot be determined (e.g. a drop mid-flight).
    Indeterminate,
}

impl fmt::Display for TransportOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportOutcome::Ack => f.write_str("ack"),
            TransportOutcome::Refused(reason) => write!(f, "refused: {reason}"),
            TransportOutcome::Timeout => f.write_str("timeout"),
            TransportOutcome::Indeterminate => f.write_str("indeterminate"),
        }
    }
}

/// Controlled transport seam. Implementations are injected (tests use a
/// counting mock); the production default is [`UnavailableTransport`].
pub trait ControlTransport {
    /// True when this adapter can dispatch right now. The gate checks this
    /// BEFORE consuming, so an unavailable transport never burns approvals.
    fn available(&self) -> bool;
    /// Dispatch exactly one request and report the typed outcome. Receives
    /// the *validated* typed [`DevicePayload`] — never the raw approval JSON.
    fn dispatch(&self, req: &DeviceControlRequest, payload: &DevicePayload) -> TransportOutcome;
}

/// Default adapter: no real transport is wired (the broker contains none). It
/// is never available, so [`DispatchGate::dispatch`] refuses before
/// consumption — no approval is burned while the backend is absent.
pub struct UnavailableTransport;

impl ControlTransport for UnavailableTransport {
    fn available(&self) -> bool {
        false
    }
    fn dispatch(&self, _req: &DeviceControlRequest, _payload: &DevicePayload) -> TransportOutcome {
        TransportOutcome::Indeterminate
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DispatchError {
    #[error("transport unavailable — approval was not consumed")]
    TransportUnavailable,
    #[error("action `{0}` is not in the allowlist")]
    InvalidAction(&'static str),
    #[error("invalid target")]
    InvalidTarget,
    #[error("payload failed domain validation (size, shape or range) — no effect was sent")]
    InvalidPayload,
    #[error("approval denied: {0}")]
    Approval(#[from] ApprovalError),
    #[error("session denied: {0}")]
    SessionDenied(&'static str),
    #[error("dispatch timed out after consumption — approval already consumed, do not retry")]
    TransportTimeout,
    #[error("dispatch outcome indeterminate — approval already consumed, do not retry")]
    IndeterminateOutcome,
}

/// Result of a successfully authorized dispatch. `outcome` is always
/// `Ack | Refused` — Timeout surfaces as [`DispatchError::TransportTimeout`]
/// and Indeterminate as [`DispatchError::IndeterminateOutcome`], both *after*
/// the approval was spent (never retried).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchReceipt {
    pub token_hash: String,
    pub outcome: TransportOutcome,
}

/// Internal approval-backed dispatch gate (see the module docs for the
/// ordering guarantees). The allowlist is explicit: a runtime context may pin
/// a narrower set than [`DeviceControlAction::ALL`].
pub struct DispatchGate<'d, 'a> {
    authority: &'a ApprovalAuthority<'d>,
    transport: &'a dyn ControlTransport,
    allowlist: &'static [DeviceControlAction],
}

impl<'d, 'a> DispatchGate<'d, 'a> {
    pub fn new(
        authority: &'a ApprovalAuthority<'d>,
        transport: &'a dyn ControlTransport,
        allowlist: &'static [DeviceControlAction],
    ) -> Self {
        Self {
            authority,
            transport,
            allowlist,
        }
    }

    /// Revalidate the frozen request → consume the approval once → dispatch
    /// exactly once. Every denial path leaves the approval pending (or
    /// permanently unusable for lifecycle states) and performs zero transport
    /// calls; a grant performs exactly one.
    ///
    /// **Identity is caller-supplied here** (`req.principal`), so this method
    /// is crate-internal: it exists for the broker's own tests and internal
    /// seams. Anonymous principals are refused (`SessionDenied("unauthenticated")`).
    /// The externally reachable entry is [`DispatchGate::dispatch_for_session`],
    /// which resolves the session through `auth_service::AuthDb` and derives
    /// principal + session hash from the *verified session*, never from the
    /// caller's JSON.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn dispatch(
        &self,
        token: &str,
        req: &DeviceControlRequest,
    ) -> Result<DispatchReceipt, DispatchError> {
        match req.principal {
            Principal::Anonymous => return Err(DispatchError::SessionDenied("unauthenticated")),
            Principal::Local { .. } => {}
        }
        self.dispatch_internal(
            token,
            req,
            &req.principal,
            req.context.session_ref.as_deref(),
        )
    }

    /// Full dispatch pipeline with identity/context supplied by the *caller of
    /// the internal seam* rather than the request JSON.
    fn dispatch_internal(
        &self,
        token: &str,
        req: &DeviceControlRequest,
        principal: &Principal,
        session_ref: Option<&str>,
    ) -> Result<DispatchReceipt, DispatchError> {
        // 1. Domain revalidation (preflight) — a malformed request is refused
        //    and the approval stays pending (zero transport calls).
        if !self.allowlist.contains(&req.action) {
            return Err(DispatchError::InvalidAction(req.action.name()));
        }
        // Target: non-empty, length-bounded, and no whitespace embedded
        // (a whitespace-only or " device-1" target is not a real device id).
        if req.target.is_empty()
            || req.target.len() > MAX_IDENTIFIER_LEN
            || req.target.chars().any(char::is_whitespace)
        {
            return Err(DispatchError::InvalidTarget);
        }
        let payload_bytes = serde_json::to_vec(&req.payload).unwrap_or_default().len();
        if payload_bytes > MAX_PAYLOAD_BYTES {
            return Err(DispatchError::InvalidPayload);
        }
        // Strict closed typed validation (shape + numeric windows). This is
        // the promise the module docs always made and the old code never
        // kept: `{"nozzle": 500}`, `null`, unknowns — all refused here.
        // Read-only on `req.payload`, so the digest-bound approve/consume
        // path stays bit-for-bit identical to the issued `Value`.
        let typed = DevicePayload::parse(req.action, &req.payload)
            .map_err(|_| DispatchError::InvalidPayload)?;
        // 2. Transport availability — checked before consumption so a missing
        //    backend never burns a usable approval.
        if !self.transport.available() {
            return Err(DispatchError::TransportUnavailable);
        }
        // 3. One consume against the frozen envelope, binding every context
        //    field the approval was issued under (session/revision/artifact/
        //    material are passed through — never dropped). Identity comes
        //    from `principal` (the seam caller = verified session at the
        //    public boundary), not from `req.principal`.
        let consumed = self.authority.consume(
            token,
            &ConsumeContext {
                action: req.action.name(),
                target: &req.target,
                principal,
                payload: &req.payload,
                session_ref,
                revision: req.context.revision,
                artifact: req.context.artifact.as_deref(),
                material: req.context.material.as_deref(),
                device_snapshot_ms: req.context.device_snapshot_ms,
                project_id: req.context.project_id.as_deref(),
            },
        )?;
        // 4. Exactly one dispatch with the typed payload and a typed outcome.
        match self.transport.dispatch(req, &typed) {
            TransportOutcome::Ack => Ok(DispatchReceipt {
                token_hash: consumed.token_hash,
                outcome: TransportOutcome::Ack,
            }),
            TransportOutcome::Refused(reason) => Ok(DispatchReceipt {
                token_hash: consumed.token_hash,
                outcome: TransportOutcome::Refused(reason),
            }),
            // The approval is already consumed; retrying cannot be safe.
            TransportOutcome::Timeout => Err(DispatchError::TransportTimeout),
            TransportOutcome::Indeterminate => Err(DispatchError::IndeterminateOutcome),
        }
    }

    /// Securely dispatch for an **authenticated session** — the only external
    /// dispatch entry. Re-resolves the session NOW (revoked/expired/removed/
    /// rescinded ⇔ zero transport calls) and binds the approval consume to the
    /// verified session's non-secret hash + principal — a caller-supplied
    /// `Principal` or `context.session_ref` in `req` is ignored here.
    ///
    /// The required scope is derived from the stored `action` via
    /// [`crate::action_registry`] (all nine control actions require
    /// `DeviceControl`) — never a caller-supplied parameter.
    pub fn dispatch_for_session(
        &self,
        auth: &auth_service::AuthDb,
        session_token: &str,
        token: &str,
        req: &DeviceControlRequest,
    ) -> Result<DispatchReceipt, DispatchError> {
        let session = crate::resolve::resolve_session(auth, session_token)
            .map_err(|e| DispatchError::SessionDenied(crate::resolve::reason(&e)))?;
        let Some(required) = crate::action_registry::required_scope(req.action.name()) else {
            return Err(DispatchError::InvalidAction(req.action.name()));
        };
        if !session.has_scope(required) {
            return Err(DispatchError::SessionDenied("scope"));
        }
        self.dispatch_internal(
            token,
            req,
            &session.principal(),
            Some(session.session_hash()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::test_support::{local_user, FakeClock, BASE};
    use crate::approval::{
        ApprovalAuthority, ApprovalError, IssueRequest, IssuedApproval, ScopedIssueRequest,
    };
    use crate::db::DbHandle;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// Injectable mock transport: counts dispatch calls, respects an
    /// availability flag, and returns a scripted outcome
    /// (0 Ack, 1 Refused, 2 Timeout, 3 Indeterminate).
    struct CountingTransport {
        calls: Arc<AtomicUsize>,
        avail: Arc<AtomicBool>,
        mode: Arc<AtomicUsize>,
    }
    impl CountingTransport {
        fn new(available: bool) -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                avail: Arc::new(AtomicBool::new(available)),
                mode: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn set_available(&self, v: bool) {
            self.avail.store(v, Ordering::Relaxed);
        }
        fn set_mode(&self, mode: usize) {
            self.mode.store(mode, Ordering::Relaxed);
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::Relaxed)
        }
    }
    impl ControlTransport for CountingTransport {
        fn available(&self) -> bool {
            self.avail.load(Ordering::Relaxed)
        }
        fn dispatch(
            &self,
            _req: &DeviceControlRequest,
            _payload: &DevicePayload,
        ) -> TransportOutcome {
            self.calls.fetch_add(1, Ordering::Relaxed);
            match self.mode.load(Ordering::Relaxed) {
                0 => TransportOutcome::Ack,
                1 => TransportOutcome::Refused("device refused".to_owned()),
                2 => TransportOutcome::Timeout,
                _ => TransportOutcome::Indeterminate,
            }
        }
    }

    fn auth<'d>(db: &'d DbHandle, clock: &FakeClock) -> ApprovalAuthority<'d> {
        ApprovalAuthority::with_clock(db, clock.clock_fn())
    }

    /// Canonical wire payload factories — the exact shapes the dispatcher
    /// validates, mirroring the editor `ControlEnvelope` args.
    fn nozzle_value(c: f64) -> Value {
        serde_json::json!({ "nozzle": c })
    }
    fn bed_value(c: f64) -> Value {
        serde_json::json!({ "bed": c })
    }
    fn fan_value(pct: f64) -> Value {
        serde_json::json!({ "fan": "part", "speed_pct": pct })
    }
    fn speed_value(mode: u8) -> Value {
        serde_json::json!({ "print_speed_mode": mode })
    }
    fn light_value(on: bool) -> Value {
        serde_json::json!({ "on": on })
    }
    fn brightness_value(on: bool, pct: u8) -> Value {
        serde_json::json!({ "on": on, "brightness": pct })
    }
    fn ace_dry_value(
        box_id: u8,
        stop: bool,
        target_temp: u8,
        duration_min: u16,
        remain_time: u8,
    ) -> Value {
        serde_json::json!({
            "box_id": box_id,
            "stop": stop,
            "target_temp": target_temp,
            "duration_min": duration_min,
            "remain_time": remain_time,
        })
    }
    fn ace_auto_feed_value(box_id: u8, enabled: bool) -> Value {
        serde_json::json!({ "box_id": box_id, "enabled": enabled })
    }
    fn ace_bind_value(box_id: u8, slot_index: u8, material: &str, color: [u8; 3]) -> Value {
        serde_json::json!({
            "box_id": box_id,
            "slot_index": slot_index,
            "material_type": material,
            "color": color,
        })
    }

    /// A valid canonical payload for `action` (used by `req`).
    fn canonical_payload(action: DeviceControlAction) -> Value {
        match action {
            DeviceControlAction::Nozzle => nozzle_value(200.0),
            DeviceControlAction::Bed => bed_value(60.0),
            DeviceControlAction::PartFan => fan_value(50.0),
            DeviceControlAction::Speed => speed_value(2),
            DeviceControlAction::LightSetEnabled => light_value(true),
            DeviceControlAction::LightBrightness => brightness_value(true, 80),
            DeviceControlAction::AceDry => ace_dry_value(3, false, 60, 120, 0),
            DeviceControlAction::AceAutoFeed => ace_auto_feed_value(2, true),
            DeviceControlAction::AceBindSlot => ace_bind_value(1, 4, "PLA", [15, 168, 220]),
        }
    }

    fn issue<'a>(a: &ApprovalAuthority<'a>, action: &'a str, target: &'a str) -> IssuedApproval {
        a.issue(IssueRequest {
            action,
            target,
            principal: local_user("user-1"),
            purpose: "dispatch gate test",
            payload: &nozzle_value(200.0),
            session_ref: None,
            revision: None,
            artifact: None,
            material: None,
            device_snapshot_ms: None,
            project_id: None,
            ttl_ms: 60_000,
        })
        .expect("issue")
    }

    /// Issue an approval bound to the exact `payload` and binding context.
    #[allow(clippy::too_many_arguments)]
    fn issue_bound<'a>(
        a: &ApprovalAuthority<'a>,
        action: &'a str,
        target: &'a str,
        payload: &'a Value,
        session_ref: Option<&'a str>,
        revision: Option<u64>,
        artifact: Option<&'a str>,
        material: Option<&'a str>,
    ) -> IssuedApproval {
        a.issue(IssueRequest {
            action,
            target,
            principal: local_user("user-1"),
            purpose: "dispatch gate test",
            payload,
            session_ref,
            revision,
            artifact,
            material,
            device_snapshot_ms: None,
            project_id: None,
            ttl_ms: 60_000,
        })
        .expect("issue")
    }

    fn req(action: DeviceControlAction, target: &str) -> DeviceControlRequest {
        DeviceControlRequest {
            action,
            target: target.to_owned(),
            payload: canonical_payload(action),
            principal: local_user("user-1"),
            context: RequestContext::default(),
        }
    }

    fn req_with(
        action: DeviceControlAction,
        target: &str,
        payload: Value,
        context: RequestContext,
    ) -> DeviceControlRequest {
        DeviceControlRequest {
            action,
            target: target.to_owned(),
            payload,
            principal: local_user("user-1"),
            context,
        }
    }

    fn gate<'d, 'a>(
        a: &'a ApprovalAuthority<'d>,
        t: &'a dyn ControlTransport,
    ) -> DispatchGate<'d, 'a> {
        DispatchGate::new(a, t, &DeviceControlAction::ALL)
    }

    /// Assert the dispatch was refused as `InvalidPayload` before any
    /// transport call and the approval is still pending.
    fn assert_payload_refused(
        g: &DispatchGate<'_, '_>,
        transport: &CountingTransport,
        a: &ApprovalAuthority<'_>,
        token: &str,
        hash: &str,
        request: &DeviceControlRequest,
    ) {
        assert!(matches!(
            g.dispatch(token, request),
            Err(DispatchError::InvalidPayload)
        ));
        assert_eq!(transport.calls(), 0, "refusal must not reach the transport");
        assert!(
            a.pending_tokens("user-1")
                .expect("pending")
                .contains(&hash.to_owned()),
            "the approval must stay pending after a payload refusal"
        );
    }

    #[test]
    fn unavailable_transport_never_consumes_and_recovers() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let issued = issue(&a, "nozzle", "device-1");
        let transport = CountingTransport::new(false);
        let g = gate(&a, &transport);
        assert!(matches!(
            g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1")),
            Err(DispatchError::TransportUnavailable)
        ));
        assert_eq!(transport.calls(), 0);
        // Approval not burned: still pending and usable once a transport exists.
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
        transport.set_available(true);
        let receipt = g
            .dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1"))
            .expect("grant after transport available");
        assert_eq!(receipt.token_hash, issued.token_hash);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1);
    }

    #[test]
    fn default_adapter_is_never_available() {
        let transport = UnavailableTransport;
        assert!(!transport.available());
    }

    #[test]
    fn allowlist_refuses_before_consume() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let issued = issue(&a, "nozzle", "device-1");
        let transport = CountingTransport::new(true);
        let g = DispatchGate::new(&a, &transport, &[DeviceControlAction::Bed]);
        assert!(matches!(
            g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1")),
            Err(DispatchError::InvalidAction("nozzle"))
        ));
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }

    #[test]
    fn invalid_target_or_payload_refuse_before_consume() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let issued = issue(&a, "nozzle", "device-1");
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        // Empty target.
        assert!(matches!(
            g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "")),
            Err(DispatchError::InvalidTarget)
        ));
        // Whitespace-only / whitespace-embedded targets are not device ids.
        assert!(matches!(
            g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "   ")),
            Err(DispatchError::InvalidTarget)
        ));
        assert!(matches!(
            g.dispatch(
                &issued.token,
                &req(DeviceControlAction::Nozzle, " device-1")
            ),
            Err(DispatchError::InvalidTarget)
        ));
        assert!(matches!(
            g.dispatch(
                &issued.token,
                &req(DeviceControlAction::Nozzle, "dev ice-1")
            ),
            Err(DispatchError::InvalidTarget)
        ));
        // Oversized target.
        let long = "t".repeat(MAX_IDENTIFIER_LEN + 1);
        assert!(matches!(
            g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, &long)),
            Err(DispatchError::InvalidTarget)
        ));
        // Oversized payload.
        let mut big = req(DeviceControlAction::Nozzle, "device-1");
        big.payload = serde_json::json!({ "data": "x".repeat(MAX_PAYLOAD_BYTES) });
        assert!(matches!(
            g.dispatch(&issued.token, &big),
            Err(DispatchError::InvalidPayload)
        ));
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }

    #[test]
    fn denied_approvals_never_dispatch() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        // Expired.
        let expired = a
            .issue(IssueRequest {
                action: "nozzle",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "t",
                payload: &nozzle_value(200.0),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            })
            .expect("issue");
        clock.set(BASE + 61_000);
        assert!(matches!(
            g.dispatch(
                &expired.token,
                &req(DeviceControlAction::Nozzle, "device-1")
            ),
            Err(DispatchError::Approval(ApprovalError::Expired))
        ));
        // Revoked.
        clock.set(BASE);
        let revoked = issue(&a, "nozzle", "device-1");
        assert!(a.revoke(&revoked.token).expect("revoke"));
        assert!(matches!(
            g.dispatch(
                &revoked.token,
                &req(DeviceControlAction::Nozzle, "device-1")
            ),
            Err(DispatchError::Approval(ApprovalError::Revoked))
        ));
        // Context changed (wrong target vs frozen envelope).
        let ctx = issue(&a, "nozzle", "device-1");
        assert!(matches!(
            g.dispatch(&ctx.token, &req(DeviceControlAction::Nozzle, "device-2")),
            Err(DispatchError::Approval(ApprovalError::ContextChanged(
                "target"
            )))
        ));
        // Token mismatch: malformed shape and well-formed-but-unknown.
        assert!(matches!(
            g.dispatch("not-a-token", &req(DeviceControlAction::Nozzle, "device-1")),
            Err(DispatchError::Approval(ApprovalError::InvalidToken))
        ));
        assert!(matches!(
            g.dispatch(
                &"a".repeat(crate::approval::TOKEN_HEX_LEN),
                &req(DeviceControlAction::Nozzle, "device-1")
            ),
            Err(DispatchError::Approval(ApprovalError::UnknownToken))
        ));
        assert_eq!(transport.calls(), 0);
        // Expired + context-changed rows stay pending (revoked does not).
        assert_eq!(a.pending_tokens("user-1").expect("pending").len(), 2);
    }

    #[test]
    fn grant_dispatches_exactly_once_and_replay_refuses() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let issued = issue(&a, "nozzle", "device-1");
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let receipt = g
            .dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1"))
            .expect("grant");
        assert_eq!(receipt.token_hash, issued.token_hash);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1);
        // Replay refuses (one-use) and the counter stays unchanged.
        assert!(matches!(
            g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1")),
            Err(DispatchError::Approval(ApprovalError::AlreadyConsumed))
        ));
        assert_eq!(transport.calls(), 1);
    }

    #[test]
    fn refused_is_a_typed_outcome_not_an_error() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let issued = issue(&a, "nozzle", "device-1");
        let transport = CountingTransport::new(true);
        transport.set_mode(1);
        let g = gate(&a, &transport);
        let receipt = g
            .dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1"))
            .expect("dispatched");
        assert!(matches!(
            receipt.outcome,
            TransportOutcome::Refused(ref r) if r == "device refused"
        ));
        assert_eq!(transport.calls(), 1);
    }

    #[test]
    fn timeout_and_indeterminate_throw_distinct_errors_and_never_retry() {
        // Timeout and Indeterminate are distinct post-consumption errors:
        // mode 2 → TransportTimeout, mode 3 → IndeterminateOutcome.
        for (mode, expect_timeout) in [(2usize, true), (3, false)] {
            let clock = FakeClock::new(BASE);
            let db = DbHandle::open_in_memory().expect("db");
            let a = auth(&db, &clock);
            let issued = issue(&a, "nozzle", "device-1");
            let transport = CountingTransport::new(true);
            transport.set_mode(mode);
            let g = gate(&a, &transport);
            let result = g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1"));
            if expect_timeout {
                assert!(matches!(result, Err(DispatchError::TransportTimeout)));
            } else {
                assert!(matches!(result, Err(DispatchError::IndeterminateOutcome)));
            }
            assert_eq!(transport.calls(), 1);
            // The approval is spent; a retry is refused with no further call.
            assert!(matches!(
                g.dispatch(&issued.token, &req(DeviceControlAction::Nozzle, "device-1")),
                Err(DispatchError::Approval(ApprovalError::AlreadyConsumed))
            ));
            assert_eq!(transport.calls(), 1);
        }
    }

    /// The pre-fix gate granted `{"nozzle": 500}` (disconfirmed by test).
    /// Hardened behavior: out-of-range is refused with zero transport calls.
    #[test]
    fn nozzle_out_of_range_is_refused_before_consume() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let payload = nozzle_value(500.0);
        let issued = issue_bound(&a, "nozzle", "device-1", &payload, None, None, None, None);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        assert_payload_refused(
            &g,
            &transport,
            &a,
            &issued.token,
            &issued.token_hash,
            &req_with(
                DeviceControlAction::Nozzle,
                "device-1",
                payload,
                RequestContext::default(),
            ),
        );
    }

    /// `null`, missing, wrong-type and unknown-field shapes are all refused —
    /// the gate validates the closed typed structure, not just byte size.
    #[test]
    fn nozzle_null_string_missing_and_unknown_fields_are_refused() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let payloads = [
            Value::Null,
            serde_json::json!({ "nozzle": null }),
            serde_json::json!({ "nozzle": "hot" }),
            serde_json::json!({ "nozzle": 200.0, "boost": true }),
            serde_json::json!({}),
            serde_json::json!({ "nozzle": true }),
        ];
        for payload in payloads {
            let issued = issue_bound(&a, "nozzle", "device-1", &payload, None, None, None, None);
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::Nozzle,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
    }

    /// No silent clamping: out-of-window and off-canonical thermals are
    /// refused exactly at the window edges (0 ≤ t ≤ max, finite floats).
    #[test]
    fn thermal_windows_reject_out_of_bounds_without_clamping() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        for (action, payload) in [
            (DeviceControlAction::Nozzle, nozzle_value(-1.0)),
            (DeviceControlAction::Nozzle, nozzle_value(320.5)),
            (DeviceControlAction::Nozzle, nozzle_value(321.0)),
            (DeviceControlAction::Bed, bed_value(121.0)),
            (DeviceControlAction::Bed, bed_value(-0.5)),
        ] {
            let issued = issue_bound(
                &a,
                action.name(),
                "device-1",
                &payload,
                None,
                None,
                None,
                None,
            );
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(action, "device-1", payload, RequestContext::default()),
            );
        }
        // Window edges grant (0 and 120 for the bed).
        for edge in [0.0, 120.0] {
            let payload = bed_value(edge);
            let issued = issue_bound(&a, "bed", "device-1", &payload, None, None, None, None);
            let receipt = g
                .dispatch(
                    &issued.token,
                    &req_with(
                        DeviceControlAction::Bed,
                        "device-1",
                        payload,
                        RequestContext::default(),
                    ),
                )
                .expect("window edge grants");
            assert_eq!(receipt.outcome, TransportOutcome::Ack);
        }
        assert_eq!(transport.calls(), 2);
    }

    /// Fan is a closed target enum + a validated percentage window.
    #[test]
    fn fan_rejects_unknown_target_and_out_of_range_percent() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let payloads = [
            serde_json::json!({ "fan": "other", "speed_pct": 50.0 }),
            serde_json::json!({ "fan": "part", "speed_pct": 101.0 }),
            serde_json::json!({ "fan": "part", "speed_pct": -1.0 }),
            serde_json::json!({ "fan": "part" }),
            serde_json::json!({ "fan": "part", "speed_pct": "fast" }),
        ];
        for payload in payloads {
            let issued = issue_bound(&a, "part_fan", "device-1", &payload, None, None, None, None);
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::PartFan,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
        // The canonical envelope grants.
        let payload = fan_value(100.0);
        let issued = issue_bound(&a, "part_fan", "device-1", &payload, None, None, None, None);
        let receipt = g
            .dispatch(
                &issued.token,
                &req_with(
                    DeviceControlAction::PartFan,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            )
            .expect("fan grant");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1);
    }

    /// Speed mode accepts the exact integers 1|2|3 — nothing else (no
    /// fractional floats, no strings, no 0/4+).
    #[test]
    fn speed_mode_accepts_only_the_integer_triplet() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        for payload in [
            speed_value(0),
            speed_value(4),
            serde_json::json!({ "print_speed_mode": 2.0 }),
            serde_json::json!({ "print_speed_mode": "2" }),
            serde_json::json!({}),
        ] {
            let issued = issue_bound(&a, "speed", "device-1", &payload, None, None, None, None);
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::Speed,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
        for mode in [1u8, 2, 3] {
            let payload = speed_value(mode);
            let issued = issue_bound(&a, "speed", "device-1", &payload, None, None, None, None);
            let receipt = g
                .dispatch(
                    &issued.token,
                    &req_with(
                        DeviceControlAction::Speed,
                        "device-1",
                        payload,
                        RequestContext::default(),
                    ),
                )
                .expect("speed mode grants");
            assert_eq!(receipt.outcome, TransportOutcome::Ack);
        }
        assert_eq!(transport.calls(), 3);
    }

    /// Lights: the enabled action takes a boolean only; the brightness
    /// action requires `on: true` and a 0–100 integer.
    #[test]
    fn light_payloads_are_boolean_strict() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        // Enabled: "yes", missing, unknown field → refused.
        for payload in [
            serde_json::json!({ "on": "yes" }),
            serde_json::json!({}),
            serde_json::json!({ "on": true, "color": "warm" }),
        ] {
            let issued = issue_bound(
                &a,
                "light_set_enabled",
                "device-1",
                &payload,
                None,
                None,
                None,
                None,
            );
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::LightSetEnabled,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
        // Brightness: off-with-brightness, out-of-range, missing on → refused.
        for payload in [
            brightness_value(false, 50),
            brightness_value(true, 101),
            serde_json::json!({ "brightness": 50 }),
        ] {
            let issued = issue_bound(
                &a,
                "light_brightness",
                "device-1",
                &payload,
                None,
                None,
                None,
                None,
            );
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::LightBrightness,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
        // Both canonical envelopes grant.
        for (action, payload) in [
            (DeviceControlAction::LightSetEnabled, light_value(false)),
            (
                DeviceControlAction::LightBrightness,
                brightness_value(true, 100),
            ),
        ] {
            let issued = issue_bound(
                &a,
                action.name(),
                "device-1",
                &payload,
                None,
                None,
                None,
                None,
            );
            let receipt = g
                .dispatch(
                    &issued.token,
                    &req_with(action, "device-1", payload, RequestContext::default()),
                )
                .expect("light grant");
            assert_eq!(receipt.outcome, TransportOutcome::Ack);
        }
        assert_eq!(transport.calls(), 2);
    }

    /// ACE dryer: box 0–9, target 0–80 °C, duration 0–1440 min, and
    /// `remain_time` must be exactly 0. Integer fields reject fractional and
    /// negative JSON numbers.
    #[test]
    fn ace_dry_enforces_window_and_shape() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let payloads = [
            ace_dry_value(10, false, 60, 120, 0),
            ace_dry_value(1, false, 81, 120, 0),
            ace_dry_value(1, false, 60, 1441, 0),
            ace_dry_value(1, false, 60, 120, 1),
            serde_json::json!({ "box_id": -1, "stop": false, "target_temp": 60, "duration_min": 120, "remain_time": 0 }),
            serde_json::json!({ "box_id": 1.5, "stop": false, "target_temp": 60, "duration_min": 120, "remain_time": 0 }),
            serde_json::json!({ "box_id": 1, "stop": false, "target_temp": 60, "duration_min": 120 }),
            serde_json::json!({ "box_id": 1, "stop": false, "target_temp": 60, "duration_min": 120, "remain_time": 0, "edit_status": 1 }),
        ];
        for payload in payloads {
            let issued = issue_bound(&a, "ace_dry", "device-1", &payload, None, None, None, None);
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::AceDry,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
        let payload = ace_dry_value(9, true, 80, 1440, 0);
        let issued = issue_bound(&a, "ace_dry", "device-1", &payload, None, None, None, None);
        let receipt = g
            .dispatch(
                &issued.token,
                &req_with(
                    DeviceControlAction::AceDry,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            )
            .expect("ace dry grant");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1);
    }

    /// ACE auto-feed: box 0–9 + boolean enabled.
    #[test]
    fn ace_auto_feed_enforces_box_window() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        for payload in [
            ace_auto_feed_value(10, true),
            serde_json::json!({ "enabled": true }),
            serde_json::json!({ "box_id": -1, "enabled": true }),
            serde_json::json!({ "box_id": 2, "enabled": "yes" }),
        ] {
            let issued = issue_bound(
                &a,
                "ace_auto_feed",
                "device-1",
                &payload,
                None,
                None,
                None,
                None,
            );
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::AceAutoFeed,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
        let payload = ace_auto_feed_value(9, false);
        let issued = issue_bound(
            &a,
            "ace_auto_feed",
            "device-1",
            &payload,
            None,
            None,
            None,
            None,
        );
        let receipt = g
            .dispatch(
                &issued.token,
                &req_with(
                    DeviceControlAction::AceAutoFeed,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            )
            .expect("ace auto feed grant");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1);
    }

    /// ACE slot bind is the MANUAL metadata path only: bounded material,
    /// exact [r,g,b] triple, and no `edit_status` field (no RFID forgery).
    #[test]
    fn ace_bind_slot_is_manual_metadata_only() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let long_material = "P".repeat(MAX_IDENTIFIER_LEN + 1);
        let payloads = [
            ace_bind_value(1, 4, "", [15, 168, 220]),
            ace_bind_value(1, 4, &long_material, [15, 168, 220]),
            serde_json::json!({ "box_id": 1, "slot_index": 4, "material_type": "PLA", "color": [-1, 0, 0] }),
            serde_json::json!({ "box_id": 1, "slot_index": 4, "material_type": "PLA", "color": [1, 2] }),
            serde_json::json!({ "box_id": 1, "slot_index": 4, "material_type": "PLA", "color": [1, 2, 3, 4] }),
            ace_bind_value(10, 4, "PLA", [15, 168, 220]),
            ace_bind_value(1, 10, "PLA", [15, 168, 220]),
            serde_json::json!({ "box_id": 1, "slot_index": 4, "material_type": "PLA", "color": [15, 168, 220], "edit_status": 0 }),
        ];
        for payload in payloads {
            let issued = issue_bound(
                &a,
                "ace_bind_slot",
                "device-1",
                &payload,
                None,
                None,
                None,
                None,
            );
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(
                    DeviceControlAction::AceBindSlot,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            );
        }
        let payload = ace_bind_value(1, 4, "PLA", [15, 168, 220]);
        let issued = issue_bound(
            &a,
            "ace_bind_slot",
            "device-1",
            &payload,
            None,
            None,
            None,
            None,
        );
        let receipt = g
            .dispatch(
                &issued.token,
                &req_with(
                    DeviceControlAction::AceBindSlot,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            )
            .expect("ace bind grant");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1);
    }

    /// The four binding context fields are passed to `consume` — a match
    /// grants, and ANY mismatch refuses with zero transport calls (the old
    /// code always sent `None` for all four, silently unbound).
    #[test]
    fn bindings_are_passed_through_to_consume() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let payload = nozzle_value(200.0);
        // (1) Match: all four bindings present on both sides → grant.
        let mut bound_ctx = RequestContext::default();
        bound_ctx.session_ref = Some("session-9".to_owned());
        bound_ctx.revision = Some(7);
        bound_ctx.artifact = Some("gcode-abc".to_owned());
        bound_ctx.material = Some("PLA".to_owned());
        let issued = issue_bound(
            &a,
            "nozzle",
            "device-1",
            &payload,
            Some("session-9"),
            Some(7),
            Some("gcode-abc"),
            Some("PLA"),
        );
        let receipt = g
            .dispatch(
                &issued.token,
                &req_with(
                    DeviceControlAction::Nozzle,
                    "device-1",
                    payload.clone(),
                    bound_ctx.clone(),
                ),
            )
            .expect("bound grant");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1);
        // (2) Each single-field mismatch refuses with zero transport calls
        //     and the approval stays pending.
        for (vary, name) in [
            (ContextField::Session("session-8"), "session"),
            (ContextField::Revision(8), "revision"),
            (ContextField::Artifact("gcode-xyz"), "artifact"),
            (ContextField::Material("PETG"), "material"),
        ] {
            let mut ctx = bound_ctx.clone();
            match vary {
                ContextField::Session(s) => ctx.session_ref = Some(s.to_owned()),
                ContextField::Revision(r) => ctx.revision = Some(r),
                ContextField::Artifact(art) => ctx.artifact = Some(art.to_owned()),
                ContextField::Material(mat) => ctx.material = Some(mat.to_owned()),
            }
            let issued = issue_bound(
                &a,
                "nozzle",
                "device-1",
                &payload,
                Some("session-9"),
                Some(7),
                Some("gcode-abc"),
                Some("PLA"),
            );
            assert!(matches!(
                g.dispatch(
                    &issued.token,
                    &req_with(DeviceControlAction::Nozzle, "device-1", payload.clone(), ctx)
                ),
                Err(DispatchError::Approval(ApprovalError::ContextChanged(f))) if f == name
            ));
            assert_eq!(
                transport.calls(),
                1,
                "no transport call for binding mismatch"
            );
            assert!(
                a.pending_tokens("user-1")
                    .expect("pending")
                    .contains(&issued.token_hash),
                "approval stays pending after a binding mismatch"
            );
        }
        // (3) Bound issue + unbound request (old behavior) is NOW refused —
        //     bindings are never silently dropped.
        let issued = issue_bound(
            &a,
            "nozzle",
            "device-1",
            &payload,
            Some("session-9"),
            None,
            None,
            None,
        );
        assert!(matches!(
            g.dispatch(
                &issued.token,
                &req_with(
                    DeviceControlAction::Nozzle,
                    "device-1",
                    payload.clone(),
                    RequestContext::default()
                )
            ),
            Err(DispatchError::Approval(ApprovalError::ContextChanged(
                "session"
            )))
        ));
        assert_eq!(transport.calls(), 1);
        // (4) Unbound issue + unbound request grants (default is unchanged).
        let issued = issue_bound(&a, "nozzle", "device-1", &payload, None, None, None, None);
        let receipt = g
            .dispatch(
                &issued.token,
                &req_with(
                    DeviceControlAction::Nozzle,
                    "device-1",
                    payload,
                    RequestContext::default(),
                ),
            )
            .expect("unbound grant");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 2);
    }

    enum ContextField {
        Session(&'static str),
        Revision(u64),
        Artifact(&'static str),
        Material(&'static str),
    }

    /// The legacy opaque `{"value": …, "kind": "test"}` payload factory (the
    /// pre-hardening dispatch-test shorthand) is no longer a valid payload
    /// for ANY typed action — unknown shape fields are refused before the
    /// approval is touched.
    #[test]
    fn opaque_legacy_payload_shape_is_refused_for_every_action() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        for action in DeviceControlAction::ALL {
            let payload = crate::approval::test_support::payload(1);
            let issued = issue_bound(
                &a,
                action.name(),
                "device-1",
                &payload,
                None,
                None,
                None,
                None,
            );
            assert_payload_refused(
                &g,
                &transport,
                &a,
                &issued.token,
                &issued.token_hash,
                &req_with(action, "device-1", payload, RequestContext::default()),
            );
        }
    }

    #[test]
    fn concurrent_dispatch_grants_one_transport_call() {
        let clock = FakeClock::new(BASE);
        let db = Arc::new(Mutex::new(DbHandle::open_in_memory().expect("db")));
        let transport = Arc::new(CountingTransport::new(true));
        let issued = {
            let guard = db.lock().expect("lock");
            let a = auth(&guard, &clock);
            issue(&a, "nozzle", "device-1")
        };
        let token = issued.token;
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let db = Arc::clone(&db);
                let transport = Arc::clone(&transport);
                let clock = clock.clone();
                let token = token.clone();
                std::thread::spawn(move || {
                    let guard = db.lock().expect("lock");
                    let a = auth(&guard, &clock);
                    let g = DispatchGate::new(&a, &*transport, &DeviceControlAction::ALL);
                    g.dispatch(&token, &req(DeviceControlAction::Nozzle, "device-1"))
                })
            })
            .collect();
        let mut ok = 0usize;
        let mut denied = 0usize;
        for t in threads {
            match t.join().expect("thread") {
                Ok(r) => {
                    assert_eq!(r.outcome, TransportOutcome::Ack);
                    ok += 1;
                }
                Err(e) => {
                    assert!(
                        matches!(e, DispatchError::Approval(ApprovalError::AlreadyConsumed)),
                        "denial must be one-use only: {e:?}"
                    );
                    denied += 1;
                }
            }
        }
        assert_eq!(ok, 1, "exactly one grant expected");
        assert_eq!(denied, 15);
        assert_eq!(
            transport.calls(),
            1,
            "exactly one transport dispatch expected"
        );
    }

    // ---------- S9.18-003: authenticated-session dispatch ----------

    /// In-memory auth repository sharing the SAME fake clock as the approval
    /// authority (deterministic expiry across both stores), pre-seeded with
    /// `user` having the `DeviceControl` capability granted.
    fn session_auth(clock: &FakeClock, user: &str) -> auth_service::AuthDb {
        let mut adb =
            auth_service::AuthDb::open_in_memory_with_clock(clock.clock_fn()).expect("auth db");
        adb.upsert_user(user, "Session User").expect("upsert user");
        adb.grant_scope(user, auth_service::Scope::DeviceControl)
            .expect("grant scope");
        adb
    }

    fn denied_reason(e: DispatchError) -> &'static str {
        match e {
            DispatchError::SessionDenied(r) => r,
            other => panic!("expected SessionDenied, got {other:?}"),
        }
    }

    /// Mint an approval bound to the given live session via the secure
    /// issue_for_session_scoped entry.
    fn issue_via_session<'a>(
        a: &ApprovalAuthority<'a>,
        adb: &auth_service::AuthDb,
        session_token: &str,
        action: &'a str,
        target: &'a str,
        revision: Option<u64>,
    ) -> IssuedApproval {
        a.issue_for_session_scoped(
            adb,
            session_token,
            &ScopedIssueRequest {
                action,
                target,
                purpose: "session dispatch test",
                payload: &nozzle_value(200.0),
                revision,
                artifact: None,
                material: None,
                device_snapshot_ms: Some(BASE),
                project_id: Some("project-1"),
                ttl_ms: 60_000,
            },
        )
        .expect("issue_for_session_scoped")
    }

    /// Request with the SAME trusted snapshot/project anchors the session
    /// approval was issued under — the device-writer consume envelope must
    /// re-supply them bit-for-bit.
    fn req_session(action: DeviceControlAction, target: &str) -> DeviceControlRequest {
        DeviceControlRequest {
            action,
            target: target.to_owned(),
            payload: canonical_payload(action),
            principal: local_user("user-1"),
            context: RequestContext {
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: Some(BASE),
                project_id: Some("project-1".to_owned()),
            },
        }
    }

    /// The session-bound dispatch path must ignore a caller-supplied
    /// principal: we forge an attacker identity inside `req` and expect the
    /// verified session's own principal + hash to govern the consume.
    #[test]
    fn authenticated_session_grants_exactly_one_authorized_dispatch() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session.raw(), "nozzle", "device-1", None);

        // Forged principal inside the request is NOT the identity used.
        let mut req = req_session(DeviceControlAction::Nozzle, "device-1");
        req.principal = local_user("attacker");
        let receipt = g
            .dispatch_for_session(&adb, session.raw(), &issued.token, &req)
            .expect("authorized session dispatch");
        assert_eq!(receipt.token_hash, issued.token_hash);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(transport.calls(), 1, "exactly one authorized call");
        // One-use: a second dispatch is refused with zero transport.
        let denied = g
            .dispatch_for_session(&adb, session.raw(), &issued.token, &req)
            .expect_err("one-use");
        assert!(matches!(
            denied,
            DispatchError::Approval(ApprovalError::AlreadyConsumed)
        ));
        assert_eq!(transport.calls(), 1);
    }

    /// A forged `Principal` with no resolvable session is denied BEFORE any
    /// transport call; the approval stays pending.
    #[test]
    fn forged_principal_without_session_is_denied_zero_transport() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session.raw(), "nozzle", "device-1", None);

        // The request carries an invented local principal, but the raw
        // "session token" handed in is garbage → no verified session → denial.
        let mut forged = req_session(DeviceControlAction::Nozzle, "device-1");
        forged.principal = local_user("totally-forged");
        let err = g
            .dispatch_for_session(&adb, &"b".repeat(64), &issued.token, &forged)
            .expect_err("no session");
        assert_eq!(denied_reason(err), "unauthenticated");
        assert_eq!(transport.calls(), 0, "denial must not reach transport");
        assert!(
            a.pending_tokens("user-1")
                .expect("pending")
                .contains(&issued.token_hash),
            "approval stays pending when session is missing"
        );
    }

    #[test]
    fn session_revoked_after_approval_denies_zero_transport() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session.raw(), "nozzle", "device-1", None);

        adb.revoke_session(session.hash()).expect("revoke");
        let err = g
            .dispatch_for_session(
                &adb,
                session.raw(),
                &issued.token,
                &req(DeviceControlAction::Nozzle, "device-1"),
            )
            .expect_err("revoked");
        assert_eq!(denied_reason(err), "revoked");
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }

    #[test]
    fn session_expired_denies_zero_transport() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session.raw(), "nozzle", "device-1", None);

        clock.advance(60_001); // past session TTL (and approval TTL)
        let err = g
            .dispatch_for_session(
                &adb,
                session.raw(),
                &issued.token,
                &req(DeviceControlAction::Nozzle, "device-1"),
            )
            .expect_err("expired");
        assert_eq!(denied_reason(err), "expired");
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }

    #[test]
    fn session_user_removed_denies_zero_transport() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session.raw(), "nozzle", "device-1", None);

        adb.remove_user("user-1").expect("remove user");
        let err = g
            .dispatch_for_session(
                &adb,
                session.raw(),
                &issued.token,
                &req(DeviceControlAction::Nozzle, "device-1"),
            )
            .expect_err("user removed");
        // FK ON + CASCADE drops the session row → unauthenticated; with FK
        // OFF the users() check → user. Both are fail-closed denials.
        let reason = denied_reason(err);
        assert!(
            reason == "unauthenticated" || reason == "user",
            "unexpected reason {reason:?}"
        );
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }

    #[test]
    fn session_scope_rescinded_denies_zero_transport() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session.raw(), "nozzle", "device-1", None);

        adb.revoke_scope("user-1", auth_service::Scope::DeviceControl)
            .expect("rescind scope");
        let err = g
            .dispatch_for_session(
                &adb,
                session.raw(),
                &issued.token,
                &req(DeviceControlAction::Nozzle, "device-1"),
            )
            .expect_err("rescinded");
        assert_eq!(denied_reason(err), "scope");
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }

    #[test]
    fn revision_mismatch_denies_zero_transport() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session.raw(), "nozzle", "device-1", Some(5));

        let mut ctx = RequestContext {
            session_ref: None,
            revision: None,
            artifact: None,
            material: None,
            device_snapshot_ms: Some(BASE),
            project_id: Some("project-1".to_owned()),
        };
        ctx.revision = Some(6); // changed since approval
        let err = g
            .dispatch_for_session(
                &adb,
                session.raw(),
                &issued.token,
                &req_with(
                    DeviceControlAction::Nozzle,
                    "device-1",
                    nozzle_value(200.0),
                    ctx,
                ),
            )
            .expect_err("revision mismatch");
        assert!(matches!(
            err,
            DispatchError::Approval(ApprovalError::ContextChanged("revision"))
        ));
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }

    #[test]
    fn replaced_session_hash_mismatch_denies_zero_transport() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session1 = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("session 1");
        let a = auth(&db, &clock);
        let transport = CountingTransport::new(true);
        let g = gate(&a, &transport);
        let issued = issue_via_session(&a, &adb, session1.raw(), "nozzle", "device-1", None);

        // Revoke session 1 and re-authenticate → a NEW session (fresh hash).
        // The approval is still bound to the ORIGINAL session hash.
        adb.revoke_session(session1.hash())
            .expect("revoke session 1");
        let session2 = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("session 2");
        assert_ne!(session2.hash(), session1.hash());

        let err = g
            .dispatch_for_session(
                &adb,
                session2.raw(),
                &issued.token,
                &req_session(DeviceControlAction::Nozzle, "device-1"),
            )
            .expect_err("session replaced");
        assert!(matches!(
            err,
            DispatchError::Approval(ApprovalError::ContextChanged("session"))
        ));
        assert_eq!(transport.calls(), 0);
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash));
    }
}
