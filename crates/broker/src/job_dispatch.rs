//! Typed job-effect dispatch gate — DEV-10 (upload / queue / start / stop).
//!
//! Backend-internal counterpart of [`crate::dispatch::DispatchGate`] for the
//! four **job effects**, each with its own closed, validated request type and
//! its own approval `action` binding:
//!
//! - `upload`    — writes an artifact to the account cloud shelf
//!   ([`UploadIntent`]; required scope `DeviceUpload`).
//! - `job.queue` — records job metadata for a later start ([`QueueIntent`];
//!   required scope `PrintJob`).
//! - `job.start` — physically starts a print ([`StartIntent`]; required scope
//!   `PrintJob`; revalidated against a **trusted** [`ProviderSnapshot`]).
//! - `job.stop`  — cancels the currently observed job ([`StopIntent`];
//!   required scope `PrintJob`; job id must equal the snapshot's observed
//!   `current_job_id`).
//!
//! Design invariants (mirroring `dispatch.rs`):
//! - **Closed request structs**: every intent is
//!   `#[serde(deny_unknown_fields)]`; unknown fields, URLs, filesystem paths
//!   and unbounded/opaque identifiers are denied before transport. Artifacts
//!   are referenced only by 64-hex SHA-256 CAS locator — never by URL or
//!   path — and `file_ref` is a trusted backend-domain reference, resolved
//!   server-side, never a UI literal.
//! - **Scope comes from the action registry** (see
//!   [`crate::action_registry`]); the caller never supplies a scope.
//! - **One-use approval**: exactly zero transport calls on every denial
//!   (auth refuse, expiry, replay, scope, domain revalidation), exactly one
//!   dispatch call on a grant. Timeout/Indeterminate happen *after* the
//!   approval is consumed and are never retried.
//! - **`Ack` means accepted, never observed**: receipts carry
//!   `observed: None`; claiming an observed job requires a separate explicit
//!   resolution (job id + time correlation against a fresh trusted snapshot)
//!   that this module does not perform.
//! - **No auto-chaining**: an upload acknowledgement never queues, a queue
//!   acknowledgement never starts.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

use auth_service::Principal;

use crate::approval::{ApprovalAuthority, ApprovalError, ConsumeContext, MAX_IDENTIFIER_LEN};
use crate::dispatch::{PayloadError, TransportOutcome, MAX_PAYLOAD_BYTES};

/// Upper bound for a queued material mapping (load positions).
pub const MAX_MATERIAL_SLOTS: usize = 16;
/// Upper bound for a single upload's exact size (1 GiB policy window).
pub const MAX_UPLOAD_BYTES: u64 = 1 << 30;
/// Freshness window for a trusted provider snapshot (mirrors the approval
/// default TTL). Older (or future) snapshots are refused — a start/stop must
/// be revalidated against an effectively-now view.
pub const MAX_SNAPSHOT_AGE_MS: i64 = 60_000;

/// Closed set of job effects. One variant per typed intent — no generic
/// `Job`/`Print` command can smuggle an off-schema payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum JobAction {
    Upload,
    Queue,
    Start,
    Stop,
}

impl JobAction {
    /// Every known action — the default full allowlist.
    pub const ALL: [JobAction; 4] = [
        JobAction::Upload,
        JobAction::Queue,
        JobAction::Start,
        JobAction::Stop,
    ];

    /// Stable wire name (also the approval `action` binding).
    pub fn name(self) -> &'static str {
        match self {
            JobAction::Upload => "upload",
            JobAction::Queue => "job.queue",
            JobAction::Start => "job.start",
            JobAction::Stop => "job.stop",
        }
    }

    /// Parse a wire name; unknown names return `None` (allowlist refusal).
    pub fn from_name(s: &str) -> Option<JobAction> {
        match s {
            "upload" => Some(JobAction::Upload),
            "job.queue" => Some(JobAction::Queue),
            "job.start" => Some(JobAction::Start),
            "job.stop" => Some(JobAction::Stop),
            _ => None,
        }
    }
}

/// Artifact compatibility for a start — a preview-only artifact can never be
/// physically started, regardless of confirmation/session (see
/// [`StartIntent`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactCompatibility {
    Ready,
    PreviewOnly,
}

/// A 64-hex lowercase SHA-256 CAS locator (internal artifact address). Only
/// the strict form is accepted: uppercase hex, URLs, paths, digests of any
/// other length are refused.
pub fn is_cas_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An opaque, server-resolved reference: non-empty, bounded, no whitespace,
/// and free of `:`, `/`, `\`, `\0` — this structurally blocks URLs
/// (`http://`), filesystem paths and raw shell-friendly tokens from ever
/// reaching a transport. Values come from trusted backend domains, never UI
/// literals.
pub fn is_opaque_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_IDENTIFIER_LEN
        && !s.chars().any(char::is_whitespace)
        && !s.contains(':')
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
}

// ---------------------------------------------------------------------------
// Closed, validated intents
// ---------------------------------------------------------------------------

/// Upload effect: write the artifact referenced by its CAS digest to the
/// account cloud shelf, under a trusted backend `file_ref`, with an exact
/// byte size (never probed from the filesystem).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadIntent {
    /// 64-hex lowercase SHA-256 CAS locator of the artifact.
    pub artifact_sha256: String,
    /// Trusted backend-domain file reference (server-resolved; never a URL or
    /// filesystem path).
    pub file_ref: String,
    /// Exact size in bytes (bounded by [`MAX_UPLOAD_BYTES`]).
    pub exact_size_bytes: u64,
}

impl UploadIntent {
    fn validate(&self) -> Result<(), PayloadError> {
        if !is_cas_digest(&self.artifact_sha256) {
            return Err(PayloadError::Range("artifact_sha256"));
        }
        if !is_opaque_ref(&self.file_ref) {
            return Err(PayloadError::Range("file_ref"));
        }
        if self.exact_size_bytes == 0 || self.exact_size_bytes > MAX_UPLOAD_BYTES {
            return Err(PayloadError::Range("exact_size_bytes"));
        }
        Ok(())
    }
}

