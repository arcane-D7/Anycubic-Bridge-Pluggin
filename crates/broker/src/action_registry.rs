//! Writer action registry — the single owner of the mapping from a stored
//! approval `action` name to the auth scope that guards it (DEV-10) AND of the
//! public-safe discovery catalog (S9.18-001).
//!
//! Every writable effect has exactly one required scope, derived from the
//! **action** (closed, backend-owned) — never from a caller-supplied
//! parameter. The approval authority, the control dispatch gate and the job
//! dispatch gate all resolve the scope through this registry, so issuance,
//! consume-time identity and effect dispatch can never disagree.
//!
//! Scope classes (see `auth_service::Scope::is_session_capability`):
//! - `device_control` — the nine physical control actions.
//! - `device_upload`   — artifact uploads (separate account write scope).
//! - `print_job`       — queue / start / stop print-job effects.
//!
//! The catalog is DERIVED from the SAME arrays and the SAME typed parsers the
//! dispatch gates use: an operation id is exactly a known approval `action`,
//! its `inputSchema` is rebuilt from the same numeric-window constants that
//! [`crate::dispatch`] enforces (drift-proof by construction), and its
//! availability is computed from backend-owned [`BackendCapabilityState`] —
//! never from request JSON. Discovery is NOT permission: every writer is
//! `unavailable` until the backend itself wires a transport, a session AND
//! (for start/stop) a trusted snapshot resolver.

use auth_service::Scope;
use serde::Serialize;

use crate::approval::MAX_IDENTIFIER_LEN;
use crate::dispatch::{
    ACE_BOX_MAX, ACE_SLOT_MAX, BED_MAX_C, BRIGHTNESS_MAX_PCT, DRYER_DURATION_MAX_MIN,
    DRYER_TARGET_MAX_C, FAN_MAX_PCT, NOZZLE_MAX_C,
};
use crate::job_dispatch::{MAX_MATERIAL_SLOTS, MAX_UPLOAD_BYTES};

/// The nine physical device-control actions.
pub const DEVICE_CONTROL_ACTIONS: [&str; 9] = [
    "nozzle",
    "bed",
    "part_fan",
    "speed",
    "light_set_enabled",
    "light_brightness",
    "ace_dry",
    "ace_auto_feed",
    "ace_bind_slot",
];

/// Artifact-upload action (writes the account cloud shelf).
pub const UPLOAD_ACTIONS: [&str; 1] = ["upload"];

/// Print-job actions (queue / start / stop — physical prints).
pub const PRINT_JOB_ACTIONS: [&str; 3] = ["job.queue", "job.start", "job.stop"];

/// Wire schema version of one operation entry. Bumped ONLY on an incompatible
/// entry-shape change (new required field, renamed key, semantic
/// reinterpretation) — never per added operation.
pub const OPERATION_SCHEMA_VERSION: u16 = 1;

/// Stable precise availability reasons (wire strings). Never a URL, key or
/// account path — just a machine-readable reason the UI can map.
pub const REASON_BACKEND_NOT_WIRED: &str = "backend-not-wired";
pub const REASON_NO_SESSION: &str = "no-session";
pub const REASON_NO_TRUSTED_SNAPSHOT: &str = "no-trusted-snapshot";
pub const REASON_REVOKED: &str = "revoked";

/// Required scope for a stored approval action, or `None` when the action is
/// unknown. Unknown names are never grantable through the session entry —
/// `issue_for_session_scoped` refuses them before any session lookup result
/// can mint anything.
pub fn required_scope(action: &str) -> Option<Scope> {
    if UPLOAD_ACTIONS.contains(&action) {
        return Some(Scope::DeviceUpload);
    }
    if PRINT_JOB_ACTIONS.contains(&action) {
        return Some(Scope::PrintJob);
    }
    if DEVICE_CONTROL_ACTIONS.contains(&action) {
        return Some(Scope::DeviceControl);
    }
    None
}

