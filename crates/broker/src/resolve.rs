//! Session-resolution bridge between the broker and the auth repository.
//!
//! The broker never parses identity from caller-supplied JSON. Every
//! protected-write path resolves the caller's raw session token through
//! `auth_service::AuthDb::resolve_session`, which re-validates (token known,
//! not revoked, not expired, user present, scope still granted) at the moment
//! of use. That gate lives here so both
//! [`crate::approval::ApprovalAuthority::issue_for_session`] and
//! [`crate::dispatch::DispatchGate::dispatch_for_session`] share the exact
//! same mapping from `SessionError` to a generic, token-free static reason.

use auth_service::{AuthDb, SessionError, VerifiedSession};

/// Map a session denial to a **static, token-free** reason. Used to build the
/// generic `SessionDenied(&'static str)` variants in `ApprovalError` /
/// `DispatchError` — raw tokens are never part of any error.
pub fn reason(err: &SessionError) -> &'static str {
    match err {
        SessionError::UnknownUser => "user",
        SessionError::ScopeNotAllowed(_) => "scope",
        SessionError::InvalidTtl => "malformed",
        SessionError::InvalidToken => "malformed",
        SessionError::UnknownToken => "unauthenticated",
        SessionError::Revoked => "revoked",
        SessionError::Expired => "expired",
        SessionError::ScopeRescinded => "scope",
        SessionError::UserRemoved => "user",
        SessionError::Rng => "unavailable",
        SessionError::InvalidClock => "unavailable",
        SessionError::Db(_) => "unavailable",
    }
}

/// Resolve a session token against the auth repository, failing closed.
pub fn resolve_session<'a>(db: &'a AuthDb, token: &str) -> Result<VerifiedSession, SessionError> {
    db.resolve_session(token)
}
