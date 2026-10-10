//! Backend approval authority — one-use, expiring, payload-bound (S9.18-003
//! slice; informs S9.17-003 DEV-04/DEV-07 and S9.17-003's own partial work).
//!
//! Protected writes (device control, print/job dispatch, uploads) must be
//! authorized by an opaque, expiring, one-use backend token bound to the exact
//! action, normalized payload digest, target and principal — never by a textual
//! `confirm` flag in the request itself. This module is that authority.
//!
//! Design notes:
//! - Issuance is gated on an identified auth principal (the real
//!   [`auth_service::Principal`] type from the auth tenant); anonymous
//!   issuance is refused. Broker never holds auth credentials or BYOK keys —
//!   it only *types* approval identity against the tenant's `Principal`.
//! - The token is 32 bytes of OS RNG ([`getrandom`]), hex-encoded (64 chars).
//!   Only its SHA-256 hash is persisted, never the raw token; a leaked DB does
//!   not leak consumable tokens.
//! - The payload binding is the SHA-256 digest of the canonicalized (recursively
//!   key-sorted, compact) args JSON; `consume` re-derives the digest from the
//!   exact args that would be dispatched, so execution-time revalidation is
//!   guaranteed (S9.17-003 frozen-payload revalidation).
//! - Every `consume` re-validates the frozen envelope (payload digest, target,
//!   principal, optional session/revision/artifact/material), expiry, revocation
//!   and one-use state, then applies a conditional `UPDATE ... WHERE
//!   consumed_ms IS NULL` inside a `BEGIN IMMEDIATE` transaction. The UPDATE is
//!   the atomic gate: exactly one concurrent consumer can ever win.
//! - All denials occur before any transport dispatch; this module contains no
//!   transport code at all (the "zero controlled transport calls on denial"
//!   property is structural).
//! - Token shape is strict: exactly [`TOKEN_HEX_LEN`] ASCII hex chars (32
//!   bytes) or the consume/revoke path refuses with
//!   [`ApprovalError::InvalidToken`] — no unbounded-length or malformed token
//!   ever reaches the DB lookup.
//! - Clock validation is fail-closed: issuance refuses a non-positive clock
//!   and uses checked arithmetic ([`ApprovalError::InvalidClock`]); `consume`
//!   refuses `now < issued_ms` (rollback) without consuming, so a pending
//!   approval can still be used once the clock recovers, and an expired
//!   approval is never revived from a rolled-back clock.
//! - Identifiers (action/target/purpose/principal id) must be non-empty and
//!   bounded ([`MAX_IDENTIFIER_LEN`]); `issue` never mints a blank record.
//! - [`IssuedApproval`] has a secret-safe `Debug` impl (raw token masked);
//!   `Serialize` is retained only for an explicit future command response —
//!   logs must never contain the raw token.
//! - No MCP tool or Tauri command exposes issuance yet — this is a broker
//!   internal API. External issuance is intentionally unavailable; this slice
//!   is the authority, not the production-ready approval flow.

use auth_service::Principal;
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::db::DbHandle;

/// Default approval lifetime when the caller does not pick one (ms).
pub const DEFAULT_TTL_MS: u64 = 60_000;
/// Hard upper bound for an approval lifetime (ms).
pub const MAX_TTL_MS: u64 = 600_000;

/// Token shape: 32 bytes of OS RNG, hex-encoded (64 ASCII hex chars). Any
/// other length or non-hex input is refused before the DB lookup.
pub const TOKEN_BYTES: usize = 32;
pub const TOKEN_HEX_LEN: usize = TOKEN_BYTES * 2;

/// Upper bound for identifier strings (action/target/purpose/principal id and
/// any bound optional reference). Prevents unbounded row keys/slugs.
pub const MAX_IDENTIFIER_LEN: usize = 256;

/// Epoch-millis clock used for issue/expiry (injectable, e.g. in tests).
pub type Clock = Box<dyn Fn() -> i64>;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Why an approval was refused. Every variant is a denial raised before any
/// transport dispatch.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApprovalError {
    #[error("approval issuance requires an identified principal")]
    MissingPrincipal,
    #[error("unknown approval token")]
    UnknownToken,
    #[error("approval already consumed (one-use)")]
    AlreadyConsumed,
    #[error("approval revoked")]
    Revoked,
    #[error("approval expired")]
    Expired,
    #[error("session denied: {0}")]
    SessionDenied(&'static str),
    #[error("approval context changed: {0}")]
    ContextChanged(&'static str),
    #[error("ttl out of bounds (0 < ttl_ms <= {MAX_TTL_MS})")]
    InvalidTtl,
    #[error("invalid token shape (expected {TOKEN_HEX_LEN} ascii hex chars)")]
    InvalidToken,
    #[error("invalid request: {0}")]
    InvalidRequest(&'static str),
    #[error("clock anomaly - cannot issue/consume at this time")]
    InvalidClock,
    #[error("operating-system randomness unavailable")]
    Rng,
    #[error("database error: {0}")]
    Db(String),
}

impl From<rusqlite::Error> for ApprovalError {
    fn from(e: rusqlite::Error) -> Self {
        ApprovalError::Db(e.to_string())
    }
}

/// Request to mint a fresh approval (never written to the DB as-is).
#[derive(Debug, Clone)]
pub struct IssueRequest<'a> {
    /// Typed action identifier, e.g. `device.command` / `print.start`.
    pub action: &'a str,
    /// Target identity (device/profile/endpoint id).
    pub target: &'a str,
    /// Resolution of the actual auth owner; must be identified.
    pub principal: Principal,
    /// Human-readable effect shown by the future approval UI.
    pub purpose: &'a str,
    /// Exact args that would be dispatched; the normalized digest is bound.
    pub payload: &'a Value,
    /// Optional session/binding ref. Empty at issue means none; any value at
    /// issue must be re-supplied identically at consume.
    pub session_ref: Option<&'a str>,
    /// Optional project revision to freeze.
    pub revision: Option<u64>,
    /// Optional artifact reference (file id / content hash).
    pub artifact: Option<&'a str>,
    /// Optional material binding.
    pub material: Option<&'a str>,
    /// Exact epoch-ms the trusted backend captured the context snapshot this
    /// approval was issued against. `None` = no snapshot bound (legacy/generic
    /// paths); when the trusted device writer is involved this MUST be
    /// `Some(positive)`.
    pub device_snapshot_ms: Option<i64>,
    /// Trusted project id the approval is scoped to (from the resolver's
    /// DeviceContext, never a caller claim). `None` = no project binding
    /// (legacy/generic paths).
    pub project_id: Option<&'a str>,
    /// Lifetime in ms; 0 selects [`DEFAULT_TTL_MS`].
    pub ttl_ms: u64,
}

/// Request to mint a fresh approval for an **authenticated session**. Unlike
/// [`IssueRequest`], there is no caller-supplied `principal`/`session_ref`:
/// both are resolved from the session by
/// [`ApprovalAuthority::issue_for_session_scoped`]. The caller never invents
/// identity.
#[derive(Debug, Clone)]
pub struct ScopedIssueRequest<'a> {
    /// Typed action identifier, e.g. `nozzle` / `job.start` / `upload`.
    pub action: &'a str,
    /// Target identity (device/profile/endpoint id).
    pub target: &'a str,
    /// Human-readable effect shown by the future approval UI.
    pub purpose: &'a str,
    /// Exact args that would be dispatched; the normalized digest is bound.
    pub payload: &'a Value,
    /// Optional project revision to freeze.
    pub revision: Option<u64>,
    /// Optional artifact reference (file id / content hash).
    pub artifact: Option<&'a str>,
    /// Optional material binding.
    pub material: Option<&'a str>,
    /// Exact epoch-ms the trusted backend captured the context snapshot this
    /// approval was issued against (see [`IssueRequest::device_snapshot_ms`]).
    pub device_snapshot_ms: Option<i64>,
    /// Trusted project id (see [`IssueRequest::project_id`]).
    pub project_id: Option<&'a str>,
    /// Lifetime in ms; 0 selects [`DEFAULT_TTL_MS`].
    pub ttl_ms: u64,
}