/// `true` when the action is a known writable effect (i.e. has a required
/// scope). Used by the dispatch gates to refuse unknown/legacy generic
/// command names.
pub fn is_writer_action(action: &str) -> bool {
    required_scope(action).is_some()
}

/// Semantic effect classification of a known writer operation (stable wire
/// codes). Backend-owned; reflects what the effect DOES, not who may call it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationEffect {
    /// Heaters / fan / speed (nozzle, bed, part_fan, speed).
    Thermal,
    /// Device / ACE state toggles (lights, ACE dry / auto-feed / bind slot).
    State,
    /// Artifact upload to the account cloud shelf.
    Upload,
    /// Print-job effects (queue / start / stop).
    Job,
}

/// Approval policy for a writer entry. All known writers are one-use
/// approvals bound to the digest of the input payload — never open-ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    /// A one-use approval bound to the payload digest, issued against the
    /// entry's required scope, must be consumed before any effect.
    OneUseApproval,
}

/// Honest handler reference: WHICH internal gate owns this effect. This slice
/// wires no real transport, so every entry reports `unavailable` (see
/// [`BackendCapabilityState`]) — the reference tells you exactly what would
/// run once the backend wires it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HandlerRef {
    /// `crate::dispatch::DispatchGate` (the nine device-control writers).
    DispatchDeviceControl,
    /// `crate::job_dispatch::JobDispatchGate` (upload / queue / start / stop).
    DispatchJob,
}

/// Backend-owned capability state the catalog consults. It is NEVER derived
/// from request JSON — a client cannot enable a capability by querying it.
/// The default (no session, no writer transport, no resolver, no revocation
/// list) makes every writer entry report `unavailable` with a precise reason.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackendCapabilityState {
    /// A verified, unexpired session exists holding the entry's required scope.
    pub authenticated_session: bool,
    /// A real device-control transport is wired (`ControlTransport`).
    pub device_control_wired: bool,
    /// A real job transport is wired (`JobTransport`) — upload/queue/start/stop.
    pub job_transport_wired: bool,
    /// A trusted provider snapshot resolver is wired (start/stop revalidate
    /// against it; without it they can never be considered available).
    pub snapshot_resolver_wired: bool,
    /// Actions the backend has revoked (stable ids). Backend-owned only — a
    /// revoked action is reported `revoked` and the dispatch gates refuse it
    /// (via the same registry + allowlist) before any effect.
    pub revoked_actions: Vec<String>,
}

impl BackendCapabilityState {
    /// `true` when the backend has revoked `id` (exact match, stable ids).
    pub fn revoked(&self, id: &str) -> bool {
        self.revoked_actions.iter().any(|revoked| revoked == id)
    }
}

/// One known writer operation in the public-safe discovery catalog
/// (S9.18-001). Every field is derived from the registry + typed parsers —
/// never from a caller's JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEntry {
    /// Stable public id — the SAME string the dispatch gates validate
    /// (`DeviceControlAction::name()` / `JobAction::name()`).
    pub id: String,
    /// Wire schema version of this entry shape ([`OPERATION_SCHEMA_VERSION`]).
    pub schema_version: u16,
    /// Semantic effect class (backend classification, never user-supplied).
    pub effect: OperationEffect,
    /// Backend-owned required auth scope — from [`required_scope`], the
    /// single mapping owner (never a caller-supplied value).
    pub required_scope: String,
    /// Approval policy for this writer (all one-use approvals).
    pub approval_policy: ApprovalPolicy,
    /// The internal gate that owns this effect (honest handler reference;
    /// NOT "executed", just which gate runs it).
    pub handler: HandlerRef,
    /// Input JSON schema — documentation-grade, agrees with the closed typed
    /// parsers (`deny_unknown_fields` + the SAME numeric windows).
    pub input_schema: serde_json::Value,
    /// `false` until the backend wires the transport, a session AND (for
    /// start/stop) the trusted snapshot resolver.
    pub available: bool,
    /// Stable reason — one of [`REASON_BACKEND_NOT_WIRED`],
    /// [`REASON_NO_SESSION`], [`REASON_NO_TRUSTED_SNAPSHOT`], [`REASON_REVOKED`].
    pub availability_reason: String,
}

