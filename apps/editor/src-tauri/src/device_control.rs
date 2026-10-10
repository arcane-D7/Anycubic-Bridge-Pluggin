//! S9.18-003 continuation slice — typed Tauri approval bridge (device control).
//!
//! Backend-managed compound authority ([`DeviceAuthorityState`]):
//! - `auth` — the session repository (`auth.db`, a **separate** file from the
//!   workspace DB, per the tenant boundary). An empty store means approvals
//!   are unavailable; this build has no login endpoint, so identity can never
//!   be invented (no auto-default user).
//! - `workspace` — a single-writer `DbHandle` over the SAME `workspace.db`
//!   the project store owns; broker migrations host the `approvals` table
//!   (never `auth.db`, avoiding cross-handle lock deadlocks).
//! - `resolver` — the ONLY trusted source of "current device / project"
//!   context. Production default: [`UnavailableDeviceResolver`] (`None`), so
//!   the editor cannot claim physical control. Tests inject a stub.
//! - `transport` — the dispatch seam. Production default:
//!   [`UnavailableTransport`] (never burns an approval).
//!
//! Command surface (all share the closed action set from
//! `broker::dispatch::DeviceControlAction` — no arbitrary MCP/raw commands):
//! - [`device_control_availability`] — public-safe bootstrap: booleans +
//!   fixed reasons only; NEVER a user id or a session bearer.
//! - [`device_control_preflight`] — typed normalized-effect draft; a present
//!   resolver + a fresh snapshot is required, otherwise typed `unavailable`
//!   (never simulated).
//! - [`device_control_approve`] — protected: requires a REAL session resolved
//!   through the backend `AuthDb` AND a trusted resolver context. A
//!   caller-supplied principal or `confirm:true` is rejected by the type
//!   (request structs deny unknown fields). Never echoes session secrets.
//! - [`device_control_dispatch`] — protected seam that consumes the issued
//!   approval exactly once and dispatches exactly once through the gate.
//!
//! The session repository (`auth.db`) is intentionally NOT held in managed
//! state: `auth_service::AuthDb` owns a boxed `!Send` clock, and per-call
//! open gives the live re-verification the security model requires. The
//! workspace handle is the only long-lived lock (single-writer) and `auth.db`
//! is a separate file/handle — no cross-handle lock order exists.

use std::fmt;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use auth_service::{AuthDb, Principal};
use broker::approval::{ApprovalAuthority, ApprovalError, ScopedIssueRequest, MAX_IDENTIFIER_LEN};
use broker::db::DbHandle;
use broker::dispatch::{
    ControlTransport, DeviceControlAction, DeviceControlRequest, DevicePayload, DispatchError,
    DispatchGate, RequestContext, UnavailableTransport, MAX_PAYLOAD_BYTES,
};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Upper bound for a trusted device context to remain current (ms).
pub const MAX_CONTEXT_AGE_MS: i64 = 60_000;

/// Opaque, trusted description of the device the backend currently knows
/// about. Produced ONLY by a [`DeviceResolver`] — never parsed from a
/// caller's JSON, and never exposed by [`device_control_availability`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceContext {
    /// Opaque device id known to the trusted resolver.
    pub device_id: String,
    /// Opaque project/workspace id owned by this session.
    pub project_id: String,
    /// Exact moment (epoch ms) the snapshot the context describes was captured.
    pub snapshot_captured_at_ms: i64,
    /// Authoritative current project revision as observed by the trusted
    /// resolver. Approve and dispatch ALWAYS bind this value: a caller may
    /// furnish a claim only when it EQUALS the trusted value (a furnished
    /// difference is refused before issue/consume); a claim can never clear
    /// or replace the binding — the stored binding is always this value.
    pub revision: Option<u64>,
    /// Authoritative current artifact reference (resolver-observed).
    pub artifact: Option<String>,
    /// Authoritative current material binding (resolver-observed).
    pub material: Option<String>,
    /// Device capabilities observed by the trusted backend at snapshot time.
    /// `None` means the backend declares NO capability descriptor (writer
    /// routes are typed unavailable — no issue row). A `Some` list declares
    /// exactly which closed actions the device can honor today; an action
    /// outside the list is refused before issue/consume.
    pub capabilities: Option<Vec<DeviceControlAction>>,
}

impl DeviceContext {
    /// A context older than [`MAX_CONTEXT_AGE_MS`] (or with an invalid/zero
    /// capture time) can never authorize a control — the gate is checked
    /// BEFORE issue and BEFORE consume.
    pub fn is_current(&self, now_ms: i64) -> bool {
        self.snapshot_captured_at_ms > 0
            && now_ms >= self.snapshot_captured_at_ms
            && now_ms - self.snapshot_captured_at_ms <= MAX_CONTEXT_AGE_MS
    }
}

/// Trusted backend boundary that answers "what device do we represent?".
///
/// This is the ONLY source of device identity the approval path trusts — a
/// caller-supplied project/current-device claim is never accepted as the
/// context (it may inform a draft, never authorize).
pub trait DeviceResolver: Send + Sync {
    /// The current trusted device context, or `None` when the backend cannot
    /// claim any physical device. `None` ⇒ every protected route is typed
    /// Unavailable BEFORE issue/consume.
    fn current_device(&self) -> Option<DeviceContext>;
}

/// Production default resolver: the backend owns no device. All protected
/// routes therefore return typed `unavailable` — no claim of physical control.
pub struct UnavailableDeviceResolver;

impl DeviceResolver for UnavailableDeviceResolver {
    fn current_device(&self) -> Option<DeviceContext> {
        None
    }
}

/// Compound backend-managed authority, managed as Tauri state.
///
/// The session repository is deliberately ABSENT here: `AuthDb` owns a boxed
/// `!Send` clock, and a per-call open of `auth.db` (see [`open_auth_store`])
/// re-verifies the session at every request — an unauthenticated or revoked
/// session can never ride on a stale in-memory handle. Production holds an
/// EMPTY `auth.db`, so identity is never invented.
pub struct DeviceAuthorityState {
    /// Single-writer handle to the SAME `workspace.db` the project store
    /// owns (broker migrations host the `approvals` table).
    workspace: Mutex<Result<DbHandle, String>>,
    /// Trusted device-context resolver. Production: [`UnavailableDeviceResolver`].
    resolver: Box<dyn DeviceResolver + Send + Sync>,
    /// One-shot dispatch seam. Production: [`UnavailableTransport`].
    transport: Box<dyn ControlTransport + Send + Sync>,
}

impl DeviceAuthorityState {
    /// Production boot. The editor cannot invent a user: `auth.db` may exist
    /// and be empty (login-required), and the resolver/transport are absent,
    /// so every writer route is typed-Unavailable before any issue/consume.
    pub fn open() -> Self {
        let workspace = match workspace_db_path() {
            Ok(path) => DbHandle::open(path).map_err(|error| error.to_string()),
            Err(error) => Err(error),
        };
        Self::with_parts(
            workspace,
            Box::new(UnavailableDeviceResolver),
            Box::new(UnavailableTransport),
        )
    }

    fn with_parts(
        workspace: Result<DbHandle, String>,
        resolver: Box<dyn DeviceResolver + Send + Sync>,
        transport: Box<dyn ControlTransport + Send + Sync>,
    ) -> Self {
        Self {
            workspace: Mutex::new(workspace),
            resolver,
            transport,
        }
    }

