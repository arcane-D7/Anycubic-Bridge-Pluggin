//! Auth API v1 contract — S6-006.
//!
//! Versioned, loopback-only surface: `who` / `scope` / `sync`. Storage is
//! swappable behind this contract (local `auth.db` in R0, Postgres later).
//! Every endpoint is read-only and returns an empty, fail-closed result when
//! the principal is anonymous.

use serde::{Deserialize, Serialize};

use crate::principal::Principal;

/// Scopes the auth service grants. Unknown/absent scope → not granted; no
/// silent widening.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Local-project reads (always available, even with auth off).
    LocalProject,
    /// Cloud-synced reads (require an identified principal; auth off → empty).
    CloudSynced,
}

/// Sync state of cloud data for the current principal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// Auth off / anonymous — cloud reads unavailable, empty result.
    Unavailable,
    /// Identified principal, nothing synced yet.
    Empty,
    /// Identified principal, synced at a given revision.
    Synced { revision: u64 },
}

/// Minimal v1 surface the editor core depends on.
pub trait AuthApiV1 {
    /// `who`: resolve the current principal.
    fn who(&self) -> Principal;
    /// `scope`: scopes granted to the current principal.
    fn scopes(&self) -> Vec<Scope>;
    /// `sync`: sync state for a given scope name.
    fn sync_state(&self, scope: &str) -> SyncState;
}