/// Effect + handler class for a known action (single source: the arrays).
fn class(id: &str) -> Option<(OperationEffect, HandlerRef)> {
    if DEVICE_CONTROL_ACTIONS.contains(&id) {
        return Some((OperationEffect::Thermal, HandlerRef::DispatchDeviceControl));
    }
    if UPLOAD_ACTIONS.contains(&id) {
        return Some((OperationEffect::Upload, HandlerRef::DispatchJob));
    }
    if PRINT_JOB_ACTIONS.contains(&id) {
        return Some((OperationEffect::Job, HandlerRef::DispatchJob));
    }
    None
}

/// The closed device-control schema for `id`; falls back to an empty object
/// for unknown ids (never reached — `operation` guards unknown ids first).
fn device_control_schema(id: &str) -> serde_json::Value {
    let mut schema = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": [],
        "properties": {}
    });
    let props = schema
        .as_object_mut()
        .expect("schema object")
        .get_mut("properties")
        .expect("properties object")
        .as_object_mut()
        .expect("properties map");
    let mut required: Vec<&str> = Vec::new();
    macro_rules! field {
        ($name:literal => $def:expr) => {{
            props.insert(String::from($name), $def);
            required.push($name);
        }};
    }
    match id {
        "nozzle" => {
            field!("nozzle" => serde_json::json!({"type":"number","minimum":0,"maximum":NOZZLE_MAX_C}))
        }
        "bed" => {
            field!("bed" => serde_json::json!({"type":"number","minimum":0,"maximum":BED_MAX_C}))
        }
        "part_fan" => {
            field!("fan" => serde_json::json!({"const":"part"}));
            field!("speed_pct" => serde_json::json!({"type":"number","minimum":0,"maximum":FAN_MAX_PCT}));
        }
        "speed" => {
            field!("print_speed_mode" => serde_json::json!({"type":"integer","enum":[1,2,3]}))
        }
        "light_set_enabled" => field!("on" => serde_json::json!({"type":"boolean"})),
        "light_brightness" => {
            field!("on" => serde_json::json!({"const":true}));
            field!("brightness" => serde_json::json!({"type":"integer","minimum":0,"maximum":BRIGHTNESS_MAX_PCT}));
        }
        "ace_dry" => {
            field!("box_id" => serde_json::json!({"type":"integer","minimum":0,"maximum":ACE_BOX_MAX}));
            field!("stop" => serde_json::json!({"type":"boolean"}));
            field!("target_temp" => serde_json::json!({"type":"integer","minimum":0,"maximum":DRYER_TARGET_MAX_C}));
            field!("duration_min" => serde_json::json!({"type":"integer","minimum":0,"maximum":DRYER_DURATION_MAX_MIN}));
            field!("remain_time" => serde_json::json!({"const":0}));
        }
        "ace_auto_feed" => {
            field!("box_id" => serde_json::json!({"type":"integer","minimum":0,"maximum":ACE_BOX_MAX}));
            field!("enabled" => serde_json::json!({"type":"boolean"}));
        }
        "ace_bind_slot" => {
            field!("box_id" => serde_json::json!({"type":"integer","minimum":0,"maximum":ACE_BOX_MAX}));
            field!("slot_index" => serde_json::json!({"type":"integer","minimum":0,"maximum":ACE_SLOT_MAX}));
            field!("material_type" => serde_json::json!({"type":"string","minLength":1,"maxLength":MAX_IDENTIFIER_LEN}));
            field!("color" => serde_json::json!({"type":"array","minItems":3,"maxItems":3,"items":{"type":"integer","minimum":0,"maximum":255}}));
        }
        _ => {}
    }
    *schema
        .get_mut("required")
        .expect("required array")
        .as_array_mut()
        .expect("required array") = required
        .into_iter()
        .map(|name| serde_json::Value::String(name.to_owned()))
        .collect();
    schema
}