    /// Trusted resolver gate — the same `None`-check guards approve and
    /// dispatch so a missing backend is refused before any issue/consume.
    fn resolve_context(&self, now_ms: i64) -> Result<DeviceContext, ControlError> {
        match self.resolver.current_device() {
            None => Err(ControlError::unavailable("resolver-unavailable")),
            Some(ctx) if !ctx.is_current(now_ms) => {
                Err(ControlError::unavailable("stale-snapshot"))
            }
            Some(ctx) => Ok(ctx),
        }
    }

    fn lock_workspace(&self) -> Result<MutexGuard<'_, Result<DbHandle, String>>, ControlError> {
        self.workspace
            .lock()
            .map_err(|_| ControlError::db("workspace-db-lock"))
    }
}

/// Auth DB path — single owner is `auth_service::config` (the same resolver
/// the auth-service CLI uses): `ANYCUBIC_AUTH_DB` > legacy `AUTH_DB` >
/// platform app-data default (Windows `%APPDATA%\AnycubicBridge\auth.db`,
/// deliberately a *different file* than `workspace.db` — session tenant ≠
/// workspace data, one-store separation). Never reads/moves/copies an
/// existing user DB; never hardcodes a machine path. The directory is created
/// only at open time (see `open_auth_store_at`), never during resolution.
fn auth_db_path() -> Result<PathBuf, String> {
    auth_service::config::default_auth_db_path().map_err(|error| error.to_string())
}

/// Open the backend session repository from its env-resolved path. Each call
/// re-opens + migrates a small store (same pattern as the existing
/// per-command `DbHandle::open(workspace_db_path()?)`) and re-verifies the
/// session live — never a stale handle.
///
/// Writer authority: the resolved auth path is refused if it aliases the
/// workspace DB (`workspace.db`) — DB separation is enforced before any open
/// so a misconfiguration can never point both stores at the same file.
fn open_auth_store() -> Result<AuthDb, ControlError> {
    let auth_path = auth_db_path().map_err(|error| ControlError::db(&error))?;
    let workspace_path = workspace_db_path().map_err(|error| ControlError::db(&error))?;
    open_auth_store_at(&auth_path, &workspace_path)
}

/// Injectable core of [`open_auth_store`]: distinctness gate (typed refusal on
/// alias), then parent-dir bootstrap + `AuthDb::open`. Resolving or opening
/// never truncates/moves an existing DB — `AuthDb::open` only migrates in
/// place, so user/session rows survive re-opens.
fn open_auth_store_at(auth_path: &std::path::Path, workspace_path: &std::path::Path) -> Result<AuthDb, ControlError> {
    auth_service::config::ensure_distinct_from(
        auth_path,
        workspace_path,
        auth_service::config::current_platform(),
    )
    .map_err(|error| ControlError::db(&error.to_string()))?;
    if let Some(parent) = auth_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| ControlError::db(&error.to_string()))?;
    }
    AuthDb::open(auth_path).map_err(|error| ControlError::db(&error.to_string()))
}

fn workspace_db_path() -> Result<PathBuf, String> {
    crate::workspace_data_dir().map(|dir| dir.join("workspace.db"))
}

/// Closed validation shared by preflight/approve/dispatch: the action name
/// must be in the broker's action registry (same enum the dispatcher
/// allowlists) and the target must be a bounded, whitespace-free identifier.
fn validate_action_and_target(
    action_name: &str,
    target: &str,
) -> Result<DeviceControlAction, ControlError> {
    let Some(action) = DeviceControlAction::from_name(action_name) else {
        return Err(ControlError::invalid("unknown-action"));
    };
    if target.is_empty()
        || target.len() > MAX_IDENTIFIER_LEN
        || target.chars().any(char::is_whitespace)
    {
        return Err(ControlError::invalid("invalid-target"));
    }
    Ok(action)
}

/// Authority rule for one trusted binding field. A caller may furnish a claim
/// only when it EQUALS the trusted value; any furnished difference is refused
/// BEFORE issue/consume. The returned value is ALWAYS the trusted side — a
/// claim can never clear or replace a binding.
fn ctx_binding_u64(
    trusted: Option<u64>,
    claimed: Option<u64>,
    reason: &'static str,
) -> Result<Option<u64>, ControlError> {
    match (trusted, claimed) {
        (Some(t), Some(c)) if c != t => Err(ControlError::invalid(reason)),
        _ => Ok(trusted),
    }
}

fn ctx_binding_str<'a>(
    trusted: Option<&'a str>,
    claimed: Option<&str>,
    reason: &'static str,
) -> Result<Option<&'a str>, ControlError> {
    match (trusted, claimed) {
        (Some(t), Some(c)) if c != t => Err(ControlError::invalid(reason)),
        _ => Ok(trusted),
    }
}

fn validate_payload(
    action: DeviceControlAction,
    payload: &serde_json::Value,
) -> Result<(), ControlError> {
    let size = serde_json::to_vec(payload).unwrap_or_default().len();
    if size > MAX_PAYLOAD_BYTES {
        return Err(ControlError::invalid("invalid-payload"));
    }
    // Strict closed typed validation (shape + numeric windows) — the same
    // parser the dispatch gate runs at consume time.
    DevicePayload::parse(action, payload).map_err(|_| ControlError::invalid("invalid-payload"))?;
    Ok(())
}

/// Capability gate shared by preflight/approve/dispatch. The DEVICE's trusted
/// capability set decides whether `action` may run today — never a caller
/// claim. `None` caps ⇒ the backend declares no capability descriptor (typed
/// unavailable, no issue row); `Some(list)` without the action ⇒ the device
/// honors other actions but not this one (typed unavailable before issue).
fn check_capability(
    ctx: &DeviceContext,
    action: DeviceControlAction,
) -> Result<(), ControlError> {
    match ctx.capabilities.as_deref() {
        None => Err(ControlError::unavailable("capability-unavailable")),
        Some(list) if !list.contains(&action) => {
            Err(ControlError::unavailable("action-not-enabled"))
        }
        Some(_) => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Availability (public-safe bootstrap)
// ---------------------------------------------------------------------------

/// Session layer: booleans + fixed reasons only. NEVER a user id, display
/// name, or session bearer. `established` is ONLY true when a trusted
/// backend current-session source has verified a live session — it is NEVER
/// inferred from `db.users()`: identity configured ≠ session authenticated.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceSessionState {
    /// True only with a verified backend session. This build has no login
    /// endpoint and no trusted current-session provider, so this is always
    /// false — an empty store stays empty (no auto-default identity), and a
    /// store that merely contains user rows is not an authenticated session.
    pub established: bool,
    /// Fixed reason when `established` is false
    /// (`auth-unconfigured` | `auth-unavailable` | `login-required` |
    /// `session-unverified`).
    pub reason: Option<String>,
}

/// Capability layer: is a trusted device resolver defined AND announcing a
/// capability set? S9.18-003: a resolver that returns `None` capabilities
/// declares no descriptor — the writer stays typed unavailable (no issue
/// row), matching the preflight/approve gate.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceCapabilityState {
    pub defined: bool,
    /// Fixed reason when `defined` is false
    /// (`resolver-unavailable` | `capability-unavailable`).
    pub reason: Option<String>,
}

/// Writer layer: would approve+dispatch actually run today?
#[derive(Debug, Clone, Serialize)]
pub struct DeviceWriterState {
    pub available: bool,
    /// Fixed reason when `available` is false.
    pub reason: Option<String>,
}