/// The exact envelope that must be re-supplied at consumption.
#[derive(Debug, Clone)]
pub struct ConsumeContext<'a> {
    pub action: &'a str,
    pub target: &'a str,
    pub principal: &'a Principal,
    /// Exact args that would be dispatched right now.
    pub payload: &'a Value,
    pub session_ref: Option<&'a str>,
    pub revision: Option<u64>,
    pub artifact: Option<&'a str>,
    pub material: Option<&'a str>,
    pub device_snapshot_ms: Option<i64>,
    pub project_id: Option<&'a str>,
}

/// A successfully minted approval. `token` is the only secret and is never
/// persisted in raw form — only [`IssuedApproval::token_hash`] is.///
/// `Debug` is secret-safe: the raw token prints as `<redacted>`, so an
/// incidental `{approval:?}` log line can never leak a consumable token.
/// `Serialize` is retained for a future explicit command response — never
/// for logging; audit/tenant code must not emit the raw token.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct IssuedApproval {
    pub token: String,
    pub token_hash: String,
    pub payload_digest: String,
    pub expires_ms: i64,
}

impl std::fmt::Debug for IssuedApproval {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedApproval")
            .field("token", &"<redacted>")
            .field("token_hash", &self.token_hash)
            .field("payload_digest", &self.payload_digest)
            .field("expires_ms", &self.expires_ms)
            .finish()
    }
}

/// The granted consumption, for audit logging (already redacted of any secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConsumedApproval {
    pub token_hash: String,
    pub principal: String,
    pub action: String,
    pub target: String,
    pub payload_digest: String,
    pub purpose: String,
}

/// Row projection for the `approvals` table. Fields like `token_hash`/
/// `issued_ms` are kept for the audit surface even when a given code path
/// currently consumes only a subset.
#[allow(dead_code)]
#[derive(Debug)]
struct ApprovalRow {
    token_hash: String,
    principal: String,
    action: String,
    payload_digest: String,
    target: String,
    purpose: String,
    session_ref: Option<String>,
    revision: Option<i64>,
    artifact: Option<String>,
    material: Option<String>,
    device_snapshot_ms: Option<i64>,
    project_id: Option<String>,
    issued_ms: i64,
    expires_ms: i64,
    consumed_ms: Option<i64>,
    revoked: bool,
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalRow> {
    Ok(ApprovalRow {
        token_hash: r.get(0)?,
        principal: r.get(1)?,
        action: r.get(2)?,
        payload_digest: r.get(3)?,
        target: r.get(4)?,
        purpose: r.get(5)?,
        session_ref: r.get(6)?,
        revision: r.get(7)?,
        artifact: r.get(8)?,
        material: r.get(9)?,
        device_snapshot_ms: r.get(10)?,
        project_id: r.get(11)?,
        issued_ms: r.get(12)?,
        expires_ms: r.get(13)?,
        consumed_ms: r.get(14)?,
        revoked: r.get(15)?,
    })
}

/// Recursively sort object keys (defense in depth; default serde_json maps are
/// already BTreeMap-ordered) and emit compact JSON for a stable digest.
/// Crate-visible so the job dispatch gate can bind e.g. material mappings
/// with the exact same canonical form.
pub(crate) fn canonicalize(value: &Value) -> String {
    fn sort(v: &mut Value) {
        match v {
            Value::Object(map) => {
                let mut pairs: Vec<(String, Value)> = map
                    .iter_mut()
                    .map(|(k, val)| {
                        sort(val);
                        (k.clone(), val.clone())
                    })
                    .collect();
                pairs.sort_by(|a, b| a.0.cmp(&b.0));
                *map = serde_json::Map::from_iter(pairs);
            }
            Value::Array(items) => {
                for item in items.iter_mut() {
                    sort(item);
                }
            }
            _ => {}
        }
    }
    let mut v = value.clone();
    sort(&mut v);
    // serde_json::to_string on a Value cannot fail for a valid cloned Value.
    serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_owned())
}

fn digest_hex(canonical_json: &str) -> String {
    hex::encode(Sha256::digest(canonical_json.as_bytes()))
}

/// SHA-256 hex digest of a canonicalized value (crate-visible for the same
/// reason as [`canonicalize`]).
pub(crate) fn digest_value(value: &Value) -> String {
    digest_hex(&canonicalize(value))
}

fn hash_token_hex(decoded: &[u8]) -> String {
    hex::encode(Sha256::digest(decoded))
}

fn new_token() -> Result<(String, String), ApprovalError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| ApprovalError::Rng)?;
    let token = hex::encode(bytes);
    let token_hash = hash_token_hex(&bytes);
    Ok((token, token_hash))
}

/// Strict token decoding: exactly [`TOKEN_HEX_LEN`] ASCII hex chars — nothing
/// shorter, longer or non-hex. Malformed inputs map to
/// [`ApprovalError::InvalidToken`]; the DB lookup is only reached with a
/// well-formed digest input.
fn decode_token(token: &str) -> Result<[u8; TOKEN_BYTES], ApprovalError> {
    if token.len() != TOKEN_HEX_LEN || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApprovalError::InvalidToken);
    }
    let mut out = [0u8; TOKEN_BYTES];
    hex::decode_to_slice(token, &mut out).map_err(|_| ApprovalError::InvalidToken)?;
    Ok(out)
}

fn validate_identifier(s: &str, field: &'static str) -> Result<(), ApprovalError> {
    if s.is_empty() || s.len() > MAX_IDENTIFIER_LEN {
        return Err(ApprovalError::InvalidRequest(field));
    }
    Ok(())
}

/// Backend-owned approval authority. Stateless over a [`DbHandle`]; all state
/// lives in the workspace DB (`approvals` table, schema v5).
pub struct ApprovalAuthority<'a> {
    db: &'a DbHandle,
    clock: Clock,
}

impl<'a> ApprovalAuthority<'a> {
    pub fn new(db: &'a DbHandle) -> Self {
        Self {
            db,
            clock: Box::new(now_ms),
        }
    }

