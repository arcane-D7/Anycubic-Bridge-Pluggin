//! Versioned IPC command contract — S7-002.
//!
//! Every interactive op is a modal lifecycle over a session:
//!
//! ```text
//! begin (revision) → 0+ updates (provisional) → commit (validate invariants,
//! journal, advance revision) | cancel (roll to begin-revision)
//! ```
//!
//! Every command carries `expected_revision`; a mismatch is rejected with the
//! **actual** revision so the UI can re-base (never force). Geometry payloads
//! travel as binary deltas on an artifact channel with bounded backpressure.
//!
//! This file is the S7-002 landing area; the full wire format + modal state
//! machine live here as that ticket executes. Currently exported types are the
//! shared vocabulary (op kinds, session identity, revision) consumed by S7-001
//! tests and the S7-003 corpus runner.

use serde::{Deserialize, Serialize};

/// Modal command kinds (wire vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandKind {
    /// Open a modal session; returns the base revision + session id.
    Begin,
    /// Apply a provisional update within the session.
    Update,
    /// Validate selection invariants, journal, advance the revision.
    Commit,
    /// Roll the session back to its begin-revision.
    Cancel,
}

/// Session identity: unique per modal lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionId(pub String);

/// Monotonic revision counter (per project/session).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Revision(pub u64);

impl Revision {
    pub fn next(self) -> Self {
        Revision(self.0 + 1)
    }
}

/// A command frame over the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub kind: CommandKind,
    pub session: SessionId,
    pub expected_revision: Revision,
    /// Stable editor element id → session-local indices for updates.
    pub remap: Option<serde_json::Value>,
}

/// Result frame: new revision + remap table + authoritative selection state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub new_revision: Revision,
    pub remap_table: Option<serde_json::Value>,
    pub selection_state: Option<serde_json::Value>,
    /// When the caller's expected_revision was stale, the actual revision.
    pub actual_revision: Option<Revision>,
}

impl CommandResult {
    pub fn ok(revision: Revision) -> Self {
        CommandResult {
            new_revision: revision,
            remap_table: None,
            selection_state: None,
            actual_revision: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_increments() {
        assert_eq!(Revision(1).next(), Revision(2));
    }

    #[test]
    fn kinds_roundtrip_snake_case() {
        let s = serde_json::to_string(&CommandKind::Begin).unwrap();
        assert_eq!(s, "\"begin\"");
    }
}