/// Public-safe availability bootstrap. Read telemetry (cloud/demo snapshots)
/// is deliberately NOT part of this reply — a read surface never grants a
/// writer channel; the frontend composes it separately.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceAvailabilityReply {
    pub session: DeviceSessionState,
    pub capability: DeviceCapabilityState,
    pub writer: DeviceWriterState,
}

fn session_state(db: &AuthDb) -> DeviceSessionState {
    match db.users() {
        Err(_) => DeviceSessionState {
            established: false,
            reason: Some("auth-unavailable".to_owned()),
        },
        Ok(users) => DeviceSessionState {
            // Public availability carries NO session argument and this build
            // has no trusted current-session provider, so `established` is
            // never set here — a non-empty users table is configuration, not
            // authentication. The writer layer must never enable on it.
            established: false,
            reason: Some(if users.is_empty() {
                "login-required".to_owned()
            } else {
                "session-unverified".to_owned()
            }),
        },
    }
}

/// Core (testable without Tauri). `auth == None` opens the production
/// repository on demand; tests inject an in-memory store.
pub fn availability(
    state: &DeviceAuthorityState,
    auth: Option<&AuthDb>,
) -> DeviceAvailabilityReply {
    let now = now_ms();
    let session = match auth {
        Some(db) => session_state(db),
        None => match open_auth_store() {
            Ok(db) => session_state(&db),
            Err(_) => DeviceSessionState {
                established: false,
                reason: Some("auth-unconfigured".to_owned()),
            },
        },
    };
    let capability = match state.resolve_context(now) {
        Ok(ctx) => match ctx.capabilities.as_deref() {
            Some(list) if !list.is_empty() => DeviceCapabilityState {
                defined: true,
                reason: None,
            },
            _ => DeviceCapabilityState {
                defined: false,
                reason: Some("capability-unavailable".to_owned()),
            },
        },
        Err(err) => DeviceCapabilityState {
            defined: false,
            reason: Some(err.reason.clone()),
        },
    };
    let writer = if !session.established {
        DeviceWriterState {
            available: false,
            reason: Some("session-unestablished".to_owned()),
        }
    } else if !capability.defined {
        DeviceWriterState {
            available: false,
            reason: capability.reason.clone(),
        }
    } else if !state.transport.available() {
        DeviceWriterState {
            available: false,
            reason: Some("transport-unavailable".to_owned()),
        }
    } else {
        DeviceWriterState {
            available: true,
            reason: None,
        }
    };
    DeviceAvailabilityReply {
        session,
        capability,
        writer,
    }
}

#[tauri::command]
pub fn device_control_availability(
    state: State<'_, DeviceAuthorityState>,
) -> DeviceAvailabilityReply {
    availability(state.inner(), None)
}

// ---------------------------------------------------------------------------
// Preflight (typed normalized-effect draft — never executes)
// ---------------------------------------------------------------------------

/// Draft request. The action/target/payload are validated against the closed
/// broker set; the effect *context* (current device/project) always comes
/// from the trusted resolver, never from this JSON.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceControlPreflightRequest {
    pub action: String,
    pub target: String,
    pub payload: serde_json::Value,
    /// Optional effect draft context from the UI — informational only; the
    /// resolver is the authority for device/project identity.
    #[serde(default)]
    pub claimed_project_id: Option<String>,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub artifact: Option<String>,
    #[serde(default)]
    pub material: Option<String>,
}

/// Typed normalization of the would-be effect. Produced only when the trusted
/// resolver is present AND its snapshot is current — never simulated.
#[derive(Debug, Clone, Serialize)]
pub struct NormalizedEffect {
    /// Closed-set action id (same enum the dispatcher allowlists).
    pub action: String,
    /// Human label of the effect.
    pub summary: String,
    /// Trusted device id (resolver-provided, not caller JSON).
    pub device: String,
    /// Trusted project id (resolver-provided).
    pub project: String,
    /// Strictly-validated projection of the args the transport would receive.
    pub args: serde_json::Value,
    pub snapshot_captured_at_ms: i64,
}

/// Informational draft context echoed from the UI request — NEVER the
/// identity authority. The resolver alone determines `device`/`project`;
/// these fields only let the UI show what it *claimed* versus what the
/// trusted backend resolved.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceDraftContext {
    pub claimed_project_id: Option<String>,
    pub revision: Option<u64>,
    pub artifact: Option<String>,
    pub material: Option<String>,
}