/// One immutable material mapping entry for a queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialSlot {
    /// Load position (bounded by [`MAX_MATERIAL_SLOTS`]).
    pub slot_index: u8,
    /// Server-resolved material reference.
    pub material_ref: String,
}

/// Print mode — closed enum, no free-form profile strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrintMode {
    Standard,
    Nonplanar,
}

/// Queue effect: record job metadata (artifact + profile revision + mode +
/// immutable material mapping) for a later, separate start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueIntent {
    pub artifact_sha256: String,
    pub file_ref: String,
    /// Profile revision the queue is bound to; a changed revision invalidates
    /// the queue (revalidation at start).
    pub profile_rev: u64,
    pub mode: PrintMode,
    /// Immutable material→load-position mapping; the mapping digest is bound
    /// into the approval's `material` field.
    pub material_mapping: Vec<MaterialSlot>,
}

impl QueueIntent {
    fn validate(&self) -> Result<(), PayloadError> {
        if !is_cas_digest(&self.artifact_sha256) {
            return Err(PayloadError::Range("artifact_sha256"));
        }
        if !is_opaque_ref(&self.file_ref) {
            return Err(PayloadError::Range("file_ref"));
        }
        if self.material_mapping.is_empty() || self.material_mapping.len() > MAX_MATERIAL_SLOTS {
            return Err(PayloadError::Range("material_mapping"));
        }
        for slot in &self.material_mapping {
            if usize::from(slot.slot_index) >= MAX_MATERIAL_SLOTS {
                return Err(PayloadError::Range("material_mapping.slot_index"));
            }
            if !is_opaque_ref(&slot.material_ref) {
                return Err(PayloadError::Range("material_mapping.material_ref"));
            }
        }
        Ok(())
    }
}

/// Start effect: physically start a queued print. `queued_intent_id` is a
/// server-resolved identifier of a previously accepted queue — never an
/// arbitrary UI literal. A preview-only artifact is always blocked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartIntent {
    /// Server-resolved identifier of the accepted queue to start.
    pub queued_intent_id: String,
    pub printer_id: String,
    /// Project revision revalidated against the queue/profile state.
    pub project_revision: u64,
    pub artifact_sha256: String,
    pub artifact_compatibility: ArtifactCompatibility,
}

impl StartIntent {
    fn validate(&self) -> Result<(), PayloadError> {
        if !is_opaque_ref(&self.queued_intent_id) {
            return Err(PayloadError::Range("queued_intent_id"));
        }
        if !is_opaque_ref(&self.printer_id) {
            return Err(PayloadError::Range("printer_id"));
        }
        if !is_cas_digest(&self.artifact_sha256) {
            return Err(PayloadError::Range("artifact_sha256"));
        }
        Ok(())
    }
}

/// Stop effect: cancel the currently observed job. There is **no** free-form
/// `stopTarget` — the job id must equal the trusted snapshot's
/// `current_job_id`, or the stop is refused with zero transport calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopIntent {
    pub printer_id: String,
    pub job_id: String,
}

impl StopIntent {
    fn validate(&self) -> Result<(), PayloadError> {
        if !is_opaque_ref(&self.printer_id) {
            return Err(PayloadError::Range("printer_id"));
        }
        if !is_opaque_ref(&self.job_id) {
            return Err(PayloadError::Range("job_id"));
        }
        Ok(())
    }
}

/// Trusted provider snapshot — a *backend-resolved* view of the printer used
/// to revalidate a start/stop. Deliberately **not** `Serialize`/`Deserialize`:
/// it can never be reconstructed from caller-supplied JSON, so no frontend
/// literal can forge `reachable`/`qualified`/`busy`. Only code with access to
/// the trusted provider source can construct it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSnapshot {
    /// Capture time (epoch ms) for staleness revalidation.
    pub captured_at_ms: i64,
    /// Printer reachable (not offline).
    pub reachable: bool,
    /// Machine-domain qualification pass (from the trusted provider source).
    pub qualified: bool,
    /// Printer active.
    pub busy: bool,
    /// Observed running job id, when busy.
    pub current_job_id: Option<String>,
}

impl ProviderSnapshot {
    /// A fully-`None`-quality snapshot: the honest "no trusted observation"
    /// state. A start revalidation against this always fails.
    pub fn unavailable(now_ms: i64) -> Self {
        ProviderSnapshot {
            captured_at_ms: now_ms,
            reachable: false,
            qualified: false,
            busy: false,
            current_job_id: None,
        }
    }
}

/// Ergonomic outcome for one job-effect dispatch (accepted/refused only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobReceipt {
    pub action: JobAction,
    pub token_hash: String,
    /// `Ack` = **accepted** only — never observed.
    pub outcome: TransportOutcome,
    /// Always `None` at this layer. Claiming an observed job requires a
    /// separate explicit resolution (job id + time correlation against a
    /// fresh trusted snapshot); this module never invents one.
    pub observed: Option<ObservedJob>,
}

/// An explicitly-observed job. Only produced by a future, separate
/// observation step — never synthesized by the dispatch gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedJob {
    pub job_id: String,
    pub observed_at_ms: i64,
}

/// THE typed request handed to the transport — the enum variant *is* the
/// effect; the transport records upload/queue/start/stop separately and never
/// sends a combined status payload.
#[derive(Debug, Clone)]
pub enum JobRequest {
    Upload(UploadIntent),
    Queue(QueueIntent),
    Start(StartIntent, ProviderSnapshot),
    Stop(StopIntent, ProviderSnapshot),
}

impl JobRequest {
    pub fn action(&self) -> JobAction {
        match self {
            JobRequest::Upload(_) => JobAction::Upload,
            JobRequest::Queue(_) => JobAction::Queue,
            JobRequest::Start(_, _) => JobAction::Start,
            JobRequest::Stop(_, _) => JobAction::Stop,
        }
    }

    /// Canonical digest-bound payload (intent only — never the provider
    /// snapshot, which is revalidation input, not frozen request data). The
    /// SAME function is used at approval-issue time and at consume time, so
    /// both sides hash an identical canonical `Value`.
    pub fn payload_value(&self) -> Value {
        match self {
            JobRequest::Upload(i) => serde_json::to_value(i).expect("UploadIntent serializes"),
            JobRequest::Queue(i) => serde_json::to_value(i).expect("QueueIntent serializes"),
            JobRequest::Start(i, _) => serde_json::to_value(i).expect("StartIntent serializes"),
            JobRequest::Stop(i, _) => serde_json::to_value(i).expect("StopIntent serializes"),
        }
    }