    /// Inject a deterministic clock (public for the broker's own tests; the
    /// clock can be an owned closure, so each test gets a private one).
    pub fn with_clock(db: &'a DbHandle, clock: impl Fn() -> i64 + 'static) -> Self {
        Self {
            db,
            clock: Box::new(clock),
        }
    }

    /// Mint a fresh one-use approval. Refused when the principal is anonymous
    /// ([`ApprovalError::MissingPrincipal`]), an identifier is empty or
    /// oversized ([`ApprovalError::InvalidRequest`]), the revision does not
    /// fit i64, the TTL is out of bounds, or the clock is anomalous
    /// ([`ApprovalError::InvalidClock`]).
    ///
    /// `principal` is a trusted internal API — the caller resolves the real
    /// auth owner from the authenticated session; it is never parsed from
    /// caller-supplied JSON. **This method is crate-internal on purpose.**
    /// The only externally reachable issuance entry is
    /// [`ApprovalAuthority::issue_for_session_scoped`] (which resolves the
    /// session via `auth_service::AuthDb` before ever minting an approval — a
    /// caller-supplied `Principal` cannot reach here).
    pub(crate) fn issue(&self, req: IssueRequest<'_>) -> Result<IssuedApproval, ApprovalError> {
        let ttl = if req.ttl_ms == 0 {
            DEFAULT_TTL_MS
        } else {
            req.ttl_ms
        };
        if ttl > MAX_TTL_MS {
            return Err(ApprovalError::InvalidTtl);
        }
        let principal = match &req.principal {
            Principal::Anonymous => return Err(ApprovalError::MissingPrincipal),
            Principal::Local { user_id } => {
                validate_identifier(user_id, "principal")?;
                user_id.as_str()
            }
        };
        // Never mint a blank/oversized record.
        validate_identifier(req.action, "action")?;
        validate_identifier(req.target, "target")?;
        validate_identifier(req.purpose, "purpose")?;
        if let Some(v) = req.session_ref {
            if v.len() > MAX_IDENTIFIER_LEN {
                return Err(ApprovalError::InvalidRequest("session"));
            }
        }
        if let Some(v) = req.artifact {
            if v.len() > MAX_IDENTIFIER_LEN {
                return Err(ApprovalError::InvalidRequest("artifact"));
            }
        }
        if let Some(v) = req.material {
            if v.len() > MAX_IDENTIFIER_LEN {
                return Err(ApprovalError::InvalidRequest("material"));
            }
        }
        if let Some(v) = req.project_id {
            if v.len() > MAX_IDENTIFIER_LEN {
                return Err(ApprovalError::InvalidRequest("project_id"));
            }
        }
        // Checked u64 → i64: a revision that cannot fit i64 is a denial,
        // never a silent cast.
        let revision_i64 = req
            .revision
            .map(i64::try_from)
            .transpose()
            .map_err(|_| ApprovalError::InvalidRequest("revision"))?;

        // Issuance clock must be non-negative and expiry must not overflow;
        // saturating arithmetic would silently mask a broken clock.
        let now_i64 = (self.clock)();
        let now = u64::try_from(now_i64).map_err(|_| ApprovalError::InvalidClock)?;
        let expires = now.checked_add(ttl).ok_or(ApprovalError::InvalidClock)?;
        let expires_ms = i64::try_from(expires).map_err(|_| ApprovalError::InvalidClock)?;

        let (token, token_hash) = new_token()?;
        let payload_digest = digest_hex(&canonicalize(req.payload));

        self.db.conn().execute(
            "INSERT INTO approvals (
                    token_hash, principal, action, payload_digest, target, purpose,
                    session_ref, revision, artifact, material,
                    device_snapshot_ms, project_id,
                    issued_ms, expires_ms, consumed_ms, revoked
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, 0)",
            rusqlite::params![
                token_hash,
                principal,
                req.action,
                payload_digest,
                req.target,
                req.purpose,
                req.session_ref,
                revision_i64,
                req.artifact,
                req.material,
                req.device_snapshot_ms,
                req.project_id,
                now_i64,
                expires_ms,
            ],
        )?;