fn draft_context(req: &DeviceControlPreflightRequest) -> DeviceDraftContext {
    DeviceDraftContext {
        claimed_project_id: req.claimed_project_id.clone(),
        revision: req.revision,
        artifact: req.artifact.clone(),
        material: req.material.clone(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceControlPreflightReply {
    /// `ready` | `invalid` | `unavailable`.
    pub status: String,
    pub action: Option<String>,
    pub target: Option<String>,
    pub effect: Option<NormalizedEffect>,
    /// Fixed reason when `status != "ready"`.
    pub reason: Option<String>,
    /// Echo of the UI's claimed draft context (non-authoritative).
    pub draft: Option<DeviceDraftContext>,
}

fn effect_summary(action: DeviceControlAction) -> &'static str {
    match action {
        DeviceControlAction::Nozzle => "set nozzle temperature",
        DeviceControlAction::Bed => "set bed temperature",
        DeviceControlAction::PartFan => "set part fan speed",
        DeviceControlAction::Speed => "set print speed",
        DeviceControlAction::LightSetEnabled => "set chamber light",
        DeviceControlAction::LightBrightness => "set light brightness",
        DeviceControlAction::AceDry => "dry filament",
        DeviceControlAction::AceAutoFeed => "auto-feed filament",
        DeviceControlAction::AceBindSlot => "bind material slot",
    }
}

/// Core (state-only, testable without Tauri). Never executes: this is a
/// draft; the deny-by-default execution path is approve+dispatch.
pub fn preflight(
    state: &DeviceAuthorityState,
    req: &DeviceControlPreflightRequest,
) -> DeviceControlPreflightReply {
    let draft = draft_context(req);
    let action = match validate_action_and_target(&req.action, &req.target) {
        Ok(action) => action,
        Err(error) => {
            return DeviceControlPreflightReply {
                status: "invalid".to_owned(),
                action: None,
                target: None,
                effect: None,
                reason: Some(error.reason),
                draft: Some(draft),
            }
        }
    };
    if let Err(error) = validate_payload(action, &req.payload) {
        return DeviceControlPreflightReply {
            status: "invalid".to_owned(),
            action: Some(action.name().to_owned()),
            target: Some(req.target.clone()),
            effect: None,
            reason: Some(error.reason),
            draft: Some(draft),
        };
    }
    let now = now_ms();
    let ctx = match state.resolve_context(now) {
        Ok(ctx) => ctx,
        Err(error) => {
            return DeviceControlPreflightReply {
                status: "unavailable".to_owned(),
                action: Some(action.name().to_owned()),
                target: Some(req.target.clone()),
                effect: None,
                reason: Some(error.reason),
                draft: Some(draft),
            }
        }
    };
    // The trusted capability descriptor gates the draft: an action the device
    // does not currently honor is typed unavailable here (matching
    // approve/dispatch) — no issue row can ever be minted for it.
    if let Err(error) = check_capability(&ctx, action) {
        return DeviceControlPreflightReply {
            status: "unavailable".to_owned(),
            action: Some(action.name().to_owned()),
            target: Some(req.target.clone()),
            effect: None,
            reason: Some(error.reason),
            draft: Some(draft),
        };
    }
    // A furnished project claim that differs from the trusted context is
    // refused at the draft stage (the claim remains informational — the
    // resolver is the authority), so a UI cannot draft against a project it
    // does not actually represent.
    if let Some(claimed_project) = req.claimed_project_id.as_deref() {
        if claimed_project != ctx.project_id {
            return DeviceControlPreflightReply {
                status: "invalid".to_owned(),
                action: Some(action.name().to_owned()),
                target: Some(req.target.clone()),
                effect: None,
                reason: Some("project-mismatch".to_owned()),
                draft: Some(draft),
            };
        }
    }
    // Only now is an effect described — from the resolver context and the
    // strict typed projection, never from caller JSON.
    let parsed = DevicePayload::parse(action, &req.payload)
        .expect("payload validated above can only fail if parser semantics diverge");
    DeviceControlPreflightReply {
        status: "ready".to_owned(),
        action: Some(action.name().to_owned()),
        target: Some(ctx.device_id.clone()),
        effect: Some(NormalizedEffect {
            action: action.name().to_owned(),
            summary: effect_summary(action).to_owned(),
            device: ctx.device_id,
            project: ctx.project_id,
            args: parsed.to_value(),
            snapshot_captured_at_ms: ctx.snapshot_captured_at_ms,
        }),
        reason: None,
        draft: Some(draft),
    }
}

#[tauri::command]
pub fn device_control_preflight(
    state: State<'_, DeviceAuthorityState>,
    request: DeviceControlPreflightRequest,
) -> DeviceControlPreflightReply {
    preflight(state.inner(), &request)
}

// ---------------------------------------------------------------------------
// Approve (protected — requires a real backend session + trusted context)
// ---------------------------------------------------------------------------

/// Protected approve request. There is deliberately NO `principal`,
/// `user_id`, `confirm`, or `transport` field — `deny_unknown_fields` rejects
/// a caller that tries to assert identity. A raw session token travels as a
/// separate command argument (memory-only, never echoed).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceControlApproveRequest {
    pub action: String,
    pub target: String,
    /// Human-readable effect the approval UI/session binds.
    pub purpose: String,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub artifact: Option<String>,
    #[serde(default)]
    pub material: Option<String>,
    /// 0 selects the broker default TTL.
    #[serde(default)]
    pub ttl_ms: u64,
}

/// One-use issuance receipt. `token` is the ONLY secret on this struct and is
/// never persisted (only its SHA-256 hash is); production never reaches this
/// reply (resolver absent ⇒ typed Unavailable before issue).
#[derive(Debug, Clone, Serialize)]
pub struct DeviceControlApproveReply {
    pub status: String,
    /// One-use raw token (consumable exactly once; memory-only).
    pub token: String,
    pub token_hash: String,
    pub payload_digest: String,
    pub expires_ms: i64,
    pub action: String,
    pub target: String,
}

/// Core (state-only, testable without Tauri). `session_token` is handled
/// memory-only: it is resolved against the backend `AuthDb` and never appears
/// in any reply.
pub fn approve(
    state: &DeviceAuthorityState,
    auth: &AuthDb,
    session_token: &str,
    req: &DeviceControlApproveRequest,
) -> Result<DeviceControlApproveReply, ControlError> {
    // 1. Trusted device context required BEFORE issue — target must equal the
    //    device the backend currently represents (a local claim is ignored).
    let ctx = state.resolve_context(now_ms())?;
    if req.target != ctx.device_id {
        return Err(ControlError::invalid(
            "target does not match the trusted current device",
        ));
    }
    // 2. Closed action set + target bounds + strict payload typing.
    let action = validate_action_and_target(&req.action, &req.target)?;
    validate_payload(action, &req.payload)?;
    // 2b. The trusted capability descriptor must actually enable `action`;
    //     a revoked/missing capability is refused BEFORE issue (no row).
    check_capability(&ctx, action)?;
    // 3. Approval bindings come SOLELY from the trusted context. A caller may
    //    furnish matching claims only; any furnished difference is refused
    //    BEFORE issue (a claim can never mint an approval for a different
    //    revision/artifact/material, nor clear a binding by omission).
    let revision = ctx_binding_u64(ctx.revision, req.revision, "revision-mismatch")?;
    let artifact = ctx_binding_str(
        ctx.artifact.as_deref(),
        req.artifact.as_deref(),
        "artifact-mismatch",
    )?;
    let material = ctx_binding_str(
        ctx.material.as_deref(),
        req.material.as_deref(),
        "material-mismatch",
    )?;
    // 4. Issuance through the session-scoped seam: principal, scope and
    //    session binding are ALL derived backend-side from `session_token`.
    let workspace = state.lock_workspace()?;
    let db = workspace
        .as_ref()
        .map_err(|error| ControlError::db(&error))?;
    let authority = ApprovalAuthority::new(db);
    let issued = authority
        .issue_for_session_scoped(
            auth,
            session_token,
            &ScopedIssueRequest {
                action: action.name(),
                target: &req.target,
                purpose: &req.purpose,
                payload: &req.payload,
                revision,
                artifact,
                material,
                // S9.18-003: anchor the approval to THIS snapshot moment and
                // the trusted project — real device-writer trust starts here.
                device_snapshot_ms: Some(ctx.snapshot_captured_at_ms),
                project_id: Some(ctx.project_id.as_str()),
                ttl_ms: req.ttl_ms,
            },
        )
        .map_err(ControlError::from_approval)?;
    Ok(DeviceControlApproveReply {
        status: "approved".to_owned(),
        token: issued.token,
        token_hash: issued.token_hash,
        payload_digest: issued.payload_digest,
        expires_ms: issued.expires_ms,
        action: action.name().to_owned(),
        target: req.target.clone(),
    })
}

#[tauri::command]
pub fn device_control_approve(
    state: State<'_, DeviceAuthorityState>,
    session_token: String,
    request: DeviceControlApproveRequest,
) -> Result<DeviceControlApproveReply, ControlError> {
    let auth = open_auth_store()?;
    approve(state.inner(), &auth, &session_token, &request)
}

// ---------------------------------------------------------------------------
// Dispatch (protected seam — consume-once → dispatch-once)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceControlDispatchRequest {
    pub action: String,
    pub target: String,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub artifact: Option<String>,
    #[serde(default)]
    pub material: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceControlDispatchReply {
    /// Typed outcome (`ack` | `refused: …`).
    pub outcome: String,
    pub token_hash: String,
}

/// Core (state-only, testable without Tauri). Re-resolves the session NOW,
/// requires the trusted resolver context, and lets the gate consume the
/// approval once and dispatch exactly once. Production transport is
/// `UnavailableTransport` ⇒ refused before consumption (approval preserved).
pub fn dispatch(
    state: &DeviceAuthorityState,
    auth: &AuthDb,
    session_token: &str,
    token: &str,
    req: &DeviceControlDispatchRequest,
) -> Result<DeviceControlDispatchReply, ControlError> {
    // Trusted context gate BEFORE consume (same rule as approve).
    let ctx = state.resolve_context(now_ms())?;
    if req.target != ctx.device_id {
        return Err(ControlError::invalid(
            "target does not match the trusted current device",
        ));
    }
    let action = validate_action_and_target(&req.action, &req.target)?;
    validate_payload(action, &req.payload)?;
    // The capability descriptor is re-checked at dispatch: a capability
    // revoked between approve and dispatch is rejected BEFORE consume (the
    // approval stays pending, never burned).
    check_capability(&ctx, action)?;
    // Consume bindings are derived from the trusted context ONLY (same rule
    // as approve): furnished claims must match, and the values passed to the
    // gate are the context's, so a changed trusted revision becomes a broker
    // context-change refusal BEFORE transport (approval preserved).
    let revision = ctx_binding_u64(ctx.revision, req.revision, "revision-mismatch")?;
    let artifact = ctx_binding_str(
        ctx.artifact.as_deref(),
        req.artifact.as_deref(),
        "artifact-mismatch",
    )?;
    let material = ctx_binding_str(
        ctx.material.as_deref(),
        req.material.as_deref(),
        "material-mismatch",
    )?;
    let workspace = state.lock_workspace()?;
    let db = workspace
        .as_ref()
        .map_err(|error| ControlError::db(&error))?;
    let authority = ApprovalAuthority::new(db);
    let gate = DispatchGate::new(
        &authority,
        state.transport.as_ref(),
        &DeviceControlAction::ALL,
    );
    let request = DeviceControlRequest {
        action,
        target: req.target.clone(),
        payload: req.payload.clone(),
        // Ignored at the external seam — identity comes from the verified
        // session, never from caller JSON.
        principal: Principal::Anonymous,
        context: RequestContext {
            session_ref: None,
            revision,
            artifact: artifact.map(str::to_owned),
            material: material.map(str::to_owned),
            // Bind the FRESH snapshot + trusted project at dispatch time too:
            // if the resolver re-read the device since approve (new snapshot
            // T'), the broker consume refuses with context-changed and zero
            // transport calls (approval preserved).
            device_snapshot_ms: Some(ctx.snapshot_captured_at_ms),
            project_id: Some(ctx.project_id.clone()),
        },
    };
    let receipt = gate
        .dispatch_for_session(auth, session_token, token, &request)
        .map_err(ControlError::from_dispatch)?;
    Ok(DeviceControlDispatchReply {
        outcome: receipt.outcome.to_string(),
        token_hash: receipt.token_hash,
    })
}

#[tauri::command]
pub fn device_control_dispatch(
    state: State<'_, DeviceAuthorityState>,
    session_token: String,
    token: String,
    request: DeviceControlDispatchRequest,
) -> Result<DeviceControlDispatchReply, ControlError> {
    let auth = open_auth_store()?;
    dispatch(state.inner(), &auth, &session_token, &token, &request)
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Secret-free, machine-readable command error. `kind` is the stable
/// category; `reason` is a fixed string. Never contains tokens, principals
/// or user-provided text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ControlError {
    pub kind: String,
    pub reason: String,
}

impl ControlError {
    fn invalid(reason: &str) -> Self {
        Self {
            kind: "invalid".to_owned(),
            reason: reason.to_owned(),
        }
    }
    fn unavailable(reason: &str) -> Self {
        Self {
            kind: "unavailable".to_owned(),
            reason: reason.to_owned(),
        }
    }
    fn session(reason: &'static str) -> Self {
        Self {
            kind: "session".to_owned(),
            reason: reason.to_owned(),
        }
    }
    fn approval(reason: &str) -> Self {
        Self {
            kind: "approval".to_owned(),
            reason: reason.to_owned(),
        }
    }
    fn db(reason: &str) -> Self {
        Self {
            kind: "db".to_owned(),
            reason: reason.to_owned(),
        }
    }

    fn from_approval(error: ApprovalError) -> Self {
        match error {
            ApprovalError::SessionDenied(reason) => Self::session(reason),
            ApprovalError::AlreadyConsumed => Self::approval("already-consumed"),
            ApprovalError::Expired => Self::approval("expired"),
            ApprovalError::Revoked => Self::approval("revoked"),
            ApprovalError::ContextChanged(_reason) => Self::approval("context-changed"),
            ApprovalError::UnknownToken => Self::approval("unknown-token"),
            ApprovalError::MissingPrincipal => Self::session("unauthenticated"),
            ApprovalError::InvalidToken => Self::invalid("invalid-approval-token"),
            ApprovalError::InvalidTtl => Self::invalid("invalid-ttl"),
            ApprovalError::InvalidRequest(reason) => Self::invalid(reason),
            ApprovalError::InvalidClock => Self::unavailable("clock-anomaly"),
            ApprovalError::Rng => Self::unavailable("randomness-unavailable"),
            ApprovalError::Db(message) => Self::db(&message),
        }
    }

    fn from_dispatch(error: DispatchError) -> Self {
        match error {
            DispatchError::TransportUnavailable => Self::unavailable("transport-unavailable"),
            DispatchError::InvalidAction(_) => Self::invalid("unknown-action"),
            DispatchError::InvalidTarget => Self::invalid("invalid-target"),
            DispatchError::InvalidPayload => Self::invalid("invalid-payload"),
            DispatchError::Approval(error) => Self::from_approval(error),
            DispatchError::SessionDenied(reason) => Self::session(reason),
            DispatchError::TransportTimeout => Self::unavailable("transport-timeout"),
            DispatchError::IndeterminateOutcome => Self::unavailable("indeterminate-outcome"),
        }
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.kind, self.reason)
    }
}