    /// Binding target for the approval envelope: the artifact (upload/queue)
    /// or the printer (start/stop).
    pub fn target(&self) -> &str {
        match self {
            JobRequest::Upload(i) => &i.artifact_sha256,
            JobRequest::Queue(i) => &i.artifact_sha256,
            JobRequest::Start(i, _) => &i.printer_id,
            JobRequest::Stop(i, _) => &i.printer_id,
        }
    }

    pub fn artifact(&self) -> Option<&str> {
        match self {
            JobRequest::Upload(i) => Some(&i.artifact_sha256),
            JobRequest::Queue(i) => Some(&i.artifact_sha256),
            JobRequest::Start(i, _) => Some(&i.artifact_sha256),
            JobRequest::Stop(_, _) => None,
        }
    }

    /// Revision binding: a start is bound to its project revision (and a
    /// queue to its profile revision via the payload); upload/stop bind none.
    pub fn revision(&self) -> Option<u64> {
        match self {
            JobRequest::Start(i, _) => Some(i.project_revision),
            _ => None,
        }
    }

    /// Material binding: a queue binds the canonical digest of its immutable
    /// material mapping.
    pub fn material(&self) -> Option<String> {
        match self {
            JobRequest::Queue(i) => Some(crate::approval::digest_value(
                &serde_json::to_value(&i.material_mapping).expect("material mapping serializes"),
            )),
            _ => None,
        }
    }

    /// Stronger-than-bound semantic validation over the typed intents (the
    /// serde boundary plus `deny_unknown_fields` already enforce the shape).
    fn validate(&self) -> Result<(), PayloadError> {
        match self {
            JobRequest::Upload(i) => i.validate(),
            JobRequest::Queue(i) => i.validate(),
            JobRequest::Start(i, _) => i.validate(),
            JobRequest::Stop(i, _) => i.validate(),
        }
    }
}

// ---------------------------------------------------------------------------
// Job transport (typed, per-effect dispatch)
// ---------------------------------------------------------------------------

/// Backend transport for job effects. Implementations record each effect
/// separately (upload vs queue vs start vs stop); receiving a typed
/// [`JobRequest`] means no combined "status send" can carry an off-schema
/// payload. In production the concrete adapter is wired by the writer layer;
/// this DEV-10 slice ships the trait + an unavailable stub.
pub trait JobTransport {
    /// Whether the effect can be dispatched right now. When `false`, the gate
    /// refuses BEFORE consuming the approval (it stays pending).
    fn available(&self) -> bool;

    /// Dispatch one typed job effect. `Ack` = accepted; `Refused(reason)` =
    /// accepted at the authorization layer but refused by the backend.
    fn dispatch(&self, req: &JobRequest) -> TransportOutcome;
}

/// Stub used until a real writer adapter exists: always unavailable, so no
/// approval is ever consumed.
pub struct UnavailableJobTransport;

