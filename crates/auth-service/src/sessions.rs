//! Local trusted session repository (S9.17-003/S9.18-003).
//!
//! Sessions are **backend-internal** facts: `AuthDb::create_session` exists
//! ONLY for an already-registered user with an explicitly granted, allowed
//! scoped capability. It is NOT a login endpoint and there is no wire path in
//! this slice (`main.rs` deliberately omits session ops — external
//! establishment remains a Sprint-10 item, partial, AVAILABLE only through
//! this crate's API).
//!
//! Discipline:
//! - Raw tokens: 32 bytes OS randomness (`getrandom` 0.2), hex-encoded,
//!   64 chars. Only the SHA-256 hash is ever persisted or returned via
//!   `SessionToken::hash`.
//! - `Token`'s `Debug` is redacted (`<redacted>`); raw tokens are never
//!   logged and never appear in `SessionError` variants.
//! - Every session is bound to an expiry (`expires_ms`), one scope, and the
//!   user that owns it. `resolve_session` re-checks revocation, expiry,
//!   scope-still-granted and user-still-present on every resolution, so a
//!   revoked session, rescinded scope, removed user or elapsed TTL fails
//!   closed at the moment of use.
//! - Clock discipline: `create_session` and `resolve_session` both require a
//!   positive clock and refuse a wallclock that rolled back before the
//!   session's creation (`InvalidClock`); `create_session` also refuses TTL
//!   overflow (checked add). Expiry is per-row monotonic — a recovered clock
//!   can never rewind an expiry.

use rusqlite::OptionalExtension;

use crate::api::Scope;
use crate::db::AuthDb;
use crate::principal::Principal;

/// Raw session token bytes (before hex encoding).
pub const SESSION_TOKEN_BYTES: usize = 32;
/// Hex length of the encoded token = `SESSION_TOKEN_BYTES * 2`.
pub const SESSION_TOKEN_HEX_LEN: usize = 64;
/// Default TTL for a device-control session: 10 minutes.
pub const DEFAULT_SESSION_TTL_MS: i64 = 600_000;
/// Upper bound for a session TTL: 24 hours.
pub const MAX_SESSION_TTL_MS: i64 = 86_400_000;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("user does not exist")]
    UnknownUser,
    #[error("scope {0} is not a session capability")]
    ScopeNotAllowed(&'static str),
    #[error("ttl out of allowed bounds")]
    InvalidTtl,
    #[error("session token is malformed")]
    InvalidToken,
    #[error("session token is not known")]
    UnknownToken,
    #[error("session was revoked")]
    Revoked,
    #[error("session has expired")]
    Expired,
    #[error("scope was rescinded")]
    ScopeRescinded,
    #[error("user was removed")]
    UserRemoved,
    #[error("rng failure")]
    Rng,
    #[error("clock failure")]
    InvalidClock,
    #[error("sqlite error: {0}")]
    Db(#[from] rusqlite::Error),
}

/// A session token. The raw value is unpersisted; `hash()` is the only
/// durable form and the only thing `revoke_session` understands.
#[derive(Clone)]
pub struct SessionToken {
    raw: String,
    hash: String, // sha256 hex — safe to store, never the secret
}

impl std::fmt::Debug for SessionToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionToken")
            .field("raw", &"<redacted>")
            .field("hash", &self.hash)
            .finish()
    }
}

impl SessionToken {
    /// The raw token. Used ONLY by the code that immediately hands it to the
    /// authenticated dispatch path (which resolves it back to a hash).
    pub fn raw(&self) -> &str {
        &self.raw
    }
    /// Non-secret SHA-256 hex form (safe to store/log).
    pub fn hash(&self) -> &str {
        &self.hash
    }
}

/// A successfully resolved session. Fields are private; access is through
/// read-only accessors, and the ONLY constructor is `AuthDb::resolve_session`
/// (crate-internal `from_parts`), so a `VerifiedSession` cannot be forged
/// outside this crate.
pub struct VerifiedSession {
    user_id: String,
    session_hash: String,
    scope: Scope,
    created_ms: i64,
    expires_ms: i64,
}