impl std::error::Error for ControlError {}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use auth_service::Scope;
    use broker::dispatch::TransportOutcome;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Injectable transport stub: counts dispatch calls, respects an
    /// availability flag, returns a scripted outcome (0 Ack, 1 Refused,
    /// 2 Timeout, 3 Indeterminate).
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
                1 => TransportOutcome::Refused("injected-refusal".to_owned()),
                2 => TransportOutcome::Timeout,
                3 => TransportOutcome::Indeterminate,
                _ => TransportOutcome::Ack,
            }
        }
    }

    struct StubDeviceResolver {
        device: Arc<Mutex<Option<DeviceContext>>>,
    }

    impl DeviceResolver for StubDeviceResolver {
        fn current_device(&self) -> Option<DeviceContext> {
            self.device.lock().unwrap().clone()
        }
    }

    fn fresh_context() -> DeviceContext {
        DeviceContext {
            device_id: "device-test".into(),
            project_id: "project-test".into(),
            snapshot_captured_at_ms: now_ms() - 10,
            revision: Some(4),
            artifact: Some("artifact-test".into()),
            material: Some("pla".into()),
            capabilities: Some(DeviceControlAction::ALL.to_vec()),
        }
    }

    fn approve_request() -> DeviceControlApproveRequest {
        DeviceControlApproveRequest {
            action: "nozzle".into(),
            target: "device-test".into(),
            purpose: "heat nozzle for test".into(),
            payload: serde_json::json!({ "nozzle": 210.0 }),
            revision: Some(4),
            artifact: Some("artifact-test".into()),
            material: Some("pla".into()),
            ttl_ms: 0,
        }
    }

    fn dispatch_request() -> DeviceControlDispatchRequest {
        DeviceControlDispatchRequest {
            action: "nozzle".into(),
            target: "device-test".into(),
            payload: serde_json::json!({ "nozzle": 210.0 }),
            revision: Some(4),
            artifact: Some("artifact-test".into()),
            material: Some("pla".into()),
        }
    }

    /// Auth store with exactly one trusted local user holding
    /// `DeviceControl` + a live session token.
    fn auth_with_session() -> (AuthDb, String) {
        let mut auth = AuthDb::open_in_memory().unwrap();
        auth.upsert_user("user-test", "Test User").unwrap();
        auth.grant_scope("user-test", Scope::DeviceControl).unwrap();
        let session = auth
            .create_session("user-test", Scope::DeviceControl, 60_000)
            .unwrap();
        (auth, session.raw().to_owned())
    }

    /// A well-shaped (but unknown) 64-hex session token — denied as
    /// `unauthenticated` rather than `malformed` (deterministic assertion).
    fn unknown_session() -> String {
        "ab".repeat(32)
    }

    fn state_with(
        resolver: Option<DeviceContext>,
        transport_available: bool,
    ) -> (DeviceAuthorityState, Arc<AtomicUsize>) {
        let (state, calls, _) = state_with_handle(resolver, transport_available);
        (state, calls)
    }

    fn state_with_handle(
        resolver: Option<DeviceContext>,
        transport_available: bool,
    ) -> (
        DeviceAuthorityState,
        Arc<AtomicUsize>,
        Arc<Mutex<Option<DeviceContext>>>,
    ) {
        let handle = Arc::new(Mutex::new(resolver));
        let calls = Arc::new(AtomicUsize::new(0));
        let avail = Arc::new(AtomicBool::new(transport_available));
        let transport = CountingTransport {
            calls: calls.clone(),
            avail: avail.clone(),
            mode: Arc::new(AtomicUsize::new(0)),
        };
        let state = DeviceAuthorityState::with_parts(
            Ok(DbHandle::open_in_memory().unwrap()),
            Box::new(StubDeviceResolver {
                device: handle.clone(),
            }),
            Box::new(transport),
        );
        (state, calls, handle)
    }

    #[test]
    fn approve_without_session_is_denied_and_zero_transport_calls() {
        let auth = AuthDb::open_in_memory().unwrap();
        let (state, calls) = state_with(Some(fresh_context()), true);
        let error = approve(&state, &auth, &unknown_session(), &approve_request()).unwrap_err();
        assert_eq!(error.kind, "session");
        assert_eq!(error.reason, "unauthenticated");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn approve_then_dispatch_consumes_exactly_one_stub_call_then_replay_is_zero() {
        let (auth, session) = auth_with_session();
        let (state, calls) = state_with(Some(fresh_context()), true);

        // Draft first: typed normalized effect, still zero transport calls.
        let draft = preflight(
            &state,
            &DeviceControlPreflightRequest {
                action: "nozzle".into(),
                target: "device-test".into(),
                payload: serde_json::json!({ "nozzle": 210.0 }),
                claimed_project_id: Some("project-test".into()),
                revision: Some(4),
                artifact: Some("artifact-test".into()),
                material: Some("pla".into()),
            },
        );
        assert_eq!(draft.status, "ready");
        let effect = draft.effect.expect("resolver present ⇒ normalized effect");
        assert_eq!(effect.device, "device-test"); // trusted resolver id, not the claim
        assert_eq!(effect.project, "project-test");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // Approve with the trusted session → one-use token minted.
        let issued = approve(&state, &auth, &session, &approve_request()).unwrap();
        assert_eq!(issued.status, "approved");
        assert_eq!(issued.action, "nozzle");
        assert_eq!(issued.target, "device-test");
        assert_eq!(issued.token.len(), 64);
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // Dispatch once → exactly one stub call.
        let receipt =
            dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap();
        assert_eq!(receipt.outcome, "ack");
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        // Replay the same token → refused (one-use), zero new transport calls.
        let replay =
            dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap_err();
        assert_eq!(replay.kind, "approval");
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn replay_without_prior_approval_is_refused_and_zero_calls() {
        let (auth, session) = auth_with_session();
        let (state, calls) = state_with(Some(fresh_context()), true);
        let forged = "cd".repeat(32); // well-shaped token never issued
        let error = dispatch(&state, &auth, &session, &forged, &dispatch_request()).unwrap_err();
        assert_eq!(error.kind, "approval");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn production_resolver_absent_routes_are_typed_unavailable_before_issue_and_consume() {
        let (auth, session) = auth_with_session();
        let state = DeviceAuthorityState::with_parts(
            Ok(DbHandle::open_in_memory().unwrap()),
            Box::new(UnavailableDeviceResolver),
            Box::new(UnavailableTransport),
        );
        let reply = availability(&state, Some(&auth));
        assert!(!reply.session.established);
        assert_eq!(reply.session.reason.as_deref(), Some("session-unverified"));
        assert!(!reply.capability.defined);
        assert!(!reply.writer.available);
        let error = approve(&state, &auth, &session, &approve_request()).unwrap_err();
        assert_eq!(error.kind, "unavailable");
        assert_eq!(error.reason, "resolver-unavailable");
        // Dispatch is gated by the SAME resolver check before any token work.
        let error = dispatch(
            &state,
            &auth,
            &session,
            &"aa".repeat(32),
            &dispatch_request(),
        )
        .unwrap_err();
        assert_eq!(error.kind, "unavailable");
        assert_eq!(error.reason, "resolver-unavailable");
    }

    #[test]
    fn stale_snapshot_is_unavailable_before_issue() {
        let (auth, session) = auth_with_session();
        let mut stale = fresh_context();
        stale.snapshot_captured_at_ms = now_ms() - (MAX_CONTEXT_AGE_MS + 1);
        let (state, calls) = state_with(Some(stale), true);
        let error = approve(&state, &auth, &session, &approve_request()).unwrap_err();
        assert_eq!(error.kind, "unavailable");
        assert_eq!(error.reason, "stale-snapshot");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn revoked_scope_denies_approve_before_issue() {
        let mut auth = AuthDb::open_in_memory().unwrap();
        auth.upsert_user("user-test", "Test User").unwrap();
        auth.grant_scope("user-test", Scope::DeviceControl).unwrap();
        let session = auth
            .create_session("user-test", Scope::DeviceControl, 60_000)
            .unwrap();
        auth.revoke_scope("user-test", Scope::DeviceControl)
            .unwrap();
        let (state, calls) = state_with(Some(fresh_context()), true);
        let error = approve(&state, &auth, session.raw(), &approve_request()).unwrap_err();
        assert_eq!(error.kind, "session");
        assert_eq!(error.reason, "scope");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn preflight_validates_the_closed_action_set_and_payload() {
        let (_auth, _) = auth_with_session();
        let (state, _) = state_with(Some(fresh_context()), true);

        // Old coarse names and unknown actions are refused (same enum as the
        // dispatcher allowlist).
        for action in ["fan_speed", "light", "ace", "print.start", "nozzle "] {
            let reply = preflight(
                &state,
                &DeviceControlPreflightRequest {
                    action: action.to_owned(),
                    target: "device-test".into(),
                    payload: serde_json::json!({ "nozzle": 210.0 }),
                    claimed_project_id: None,
                    revision: None,
                    artifact: None,
                    material: None,
                },
            );
            assert_eq!(reply.status, "invalid", "action {action:?} must be refused");
        }
        // Strict typed payload windows still apply at the draft stage.
        let reply = preflight(
            &state,
            &DeviceControlPreflightRequest {
                action: "nozzle".into(),
                target: "device-test".into(),
                payload: serde_json::json!({ "nozzle": 500.0 }),
                claimed_project_id: None,
                revision: None,
                artifact: None,
                material: None,
            },
        );
        assert_eq!(reply.status, "invalid");
        // Whitespace/oversized targets are refused.
        let reply = preflight(
            &state,
            &DeviceControlPreflightRequest {
                action: "nozzle".into(),
                target: " device-1".into(),
                payload: serde_json::json!({ "nozzle": 210.0 }),
                claimed_project_id: None,
                revision: None,
                artifact: None,
                material: None,
            },
        );
        assert_eq!(reply.status, "invalid");
    }

    #[test]
    fn confirm_true_and_caller_principal_are_rejected_by_the_type() {
        let attacker = serde_json::json!({
            "action": "nozzle",
            "target": "device-test",
            "purpose": "heat",
            "payload": { "nozzle": 210.0 },
            "confirm": true,
            "principal": { "user_id": "attacker" }
        });
        assert!(
            serde_json::from_value::<DeviceControlApproveRequest>(attacker).is_err(),
            "caller-supplied confirm/principal must be rejected by the type"
        );
    }

    #[test]
    fn availability_never_reports_secrets_for_production_open() {
        // Production boot: empty auth store + absent resolver/transport.
        let auth = AuthDb::open_in_memory().unwrap();
        let (state, _) = state_with(None, false);
        let reply = availability(&state, Some(&auth));
        assert!(!reply.session.established);
        assert_eq!(reply.session.reason.as_deref(), Some("login-required"));
        assert!(!reply.capability.defined);
        assert!(!reply.writer.available);
        assert_eq!(
            reply.writer.reason.as_deref(),
            Some("session-unestablished")
        );
        // Compile-time secret safety: the reply struct exposes no user id /
        // session bearer — serialize and assert the key names are closed.
        let json = serde_json::to_value(&reply).unwrap();
        for key in ["user_id", "session_token", "accessToken", "principal"] {
            assert!(
                !json.as_object().unwrap().contains_key(key),
                "availability leaks {key}"
            );
        }
    }

    #[test]
    fn user_rows_without_a_verified_session_never_establish_writer() {
        // Identity is CONFIGURED and the resolver + transport are both
        // present — yet without a verified backend session the writer must
        // stay off: user rows are not an authenticated session.
        let mut auth = AuthDb::open_in_memory().unwrap();
        auth.upsert_user("user-test", "Test User").unwrap();
        auth.grant_scope("user-test", Scope::DeviceControl).unwrap();
        let (state, _) = state_with(Some(fresh_context()), true);
        let reply = availability(&state, Some(&auth));
        assert!(!reply.session.established);
        assert_eq!(reply.session.reason.as_deref(), Some("session-unverified"));
        assert!(reply.capability.defined, "resolver present");
        assert!(
            !reply.writer.available,
            "no verified session ⇒ never a writer"
        );
        assert_eq!(
            reply.writer.reason.as_deref(),
            Some("session-unestablished")
        );
    }

    #[test]
    fn empty_store_is_login_required_even_with_resolver_and_transport() {
        let auth = AuthDb::open_in_memory().unwrap();
        let (state, _) = state_with(Some(fresh_context()), true);
        let reply = availability(&state, Some(&auth));
        assert!(!reply.session.established);
        assert_eq!(reply.session.reason.as_deref(), Some("login-required"));
        assert!(reply.capability.defined);
        assert!(!reply.writer.available);
        assert_eq!(
            reply.writer.reason.as_deref(),
            Some("session-unestablished")
        );
    }

    #[test]
    fn furnished_binding_mismatch_is_invalid_before_issue() {
        let (auth, session) = auth_with_session();
        let (state, calls) = state_with(Some(fresh_context()), true);

        // Trusted ctx: revision 4, artifact-test, pla. Any furnished claim
        // that differs must be refused BEFORE issue (zero transport, and the
        // request never reaches the approval authority).
        let mut wrong = approve_request();
        wrong.revision = Some(5);
        let error = approve(&state, &auth, &session, &wrong).unwrap_err();
        assert_eq!(error.kind, "invalid");
        assert_eq!(error.reason, "revision-mismatch");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        let mut wrong = approve_request();
        wrong.artifact = Some("artifact-attacker".into());
        let error = approve(&state, &auth, &session, &wrong).unwrap_err();
        assert_eq!(error.kind, "invalid");
        assert_eq!(error.reason, "artifact-mismatch");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        let mut wrong = approve_request();
        wrong.material = Some("petg".into());
        let error = approve(&state, &auth, &session, &wrong).unwrap_err();
        assert_eq!(error.kind, "invalid");
        assert_eq!(error.reason, "material-mismatch");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn dispatch_with_furnished_mismatch_preserves_the_approval() {
        let (auth, session) = auth_with_session();
        let (state, calls) = state_with(Some(fresh_context()), true);
        let issued = approve(&state, &auth, &session, &approve_request()).unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // A furnished difference at dispatch is refused BEFORE consume.
        let mut wrong = dispatch_request();
        wrong.revision = Some(5);
        let error = dispatch(&state, &auth, &session, &issued.token, &wrong).unwrap_err();
        assert_eq!(error.kind, "invalid");
        assert_eq!(error.reason, "revision-mismatch");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // The same token is preserved and still consumable exactly once.
        let receipt =
            dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap();
        assert_eq!(receipt.outcome, "ack");
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let replay =
            dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap_err();
        assert_eq!(replay.kind, "approval");
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn changed_trusted_revision_between_approve_and_dispatch_is_refused_before_transport() {
        let (auth, session) = auth_with_session();
        // Keep the ORIGINAL context: restoring it later must reproduce the
        // EXACT snapshot the approval was anchored to (a fresh context would
        // mint a new snapshot T' and the result would be a snapshot
        // context-change, not the ack proving the approval was never burned).
        let original = fresh_context();
        let (state, calls, handle) = state_with_handle(Some(original.clone()), true);
        let issued = approve(&state, &auth, &session, &approve_request()).unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // Backend observes a fresh snapshot with a NEW trusted revision before
        // the approval is consumed.
        let mut changed = original.clone();
        changed.revision = Some(5);
        *handle.lock().unwrap() = Some(changed);

        // The UI refresh its draft to the new trusted revision; the broker
        // detects the change vs the frozen approval row and refuses BEFORE
        // transport — the approval stays pending.
        let mut req = dispatch_request();
        req.revision = Some(5);
        let error = dispatch(&state, &auth, &session, &issued.token, &req).unwrap_err();
        assert_eq!(error.kind, "approval");
        assert_eq!(error.reason, "context-changed");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // Restoring the ORIGINAL trusted context (same revision AND snapshot)
        // lets the same approval dispatch exactly once — proof it was never
        // consumed.
        *handle.lock().unwrap() = Some(original);
        let receipt =
            dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap();
        assert_eq!(receipt.outcome, "ack");
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let replay =
            dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap_err();
        assert_eq!(replay.kind, "approval");
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn preflight_rejects_a_project_claim_that_differs_from_the_trusted_context() {
        let (_auth, _) = auth_with_session();
        let (state, _) = state_with(Some(fresh_context()), true);
        let base = |claimed: Option<String>| DeviceControlPreflightRequest {
            action: "nozzle".into(),
            target: "device-test".into(),
            payload: serde_json::json!({ "nozzle": 210.0 }),
            claimed_project_id: claimed,
            revision: Some(4),
            artifact: Some("artifact-test".into()),
            material: Some("pla".into()),
        };
        // Different project claim → refused at the draft stage.
        let reply = preflight(&state, &base(Some("project-other".into())));
        assert_eq!(reply.status, "invalid");
        assert_eq!(reply.reason.as_deref(), Some("project-mismatch"));
        assert!(reply.effect.is_none());
        // Matching claim and omitted claim both draft against the trusted
        // project.
        let reply = preflight(&state, &base(Some("project-test".into())));
        assert_eq!(reply.status, "ready");
        assert_eq!(reply.effect.as_ref().unwrap().project, "project-test");
        let reply = preflight(&state, &base(None));
        assert_eq!(reply.status, "ready");
        assert_eq!(reply.effect.as_ref().unwrap().project, "project-test");
    }

    // ---------------------------------------------------------------------
    // S9.18-003 staged regression vector: capabilities (cap false)
    // ---------------------------------------------------------------------

    #[test]
    fn capabilities_none_keep_preflight_and_approve_typed_unavailable_no_row() {
        // resolver present BUT capabilities None ⇒ the backend declares no
        // capability descriptor: writer routes stay typed unavailable and no
        // approval row can be minted.
        let mut ctx = fresh_context();
        ctx.capabilities = None;
        let (_auth, session) = auth_with_session();
        let (state, calls, handle) = state_with_handle(Some(ctx), true);

        // Availability: capability.defined false ⇒ writer off.
        let reply = availability(&state, Some(&AuthDb::open_in_memory().unwrap()));
        assert!(!reply.capability.defined);
        assert_eq!(
            reply.capability.reason.as_deref(),
            Some("capability-unavailable")
        );
        assert!(!reply.writer.available);

        // Preflight: typed unavailable, never a draft effect.
        let pre = preflight(&state, &DeviceControlPreflightRequest {
            action: "nozzle".into(),
            target: "device-test".into(),
            payload: serde_json::json!({ "nozzle": 210.0 }),
            claimed_project_id: None,
            revision: Some(4),
            artifact: Some("artifact-test".into()),
            material: Some("pla".into()),
        });
        assert_eq!(pre.status, "unavailable");
        assert_eq!(pre.reason.as_deref(), Some("capability-unavailable"));
        assert!(pre.effect.is_none());

        // Approve: same gate, no issue row (pending empty).
        let error = approve(&state, &AuthDb::open_in_memory().unwrap(), &session, &approve_request())
            .unwrap_err();
        assert_eq!(error.kind, "unavailable");
        assert_eq!(error.reason, "capability-unavailable");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // Prove no row: even after restoring full caps, this context can not
        // consume "the approval that never existed" — token is unknown.
        *handle.lock().unwrap() = Some(fresh_context());
        let error = dispatch(&state, &AuthDb::open_in_memory().unwrap(), &session, "not-a-real-token", &dispatch_request())
            .unwrap_err();
        assert_eq!(error.kind, "session");
        assert_eq!(error.reason, "unauthenticated");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn action_outside_capability_list_is_typed_unavailable_before_issue() {
        // Caps exist but DO NOT include the requested action ⇒
        // action-not-enabled at preflight AND approve; no issue row.
        let mut ctx = fresh_context();
        ctx.capabilities = Some(vec![DeviceControlAction::PartFan]);
        let (_auth, session) = auth_with_session();
        let (state, calls, handle) = state_with_handle(Some(ctx), true);

        let pre = preflight(&state, &DeviceControlPreflightRequest {
            action: "nozzle".into(),
            target: "device-test".into(),
            payload: serde_json::json!({ "nozzle": 210.0 }),
            claimed_project_id: None,
            revision: Some(4),
            artifact: Some("artifact-test".into()),
            material: Some("pla".into()),
        });
        assert_eq!(pre.status, "unavailable");
        assert_eq!(pre.reason.as_deref(), Some("action-not-enabled"));
        assert!(pre.effect.is_none());

        let error = approve(&state, &AuthDb::open_in_memory().unwrap(), &session, &approve_request())
            .unwrap_err();
        assert_eq!(error.kind, "unavailable");
        assert_eq!(error.reason, "action-not-enabled");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        *handle.lock().unwrap() = Some(fresh_context());
        let error = dispatch(&state, &AuthDb::open_in_memory().unwrap(), &session, "not-a-real-token", &dispatch_request())
            .unwrap_err();
        assert_eq!(error.kind, "session");
        assert_eq!(error.reason, "unauthenticated");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn capability_revoked_between_approve_and_dispatch_rejects_before_consume() {
        // Approve succeeds with full caps; before dispatch the backend
        // re-reads the device and the capability is REVOKED (caps None).
        // Dispatch must reject BEFORE consume — the approval row stays
        // pending and zero transport calls happen.
        let (auth, session) = auth_with_session();
        let original = fresh_context();
        let (state, calls, handle) = state_with_handle(Some(original.clone()), true);

        let issued = approve(&state, &auth, &session, &approve_request()).unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        let mut revoked = original;
        revoked.capabilities = None;
        *handle.lock().unwrap() = Some(revoked);

        let error = dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap_err();
        assert_eq!(error.kind, "unavailable");
        assert_eq!(error.reason, "capability-unavailable");
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        // Caps restored (fresh snapshot T' would trip snapshot context-changed
        // too — restore the ORIGINAL context to prove the row survived).
        *handle.lock().unwrap() = Some(fresh_context());
        let error = dispatch(&state, &auth, &session, &issued.token, &dispatch_request()).unwrap_err();
        assert_eq!(error.kind, "approval");
        assert_eq!(error.reason, "context-changed");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn auth_store_refuses_a_path_aliasing_the_workspace_db() {
        // Writer authority: the auth store must NEVER open a path equal to
        // the workspace DB (typed refusal, "db" kind) — while a genuinely
        // distinct file in the same directory opens normally and preserves
        // rows across a re-open (no move/truncate).
        let tmp = tempfile::tempdir().unwrap();
        let same = tmp.path().join("workspace.db");
        let error = match open_auth_store_at(&same, &same) {
            Err(error) => error,
            Ok(_) => panic!("aliasing path must be refused"),
        };
        assert_eq!(error.kind, "db");
        assert!(
            error.reason.contains("workspace db path"),
            "refusal must surface the alias reason, got: {}",
            error.reason
        );

        let auth_path = tmp.path().join("auth.db");
        let workspace_path = tmp.path().join("workspace.db");
        {
            let mut auth = open_auth_store_at(&auth_path, &workspace_path).unwrap();
            auth.upsert_user("u1", "Editor User").unwrap();
            assert!(
                !workspace_path.exists(),
                "opening the auth store must not create the workspace DB"
            );
        }
        // Re-open through the same gate: rows survive (resolution never
        // overwrites/moves an existing user DB).
        let reopened = open_auth_store_at(&auth_path, &workspace_path).unwrap();
        assert_eq!(
            reopened.users().unwrap(),
            vec![("u1".to_string(), "Editor User".to_string())]
        );
    }

    #[test]
    fn resolved_auth_and_workspace_paths_are_never_equal() {
        // Production invariant: whatever the env yields, the auth store path
        // and the workspace path must always be different files — enforced by
        // the shared distinctness gate on every production open. If neither
        // can resolve (no app-data dir) there is nothing to conflate, and
        // availability reports auth-unconfigured instead.
        match (auth_db_path(), workspace_db_path()) {
            (Ok(auth), Ok(workspace)) => assert!(
                auth_service::config::ensure_distinct_from(
                    &auth,
                    &workspace,
                    auth_service::config::current_platform(),
                )
                .is_ok(),
                "auth db ({}) must never alias the workspace db ({})",
                auth.display(),
                workspace.display(),
            ),
            (Err(_), Err(_)) => {}
            _ => panic!("auth/workspace path availability must agree"),
        }
    }
}