        Ok(IssuedApproval {
            token,
            token_hash,
            payload_digest,
            expires_ms,
        })
    }

    /// Securely mint an approval for an **authenticated session** — the only
    /// external issuance entry. Resolves the session NOW via the auth
    /// repository, and only then mints (with principal + session hash bound).
    /// A caller-supplied `Principal` never reaches
    /// [`ApprovalAuthority::issue`] from here.
    ///
    /// The required scope is derived **privately** from the stored `action`
    /// name via [`crate::action_registry::required_scope`] — the caller never
    /// supplies a scope parameter, so authorization for every effect is
    /// decided by the action registry, not by the requester. Unknown actions
    /// are refused before anything can be minted (`InvalidRequest("action")`).
    ///
    /// `session_token` is the raw session token handed to the command path
    /// (never persisted by the delegate); the approval is bound to its
    /// non-secret SHA-256 hash. Returns `SessionDenied(reason)` for every
    /// refused resolution — a generic variant, never the token.
    pub fn issue_for_session_scoped(
        &self,
        auth: &auth_service::AuthDb,
        session_token: &str,
        req: &ScopedIssueRequest<'_>,
    ) -> Result<IssuedApproval, ApprovalError> {
        let session = crate::resolve::resolve_session(auth, session_token)
            .map_err(|e| ApprovalError::SessionDenied(crate::resolve::reason(&e)))?;
        // Scope classes are owned by the action registry — never a
        // caller-visible parameter.
        let Some(required) = crate::action_registry::required_scope(req.action) else {
            return Err(ApprovalError::InvalidRequest("action"));
        };
        if !session.has_scope(required) {
            return Err(ApprovalError::SessionDenied("scope"));
        }
        // Device-writer trust starts here: for DeviceControl-scope effects the
        // approval MUST be anchored to a positive trusted snapshot and a
        // project id taken from the backend-resolved DeviceContext (never a
        // caller claim). Generic job paths (upload/print-job scopes) keep the
        // noWriter None/None lanes.
        if required == auth_service::Scope::DeviceControl {
            if !matches!(req.device_snapshot_ms, Some(ms) if ms > 0) {
                return Err(ApprovalError::InvalidRequest("device_snapshot_ms"));
            }
            if req.project_id.is_none() {
                return Err(ApprovalError::InvalidRequest("project_id"));
            }
        }
        let principal = session.principal(); // Principal::Local{user_id}
        let session_ref = Some(session.session_hash().to_string());
        self.issue(IssueRequest {
            action: req.action,
            target: req.target,
            principal,
            purpose: req.purpose,
            payload: req.payload,
            session_ref: session_ref.as_deref(),
            revision: req.revision,
            artifact: req.artifact,
            material: req.material,
            device_snapshot_ms: req.device_snapshot_ms,
            project_id: req.project_id,
            ttl_ms: req.ttl_ms,
        })
    }

    /// Consume a token for exactly the frozen envelope. Any deviation, expiry,
    /// revocation or repeated use is a denial ([`ApprovalError`]) and the
    /// approval remains/becomes unusable — never a grant.
    pub fn consume(
        &self,
        token: &str,
        ctx: &ConsumeContext<'_>,
    ) -> Result<ConsumedApproval, ApprovalError> {
        let token_bytes = decode_token(token)?;
        let token_hash = hash_token_hex(&token_bytes);
        let now = (self.clock)();
        let conn = self.db.conn();

        // BEGIN IMMEDIATE: take the write lock up front so a concurrent
        // consumer is serialized at the DB level; the conditional UPDATE below
        // is the atomic one-winner gate.
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<ConsumedApproval, ApprovalError> {
            let row = conn
                .query_row(
                    "SELECT token_hash, principal, action, payload_digest, target, purpose,
                            session_ref, revision, artifact, material,
                            device_snapshot_ms, project_id,
                            issued_ms, expires_ms, consumed_ms, revoked
                     FROM approvals WHERE token_hash = ?1",
                    [&token_hash],
                    row_from,
                )
                .optional()?;

            let Some(row) = row else {
                return Err(ApprovalError::UnknownToken);
            };

            // Lifecycle denials (order matters for deterministic reporting).
            if row.revoked {
                return Err(ApprovalError::Revoked);
            }
            if row.consumed_ms.is_some() {
                return Err(ApprovalError::AlreadyConsumed);
            }
            if row.issued_ms > now {
                // Clock rolled back before this approval was issued — fail
                // closed, no grant. The row stays pending: once the clock
                // recovers the same context can consume it, and expiry is
                // re-checked against the recovered clock so an expired
                // approval is never revived by old-clock reuse.
                return Err(ApprovalError::InvalidClock);
            }
            if row.expires_ms <= now {
                return Err(ApprovalError::Expired);
            }

            // Envelope revalidation against the frozen row.
            match &ctx.principal {
                Principal::Anonymous => return Err(ApprovalError::ContextChanged("principal")),
                Principal::Local { user_id } => {
                    if row.principal != *user_id {
                        return Err(ApprovalError::ContextChanged("principal"));
                    }
                }
            }
            if row.action != ctx.action {
                return Err(ApprovalError::ContextChanged("action"));
            }
            if row.target != ctx.target {
                return Err(ApprovalError::ContextChanged("target"));
            }
            if row.payload_digest != digest_hex(&canonicalize(ctx.payload)) {
                return Err(ApprovalError::ContextChanged("payload_digest"));
            }
            if row.session_ref.as_deref() != ctx.session_ref {
                return Err(ApprovalError::ContextChanged("session"));
            }
            // Issue now guarantees stored revisions fit u64; a corrupt row
            // with a negative revision is a mismatch, never a wrap-around.
            let row_revision = match row.revision {
                Some(r) => match u64::try_from(r) {
                    Ok(v) => Some(v),
                    Err(_) => return Err(ApprovalError::ContextChanged("revision")),
                },
                None => None,
            };
            if row_revision != ctx.revision {
                return Err(ApprovalError::ContextChanged("revision"));
            }
            if row.artifact.as_deref() != ctx.artifact {
                return Err(ApprovalError::ContextChanged("artifact"));
            }
            if row.material.as_deref() != ctx.material {
                return Err(ApprovalError::ContextChanged("material"));
            }
            // Snapshot + project bindings: strict Option equality. A legacy v5
            // row (NULL snapshot/project) can never authorize a device write
            // when the trusted context carries Some — the mismatch is a
            // ContextChanged (approval stays pending). Generic job calls that
            // carry None on both sides keep working (their rows are NULL).
            if row.device_snapshot_ms != ctx.device_snapshot_ms {
                return Err(ApprovalError::ContextChanged("snapshot"));
            }
            if row.project_id.as_deref() != ctx.project_id {
                return Err(ApprovalError::ContextChanged("project"));
            }

            // Atomic one-use gate: only a row that is still unconsumed,
            // unrevoked and unexpired can transition; rows affected must be
            // exactly 1.
            let changed = conn.execute(
                "UPDATE approvals SET consumed_ms = ?1
                 WHERE token_hash = ?2
                   AND consumed_ms IS NULL
                   AND revoked = 0
                   AND expires_ms > ?1",
                rusqlite::params![now, token_hash],
            )?;

            if changed != 1 {
                // A concurrent consumer won between our read and the UPDATE.
                return Err(ApprovalError::AlreadyConsumed);
            }

            Ok(ConsumedApproval {
                token_hash,
                principal: row.principal,
                action: row.action,
                target: row.target,
                payload_digest: row.payload_digest,
                purpose: row.purpose,
            })
        })();

        match outcome {
            Ok(grant) => {
                conn.execute_batch("COMMIT")?;
                Ok(grant)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Revoke a pending approval. Returns true when an unconsumed row was
    /// revoked, false when nothing pending existed for that token.
    pub fn revoke(&self, token: &str) -> Result<bool, ApprovalError> {
        let token_bytes = decode_token(token)?;
        let token_hash = hash_token_hex(&token_bytes);
        let changed = self.db.conn().execute(
            "UPDATE approvals SET revoked = 1
                 WHERE token_hash = ?1 AND consumed_ms IS NULL AND revoked = 0",
            [&token_hash],
        )?;
        Ok(changed > 0)
    }

    /// Pending (unconsumed, unrevoked) token hashes for a principal — future
    /// approval-UI discovery; also lets tests assert pending state stays intact
    /// after a denial.
    pub fn pending_tokens(&self, principal: &str) -> Result<Vec<String>, ApprovalError> {
        let mut stmt = self.db.conn().prepare(
            "SELECT token_hash FROM approvals
                 WHERE principal = ?1 AND consumed_ms IS NULL AND revoked = 0
                 ORDER BY issued_ms ASC, token_hash ASC",
        )?;
        let rows = stmt.query_map([principal], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use auth_service::Principal;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};

    const BASE: i64 = 1_700_000_000_000;

    /// Private, per-test fake clock: owned, deterministic, and isolated from
    /// other parallel test threads (the concurrent test clones it).
    #[derive(Clone)]
    struct FakeClock(Arc<AtomicI64>);
    impl FakeClock {
        fn new(start: i64) -> Self {
            Self(Arc::new(AtomicI64::new(start)))
        }
        fn set(&self, v: i64) {
            self.0.store(v, Ordering::Relaxed);
        }
        fn advance(&self, by: i64) {
            self.0.fetch_add(by, Ordering::Relaxed);
        }
        fn clock_fn(&self) -> impl Fn() -> i64 + 'static {
            let c = Arc::clone(&self.0);
            move || c.load(Ordering::Relaxed)
        }
    }

    fn authority<'a>(db: &'a DbHandle, clock: &'a FakeClock) -> ApprovalAuthority<'a> {
        ApprovalAuthority::with_clock(db, clock.clock_fn())
    }

    fn local_user(id: &str) -> Principal {
        Principal::Local {
            user_id: id.to_owned(),
        }
    }

    fn test_user() -> &'static Principal {
        static U: OnceLock<Principal> = OnceLock::new();
        U.get_or_init(|| Principal::Local {
            user_id: "user-1".to_owned(),
        })
    }

    fn ctx<'a>(
        action: &'a str,
        target: &'a str,
        payload: &'a Value,
        session: Option<&'a str>,
        revision: Option<u64>,
        artifact: Option<&'a str>,
        material: Option<&'a str>,
    ) -> ConsumeContext<'a> {
        ConsumeContext {
            action,
            target,
            principal: test_user(),
            payload,
            session_ref: session,
            revision,
            artifact,
            material,
            device_snapshot_ms: None,
            project_id: None,
        }
    }

    fn payload(v: u64) -> Value {
        serde_json::json!({ "value": v, "kind": "test" })
    }

    #[test]
    fn anonymous_issuance_is_refused() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let err = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: Principal::Anonymous,
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect_err("anonymous must be refused");
        assert_eq!(err, ApprovalError::MissingPrincipal);
        assert!(a.pending_tokens("user-1").expect("pending").is_empty());
    }

    #[test]
    fn exact_context_consumes_exactly_once() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "move 10mm",
                payload: &payload(1),
                session_ref: Some("sess-42"),
                revision: Some(7),
                artifact: Some("job-9"),
                material: Some("pla"),
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        // Token shape: 32 bytes of RNG → 64 hex chars; raw token != stored hash.
        assert_eq!(ok.token.len(), 64);
        assert!(ok.token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(ok.token, ok.token_hash);

        let grant = a
            .consume(
                &ok.token,
                &ConsumeContext {
                    action: "device.command",
                    target: "device-1",
                    principal: &local_user("user-1"),
                    payload: &payload(1),
                    session_ref: Some("sess-42"),
                    revision: Some(7),
                    artifact: Some("job-9"),
                    material: Some("pla"),
                    device_snapshot_ms: None,
                    project_id: None,
                },
            )
            .expect("exact envelope consumes");
        assert_eq!(grant.token_hash, ok.token_hash);
        assert_eq!(grant.payload_digest, ok.payload_digest);

        // Replay of the same token fails (one-use).
        let replay = a.consume(
            &ok.token,
            &ConsumeContext {
                action: "device.command",
                target: "device-1",
                principal: &local_user("user-1"),
                payload: &payload(1),
                session_ref: Some("sess-42"),
                revision: Some(7),
                artifact: Some("job-9"),
                material: Some("pla"),
                device_snapshot_ms: None,
                project_id: None,
            },
        );
        assert_eq!(replay.err(), Some(ApprovalError::AlreadyConsumed));
        assert!(a.pending_tokens("user-1").expect("pending").is_empty());
    }

    #[test]
    fn wrong_payload_is_denied() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &serde_json::json!({ "nozzle": 210 }),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        let err = a
            .consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &serde_json::json!({ "nozzle": 220 }),
                    None,
                    None,
                    None,
                    None,
                ),
            )
            .expect_err("payload changed");
        assert_eq!(err, ApprovalError::ContextChanged("payload_digest"));
        // Denial leaves the approval pending and intact.
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&ok.token_hash));
    }

    #[test]
    fn wrong_target_is_denied() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        assert_eq!(
            a.consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-2",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::ContextChanged("target"))
        );
    }

    #[test]
    fn wrong_revision_is_denied() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "print.start",
                target: "printer-a",
                principal: local_user("user-1"),
                purpose: "print job",
                payload: &payload(1),
                session_ref: None,
                revision: Some(4),
                artifact: Some("file-2"),
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        assert_eq!(
            a.consume(
                &ok.token,
                &ctx(
                    "print.start",
                    "printer-a",
                    &payload(1),
                    None,
                    Some(5),
                    Some("file-2"),
                    None
                )
            ),
            Err(ApprovalError::ContextChanged("revision"))
        );
        // The approval stays pending: a corrected consume with the frozen
        // revision still succeeds (no blind consent loss on a conveyance fix).
        assert!(a
            .consume(
                &ok.token,
                &ctx(
                    "print.start",
                    "printer-a",
                    &payload(1),
                    None,
                    Some(4),
                    Some("file-2"),
                    None
                )
            )
            .is_ok());
    }

    #[test]
    fn wrong_session_is_denied() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: Some("sess-42"),
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        assert_eq!(
            a.consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    Some("sess-43"),
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::ContextChanged("session"))
        );
        // Supplying a session when none was bound is also a mismatch (strict
        // envelope equality).
        let bare = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        assert_eq!(
            a.consume(
                &bare.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    Some("sess-1"),
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::ContextChanged("session"))
        );
    }

    #[test]
    fn changing_material_or_artifact_invalidates_pending_approval() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "ace-1",
                principal: local_user("user-1"),
                purpose: "dry spool",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: Some("spool-3"),
                material: Some("pla"),
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        assert_eq!(
            a.consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "ace-1",
                    &payload(1),
                    None,
                    None,
                    Some("spool-3"),
                    Some("petg")
                )
            ),
            Err(ApprovalError::ContextChanged("material"))
        );
        assert!(a
            .consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "ace-1",
                    &payload(1),
                    None,
                    None,
                    Some("spool-9"),
                    Some("pla")
                )
            )
            .is_err());
        // Still pending after denials.
        assert_eq!(
            a.pending_tokens("user-1").expect("pending"),
            vec![ok.token_hash]
        );
    }

    #[test]
    fn expiry_is_enforced_and_respected_before_grant() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            })
            .expect("issue");
        clock.set(BASE + 59_999);
        assert!(
            a.consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            )
            .is_ok(),
            "within ttl must grant"
        );
    }

    #[test]
    fn expiry_is_denied_after_ttl() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            })
            .expect("issue");
        clock.set(BASE + 60_000);
        assert_eq!(
            a.consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::Expired)
        );
    }

    #[test]
    fn revocation_is_denied() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        assert!(a.revoke(&ok.token).expect("revoke pending"));
        assert_eq!(
            a.consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::Revoked)
        );
        // Revoking again reports no pending row.
        assert!(!a.revoke(&ok.token).expect("revoke again returns false"));
    }

    #[test]
    fn malformed_and_unknown_tokens_are_denied() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        // Malformed shape is refused before any DB lookup.
        assert_eq!(
            a.consume(
                "not-a-token",
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::InvalidToken)
        );
        assert_eq!(a.revoke("not-a-token"), Err(ApprovalError::InvalidToken));
        // Well-formed 64-hex but absent stays a lookup miss.
        assert_eq!(
            a.consume(
                &"a".repeat(TOKEN_HEX_LEN),
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::UnknownToken)
        );
    }

    #[test]
    fn ttl_out_of_bounds_is_refused() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let err = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: MAX_TTL_MS + 1,
            })
            .expect_err("overlong ttl must be refused");
        assert_eq!(err, ApprovalError::InvalidTtl);
    }

    #[test]
    fn distinct_issues_yield_distinct_tokens() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let t1 = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        let t2 = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        assert_ne!(t1.token, t2.token);
        assert_ne!(t1.token_hash, t2.token_hash);
        assert_eq!(a.pending_tokens("user-1").expect("pending").len(), 2);
    }

    #[test]
    fn concurrent_replay_grants_exactly_once() {
        let clock = FakeClock::new(BASE);
        let db = Arc::new(Mutex::new(DbHandle::open_in_memory().expect("db")));
        let issued = {
            let guard = db.lock().expect("lock");
            let a = authority(&guard, &clock);
            a.issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            })
            .expect("issue")
        };
        let token = issued.token;
        let grant_evt = Arc::new(Mutex::new(()));

        let threads: Vec<_> = (0..16)
            .map(|_| {
                let db = Arc::clone(&db);
                let token = token.clone();
                let clock = clock.clone();
                let _gate = Arc::clone(&grant_evt);
                std::thread::spawn(move || {
                    let db = db.lock().expect("lock");
                    let a = ApprovalAuthority::with_clock(&db, clock.clock_fn());
                    a.consume(
                        &token,
                        &ConsumeContext {
                            action: "device.command",
                            target: "device-1",
                            principal: &local_user("user-1"),
                            payload: &payload(1),
                            session_ref: None,
                            revision: None,
                            artifact: None,
                            material: None,
                            device_snapshot_ms: None,
                            project_id: None,
                        },
                    )
                })
            })
            .collect();

        let mut ok = 0usize;
        let mut denied = 0usize;
        for t in threads {
            match t.join().expect("thread") {
                Ok(_) => ok += 1,
                Err(e) => {
                    assert!(
                        matches!(e, ApprovalError::AlreadyConsumed | ApprovalError::Expired),
                        "denial must be lifecycle-only: {e:?}"
                    );
                    denied += 1;
                }
            }
        }
        assert_eq!(ok, 1, "exactly one grant expected");
        assert_eq!(denied, 15);
    }

    #[test]
    fn debug_format_masks_raw_token_but_serialize_keeps_it() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        let rendered = format!("{ok:?}");
        assert!(
            !rendered.contains(&ok.token),
            "raw token must never appear in Debug output"
        );
        assert!(rendered.contains("<redacted>"));
        // Serialize (explicit command response) keeps the consumable token.
        let json = serde_json::to_value(&ok).expect("serialize");
        assert_eq!(json["token"].as_str().expect("token"), ok.token);
    }

    #[test]
    fn token_shape_is_strict_hex64() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
            .expect("issue");
        let p = payload(1);
        let base = &ctx("device.command", "device-1", &p, None, None, None, None);
        // Too short.
        let short = &ok.token[..63];
        assert_eq!(a.consume(short, base), Err(ApprovalError::InvalidToken));
        // Too long.
        let long = format!("{}0", ok.token);
        assert_eq!(a.consume(&long, base), Err(ApprovalError::InvalidToken));
        // 64 chars but not hex.
        let nonhex = "z".repeat(TOKEN_HEX_LEN);
        assert_eq!(a.consume(&nonhex, base), Err(ApprovalError::InvalidToken));
        // Decode never touches the DB with a malformed token.
        assert_eq!(a.revoke(&short), Err(ApprovalError::InvalidToken));
    }

    #[test]
    fn blank_and_oversized_identifiers_are_never_minted() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let issue = |action: &str,
                     target: &str,
                     purpose: &str,
                     principal: Principal,
                     revision: Option<u64>| {
            a.issue(IssueRequest {
                action,
                target,
                principal,
                purpose,
                payload: &payload(1),
                session_ref: None,
                revision,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            })
        };
        let user = local_user("user-1");
        assert_eq!(
            issue("", "device-1", "test", user.clone(), None),
            Err(ApprovalError::InvalidRequest("action"))
        );
        assert_eq!(
            issue("device.command", "", "test", user.clone(), None),
            Err(ApprovalError::InvalidRequest("target"))
        );
        assert_eq!(
            issue("device.command", "device-1", "", user.clone(), None),
            Err(ApprovalError::InvalidRequest("purpose"))
        );
        assert_eq!(
            issue(
                "device.command",
                "device-1",
                "test",
                Principal::Local {
                    user_id: String::new()
                },
                None
            ),
            Err(ApprovalError::InvalidRequest("principal"))
        );
        let oversized = "x".repeat(MAX_IDENTIFIER_LEN + 1);
        assert_eq!(
            issue(&oversized, "device-1", "test", user.clone(), None),
            Err(ApprovalError::InvalidRequest("action"))
        );
        // u64 revision that cannot fit i64 is refused, never silently cast.
        assert_eq!(
            issue("device.command", "device-1", "test", user, Some(u64::MAX)),
            Err(ApprovalError::InvalidRequest("revision"))
        );
        assert!(a.pending_tokens("user-1").expect("pending").is_empty());
    }

    #[test]
    fn consume_clock_rollback_fails_closed_and_recovers() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            })
            .expect("issue");
        // Roll back before issuance: fail closed, no grant, row stays pending.
        clock.set(BASE - 1_000);
        assert_eq!(
            a.consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            ),
            Err(ApprovalError::InvalidClock)
        );
        assert!(a
            .pending_tokens("user-1")
            .expect("pending")
            .contains(&ok.token_hash));
        // Once the clock recovers (still inside the TTL window), the same
        // context consumes normally.
        clock.set(BASE + 30_000);
        assert!(a
            .consume(
                &ok.token,
                &ctx(
                    "device.command",
                    "device-1",
                    &payload(1),
                    None,
                    None,
                    None,
                    None
                )
            )
            .is_ok());
    }

    #[test]
    fn issue_clock_before_epoch_is_refused() {
        let clock = FakeClock::new(-1);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        assert_eq!(
            a.issue(IssueRequest {
                action: "device.command",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "test",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 0,
            }),
            Err(ApprovalError::InvalidClock)
        );
    }

    // ---------- S9.18-003: session-authenticated issuance ----------

    /// In-memory auth repository sharing the SAME fake clock as the authority.
    fn session_auth(clock: &FakeClock, user: &str) -> auth_service::AuthDb {
        let mut adb =
            auth_service::AuthDb::open_in_memory_with_clock(clock.clock_fn()).expect("auth db");
        adb.upsert_user(user, "Session User").expect("upsert");
        adb.grant_scope(user, auth_service::Scope::DeviceControl)
            .expect("grant scope");
        adb
    }

    fn reason_of(e: ApprovalError) -> &'static str {
        match e {
            ApprovalError::SessionDenied(r) => r,
            other => panic!("expected SessionDenied, got {other:?}"),
        }
    }

    /// A plain (late-bound) fn constructor — closures cannot be generic over
    /// the payload borrow. Uses a KNOWN registry action so the scoped issue
    /// entry can derive its required scope.
    fn scoped_req<'a>(payload: &'a Value) -> ScopedIssueRequest<'a> {
        ScopedIssueRequest {
            action: "nozzle",
            target: "device-1",
            purpose: "session test",
            payload,
            revision: None,
            artifact: None,
            material: None,
            device_snapshot_ms: Some(BASE),
            project_id: Some("project-1"),
            ttl_ms: 60_000,
        }
    }

    #[test]
    fn issue_for_session_binds_verified_session_and_round_trips() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = authority(&db, &clock);

        let issued = a
            .issue_for_session_scoped(
                &adb,
                session.raw(),
                &ScopedIssueRequest {
                    action: "nozzle",
                    target: "device-1",
                    purpose: "session test",
                    payload: &payload(1),
                    revision: None,
                    artifact: None,
                    material: None,
                    device_snapshot_ms: Some(BASE),
                    project_id: Some("project-1"),
                    ttl_ms: 60_000,
                },
            )
            .expect("issue_for_session_scoped");
        // The approval is bound to the session's non-secret hash — never the
        // raw token — and the verified principal.
        let pending = a.pending_tokens("user-1").expect("pending");
        assert!(pending.contains(&issued.token_hash));

        // Consume inside the session TTL with matching principal + hash + the
        // trusted snapshot/project → grant.
        let consumed = a
            .consume(
                &issued.token,
                &ConsumeContext {
                    action: "nozzle",
                    target: "device-1",
                    principal: &local_user("user-1"),
                    payload: &payload(1),
                    session_ref: Some(session.hash()),
                    revision: None,
                    artifact: None,
                    material: None,
                    device_snapshot_ms: Some(BASE),
                    project_id: Some("project-1"),
                },
            )
            .expect("consumed");
        assert_eq!(consumed.token_hash, issued.token_hash);
        // Second consume → one-use denial.
        assert_eq!(
            a.consume(
                &issued.token,
                &ConsumeContext {
                    action: "nozzle",
                    target: "device-1",
                    principal: &local_user("user-1"),
                    payload: &payload(1),
                    session_ref: Some(session.hash()),
                    revision: None,
                    artifact: None,
                    material: None,
                    device_snapshot_ms: Some(BASE),
                    project_id: Some("project-1"),
                },
            ),
            Err(ApprovalError::AlreadyConsumed)
        );
    }

    #[test]
    fn issue_for_session_denials_map_to_static_token_free_reasons() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let mut adb = session_auth(&clock, "user-1");
        // Sanity: with DeviceControl granted, minting is allowed under the
        // S9.18 create_session contract (scope must be a live grant).
        let _session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let a = authority(&db, &clock);
        let p1: Value = payload(1);

        // 1. Unknown session token → generic "unauthenticated", never the token.
        assert_eq!(
            a.issue_for_session_scoped(&adb, &"c".repeat(64), &scoped_req(&p1))
                .expect_err("unknown"),
            ApprovalError::SessionDenied("unauthenticated")
        );
        // 2. Malformed (not 64 hex) → "malformed".
        assert_eq!(
            a.issue_for_session_scoped(&adb, "not-a-token", &scoped_req(&p1))
                .expect_err("malformed"),
            ApprovalError::SessionDenied("malformed")
        );
        // 3. Revoked.
        let s1 = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("s1");
        adb.revoke_session(s1.hash()).expect("revoke");
        assert_eq!(
            a.issue_for_session_scoped(&adb, s1.raw(), &scoped_req(&p1))
                .expect_err("revoked"),
            ApprovalError::SessionDenied("revoked")
        );
        // 4. Expired.
        let s2 = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("s2");
        clock.advance(60_001);
        assert_eq!(
            a.issue_for_session_scoped(&adb, s2.raw(), &scoped_req(&p1))
                .expect_err("expired"),
            ApprovalError::SessionDenied("expired")
        );
        // 5. Scope rescinded after grant.
        let s3 = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("s3");
        adb.revoke_scope("user-1", auth_service::Scope::DeviceControl)
            .expect("rescind");
        assert_eq!(
            a.issue_for_session_scoped(&adb, s3.raw(), &scoped_req(&p1))
                .expect_err("rescinded"),
            ApprovalError::SessionDenied("scope")
        );
        // 6. User removed (session row cascade-deleted → unauthenticated).
        // Re-grant the capability (case 5 revoked it) so s4 can mint under
        // the S9.18 create_session contract.
        adb.grant_scope("user-1", auth_service::Scope::DeviceControl)
            .expect("re-grant scope");
        let s4 = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("s4");
        adb.remove_user("user-1").expect("remove");
        let e = a
            .issue_for_session_scoped(&adb, s4.raw(), &scoped_req(&p1))
            .expect_err("removed user");
        let reason = reason_of(e);
        assert!(
            reason == "unauthenticated" || reason == "user",
            "unexpected {reason:?}"
        );
    }

    // ---------- DEV-10: registry-scoped issuance ----------

    #[test]
    fn issue_for_session_scoped_derives_scope_from_action_and_never_caller() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let mut adb =
            auth_service::AuthDb::open_in_memory_with_clock(clock.clock_fn()).expect("auth db");
        adb.upsert_user("user-1", "Session User").expect("upsert");
        for scope in [
            auth_service::Scope::DeviceControl,
            auth_service::Scope::DeviceUpload,
            auth_service::Scope::PrintJob,
        ] {
            adb.grant_scope("user-1", scope).expect("grant");
        }
        let p1: Value = payload(1);
        let req_for = |action: &'static str| ScopedIssueRequest {
            action,
            target: "device-1",
            purpose: "scope matrix",
            payload: &p1,
            revision: None,
            artifact: None,
            material: None,
            device_snapshot_ms: Some(BASE),
            project_id: Some("project-1"),
            ttl_ms: 60_000,
        };
        // A DeviceUpload session cannot issue a print-job effect — and
        // neither can a DeviceControl session. Only the matching scope mints.
        // (Sessions are created per scope; the token carries its scope.)
        let ctl = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("control session");
        let upload = adb
            .create_session("user-1", auth_service::Scope::DeviceUpload, 60_000)
            .expect("upload session");
        let job = adb
            .create_session("user-1", auth_service::Scope::PrintJob, 60_000)
            .expect("print-job session");

        // job.start requires PrintJob — DeviceControl/DeviceUpload refuse.
        assert_eq!(
            a.issue_for_session_scoped(&adb, ctl.raw(), &req_for("job.start"))
                .expect_err("control session must not print"),
            ApprovalError::SessionDenied("scope")
        );
        assert_eq!(
            a.issue_for_session_scoped(&adb, upload.raw(), &req_for("job.start"))
                .expect_err("upload session must not print"),
            ApprovalError::SessionDenied("scope")
        );
        a.issue_for_session_scoped(&adb, job.raw(), &req_for("job.start"))
            .expect("print-job session issues job.start");

        // upload requires DeviceUpload — a PrintJob session cannot upload.
        assert_eq!(
            a.issue_for_session_scoped(&adb, job.raw(), &req_for("upload"))
                .expect_err("print-job session must not upload"),
            ApprovalError::SessionDenied("scope")
        );
        a.issue_for_session_scoped(&adb, upload.raw(), &req_for("upload"))
            .expect("upload session issues upload");

        // nozzle requires DeviceControl — a PrintJob session cannot control
        // the physical machine.
        assert_eq!(
            a.issue_for_session_scoped(&adb, job.raw(), &req_for("nozzle"))
                .expect_err("print-job session must not control"),
            ApprovalError::SessionDenied("scope")
        );
        a.issue_for_session_scoped(&adb, ctl.raw(), &req_for("nozzle"))
            .expect("control session issues nozzle");
    }

    #[test]
    fn unknown_action_cannot_mint_through_session_scope() {
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let mut adb = session_auth(&clock, "user-1"); // DeviceControl granted
        let session = adb
            .create_session("user-1", auth_service::Scope::DeviceControl, 60_000)
            .expect("create session");
        let p1: Value = payload(1);
        // A legacy/generic command name has NO registry scope → refused
        // before any minting; no "catch-all" commands survive.
        for bad in ["device.command", "print.start", "job", ""] {
            assert_eq!(
                a.issue_for_session_scoped(
                    &adb,
                    session.raw(),
                    &ScopedIssueRequest {
                        action: bad,
                        target: "device-1",
                        purpose: "unknown action",
                        payload: &p1,
                        revision: None,
                        artifact: None,
                        material: None,
                        device_snapshot_ms: Some(BASE),
                        project_id: Some("project-1"),
                        ttl_ms: 60_000,
                    },
                )
                .expect_err("unknown action"),
                ApprovalError::InvalidRequest("action"),
                "{bad:?}"
            );
        }
        // Nothing was minted for the principal.
        assert!(a.pending_tokens("user-1").expect("pending").is_empty());
    }

    // ---------- S9.18-003 staged regression vectors ----------
    // These four vectors were staged FIRST (red): project swap same revision,
    // snapshot new fresh, cap false (Tauri), legacy without context. They pin
    // the invariant that a trusted snapshot + project binding — stored as
    // first-class columns — can never be satisfied by a different context.

    #[test]
    fn project_swap_same_revision_is_denied() {
        // Attacker validates project A at rev 2, then swaps the trusted
        // context to project B — same printer, same material, same revision.
        // The frozen project binding must reject the swap.
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "nozzle",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "project swap",
                payload: &payload(1),
                session_ref: None,
                revision: Some(2),
                artifact: None,
                material: Some("pla"),
                device_snapshot_ms: Some(BASE),
                project_id: Some("project-A"),
                ttl_ms: 60_000,
            })
            .expect("issue");
        assert_eq!(
            a.consume(
                &ok.token,
                &ConsumeContext {
                    action: "nozzle",
                    target: "device-1",
                    principal: &local_user("user-1"),
                    payload: &payload(1),
                    session_ref: None,
                    revision: Some(2),
                    artifact: None,
                    material: Some("pla"),
                    device_snapshot_ms: Some(BASE),
                    project_id: Some("project-B"),
                },
            ),
            Err(ApprovalError::ContextChanged("project"))
        );
        // The approval stays pending — never silently rebound.
        assert!(
            a.pending_tokens("user-1")
                .expect("pending")
                .contains(&ok.token_hash)
        );
    }

    #[test]
    fn snapshot_new_fresh_denies_stale_payload_same_context() {
        // Approve against snapshot T; the trusted resolver re-reads the
        // device BEFORE dispatch and now reports T+1 (a NEW fresh snapshot).
        // Even with an identical payload and same project, the snapshot
        // anchor moved → the approval must not authorize the write.
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        let ok = a
            .issue(IssueRequest {
                action: "nozzle",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "snapshot refresh",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: Some(BASE),
                project_id: Some("project-1"),
                ttl_ms: 60_000,
            })
            .expect("issue");
        assert_eq!(
            a.consume(
                &ok.token,
                &ConsumeContext {
                    action: "nozzle",
                    target: "device-1",
                    principal: &local_user("user-1"),
                    payload: &payload(1),
                    session_ref: None,
                    revision: None,
                    artifact: None,
                    material: None,
                    device_snapshot_ms: Some(BASE + 1),
                    project_id: Some("project-1"),
                },
            ),
            Err(ApprovalError::ContextChanged("snapshot"))
        );
        // Snapshot moved — the pending approval survives for the REAL fresh
        // snapshot, it is not burned by the denial.
        assert!(
            a.pending_tokens("user-1")
                .expect("pending")
                .contains(&ok.token_hash)
        );
    }

    #[test]
    fn legacy_null_columns_never_authorize_trusted_writes() {
        // A legacy v5-style approval (NULL device_snapshot_ms + project_id)
        // MUST NOT authorize a device write when the consume context carries
        // the trusted snapshot/project (strict Option equality). The old
        // generic job path (None/None) must keep working.
        let clock = FakeClock::new(BASE);
        let db = DbHandle::open_in_memory().expect("db");
        let a = authority(&db, &clock);
        // Issued without any snapshot/project anchor → v6 columns stay NULL,
        // exactly like a legacy v5 row after migration.
        let legacy = a
            .issue(IssueRequest {
                action: "nozzle",
                target: "device-1",
                principal: local_user("user-1"),
                purpose: "legacy row",
                payload: &payload(1),
                session_ref: None,
                revision: None,
                artifact: None,
                material: None,
                device_snapshot_ms: None,
                project_id: None,
                ttl_ms: 60_000,
            })
            .expect("issue");
        // Trusted Some(snapshot) consumer → denied, pending preserved.
        assert_eq!(
            a.consume(
                &legacy.token,
                &ConsumeContext {
                    action: "nozzle",
                    target: "device-1",
                    principal: &local_user("user-1"),
                    payload: &payload(1),
                    session_ref: None,
                    revision: None,
                    artifact: None,
                    material: None,
                    device_snapshot_ms: Some(BASE),
                    project_id: None,
                },
            ),
            Err(ApprovalError::ContextChanged("snapshot"))
        );
        assert!(
            a.pending_tokens("user-1")
                .expect("pending")
                .contains(&legacy.token_hash)
        );
        // Generic job lane (None/None) still grants — noWriter path intact.
        assert!(a
            .consume(
                &legacy.token,
                &ConsumeContext {
                    action: "nozzle",
                    target: "device-1",
                    principal: &local_user("user-1"),
                    payload: &payload(1),
                    session_ref: None,
                    revision: None,
                    artifact: None,
                    material: None,
                    device_snapshot_ms: None,
                    project_id: None,
                },
            )
            .is_ok());
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Shared deterministic helpers for the broker's approval/dispatch
    //! security tests (fake clock + principal/payload constructors).

    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    use auth_service::Principal;
    use serde_json::Value;

    /// Fixed epoch start shared by approval and dispatch tests.
    pub(crate) const BASE: i64 = 1_700_000_000_000;

    /// Private, deterministic, thread-safe fake clock.
    #[derive(Clone)]
    pub(crate) struct FakeClock(Arc<AtomicI64>);
    impl FakeClock {
        pub(crate) fn new(start: i64) -> Self {
            Self(Arc::new(AtomicI64::new(start)))
        }
        pub(crate) fn set(&self, v: i64) {
            self.0.store(v, Ordering::Relaxed);
        }
        pub(crate) fn advance(&self, by: i64) {
            self.0.fetch_add(by, Ordering::Relaxed);
        }
        pub(crate) fn clock_fn(&self) -> impl Fn() -> i64 + 'static {
            let c = Arc::clone(&self.0);
            move || c.load(Ordering::Relaxed)
        }
    }

    pub(crate) fn local_user(id: &str) -> Principal {
        Principal::Local {
            user_id: id.to_owned(),
        }
    }

    pub(crate) fn payload(v: u64) -> Value {
        serde_json::json!({ "value": v, "kind": "test" })
    }
}