impl VerifiedSession {
    /// Crate-internal constructor — not `pub`, cannot be called from broker
    /// or any external crate.
    pub(crate) fn from_parts(
        user_id: String,
        session_hash: String,
        scope: Scope,
        created_ms: i64,
        expires_ms: i64,
    ) -> Self {
        VerifiedSession {
            user_id,
            session_hash,
            scope,
            created_ms,
            expires_ms,
        }
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }
    /// Non-secret session hash — the value bound into approvals.
    pub fn session_hash(&self) -> &str {
        &self.session_hash
    }
    pub fn scope(&self) -> Scope {
        self.scope
    }
    pub fn created_ms(&self) -> i64 {
        self.created_ms
    }
    pub fn expires_ms(&self) -> i64 {
        self.expires_ms
    }
    /// True when `now_ms` is at/after `expires_ms` (or expiry was not set).
    pub fn is_expired_at(&self, now_ms: i64) -> bool {
        self.expires_ms <= 0 || now_ms >= self.expires_ms
    }
    /// True when `required` is granted by this session's bound scope.
    pub fn has_scope(&self, required: Scope) -> bool {
        self.scope == required
    }
    /// The principal this session identifies.
    pub fn principal(&self) -> Principal {
        Principal::Local {
            user_id: self.user_id.clone(),
        }
    }
}

impl std::fmt::Debug for VerifiedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedSession")
            .field("user_id", &self.user_id)
            .field("session_hash", &self.session_hash)
            .field("scope", &self.scope)
            .field("created_ms", &self.created_ms)
            .field("expires_ms", &self.expires_ms)
            .finish_non_exhaustive()
    }
}

/// Strict hex decoder for session tokens.
pub(crate) fn decode_session_token(token: &str) -> Result<[u8; SESSION_TOKEN_BYTES], SessionError> {
    let bytes = token.as_bytes();
    if bytes.len() != SESSION_TOKEN_HEX_LEN {
        return Err(SessionError::InvalidToken);
    }
    let mut out = [0u8; SESSION_TOKEN_BYTES];
    let mut i = 0;
    // FIXME: hoisted allocation-free manual hex decode to avoid needing hex
    // for the *decode* path; hex crate only used for encode.
    while i < SESSION_TOKEN_BYTES {
        let hi = hex_nibble(bytes[i * 2])?;
        let lo = hex_nibble(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
        i += 1;
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> Result<u8, SessionError> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        _ => Err(SessionError::InvalidToken),
    }
}

/// SHA-256 hex digest of raw token bytes.
pub(crate) fn hash_token_bytes(token: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token);
    hex::encode(digest)
}

/// Creates a fresh raw token from the OS RNG.
pub(crate) fn new_session_token() -> Result<(String, String), SessionError> {
    let mut bytes = [0u8; SESSION_TOKEN_BYTES];
    getrandom::getrandom(&mut bytes).map_err(|_| SessionError::Rng)?;
    let raw = hex::encode(bytes);
    let hash = hash_token_bytes(&bytes);
    Ok((raw, hash))
}