impl JobTransport for UnavailableJobTransport {
    fn available(&self) -> bool {
        false
    }
    fn dispatch(&self, _req: &JobRequest) -> TransportOutcome {
        // Unreachable in practice (the gate checks availability first).
        TransportOutcome::Refused("unavailable transport".into())
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JobDispatchError {
    #[error("job transport unavailable")]
    TransportUnavailable,
    #[error("unknown job action")]
    InvalidAction(&'static str),
    #[error("invalid job payload")]
    InvalidPayload,
    #[error("start/stop requires a trusted provider snapshot")]
    SnapshotUnavailable,
    #[error("printer offline in trusted snapshot")]
    PrinterOffline,
    #[error("provider snapshot stale or from the future")]
    StaleSnapshot,
    #[error("machine qualification not met")]
    Unqualified,
    #[error("printer is busy (another job running)")]
    PrinterBusy,
    #[error("job not observed (id does not match the current job)")]
    JobNotObserved,
    #[error("artifact is preview-only and can never be started")]
    PreviewOnlyBlocked,
    #[error("approval error: {0}")]
    Approval(#[from] ApprovalError),
    #[error("session denied: {0}")]
    SessionDenied(&'static str),
    #[error("transport timed out after the approval was consumed — no retry")]
    TransportTimeout,
    #[error("transport outcome indeterminate after the approval was consumed — no retry")]
    IndeterminateOutcome,
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/// Backend job-effect gate: allowlist → payload bounds → typed validation →
/// trusted-snapshot domain revalidation → transport availability → one-use
/// approval consume → exactly one transport dispatch.
pub struct JobDispatchGate<'d, 'a> {
    authority: &'a ApprovalAuthority<'d>,
    transport: &'a dyn JobTransport,
    allowlist: &'static [JobAction],
    clock: Box<dyn Fn() -> i64>,
}

impl<'d, 'a> JobDispatchGate<'d, 'a> {
    pub fn new(authority: &'a ApprovalAuthority<'d>, transport: &'a dyn JobTransport) -> Self {
        Self {
            authority,
            transport,
            allowlist: &JobAction::ALL,
            clock: Box::new(crate::approval::now_ms),
        }
    }

    /// Inject a deterministic clock (job tests + staleness determinism).
    pub fn with_clock(
        authority: &'a ApprovalAuthority<'d>,
        transport: &'a dyn JobTransport,
        clock: impl Fn() -> i64 + 'static,
    ) -> Self {
        Self {
            authority,
            transport,
            allowlist: &JobAction::ALL,
            clock: Box::new(clock),
        }
    }

    /// Restrict the allowlist (defaults to all four actions).
    pub fn with_allowlist(mut self, allowlist: &'static [JobAction]) -> Self {
        self.allowlist = allowlist;
        self
    }

    pub fn allowlist(&self) -> &'static [JobAction] {
        self.allowlist
    }

    /// Crate-internal dispatch with a caller-supplied principal (tests use it
    /// to exercise the frozen-envelope path without a session store). The
    /// only external entry is [`JobDispatchGate::run_for_session`].
    pub(crate) fn run(
        &self,
        token: &str,
        req: &JobRequest,
        principal: &Principal,
        session_ref: Option<&str>,
    ) -> Result<JobReceipt, JobDispatchError> {
        // 1. Allowlist.
        if !self.allowlist.contains(&req.action()) {
            return Err(JobDispatchError::InvalidAction(req.action().name()));
        }
        // 2. Payload size bound (the typed parse below is stricter). The
        //    same canonical value is reused for the envelope binding.
        let body = req.payload_value();
        if body.to_string().len() > MAX_PAYLOAD_BYTES {
            return Err(JobDispatchError::InvalidPayload);
        }
        // 3. Typed semantic validation (closed structs already deny unknowns).
        req.validate()
            .map_err(|_| JobDispatchError::InvalidPayload)?;

        // 4. Domain revalidation against the trusted snapshot.
        let now = (self.clock)();
        self.revalidate_domain(req, now)?;

        // 5. Transport availability BEFORE consuming the approval.
        if !self.transport.available() {
            return Err(JobDispatchError::TransportUnavailable);
        }

        // 6. Consume exactly once with the full envelope bound.
        let material = req.material();
        let ctx = ConsumeContext {
            action: req.action().name(),
            target: req.target(),
            principal,
            payload: &body,
            session_ref,
            revision: req.revision(),
            artifact: req.artifact(),
            material: material.as_deref(),
            // Jobs carry no trusted snapshot/project anchor (noWriter lanes) —
            // S9.18-003 keeps job bindings None so legacy rows stay compatible.
            device_snapshot_ms: None,
            project_id: None,
        };
        let consumed = self.authority.consume(token, &ctx)?;

        // 7. Dispatch exactly once. Timeout/Indeterminate happen AFTER the
        //    consume; the approval is already spent and is never retried.
        match self.transport.dispatch(req) {
            TransportOutcome::Ack => Ok(JobReceipt {
                action: req.action(),
                token_hash: consumed.token_hash,
                outcome: TransportOutcome::Ack,
                observed: None,
            }),
            TransportOutcome::Refused(reason) => Ok(JobReceipt {
                action: req.action(),
                token_hash: consumed.token_hash,
                outcome: TransportOutcome::Refused(reason),
                observed: None,
            }),
            TransportOutcome::Timeout => Err(JobDispatchError::TransportTimeout),
            TransportOutcome::Indeterminate => Err(JobDispatchError::IndeterminateOutcome),
        }
    }

    /// Domain revalidation from a **trusted provider snapshot**, name by
    /// action. Denials here happen before transport availability and consume,
    /// so they never touch the transport and leave the approval pending.
    fn revalidate_domain(&self, req: &JobRequest, now: i64) -> Result<(), JobDispatchError> {
        match req {
            JobRequest::Start(intent, snap) => {
                self.revalidate_snapshot(snap, now)?;
                // Preview-only artifacts are blocked ALWAYS — regardless of
                // confirmation or session — and the approval stays pending.
                if intent.artifact_compatibility == ArtifactCompatibility::PreviewOnly {
                    return Err(JobDispatchError::PreviewOnlyBlocked);
                }
                // Start requires the machine idle AND qualified.
                if !snap.qualified {
                    return Err(JobDispatchError::Unqualified);
                }
                if snap.busy || snap.current_job_id.is_some() {
                    return Err(JobDispatchError::PrinterBusy);
                }
                Ok(())
            }
            JobRequest::Stop(intent, snap) => {
                self.revalidate_snapshot(snap, now)?;
                // Stop is allowed only when the snapshot OBSERVES the job —
                // no free-form stop target, no invented observation.
                if snap.current_job_id.as_deref() != Some(intent.job_id.as_str()) {
                    return Err(JobDispatchError::JobNotObserved);
                }
                Ok(())
            }
            JobRequest::Upload(_) | JobRequest::Queue(_) => Ok(()),
        }
    }

    fn revalidate_snapshot(
        &self,
        snap: &ProviderSnapshot,
        now: i64,
    ) -> Result<(), JobDispatchError> {
        if !snap.reachable {
            return Err(JobDispatchError::PrinterOffline);
        }
        if snap.captured_at_ms > now || now - snap.captured_at_ms > MAX_SNAPSHOT_AGE_MS {
            return Err(JobDispatchError::StaleSnapshot);
        }
        Ok(())
    }

    /// Securely dispatch a job effect for an **authenticated session** — the
    /// only external dispatch entry. Re-resolves the session NOW and requires
    /// the action's registry scope (see [`crate::action_registry`]); identity
    /// and session hash are bound from the verified session, never from a
    /// caller-supplied value.
    pub fn run_for_session(
        &self,
        auth: &auth_service::AuthDb,
        session_token: &str,
        token: &str,
        req: &JobRequest,
    ) -> Result<JobReceipt, JobDispatchError> {
        let session = crate::resolve::resolve_session(auth, session_token)
            .map_err(|e| JobDispatchError::SessionDenied(crate::resolve::reason(&e)))?;
        // Scope classes are owned by the action registry — never a
        // caller-supplied parameter.
        let Some(required) = crate::action_registry::required_scope(req.action().name()) else {
            return Err(JobDispatchError::InvalidAction(req.action().name()));
        };
        if !session.has_scope(required) {
            return Err(JobDispatchError::SessionDenied("scope"));
        }
        self.run(
            token,
            req,
            &session.principal(),
            Some(session.session_hash()),
        )
    }
}

impl fmt::Display for JobAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::test_support::{local_user, FakeClock, BASE};
    use crate::approval::{ApprovalAuthority, ApprovalError, IssueRequest, IssuedApproval};
    use crate::db::DbHandle;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn authority<'a>(db: &'a DbHandle, clock: &'a FakeClock) -> ApprovalAuthority<'a> {
        ApprovalAuthority::with_clock(db, clock.clock_fn())
    }

    fn gate<'d, 'a>(
        a: &'a ApprovalAuthority<'d>,
        t: &'a CountingJobTransport,
        clock: &FakeClock,
    ) -> JobDispatchGate<'d, 'a> {
        JobDispatchGate::with_clock(a, t, clock.clock_fn())
    }

    /// Auth repo sharing the gate's clock; grants `scope` to the user.
    fn session_auth(
        clock: &FakeClock,
        user: &str,
        scope: auth_service::Scope,
    ) -> auth_service::AuthDb {
        let mut adb =
            auth_service::AuthDb::open_in_memory_with_clock(clock.clock_fn()).expect("auth db");
        adb.upsert_user(user, "Session User").expect("upsert user");
        adb.grant_scope(user, scope).expect("grant scope");
        adb
    }

    fn issue_scoped(
        a: &ApprovalAuthority<'_>,
        adb: &auth_service::AuthDb,
        session_raw: &str,
        req: &JobRequest,
    ) -> IssuedApproval {
        let material = req.material();
        a.issue_for_session_scoped(
            adb,
            session_raw,
            &crate::approval::ScopedIssueRequest {
                action: req.action().name(),
                target: req.target(),
                purpose: "job session test",
                payload: &req.payload_value(),
                revision: req.revision(),
                artifact: req.artifact(),
                material: material.as_deref(),
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            },
        )
        .expect("issue_for_session_scoped")
    }

    /// Crate-level issue (no session) — identical envelope bindings.
    fn issue_job(
        a: &ApprovalAuthority<'_>,
        principal: Principal,
        req: &JobRequest,
    ) -> IssuedApproval {
        let body = req.payload_value();
        let material = req.material();
        a.issue(IssueRequest {
            action: req.action().name(),
            target: req.target(),
            principal,
            purpose: "job test",
            payload: &body,
            session_ref: None,
            revision: req.revision(),
            artifact: req.artifact(),
            material: material.as_deref(),
            device_snapshot_ms: None,
            project_id: None,
            ttl_ms: 60_000,
        })
        .expect("issue")
    }

    // ---- intent builders ----
    fn upload(artifact: u64, file_ref: &str, size: u64) -> UploadIntent {
        UploadIntent {
            artifact_sha256: format!("{artifact:064x}"),
            file_ref: file_ref.to_string(),
            exact_size_bytes: size,
        }
    }

    fn queue(artifact: u64, rev: u64, mapping: &[(&str, u8)]) -> QueueIntent {
        QueueIntent {
            artifact_sha256: format!("{artifact:064x}"),
            file_ref: "cloud-file-1".to_string(),
            profile_rev: rev,
            mode: PrintMode::Standard,
            material_mapping: mapping
                .iter()
                .map(|(m, s)| MaterialSlot {
                    slot_index: *s,
                    material_ref: m.to_string(),
                })
                .collect(),
        }
    }

    fn start(
        artifact: u64,
        printer: &str,
        queued: &str,
        rev: u64,
        compat: ArtifactCompatibility,
    ) -> StartIntent {
        StartIntent {
            queued_intent_id: queued.to_string(),
            printer_id: printer.to_string(),
            project_revision: rev,
            artifact_sha256: format!("{artifact:064x}"),
            artifact_compatibility: compat,
        }
    }

    fn stop(printer: &str, job_id: &str) -> StopIntent {
        StopIntent {
            printer_id: printer.to_string(),
            job_id: job_id.to_string(),
        }
    }

    fn snap(
        now_ms: i64,
        reachable: bool,
        qualified: bool,
        busy: bool,
        job: Option<&str>,
    ) -> ProviderSnapshot {
        ProviderSnapshot {
            captured_at_ms: now_ms,
            reachable,
            qualified,
            busy,
            current_job_id: job.map(str::to_string),
        }
    }

    // ---- mock transport: per-action counters, availability + scripted mode
    struct CountingJobTransport {
        total: AtomicUsize,
        by_action: Mutex<HashMap<JobAction, usize>>,
        avail: AtomicBool,
        mode: AtomicUsize, // 0 Ack, 1 Refused, 2 Timeout, 3 Indeterminate
    }

    impl CountingJobTransport {
        fn new(avail: bool) -> Self {
            Self {
                total: AtomicUsize::new(0),
                by_action: Mutex::new(HashMap::new()),
                avail: AtomicBool::new(avail),
                mode: AtomicUsize::new(0),
            }
        }
        fn total(&self) -> usize {
            self.total.load(Ordering::SeqCst)
        }
        fn calls_for(&self, a: JobAction) -> usize {
            self.by_action.lock().unwrap().get(&a).copied().unwrap_or(0)
        }
        fn set_avail(&self, b: bool) {
            self.avail.store(b, Ordering::SeqCst);
        }
        fn set_mode(&self, m: usize) {
            self.mode.store(m, Ordering::SeqCst);
        }
    }

    impl JobTransport for CountingJobTransport {
        fn available(&self) -> bool {
            self.avail.load(Ordering::SeqCst)
        }
        fn dispatch(&self, req: &JobRequest) -> TransportOutcome {
            self.total.fetch_add(1, Ordering::SeqCst);
            *self
                .by_action
                .lock()
                .unwrap()
                .entry(req.action())
                .or_insert(0) += 1;
            match self.mode.load(Ordering::SeqCst) {
                0 => TransportOutcome::Ack,
                1 => TransportOutcome::Refused("backend refused".into()),
                2 => TransportOutcome::Timeout,
                _ => TransportOutcome::Indeterminate,
            }
        }
    }

    fn pending_contains(a: &ApprovalAuthority<'_>, issued: &IssuedApproval) -> bool {
        a.pending_tokens("user-1")
            .expect("pending")
            .contains(&issued.token_hash)
    }

    // ---- tests ----

    #[test]
    fn job_action_names_are_closed_and_registry_scoped() {
        for (action, name, scope) in [
            (
                JobAction::Upload,
                "upload",
                auth_service::Scope::DeviceUpload,
            ),
            (JobAction::Queue, "job.queue", auth_service::Scope::PrintJob),
            (JobAction::Start, "job.start", auth_service::Scope::PrintJob),
            (JobAction::Stop, "job.stop", auth_service::Scope::PrintJob),
        ] {
            assert_eq!(action.name(), name);
            assert_eq!(JobAction::from_name(name), Some(action));
            assert_eq!(crate::action_registry::required_scope(name), Some(scope));
        }
        for bad in ["queue", "start", "job", "upload.again", ""] {
            assert_eq!(JobAction::from_name(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn allowlist_restricts_actions() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = JobDispatchGate::with_clock(&a, &t, clock.clock_fn())
            .with_allowlist(&[JobAction::Upload]);
        let p = local_user("user-1");
        let req = JobRequest::Queue(queue(1, 5, &[("pla", 0)]));
        let issued = issue_job(&a, p.clone(), &req);
        let err = g
            .run(&issued.token, &req, &p, None)
            .expect_err("pinned allowlist");
        assert_eq!(err, JobDispatchError::InvalidAction("job.queue"));
        assert_eq!(t.total(), 0);
        assert!(pending_contains(&a, &issued), "approval stays pending");
    }

    #[test]
    fn upload_accepts_typed_cas_and_denies_urls_paths_hashes_and_unknown_fields() {
        // The serde boundary denies unknown fields at the type level.
        let mut spoofed = serde_json::json!({
            "artifact_sha256": format!("{:064x}", 1_u64),
            "file_ref": "cloud-file-1",
            "exact_size_bytes": 42_u64,
            "hacked": true,
        });
        assert!(serde_json::from_value::<UploadIntent>(spoofed.clone()).is_err());
        spoofed.as_object_mut().unwrap().remove("hacked");
        assert!(serde_json::from_value::<UploadIntent>(spoofed).is_ok());

        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");
        let good = upload(1, "cloud-file-1", 42);
        let req = JobRequest::Upload(good.clone());
        let issued = issue_job(&a, p.clone(), &req);

        // Every bad form is refused before transport; the approval survives.
        let bad_forms: Vec<UploadIntent> = vec![
            upload(1, "https://evil.example/artifact", 42), // URL
            upload(1, "C:\\windows\\artifact", 42),         // path
            upload(1, "/etc/artifact", 42),                 // path
            upload(1, "cloud file 1", 42),                  // whitespace
            UploadIntent {
                artifact_sha256: "A".repeat(64), // uppercase hex refused
                file_ref: "cloud-file-1".into(),
                exact_size_bytes: 42,
            },
            UploadIntent {
                artifact_sha256: format!("{:032x}", 1_u64), // wrong length
                file_ref: "cloud-file-1".into(),
                exact_size_bytes: 42,
            },
            upload(1, "cloud-file-1", 0),
            upload(1, "cloud-file-1", MAX_UPLOAD_BYTES + 1),
        ];
        for bad in bad_forms {
            let err = g
                .run(&issued.token, &JobRequest::Upload(bad), &p, None)
                .expect_err("bad upload must be refused");
            assert_eq!(err, JobDispatchError::InvalidPayload);
            assert_eq!(t.total(), 0, "a denial must never reach the transport");
            assert!(pending_contains(&a, &issued), "approval stays pending");
        }

        // The same token then grants exactly one dispatch.
        let receipt = g
            .run(&issued.token, &JobRequest::Upload(good), &p, None)
            .expect("valid upload");
        assert_eq!(receipt.action, JobAction::Upload);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(receipt.observed, None, "Ack never claims observation");
        assert_eq!(t.total(), 1);
        assert_eq!(t.calls_for(JobAction::Upload), 1);
    }

    #[test]
    fn unavailable_transport_never_consumes() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(false); // unavailable
        let g = gate(&a, &t, &clock);
        let mut adb = session_auth(&clock, "user-1", auth_service::Scope::DeviceUpload);
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceUpload, 60_000)
            .expect("session");
        let req = JobRequest::Upload(upload(1, "cloud-file-1", 42));
        let issued = issue_scoped(&a, &adb, session.raw(), &req);

        let err = g
            .run_for_session(&adb, session.raw(), &issued.token, &req)
            .expect_err("unavailable transport");
        assert_eq!(err, JobDispatchError::TransportUnavailable);
        assert_eq!(t.total(), 0);
        assert!(pending_contains(&a, &issued), "approval stays pending");

        // Backend becomes available → the SAME token grants, exactly once.
        t.set_avail(true);
        let receipt = g
            .run_for_session(&adb, session.raw(), &issued.token, &req)
            .expect("available");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(t.total(), 1);
        assert!(
            g.run_for_session(&adb, session.raw(), &issued.token, &req)
                .is_err(),
            "one-use"
        );
        assert_eq!(t.total(), 1);
    }

    #[test]
    fn preview_only_start_blocked_always_zero_transport_approval_pending() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");
        // Preview-only artifact, otherwise fully valid snapshot.
        let req = JobRequest::Start(
            start(
                3,
                "printer-ace-1",
                "queued-7",
                5,
                ArtifactCompatibility::PreviewOnly,
            ),
            snap(BASE, true, true, false, None),
        );
        let issued = issue_job(&a, p.clone(), &req);

        let err = g
            .run(&issued.token, &req, &p, None)
            .expect_err("preview-only");
        assert_eq!(err, JobDispatchError::PreviewOnlyBlocked);
        assert_eq!(t.total(), 0, "preview-only must never reach transport");
        assert!(pending_contains(&a, &issued), "approval stays pending");
    }

    #[test]
    fn start_revalidates_trusted_snapshot() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");

        let inten = |snap: ProviderSnapshot| {
            JobRequest::Start(
                start(
                    3,
                    "printer-ace-1",
                    "queued-7",
                    5,
                    ArtifactCompatibility::Ready,
                ),
                snap,
            )
        };
        // Every bad snapshot is refused with zero transport; the approval is
        // re-usable for each case because none of them consume it.
        let issued = issue_job(&a, p.clone(), &inten(snap(BASE, true, true, false, None)));

        let bad_snapshots: Vec<ProviderSnapshot> = vec![
            snap(BASE, false, true, false, None),          // offline
            snap(BASE - 120_000, true, true, false, None), // stale
            snap(BASE + 5_000, true, true, false, None),   // future
            snap(BASE, true, false, false, None),          // not qualified
            snap(BASE, true, true, true, None),            // busy
            snap(BASE, true, true, false, Some("job-9")),  // another job running
            ProviderSnapshot::unavailable(BASE),
        ];
        for bad in bad_snapshots {
            let expected = match &bad {
                s if !s.reachable => JobDispatchError::PrinterOffline,
                s if s.captured_at_ms != BASE => JobDispatchError::StaleSnapshot,
                s if !s.qualified => JobDispatchError::Unqualified,
                s if s.busy || s.current_job_id.is_some() => JobDispatchError::PrinterBusy,
                _ => unreachable!("all cases enumerated"),
            };
            let err = g
                .run(&issued.token, &inten(bad), &p, None)
                .expect_err("bad snapshot");
            assert_eq!(err, expected);
            assert_eq!(t.total(), 0, "a denial must never reach the transport");
            assert!(pending_contains(&a, &issued), "approval stays pending");
        }

        // A fresh, qualified, idle snapshot grants exactly one start.
        let receipt = g
            .run(
                &issued.token,
                &inten(snap(BASE, true, true, false, None)),
                &p,
                None,
            )
            .expect("valid start");
        assert_eq!(receipt.action, JobAction::Start);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(receipt.observed, None);
        assert_eq!(t.total(), 1);
        assert_eq!(t.calls_for(JobAction::Start), 1);
    }

    #[test]
    fn stop_matches_only_the_observed_job() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");

        let req = JobRequest::Stop(
            stop("printer-ace-1", "job-9"),
            snap(BASE, true, true, true, Some("job-9")),
        );
        let issued = issue_job(&a, p.clone(), &req);

        // Wrong job id (or none observed) → denied with zero transport.
        for (job, snappy, err) in [
            (
                "job-8",
                snap(BASE, true, true, true, Some("job-9")),
                JobDispatchError::JobNotObserved,
            ),
            (
                "job-9",
                snap(BASE, true, true, false, None),
                JobDispatchError::JobNotObserved,
            ),
            (
                "job-9",
                snap(BASE, false, true, true, Some("job-9")),
                JobDispatchError::PrinterOffline,
            ),
        ] {
            let bad = JobRequest::Stop(stop("printer-ace-1", job), snappy);
            assert_eq!(
                g.run(&issued.token, &bad, &p, None)
                    .expect_err("mismatched stop"),
                err
            );
            assert_eq!(t.total(), 0);
            assert!(pending_contains(&a, &issued));
        }

        // The observed job id grants exactly one stop.
        let receipt = g.run(&issued.token, &req, &p, None).expect("observed stop");
        assert_eq!(receipt.action, JobAction::Stop);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(receipt.observed, None);
        assert_eq!(t.total(), 1);
        assert_eq!(t.calls_for(JobAction::Stop), 1);
    }

    #[test]
    fn queue_artifact_revision_and_mapping_changes_deny_zero_calls() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");

        let req = JobRequest::Queue(queue(7, 5, &[("pla", 0), ("abs", 1)]));
        let issued = issue_job(&a, p.clone(), &req);

        // Artifact swapped → the queue's artifact IS the approval target, so
        // a different artifact is a target mismatch (zero transport).
        let swapped = JobRequest::Queue(queue(8, 5, &[("pla", 0), ("abs", 1)]));
        assert!(matches!(
            g.run(&issued.token, &swapped, &p, None)
                .expect_err("artifact"),
            JobDispatchError::Approval(ApprovalError::ContextChanged("target"))
        ));
        // Profile revision changed → payload digest mismatch.
        let rev_changed = JobRequest::Queue(queue(7, 6, &[("pla", 0), ("abs", 1)]));
        assert!(matches!(
            g.run(&issued.token, &rev_changed, &p, None)
                .expect_err("revision"),
            JobDispatchError::Approval(ApprovalError::ContextChanged("payload_digest"))
        ));
        // Material mapping changed → payload digest mismatch.
        let map_changed = JobRequest::Queue(queue(7, 5, &[("pla", 0)]));
        assert!(matches!(
            g.run(&issued.token, &map_changed, &p, None)
                .expect_err("mapping"),
            JobDispatchError::Approval(ApprovalError::ContextChanged("payload_digest"))
        ));
        assert_eq!(t.total(), 0, "no denial may reach the transport");
        assert!(pending_contains(&a, &issued));

        // The exact frozen queue grants exactly one dispatch.
        let receipt = g.run(&issued.token, &req, &p, None).expect("valid queue");
        assert_eq!(receipt.action, JobAction::Queue);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(t.total(), 1);
        assert_eq!(t.calls_for(JobAction::Queue), 1);
    }

    #[test]
    fn queue_material_binding_rejects_foreign_material() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");
        let req = JobRequest::Queue(queue(7, 5, &[("pla", 0)]));

        // An approval minted with a foreign material binding cannot consume a
        // queue whose mapping digest differs.
        let body = req.payload_value();
        let issued = a
            .issue(IssueRequest {
                action: req.action().name(),
                target: req.target(),
                principal: p.clone(),
                purpose: "foreign material",
                payload: &body,
                session_ref: None,
                revision: None,
                artifact: req.artifact(),
                material: Some("foreign-material-digest"),
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            })
            .expect("issue");

        assert!(matches!(
            g.run(&issued.token, &req, &p, None).expect_err("material"),
            JobDispatchError::Approval(ApprovalError::ContextChanged("material"))
        ));
        assert_eq!(t.total(), 0);
        assert!(pending_contains(&a, &issued));
    }

