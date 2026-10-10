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
    /// Device-control capability: authorizes protected writes (temperature,
    /// fan, speed, lights, ACE). This scope NEVER covers reads.
    DeviceControl,
    /// Device-upload capability (DEV-10): authorizes writing artifacts to
    /// the account cloud shelf via the typed upload effect. A protected
    /// WRITER scope — unrelated to the read-only `CloudSynced` scope; it
    /// never covers reads.
    DeviceUpload,
    /// Print-job capability (DEV-10): authorizes the queue / start / stop
    /// print-job effects. A protected WRITER scope; it never covers reads.
    PrintJob,
}

impl Scope {
    /// Stable wire/storage name (also the `scopes`/`device_sessions` column
    /// value). The parser side (`Scope::from_name`) is exhaustive and
    /// fail-closed: an unknown name is `None`, never a fallback grant.
    pub fn name(self) -> &'static str {
        match self {
            Scope::LocalProject => "local_project",
            Scope::CloudSynced => "cloud_synced",
            Scope::DeviceControl => "device_control",
            Scope::DeviceUpload => "device_upload",
            Scope::PrintJob => "print_job",
        }
    }

    /// Parse a storage name. **Exhaustive allowlist:** unknown names return
    /// `None` — never a default scope — so a corrupted/unknown row cannot
    /// silently widen to a grant.
    pub fn from_name(name: &str) -> Option<Scope> {
        match name {
            "local_project" => Some(Scope::LocalProject),
            "cloud_synced" => Some(Scope::CloudSynced),
            "device_control" => Some(Scope::DeviceControl),
            "device_upload" => Some(Scope::DeviceUpload),
            "print_job" => Some(Scope::PrintJob),
            _ => None,
        }
    }

    /// Scopes that can back a session (an explicit writable capability).
    /// `LocalProject`/`CloudSynced` are READ scopes and must never grant
    /// writer access. Only the protected writers — `DeviceControl`,
    /// `DeviceUpload` and `PrintJob` — are session capabilities.
    pub fn is_session_capability(self) -> bool {
        matches!(
            self,
            Scope::DeviceControl | Scope::DeviceUpload | Scope::PrintJob
        )
    }
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