impl AuthDb {
    /// Create a session for an EXISTING user with an explicitly allowed,
    /// scoped capability. This is a repository (backend-internal) operation:
    /// it never creates a user and never runs on a login wire.
    ///
    /// * `user_id` must already exist in `users` (`UnknownUser` otherwise).
    /// * `scope` must be a session capability (`Scope::is_session_capability`,
    ///   i.e. `DeviceControl`); read scopes like `LocalProject` are refused.
    /// * `scope` must ALSO already be **granted** to that user in `scopes`
    ///   (`ScopeRescinded` otherwise — never-granted and revoked-after are
    ///   the same fail-closed denial). The grant is verified BEFORE the RNG
    ///   is touched and re-verified atomically by the INSERT, so a
    ///   concurrent revocation on an external file can never mint a row that
    ///   was not backed by a live grant at statement time.
    /// * `ttl_ms` bounded by
    ///   `0 < ttl_ms <= MAX_SESSION_TTL_MS` (`InvalidTtl` otherwise).
    /// * the clock must be positive and `now + ttl_ms` overflow-safe
    ///   (`InvalidClock` otherwise).
    ///
    /// Returns the one-handoff token (raw + hash); only `hash` is stored.
    pub fn create_session(
        &mut self,
        user_id: &str,
        scope: Scope,
        ttl_ms: i64,
    ) -> Result<SessionToken, SessionError> {
        if ttl_ms <= 0 || ttl_ms > MAX_SESSION_TTL_MS {
            return Err(SessionError::InvalidTtl);
        }
        if !scope.is_session_capability() {
            return Err(SessionError::ScopeNotAllowed(scope.name()));
        }
        // Clock validity first: a zero/pre-Epoch clock cannot produce a
        // meaningful expiry, and `now + ttl` must not overflow.
        let now = self.now();
        if now <= 0 {
            return Err(SessionError::InvalidClock);
        }
        let Some(expires) = now.checked_add(ttl_ms) else {
            return Err(SessionError::InvalidClock);
        };
        // User must exist AND hold the capability as a granted row. Both are
        // checked BEFORE the RNG — `getrandom` is never spent on a refusal.
        let user_exists: Option<i64> = self
            .conn
            .query_row("SELECT 1 FROM users WHERE id = ?1", [user_id], |r| r.get(0))
            .optional()?;
        if user_exists.is_none() {
            return Err(SessionError::UnknownUser);
        }
        let grant_exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM scopes WHERE user_id = ?1 AND scope = ?2",
                rusqlite::params![user_id, scope.name()],
                |r| r.get(0),
            )
            .optional()?;
        if grant_exists.is_none() {
            // Never granted, or revoked before the request: the same
            // fail-closed denial `resolve_session` reports at use-time.
            return Err(SessionError::ScopeRescinded);
        }
        let (raw, hash) = new_session_token()?;
        // Atomic single-statement INSERT...SELECT: the row only appears when
        // BOTH the user and the grant were present at SQL execution time.
        let inserted = self.conn.execute(
            "INSERT INTO device_sessions (token_hash, user_id, created_ms, expires_ms, scope, revoked_ms)
             SELECT ?1, ?2, ?3, ?4, ?5, NULL
             WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)
               AND EXISTS (SELECT 1 FROM scopes WHERE user_id = ?2 AND scope = ?5)",
            rusqlite::params![hash, user_id, now, expires, scope.name()],
        )?;
        if inserted == 0 {
            // A concurrent writer removed the user/grant between the pre-check
            // and the write (external file). Re-query for a specific
            // fail-closed reason; nothing was persisted.
            let user_still: Option<i64> = self
                .conn
                .query_row("SELECT 1 FROM users WHERE id = ?1", [user_id], |r| r.get(0))
                .optional()?;
            if user_still.is_none() {
                return Err(SessionError::UnknownUser);
            }
            return Err(SessionError::ScopeRescinded);
        }
        Ok(SessionToken { raw, hash })
    }

    /// Resolve a session token to its verified session — the ONLY
    /// `VerifiedSession` constructor. Re-checks, live: token known, not
    /// revoked, not expired, user still present, scope still granted.
    /// A v1-era row (expires_ms = 0) or any unknown scope string fails
    /// closed.
    pub fn resolve_session(&self, token: &str) -> Result<VerifiedSession, SessionError> {
        let raw_bytes = decode_session_token(token)?;
        let token_hash = hash_token_bytes(&raw_bytes);
        let (user_id, created_ms, expires_ms, scope_name, revoked_ms): (
            String,
            i64,
            i64,
            String,
            Option<i64>,
        ) = self
            .conn
            .query_row(
                "SELECT user_id, created_ms, expires_ms, scope, revoked_ms
                     FROM device_sessions WHERE token_hash = ?1",
                [&token_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?
            .ok_or(SessionError::UnknownToken)?;
        if revoked_ms.is_some() {
            return Err(SessionError::Revoked);
        }
        // Clock sanity BEFORE any grant lookup. A non-positive clock (zero /
        // pre-Epoch) and a wallclock that rolled back to before this
        // session's creation are both invalid → fail closed. Expiry stays
        // per-row monotonic: once the clock recovers past `created_ms` the
        // same row resolves again, and an expired session is never revived
        // by old-clock reuse.
        let now = self.now();
        if now <= 0 || now < created_ms {
            return Err(SessionError::InvalidClock);
        }
        if expires_ms <= 0 || now >= expires_ms {
            return Err(SessionError::Expired);
        }
        let scope =
            Scope::from_name(&scope_name).ok_or(SessionError::ScopeNotAllowed("unknown"))?;
        let user_present: Option<i64> = self
            .conn
            .query_row("SELECT 1 FROM users WHERE id = ?1", [&user_id], |r| {
                r.get(0)
            })
            .optional()?;
        if user_present.is_none() {
            return Err(SessionError::UserRemoved);
        }
        let scope_present: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM scopes WHERE user_id = ?1 AND scope = ?2",
                rusqlite::params![user_id, scope.name()],
                |r| r.get(0),
            )
            .optional()?;
        if scope_present.is_none() {
            return Err(SessionError::ScopeRescinded);
        }
        Ok(VerifiedSession::from_parts(
            user_id, token_hash, scope, created_ms, expires_ms,
        ))
    }

    /// Revoke a session by its hash (non-secret). Returns whether a row was
    /// revoked. Revocation is immediate: a following `resolve_session` returns
    /// `Revoked`.
    pub fn revoke_session(&self, session_hash: &str) -> Result<bool, SessionError> {
        let now = self.now();
        let changed = self.conn.execute(
            "UPDATE device_sessions SET revoked_ms = ?2 WHERE token_hash = ?1 AND revoked_ms IS NULL",
            rusqlite::params![session_hash, now],
        )?;
        Ok(changed > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    const BASE: i64 = 1_700_000_000_000;

    struct FakeClock(Arc<AtomicI64>);
    impl FakeClock {
        fn new(start: i64) -> Self {
            FakeClock(Arc::new(AtomicI64::new(start)))
        }
        fn set(&self, v: i64) {
            self.0.store(v, Ordering::SeqCst);
        }
        fn advance(&self, by: i64) {
            self.0.fetch_add(by, Ordering::SeqCst);
        }
        fn clock_fn(&self) -> impl Fn() -> i64 + 'static {
            let arc = Arc::clone(&self.0);
            move || arc.load(Ordering::SeqCst)
        }
    }

    fn db_with(clock: &FakeClock) -> AuthDb {
        AuthDb::open_in_memory_with_clock(clock.clock_fn()).expect("open in-memory")
    }

    fn seed_user(db: &mut AuthDb, id: &str) {
        db.upsert_user(id, "Test User").expect("upsert");
        db.grant_scope(id, Scope::DeviceControl).expect("grant");
    }

    #[test]
    fn create_session_requires_existing_user() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        // grant_scope for an unregistered user is a no-op insert (FK off for
        // scopes? no — FK ON, so this fails) → use upsert first, then no row
        // exists for a DIFFERENT id.
        let err = db
            .create_session("ghost-user", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect_err("unknown user");
        assert!(matches!(err, SessionError::UnknownUser));
    }

    #[test]
    fn create_session_refuses_read_scope() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        db.upsert_user("u1", "U").expect("upsert");
        db.grant_scope("u1", Scope::LocalProject).expect("grant");
        let err = db
            .create_session("u1", Scope::LocalProject, DEFAULT_SESSION_TTL_MS)
            .expect_err("read scope is not a session capability");
        assert!(matches!(
            err,
            SessionError::ScopeNotAllowed("local_project")
        ));
    }

    #[test]
    fn create_session_refuses_cloud_synced_read_scope() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        db.upsert_user("u1", "U").expect("upsert");
        db.grant_scope("u1", Scope::CloudSynced).expect("grant");
        let err = db
            .create_session("u1", Scope::CloudSynced, DEFAULT_SESSION_TTL_MS)
            .expect_err("cloud-synced is a READ scope, never a writer");
        assert!(matches!(err, SessionError::ScopeNotAllowed("cloud_synced")));
    }

    // DEV-10: DeviceUpload and PrintJob are protected WRITER capabilities,
    // grantable to sessions exactly like DeviceControl.
    #[test]
    fn create_session_accepts_device_upload_writer_scope() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        db.upsert_user("u1", "U").expect("upsert");
        db.grant_scope("u1", Scope::DeviceUpload).expect("grant");
        let token = db
            .create_session("u1", Scope::DeviceUpload, DEFAULT_SESSION_TTL_MS)
            .expect("device_upload is a session capability");
        let session = db.resolve_session(token.raw()).expect("resolve");
        assert_eq!(session.scope(), Scope::DeviceUpload);
        assert!(session.has_scope(Scope::DeviceUpload));
        assert!(!session.has_scope(Scope::DeviceControl), "no cross-scope");
        assert!(!session.has_scope(Scope::PrintJob), "no cross-scope");
    }

    #[test]
    fn create_session_accepts_print_job_writer_scope() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        db.upsert_user("u1", "U").expect("upsert");
        db.grant_scope("u1", Scope::PrintJob).expect("grant");
        let token = db
            .create_session("u1", Scope::PrintJob, DEFAULT_SESSION_TTL_MS)
            .expect("print_job is a session capability");
        let session = db.resolve_session(token.raw()).expect("resolve");
        assert_eq!(session.scope(), Scope::PrintJob);
        assert!(session.has_scope(Scope::PrintJob));
        assert!(!session.has_scope(Scope::DeviceControl), "no cross-scope");
        assert!(!session.has_scope(Scope::DeviceUpload), "no cross-scope");
        // The grant is still required: without it the SAME mint refuses.
        db.revoke_scope("u1", Scope::PrintJob).expect("revoke");
        assert!(matches!(
            db.create_session("u1", Scope::PrintJob, DEFAULT_SESSION_TTL_MS)
                .expect_err("rescinded"),
            SessionError::ScopeRescinded
        ));
    }

    #[test]
    fn create_session_ttl_bounds() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        for bad in [0, -1, MAX_SESSION_TTL_MS + 1] {
            let err = db
                .create_session("u1", Scope::DeviceControl, bad)
                .expect_err("ttl bound");
            assert!(matches!(err, SessionError::InvalidTtl), "ttl {bad}");
        }
    }

    #[test]
    fn create_session_requires_granted_scope_and_mints_nothing_on_denial() {
        // Regression (S9.18 correction): create_session previously minted a
        // session for ANY existing user without checking that the scope was
        // actually granted. It must refuse with ScopeRescinded BEFORE any
        // RNG/persist — and leave ZERO rows behind.
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        db.upsert_user("u1", "U").expect("upsert");
        // DeviceControl deliberately NOT granted here.
        let err = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect_err("scope not granted");
        assert!(matches!(err, SessionError::ScopeRescinded));
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM device_sessions", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 0, "denied create must not mint a row");
    }

    #[test]
    fn create_session_clock_must_be_positive() {
        for bad_now in [0i64, -1, -1_700_000_000_000] {
            let clock = FakeClock::new(bad_now);
            let mut db = db_with(&clock);
            db.upsert_user("u1", "U").expect("upsert");
            db.grant_scope("u1", Scope::DeviceControl).expect("grant");
            let err = db
                .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
                .expect_err("bad clock");
            assert!(
                matches!(err, SessionError::InvalidClock),
                "clock {bad_now} gave {err:?}"
            );
        }
    }

    #[test]
    fn create_session_expiry_overflow_is_refused() {
        // now + ttl_ms must fit i64 (checked_add); a broken huge clock can
        // never mint an unwrappable expiry.
        let clock = FakeClock::new(i64::MAX - 1000);
        let mut db = db_with(&clock);
        db.upsert_user("u1", "U").expect("upsert");
        db.grant_scope("u1", Scope::DeviceControl).expect("grant");
        let err = db
            .create_session("u1", Scope::DeviceControl, MAX_SESSION_TTL_MS)
            .expect_err("overflow");
        assert!(matches!(err, SessionError::InvalidClock));
    }

    #[test]
    fn resolve_session_clock_rollback_denied_before_grants_then_recovers() {
        // A wallclock rolled back to before created_ms is InvalidClock and
        // MUST be reported before any grant/user lookup. Once the clock
        // recovers past created_ms the same session resolves again.
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        // Roll back just before creation.
        clock.set(BASE - 1);
        let err = db.resolve_session(token.raw()).expect_err("rollback");
        assert!(matches!(err, SessionError::InvalidClock));
        // Even with the scope revoked, the clock fault is reported first
        // (clock check runs BEFORE grants).
        db.revoke_scope("u1", Scope::DeviceControl)
            .expect("rescind");
        let err = db.resolve_session(token.raw()).expect_err("still rollback");
        assert!(matches!(err, SessionError::InvalidClock));
        // Clock recovers past created_ms → grants now gate resolution.
        clock.set(BASE + 1000);
        let err = db.resolve_session(token.raw()).expect_err("rescinded");
        assert!(matches!(err, SessionError::ScopeRescinded));
    }

    #[test]
    fn resolve_session_zero_and_pre_epoch_clock_are_invalid() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        clock.set(0); // now(0) <= 0 and < created_ms (BASE)
        let err = db.resolve_session(token.raw()).expect_err("zero clock");
        assert!(matches!(err, SessionError::InvalidClock));
        clock.set(-5); // pre-Epoch
        let err = db.resolve_session(token.raw()).expect_err("pre-epoch");
        assert!(matches!(err, SessionError::InvalidClock));
        // Under a valid clock the same row still resolves as revoked (closed).
        clock.set(BASE);
        db.revoke_session(token.hash()).expect("revoke");
        let err = db.resolve_session(token.raw()).expect_err("revoked");
        assert!(matches!(err, SessionError::Revoked));
    }

    #[test]
    fn session_happy_path_and_fields() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        assert_eq!(token.raw().len(), SESSION_TOKEN_HEX_LEN);
        assert_eq!(token.hash().len(), 64);
        let session = db.resolve_session(token.raw()).expect("resolve");
        assert_eq!(session.user_id(), "u1");
        assert_eq!(session.session_hash(), token.hash());
        assert_eq!(session.scope(), Scope::DeviceControl);
        assert_eq!(session.created_ms(), BASE);
        assert_eq!(session.expires_ms(), BASE + DEFAULT_SESSION_TTL_MS);
        assert!(!session.is_expired_at(BASE));
        assert!(session.is_expired_at(BASE + DEFAULT_SESSION_TTL_MS));
        assert!(session.has_scope(Scope::DeviceControl));
        assert!(!session.has_scope(Scope::LocalProject));
        assert!(matches!(
            session.principal(),
            Principal::Local { user_id } if user_id == "u1"
        ));
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        let clock = FakeClock::new(BASE);
        let db = db_with(&clock);
        for bad in ["", "abc", "0".repeat(63).as_str(), "Z".repeat(64).as_str()] {
            let err = db.resolve_session(bad).expect_err("malformed");
            assert!(matches!(err, SessionError::InvalidToken));
        }
        // Bounded decode: a pathologically long input is rejected by length
        // alone (no unbounded work, no secret material in the error).
        let long = "ab".repeat(512);
        assert!(matches!(
            db.resolve_session(&long).expect_err("long malformed"),
            SessionError::InvalidToken
        ));
    }

    #[test]
    fn unknown_token_is_unknown() {
        let clock = FakeClock::new(BASE);
        let db = db_with(&clock);
        let err = db
            .resolve_session(&"a".repeat(64))
            .expect_err("unknown hash");
        assert!(matches!(err, SessionError::UnknownToken));
    }

    #[test]
    fn revoked_session_fails_closed() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        assert!(db.revoke_session(token.hash()).expect("revoke"));
        let err = db.resolve_session(token.raw()).expect_err("revoked");
        assert!(matches!(err, SessionError::Revoked));
        // second revoke is a no-op
        assert!(!db.revoke_session(token.hash()).expect("no-op"));
    }

    #[test]
    fn expired_session_fails_closed() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        clock.advance(DEFAULT_SESSION_TTL_MS + 1);
        let err = db.resolve_session(token.raw()).expect_err("expired");
        assert!(matches!(err, SessionError::Expired));
    }

    #[test]
    fn removed_user_fails_closed() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        assert!(db.remove_user("u1").expect("removed"));
        // FK ON + ON DELETE CASCADE → the session row itself is gone, so the
        // token resolves as UnknownToken; with FK OFF the users() check in
        // resolve_session yields UserRemoved. Both are fail-closed denials.
        let err = db.resolve_session(token.raw()).expect_err("user removed");
        assert!(
            matches!(err, SessionError::UserRemoved | SessionError::UnknownToken),
            "unexpected {err:?}"
        );
        // second remove is a no-op
        assert!(!db.remove_user("u1").expect("no-op"));
    }

    #[test]
    fn rescinded_scope_fails_closed() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        db.revoke_scope("u1", Scope::DeviceControl)
            .expect("rescind");
        let err = db.resolve_session(token.raw()).expect_err("rescinded");
        assert!(matches!(err, SessionError::ScopeRescinded));
    }

    #[test]
    fn v1_rows_expire_immediately() {
        // Simulate a pre-v2 row: expires_ms=0 (default) → must resolve as
        // Expired, not active.
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let (raw, hash) = new_session_token().expect("token");
        db.conn
            .execute(
                "INSERT INTO device_sessions (token_hash, user_id, created_ms, revoked_ms, expires_ms, scope)
                 VALUES (?1, ?2, ?3, NULL, 0, 'device_control')",
                rusqlite::params![hash, "u1", BASE],
            )
            .expect("insert v1-style row");
        let err = db.resolve_session(&raw).expect_err("v1 row invalid");
        assert!(matches!(err, SessionError::Expired));
    }

    #[test]
    fn unknown_scope_string_is_never_granted() {
        // Regression: previously scope_from_name '_' → LocalProject granted
        // unknown names. Now scopes_for must SKIP unknown rows.
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        db.upsert_user("u1", "U").expect("upsert");
        db.conn
            .execute(
                "INSERT INTO scopes (user_id, scope, granted_ms) VALUES (?1, ?2, ?3)",
                rusqlite::params!["u1", "totally_unknown_scope", BASE],
            )
            .expect("insert unknown scope");
        let scopes = db
            .scopes_for(&Principal::Local {
                user_id: "u1".into(),
            })
            .expect("scopes");
        // The ONLY row is an unknown name → skipped → no grants.
        assert_eq!(scopes, vec![]);
    }

    #[test]
    fn session_token_debug_is_redacted() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        let debug = format!("{token:?}");
        assert!(!debug.contains(&token.raw().to_string()));
        assert!(debug.contains("<redacted>"));
        assert!(debug.contains(&token.hash().to_string()));
    }

    #[test]
    fn raw_token_never_stored_and_revocable_by_hash_only() {
        let clock = FakeClock::new(BASE);
        let mut db = db_with(&clock);
        seed_user(&mut db, "u1");
        let token = db
            .create_session("u1", Scope::DeviceControl, DEFAULT_SESSION_TTL_MS)
            .expect("create");
        // The raw token must not appear anywhere in the DB.
        let mut stmt = db
            .conn
            .prepare("SELECT token_hash, user_id, scope FROM device_sessions")
            .expect("prep");
        let mut rows = stmt.query([]).expect("q");
        while let Some(row) = rows.next().expect("n") {
            let (hash, uid, scope): (String, String, String) = (
                row.get(0).expect("h"),
                row.get(1).expect("u"),
                row.get(2).expect("s"),
            );
            assert_eq!(hash, token.hash());
            assert_eq!(uid, "u1");
            assert_eq!(scope, "device_control");
            assert!(!hash.contains(&token.raw().to_string()));
            assert_ne!(hash, token.raw());
        }
        // Revocation by hash only (raw is meaningless after handoff).
        assert!(db.revoke_session(token.hash()).expect("revoke"));
    }
}