/// The closed job schema for `id` (upload / job.queue / job.start / job.stop).
fn job_schema(id: &str) -> serde_json::Value {
    let opaque_ref = serde_json::json!({
        "type": "string",
        "minLength": 1,
        "maxLength": MAX_IDENTIFIER_LEN,
        "pattern": r"^[^\s/:\\]+$",
    });
    let cas = serde_json::json!({
        "type": "string",
        "pattern": r"^[0-9a-f]{64}$",
    });
    match id {
        "upload" => serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["artifact_sha256", "file_ref", "exact_size_bytes"],
            "properties": {
                "artifact_sha256": cas,
                "file_ref": opaque_ref,
                "exact_size_bytes": {"type":"integer","minimum":1,"maximum":MAX_UPLOAD_BYTES},
            },
        }),
        "job.queue" => serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["artifact_sha256", "file_ref", "profile_rev", "mode", "material_mapping"],
            "properties": {
                "artifact_sha256": cas,
                "file_ref": opaque_ref,
                "profile_rev": {"type":"integer","minimum":0},
                "mode": {"type":"string","enum":["standard","nonplanar"]},
                "material_mapping": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_MATERIAL_SLOTS,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["slot_index", "material_ref"],
                        "properties": {
                            "slot_index": {"type":"integer","minimum":0,"maximum":MAX_MATERIAL_SLOTS - 1},
                            "material_ref": opaque_ref,
                        },
                    },
                },
            },
        }),
        "job.start" => serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["queued_intent_id", "printer_id", "project_revision", "artifact_sha256", "artifact_compatibility"],
            "properties": {
                "queued_intent_id": opaque_ref,
                "printer_id": opaque_ref,
                "project_revision": {"type":"integer","minimum":0},
                "artifact_sha256": cas,
                "artifact_compatibility": {"type":"string","enum":["ready","preview_only"]},
            },
        }),
        "job.stop" => serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["printer_id", "job_id"],
            "properties": {
                "printer_id": opaque_ref,
                "job_id": opaque_ref,
            },
        }),
        _ => serde_json::json!({ "type": "object" }),
    }
}

/// Input JSON schema for a known operation (documentation-grade; the
/// authoritative check stays the typed closed parser).
fn input_schema(id: &str) -> Option<serde_json::Value> {
    match class(id) {
        Some((_, HandlerRef::DispatchDeviceControl)) => Some(device_control_schema(id)),
        Some((_, HandlerRef::DispatchJob)) => Some(job_schema(id)),
        None => None,
    }
}

/// Pure availability decision — backend-owned state only, never caller JSON.
/// Gate order: revoked → writer/resolver wiring → session → trusted snapshot.
fn availability(
    id: &str,
    handler: HandlerRef,
    state: &BackendCapabilityState,
) -> (bool, &'static str) {
    if state.revoked(id) {
        return (false, REASON_REVOKED);
    }
    let wired = match handler {
        HandlerRef::DispatchDeviceControl => state.device_control_wired,
        HandlerRef::DispatchJob => state.job_transport_wired,
    };
    if !wired {
        return (false, REASON_BACKEND_NOT_WIRED);
    }
    if !state.authenticated_session {
        return (false, REASON_NO_SESSION);
    }
    if handler == HandlerRef::DispatchJob
        && matches!(id, "job.start" | "job.stop")
        && !state.snapshot_resolver_wired
    {
        return (false, REASON_NO_TRUSTED_SNAPSHOT);
    }
    (true, "")
}

/// Full catalog of every known writer operation, availability evaluated
/// against `state`. Order: device-control (registry order), upload, then the
/// print-job actions. Bounded by construction (13 entries; schemas are
/// closed constant JSON rebuilt from the dispatch windows).
pub fn operations(state: &BackendCapabilityState) -> Vec<OperationEntry> {
    let mut ids: Vec<&str> = DEVICE_CONTROL_ACTIONS.to_vec();
    ids.extend(UPLOAD_ACTIONS);
    ids.extend(PRINT_JOB_ACTIONS);
    ids.iter().filter_map(|id| operation(id, state)).collect()
}

