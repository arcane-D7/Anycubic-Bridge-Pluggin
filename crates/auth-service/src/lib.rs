//! Auth service skeleton — S6-006.
//!
//! Separable, loopback-only auth service. Owns its own `auth.db` — **never**
//! the editor/workspace DB (see `broker`). The editor core boots and operates
//! with this service absent: auth off → `synced` reads unavailable, no
//! fallback to another user, empty result. Printer/cloud credentials never
//! flow through here (tenant boundary: auth tenant ≠ printer creds).

use serde::{Deserialize, Serialize};

pub mod api;
pub mod db;
pub mod principal;

pub use api::{AuthApiV1, Scope, SyncState};
pub use db::{AuthDb, AuthDbError};
pub use principal::Principal;

/// API contract version (v1: who/scope/sync).
pub const AUTH_API_VERSION: &str = "v1";

/// Epoch-millis timestamp used for the auth store (injectable in tests).
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A resolved "who am I" answer from the auth service.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WhoAmI {
    pub principal: Principal,
    pub scopes: Vec<Scope>,
    pub sync: SyncState,
}