    #[test]
    fn wrong_scope_denied_even_with_valid_control_session() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);

        // A PrintJob session legitimately mints a job.start approval.
        let mut adb = session_auth(&clock, "user-1", auth_service::Scope::PrintJob);
        let job_session = adb
            .create_session("user-1", auth_service::Scope::PrintJob, 60_000)
            .expect("print session");
        let req = JobRequest::Start(
            start(
                3,
                "printer-ace-1",
                "queued-7",
                5,
                ArtifactCompatibility::Ready,
            ),
            snap(BASE, true, true, false, None),
        );
        let issued = issue_scoped(&a, &adb, job_session.raw(), &req);

        // A valid DeviceControl session canNOT run it — scope check happens
        // before any consume/transport, and the approval stays pending.
        adb.grant_scope("user-1", auth_service::Scope::DeviceControl)
            .expect("grant control");
        let ctl_session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("control session");
        let err = g
            .run_for_session(&adb, ctl_session.raw(), &issued.token, &req)
            .expect_err("control session must not start prints");
        assert_eq!(err, JobDispatchError::SessionDenied("scope"));
        assert_eq!(t.total(), 0);
        assert!(pending_contains(&a, &issued));

        // The issuing PrintJob session still grants the SAME token.
        t.set_avail(true);
        let receipt = g
            .run_for_session(&adb, job_session.raw(), &issued.token, &req)
            .expect("print session start");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(t.total(), 1);
    }

    #[test]
    fn upload_ack_never_queues_or_starts() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");
        let req = JobRequest::Upload(upload(1, "cloud-file-1", 42));
        let issued = issue_job(&a, p.clone(), &req);

        let receipt = g.run(&issued.token, &req, &p, None).expect("upload");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(t.total(), 1, "exactly one effect dispatched");
        assert_eq!(t.calls_for(JobAction::Queue), 0, "no auto-queue");
        assert_eq!(t.calls_for(JobAction::Start), 0, "no auto-start");
        assert_eq!(t.calls_for(JobAction::Stop), 0);
    }

    #[test]
    fn queue_ack_never_starts() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");
        let req = JobRequest::Queue(queue(7, 5, &[("pla", 0)]));
        let issued = issue_job(&a, p.clone(), &req);

        let receipt = g.run(&issued.token, &req, &p, None).expect("queue");
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(t.total(), 1, "exactly one effect dispatched");
        assert_eq!(t.calls_for(JobAction::Start), 0, "no auto-start");
        assert_eq!(t.calls_for(JobAction::Stop), 0);
    }

    #[test]
    fn every_auth_denial_stays_zero_transport_and_pending() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let p = local_user("user-1");
        let req = JobRequest::Upload(upload(1, "cloud-file-1", 42));
        let token = issue_job(&a, p.clone(), &req);

        // Unknown token.
        assert!(matches!(
            g.run(&"c".repeat(64), &req, &p, None).expect_err("unknown"),
            JobDispatchError::Approval(ApprovalError::UnknownToken)
        ));
        // Wrong target (a different artifact) → context mismatch.
        let wrong_target = JobRequest::Upload(upload(2, "cloud-file-1", 42));
        assert!(matches!(
            g.run(&token.token, &wrong_target, &p, None)
                .expect_err("target"),
            JobDispatchError::Approval(ApprovalError::ContextChanged("target"))
        ));
        assert_eq!(t.total(), 0);

        // Expired after TTL.
        clock.advance(60_001);
        assert_eq!(
            g.run(&token.token, &req, &p, None).expect_err("expired"),
            JobDispatchError::Approval(ApprovalError::Expired)
        );
        assert_eq!(t.total(), 0);
        // Pending still reports it (unconsumed; expiry is rechecked on the
        // recovered clock — here intentionally at BASE + 60_001).
        assert!(pending_contains(&a, &token));

        // Revoked.
        let token2 = issue_job(&a, p.clone(), &req);
        a.revoke(&token2.token).expect("revoke");
        assert_eq!(
            g.run(&token2.token, &req, &p, None).expect_err("revoked"),
            JobDispatchError::Approval(ApprovalError::Revoked)
        );
        assert_eq!(t.total(), 0);

        // Replay of a consumed approval.
        let token3 = issue_job(&a, p.clone(), &req);
        g.run(&token3.token, &req, &p, None).expect("first grant");
        assert_eq!(t.total(), 1);
        assert_eq!(
            g.run(&token3.token, &req, &p, None).expect_err("replay"),
            JobDispatchError::Approval(ApprovalError::AlreadyConsumed)
        );
        assert_eq!(t.total(), 1, "replay must not re-dispatch");
    }

    #[test]
    fn timeout_and_indeterminate_are_consumed_never_retried() {
        for (mode, expected) in [
            (2_usize, JobDispatchError::TransportTimeout),
            (3_usize, JobDispatchError::IndeterminateOutcome),
        ] {
            let clock = FakeClock::new(BASE);
            let db = DbHandle::open_in_memory().expect("db");
            let a = authority(&db, &clock);
            let t = CountingJobTransport::new(true);
            t.set_mode(mode);
            let g = gate(&a, &t, &clock);
            let p = local_user("user-1");
            let req = JobRequest::Queue(queue(7, 5, &[("pla", 0)]));
            let token = issue_job(&a, p.clone(), &req);

            let err = g
                .run(&token.token, &req, &p, None)
                .expect_err("indeterminate");
            assert_eq!(err, expected);
            assert_eq!(t.total(), 1, "dispatched exactly once");
            assert!(!pending_contains(&a, &token), "approval was spent");

            // The adapter starts acking, but the token is already consumed →
            // no blind retry.
            t.set_mode(0);
            assert_eq!(
                g.run(&token.token, &req, &p, None).expect_err("no retry"),
                JobDispatchError::Approval(ApprovalError::AlreadyConsumed)
            );
            assert_eq!(t.total(), 1, "no second dispatch");
        }
    }

    #[test]
    fn run_for_session_binds_verified_session_and_round_trips() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t = CountingJobTransport::new(true);
        let g = gate(&a, &t, &clock);
        let mut adb = session_auth(&clock, "user-1", auth_service::Scope::PrintJob);
        let session = adb
            .create_session("user-1", auth_service::Scope::PrintJob, 60_000)
            .expect("session");
        let req = JobRequest::Stop(
            stop("printer-ace-1", "job-9"),
            snap(BASE, true, true, true, Some("job-9")),
        );
        let issued = issue_scoped(&a, &adb, session.raw(), &req);

        let receipt = g
            .run_for_session(&adb, session.raw(), &issued.token, &req)
            .expect("authorized stop");
        assert_eq!(receipt.token_hash, issued.token_hash);
        assert_eq!(receipt.outcome, TransportOutcome::Ack);
        assert_eq!(receipt.observed, None);
        assert_eq!(t.total(), 1);
        assert_eq!(t.calls_for(JobAction::Stop), 1);

        // One-use.
        assert!(g
            .run_for_session(&adb, session.raw(), &issued.token, &req)
            .is_err());
        assert_eq!(t.total(), 1);
    }
}