/// One operation entry, or `None` for any unknown id (no fallback, no
/// widening — an unknown id is exactly as unknown to the catalog as it is to
/// [`required_scope`]).
pub fn operation(id: &str, state: &BackendCapabilityState) -> Option<OperationEntry> {
    let scope = required_scope(id)?;
    let (effect, handler) = class(id)?;
    let (available, availability_reason) = availability(id, handler, state);
    Some(OperationEntry {
        id: id.to_owned(),
        schema_version: OPERATION_SCHEMA_VERSION,
        effect,
        required_scope: scope.name().to_owned(),
        approval_policy: ApprovalPolicy::OneUseApproval,
        handler,
        input_schema: input_schema(id)?,
        available,
        availability_reason: availability_reason.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_maps_every_class_without_overlap() {
        // Each known action maps to exactly its class.
        for name in DEVICE_CONTROL_ACTIONS {
            assert_eq!(required_scope(name), Some(Scope::DeviceControl), "{name}");
        }
        for name in UPLOAD_ACTIONS {
            assert_eq!(required_scope(name), Some(Scope::DeviceUpload), "{name}");
        }
        for name in PRINT_JOB_ACTIONS {
            assert_eq!(required_scope(name), Some(Scope::PrintJob), "{name}");
        }
        // No action belongs to two classes.
        for a in DEVICE_CONTROL_ACTIONS
            .iter()
            .chain(UPLOAD_ACTIONS.iter())
            .chain(PRINT_JOB_ACTIONS.iter())
        {
            let matches: usize = usize::from(DEVICE_CONTROL_ACTIONS.contains(a))
                + usize::from(UPLOAD_ACTIONS.contains(a))
                + usize::from(PRINT_JOB_ACTIONS.contains(a));
            assert_eq!(matches, 1, "action {a} must belong to exactly one class");
        }
    }

    #[test]
    fn unknown_action_has_no_scope() {
        for bad in [
            "device.command",
            "job",
            "job.anything",
            "uploader",
            "rename",
            "",
        ] {
            assert_eq!(required_scope(bad), None, "must refuse {bad:?}");
            assert!(!is_writer_action(bad), "must refuse {bad:?}");
        }
    }

    fn state_of(
        authenticated_session: bool,
        device_control_wired: bool,
        job_transport_wired: bool,
        snapshot_resolver_wired: bool,
        revoked: &[&str],
    ) -> BackendCapabilityState {
        BackendCapabilityState {
            authenticated_session,
            device_control_wired,
            job_transport_wired,
            snapshot_resolver_wired,
            revoked_actions: revoked.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn catalog_lists_all_13_known_writers_with_registry_scope() {
        let state = BackendCapabilityState::default();
        let catalog = operations(&state);
        assert_eq!(catalog.len(), 13, "all known writers must be listed");
        assert_eq!(DEVICE_CONTROL_ACTIONS.len(), 9);
        assert_eq!(UPLOAD_ACTIONS.len(), 1);
        assert_eq!(PRINT_JOB_ACTIONS.len(), 3);
        for entry in &catalog {
            assert_eq!(
                entry.schema_version, OPERATION_SCHEMA_VERSION,
                "{}",
                entry.id
            );
            // The catalog scope is the registry scope — one owner, no drift.
            assert_eq!(
                entry.required_scope,
                required_scope(&entry.id).expect("known id").name(),
                "{}",
                entry.id
            );
            assert_eq!(
                entry.approval_policy,
                ApprovalPolicy::OneUseApproval,
                "{}",
                entry.id
            );
            // Every writer entry has a closed input schema.
            assert_eq!(
                entry.input_schema.get("type").and_then(|t| t.as_str()),
                Some("object"),
                "{}",
                entry.id
            );
            assert_eq!(
                entry
                    .input_schema
                    .get("additionalProperties")
                    .and_then(|v| v.as_bool()),
                Some(false),
                "{} — schema must deny unknown fields like the typed parsers",
                entry.id
            );
        }
        // Class → scope/effect/handler agreement.
        for entry in &catalog {
            if DEVICE_CONTROL_ACTIONS.contains(&entry.id.as_str()) {
                assert_eq!(entry.required_scope, "device_control", "{}", entry.id);
                assert_eq!(
                    entry.handler,
                    HandlerRef::DispatchDeviceControl,
                    "{}",
                    entry.id
                );
            } else if entry.id == "upload" {
                assert_eq!(entry.required_scope, "device_upload", "{}", entry.id);
                assert_eq!(entry.handler, HandlerRef::DispatchJob, "{}", entry.id);
                assert_eq!(entry.effect, OperationEffect::Upload, "{}", entry.id);
            } else {
                assert_eq!(entry.required_scope, "print_job", "{}", entry.id);
                assert_eq!(entry.handler, HandlerRef::DispatchJob, "{}", entry.id);
                assert_eq!(entry.effect, OperationEffect::Job, "{}", entry.id);
            }
        }
    }

    #[test]
    fn default_backend_state_reports_every_writer_unavailable() {
        let state = BackendCapabilityState::default();
        let catalog = operations(&state);
        assert_eq!(catalog.len(), 13);
        for entry in &catalog {
            assert!(
                !entry.available,
                "{} must be unavailable by default",
                entry.id
            );
            // Precise, stable reason: the default backend wires NO transport,
            // so the FIRST failing gate is the wiring gate.
            assert_eq!(
                entry.availability_reason, REASON_BACKEND_NOT_WIRED,
                "{}",
                entry.id
            );
        }
    }

    #[test]
    fn wired_session_makes_device_control_available_but_jobs_need_more() {
        // Full backend except the trusted snapshot resolver: device control
        // available; upload/queue available; start/stop pinned unavailable.
        let state = state_of(true, true, true, false, &[]);
        for id in DEVICE_CONTROL_ACTIONS {
            let e = operation(id, &state).unwrap();
            assert!(e.available, "{id}");
            assert_eq!(e.availability_reason, "", "{id}");
        }
        for id in ["upload", "job.queue"] {
            let e = operation(id, &state).unwrap();
            assert!(e.available, "{id}");
        }
        for id in ["job.start", "job.stop"] {
            let e = operation(id, &state).unwrap();
            assert!(!e.available, "{id} requires a trusted snapshot resolver");
            assert_eq!(e.availability_reason, REASON_NO_TRUSTED_SNAPSHOT, "{id}");
        }
        // Missing session → every writer reports no-session (behind wiring).
        let no_session = state_of(false, true, true, true, &[]);
        for entry in operations(&no_session) {
            assert_eq!(entry.availability_reason, REASON_NO_SESSION, "{}", entry.id);
        }
        // No wiring at all → backend-not-wired (the default backend).
        let unwired = state_of(true, false, false, false, &[]);
        for entry in operations(&unwired) {
            assert_eq!(
                entry.availability_reason, REASON_BACKEND_NOT_WIRED,
                "{}",
                entry.id
            );
        }
    }

    #[test]
    fn revoked_action_reports_revoked_before_any_other_gate() {
        // Revocation beats wiring: even a fully-wired backend reports the
        // revoked writer unavailable with the stable "revoked" reason.
        let state = state_of(true, true, true, true, &["nozzle", "job.start"]);
        let nozzle = operation("nozzle", &state).unwrap();
        assert!(!nozzle.available);
        assert_eq!(nozzle.availability_reason, REASON_REVOKED);
        let start = operation("job.start", &state).unwrap();
        assert!(!start.available);
        assert_eq!(start.availability_reason, REASON_REVOKED);
        // Sibling actions are NOT dragged down by the revocation list.
        let bed = operation("bed", &state).unwrap();
        assert!(bed.available, "a sibling action must stay available");
        let queue = operation("job.queue", &state).unwrap();
        assert!(queue.available, "a sibling job action must stay available");
    }

    #[test]
    fn unknown_id_has_no_catalog_entry() {
        let state = BackendCapabilityState::default();
        for bad in [
            "device.command",
            "job",
            "job.anything",
            "uploader",
            "rename",
            "",
        ] {
            assert!(operation(bad, &state).is_none(), "must refuse {bad:?}");
        }
    }

    #[test]
    fn catalog_schemas_track_the_dispatch_windows() {
        // The input schemas are rebuilt from the SAME constants the typed
        // parsers enforce — a displacement here is a real drift signal.
        let state = BackendCapabilityState::default();
        let window = |id: &str, path: &str| {
            operation(id, &state)
                .expect("known id")
                .input_schema
                .pointer(path)
                .cloned()
        };
        let max = |v: Option<serde_json::Value>| v.and_then(|v| v.as_f64());
        assert_eq!(
            max(window("nozzle", "/properties/nozzle/maximum")),
            Some(NOZZLE_MAX_C),
            "nozzle must track NOZZLE_MAX_C"
        );
        assert_eq!(
            max(window("bed", "/properties/bed/maximum")),
            Some(BED_MAX_C),
            "bed must track BED_MAX_C"
        );
        assert_eq!(
            max(window("part_fan", "/properties/speed_pct/maximum")),
            Some(FAN_MAX_PCT),
            "part_fan must track FAN_MAX_PCT"
        );
        assert_eq!(
            max(window("speed", "/properties/print_speed_mode/enum/2")),
            Some(3.0),
            "speed must expose the wire enum 1|2|3"
        );
        assert_eq!(
            max(window("light_brightness", "/properties/brightness/maximum")),
            Some(f64::from(BRIGHTNESS_MAX_PCT)),
            "brightness must track BRIGHTNESS_MAX_PCT"
        );
        assert_eq!(
            max(window("ace_dry", "/properties/box_id/maximum")),
            Some(f64::from(ACE_BOX_MAX)),
            "ace_dry box_id must track ACE_BOX_MAX"
        );
        assert_eq!(
            max(window("ace_dry", "/properties/target_temp/maximum")),
            Some(f64::from(DRYER_TARGET_MAX_C)),
            "ace_dry target_temp must track DRYER_TARGET_MAX_C"
        );
        assert_eq!(
            max(window("ace_dry", "/properties/duration_min/maximum")),
            Some(f64::from(DRYER_DURATION_MAX_MIN)),
            "ace_dry duration_min must track DRYER_DURATION_MAX_MIN"
        );
        assert_eq!(
            max(window("ace_bind_slot", "/properties/slot_index/maximum")),
            Some(f64::from(ACE_SLOT_MAX)),
            "ace_bind_slot slot_index must track ACE_SLOT_MAX"
        );
        assert_eq!(
            max(window("upload", "/properties/exact_size_bytes/maximum")),
            Some(MAX_UPLOAD_BYTES as f64),
            "upload must track MAX_UPLOAD_BYTES"
        );
        assert_eq!(
            max(window("job.queue", "/properties/material_mapping/maxItems")),
            Some(MAX_MATERIAL_SLOTS as f64),
            "job.queue must track MAX_MATERIAL_SLOTS"
        );
        // Identifier bound on every ref-bearing schema.
        for id in [
            "ace_bind_slot",
            "upload",
            "job.queue",
            "job.start",
            "job.stop",
        ] {
            let schema = operation(id, &state).expect("known id").input_schema;
            let text = schema.to_string();
            assert!(
                text.contains(&format!("\"maxLength\":{MAX_IDENTIFIER_LEN}")),
                "{id} must expose MAX_IDENTIFIER_LEN ({text})"
            );
        }
    }

    #[test]
    fn catalog_wire_never_leaks_secrets_or_local_paths() {
        let catalog = serde_json::to_string(&operations(&BackendCapabilityState::default()))
            .expect("catalog serializes");
        for forbidden in [
            "://",
            "api_key",
            "Bearer",
            "access_token",
            "token",
            "AppData",
            "Users",
            r"\Users",
        ] {
            assert!(
                !catalog.contains(forbidden),
                "catalog must not leak {forbidden:?} (output is documentation-grade)"
            );
        }
    }
}
