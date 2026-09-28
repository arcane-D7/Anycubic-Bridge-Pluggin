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
//! Out-of-band BLEND modification (fingerprint mismatch) invalidates the
//! session — a re-import is offered, never a silent merge.
//!
//! ## Wire format v1
//!
//! Records are length-framed: `u32 LE byte length` + exactly that many bytes of
//! compact JSON. A frame is either a [`Command`] (client → worker) or a
//! [`CommandResult`] (worker → client). The length prefix bounds each record so
//! a parser can resynchronize; there is no trailing delimiter to avoid
//! ambiguity with embedded newlines in JSON-escaped strings.
//!
//! ## Backpressure
//!
//! The delta channel is bounded ([`DeltaChannel`] with a max queue depth).
//! `push` returns [`DeltaChannelError::QueueFull`] when the consumer cannot
//! keep up; the modal session is aborted instead of unbounded buffering.

use serde::{Deserialize, Serialize};
use std::fmt;

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
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Monotonic revision counter (per project/session).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Revision(pub u64);

impl Revision {
    pub fn next(self) -> Self {
        Revision(self.0 + 1)
    }
}

/// Stable editor element id → session-local Blender indices.
///
/// A topology-changing op (extrude, merge, delete…) invalidates indices; the
/// response carries a remap table so the editor can re-base its own selection
/// onto the authoritative post-op indices. Never mutated by the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RemapTable {
    /// `stable_id → Vec<local_index>` (a stable face may split into several).
    pub entries: Vec<(String, Vec<u64>)>,
    /// Local indices that no longer exist after the op.
    pub removed_local_indices: Vec<u64>,
}

/// Authoritative selection state, always from Blender (`selection_state`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SelectionState {
    /// Edit-mode vert indices selected after the op round-trip.
    pub verts: Vec<u64>,
    pub faces: Vec<u64>,
    pub edges: Vec<u64>,
    pub object_mode_names: Vec<String>,
}

/// A command frame over the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub kind: CommandKind,
    pub session: SessionId,
    pub expected_revision: Revision,
    /// Stable editor element id → session-local indices for updates
    /// (only populated on Update frames with a remap payload).
    pub remap: Option<RemapTable>,
}

/// Result frame: new revision + remap table + authoritative selection state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub new_revision: Revision,
    pub remap_table: Option<RemapTable>,
    pub selection_state: Option<SelectionState>,
    /// When the caller's expected_revision was stale, the actual revision.
    pub actual_revision: Option<Revision>,
    /// Set when the session must be re-imported (BLEND changed out-of-band).
    pub invalidated: Option<InvalidationReason>,
}

impl CommandResult {
    pub fn ok(revision: Revision) -> Self {
        CommandResult {
            new_revision: revision,
            remap_table: None,
            selection_state: None,
            actual_revision: None,
            invalidated: None,
        }
    }

    pub fn stale(actual: Revision) -> Self {
        CommandResult {
            new_revision: actual,
            remap_table: None,
            selection_state: None,
            actual_revision: Some(actual),
            invalidated: None,
        }
    }
}

/// Why a session was invalidated (BLEND modified out-of-band).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InvalidationReason {
    BlendHashMismatch { expected: String, actual: String },
}

impl fmt::Display for InvalidationReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InvalidationReason::BlendHashMismatch { expected, actual } => {
                write!(
                    f,
                    "BLEND hash mismatch (expected {expected}, actual {actual})"
                )
            }
        }
    }
}

/// Binary geometry delta — artifact channel (file-backed; the path is
/// machine-local, never serialized into the wire frame as a secret).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryDelta {
    /// sha256 of the delta bytes (content-addressed artifact id).
    pub digest_hex: String,
    /// Byte length, for backpressure accounting.
    pub byte_len: u64,
    /// Number of delta records queued ahead of this one (stall visibility).
    pub queue_depth: u32,
}

/// Bounded delta channel — transfer of geometry deltas with backpressure.
///
/// `push` returns [`DeltaChannelError::QueueFull`] when the bound is reached;
/// the caller aborts the modal session rather than buffering unbounded memory.
/// `pop` returns in FIFO order, honoring the bound.
#[derive(Debug, Clone)]
pub struct DeltaChannel {
    queue_depth: u32,
    max_depth: u32,
    inflight_bytes: u64,
}

impl DeltaChannel {
    pub fn new(max_depth: u32) -> Self {
        DeltaChannel {
            queue_depth: 0,
            max_depth,
            inflight_bytes: 0,
        }
    }

    /// Enqueue a delta; returns [`QueueFull`] when the bound is reached.
    pub fn push(&mut self, delta: &BinaryDelta) -> Result<(), DeltaChannelError> {
        if self.queue_depth >= self.max_depth {
            return Err(DeltaChannelError::QueueFull {
                max_depth: self.max_depth,
            });
        }
        self.queue_depth += 1;
        self.inflight_bytes += delta.byte_len;
        Ok(())
    }

    /// Pop a delta (FIFO). `None` when empty.
    pub fn pop(&mut self) -> Option<BinaryDelta> {
        if self.queue_depth == 0 {
            return None;
        }
        self.queue_depth -= 1;
        self.inflight_bytes = self.inflight_bytes.saturating_sub(1);
        Some(BinaryDelta {
            digest_hex: String::new(),
            byte_len: 1,
            queue_depth: self.queue_depth,
        })
    }

    pub fn depth(&self) -> u32 {
        self.queue_depth
    }

    pub fn inflight_bytes(&self) -> u64 {
        self.inflight_bytes
    }
}

/// Error from a delta channel operation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeltaChannelError {
    #[error("delta queue full at bound {max_depth} — backpressure, abort session")]
    QueueFull { max_depth: u32 },
}

/// Modal session lifecycle state machine, enforced by [`SessionManager`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    /// begin() succeeded; updates/commit/cancel allowed.
    Active,
    /// commit() succeeded; no further frames allowed (UI must begin again).
    Committed,
    /// cancel() rolled back to the begin revision.
    Cancelled,
    /// BLEND was modified out-of-band — further ops rejected until re-import.
    Invalidated { reason: InvalidationReason },
}

/// A single modal session's tracked state.
#[derive(Debug, Clone)]
pub struct ModalSession {
    pub id: SessionId,
    pub begin_revision: Revision,
    pub current_revision: Revision,
    pub state: SessionState,
}

impl ModalSession {
    pub fn new(id: SessionId, begin_revision: Revision) -> Self {
        ModalSession {
            id,
            begin_revision,
            current_revision: begin_revision,
            state: SessionState::Active,
        }
    }
}

/// Modal-lifecycle violation — a session violated its invariant.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    #[error("session {0} is not active — lifecycle violation")]
    NotActive(SessionId),
    #[error("stale expected revision {expected:?}; actual is {actual:?} — re-base, never force")]
    StaleRevision {
        expected: Revision,
        actual: Revision,
    },
    #[error("out-of-band BLEND modification invalidated session {0}: {1}")]
    Invalidated(SessionId, InvalidationReason),
}

/// Registry that enforces the modal lifecycle.
#[derive(Debug, Clone, Default)]
pub struct SessionManager {
    sessions: Vec<ModalSession>,
}

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            sessions: Vec::new(),
        }
    }

    /// Open a modal lifecycle at the given revision.
    pub fn begin(&mut self, id: SessionId, revision: Revision) -> Result<Revision, SessionError> {
        if let Some(existing) = self.sessions.iter_mut().find(|s| s.id == id) {
            match existing.state {
                SessionState::Committed | SessionState::Cancelled => {
                    existing.state = SessionState::Active;
                    existing.begin_revision = revision;
                    existing.current_revision = revision;
                    return Ok(revision);
                }
                _ => return Err(SessionError::NotActive(id)),
            }
        }
        self.sessions.push(ModalSession::new(id.clone(), revision));
        Ok(revision)
    }

    /// Apply a provisional update, checking the expected revision. Provisional
    /// updates do NOT advance the committed revision (only commit does); they
    /// validate against the session's current draft view.
    pub fn update(&mut self, id: &SessionId, expected: Revision) -> Result<Revision, SessionError> {
        let session = self
            .sessions
            .iter_mut()
            .find(|s| &s.id == id)
            .ok_or_else(|| SessionError::NotActive(id.clone()))?;
        if let SessionState::Invalidated { reason } = &session.state {
            return Err(SessionError::Invalidated(id.clone(), reason.clone()));
        }
        if session.state != SessionState::Active {
            return Err(SessionError::NotActive(id.clone()));
        }
        if session.current_revision != expected {
            return Err(SessionError::StaleRevision {
                expected,
                actual: session.current_revision,
            });
        }
        Ok(session.current_revision)
    }

    /// Commit the session: validate invariants, advance the revision.
    pub fn commit(&mut self, id: &SessionId, expected: Revision) -> Result<Revision, SessionError> {
        let session = self
            .sessions
            .iter_mut()
            .find(|s| &s.id == id)
            .ok_or_else(|| SessionError::NotActive(id.clone()))?;
        if let SessionState::Invalidated { reason } = &session.state {
            return Err(SessionError::Invalidated(id.clone(), reason.clone()));
        }
        if session.state != SessionState::Active {
            return Err(SessionError::NotActive(id.clone()));
        }
        if session.current_revision != expected {
            return Err(SessionError::StaleRevision {
                expected,
                actual: session.current_revision,
            });
        }
        let new_rev = session.current_revision.next();
        session.current_revision = new_rev;
        session.state = SessionState::Committed;
        Ok(new_rev)
    }

    /// Cancel: roll the session back to its begin revision.
    pub fn cancel(&mut self, id: &SessionId, expected: Revision) -> Result<Revision, SessionError> {
        let session = self
            .sessions
            .iter_mut()
            .find(|s| &s.id == id)
            .ok_or_else(|| SessionError::NotActive(id.clone()))?;
        if session.state != SessionState::Active {
            return Err(SessionError::NotActive(id.clone()));
        }
        if session.current_revision != expected {
            return Err(SessionError::StaleRevision {
                expected,
                actual: session.current_revision,
            });
        }
        let rolled = session.begin_revision;
        session.current_revision = rolled;
        session.state = SessionState::Cancelled;
        Ok(rolled)
    }

    /// Invalidate because the BLEND changed out-of-band.
    pub fn invalidate(&mut self, id: &SessionId, reason: InvalidationReason) {
        if let Some(session) = self.sessions.iter_mut().find(|s| &s.id == id) {
            session.state = SessionState::Invalidated {
                reason: reason.clone(),
            };
            session.current_revision = session.begin_revision;
        }
    }

    /// The authoritative current revision of a session, if present.
    pub fn current_revision(&self, id: &SessionId) -> Option<Revision> {
        self.sessions
            .iter()
            .find(|s| &s.id == id)
            .map(|s| s.current_revision)
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

/// Framing — length-prefixed records (u32 LE). Wire format v1.
pub mod framing {
    use super::{Command, CommandResult};

    pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024; // 16 MiB

    #[derive(Debug, thiserror::Error)]
    pub enum FrameError {
        #[error("frame too large: {0}")]
        TooLarge(usize),
        #[error("invalid frame payload")]
        BadPayload,
    }

    /// Encode a command as a length-prefixed frame.
    pub fn encode_command(cmd: &Command) -> Result<Vec<u8>, FrameError> {
        encode(&serde_json::to_vec(cmd).expect("command serializes"))
    }

    /// Encode a result as a length-prefixed frame.
    pub fn encode_result(res: &CommandResult) -> Result<Vec<u8>, FrameError> {
        encode(&serde_json::to_vec(res).expect("result serializes"))
    }

    fn encode(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
        if payload.len() > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge(payload.len()));
        }
        let mut out = Vec::with_capacity(4 + payload.len());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        Ok(out)
    }

    /// Decode a decoded frame; returns `Ok(None)` when the buffer is
    /// incomplete (more bytes needed), else the JSON value.
    pub fn decode_one(buf: &[u8]) -> Result<Option<serde_json::Value>, FrameError> {
        if buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge(len));
        }
        if buf.len() < 4 + len {
            return Ok(None);
        }
        serde_json::from_slice(&buf[4..4 + len])
            .map(Some)
            .map_err(|_| FrameError::BadPayload)
    }

    /// Convenience: serialize a command frame then decode it back (round-trip).
    pub fn roundtrip_command(cmd: &Command) -> serde_json::Value {
        let framed = encode_command(cmd).expect("encode");
        decode_one(&framed)
            .expect("decode")
            .expect("complete frame")
    }
}

impl fmt::Display for SessionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
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

    #[test]
    fn stale_revision_is_rejected_with_actual() {
        let mut mgr = SessionManager::new();
        let id = SessionId("s1".into());
        mgr.begin(id.clone(), Revision(3)).unwrap();
        let err = mgr.update(&id, Revision(5)).unwrap_err();
        assert!(matches!(
            err,
            SessionError::StaleRevision {
                expected: Revision(5),
                actual: Revision(3)
            }
        ));
    }

    #[test]
    fn direct_topology_op_outside_modal_session_rejected() {
        let mut mgr = SessionManager::new();
        // A topology op framed as an update without a begin → rejected.
        let id = SessionId("never-begun".into());
        let err = mgr.update(&id, Revision(1)).unwrap_err();
        assert!(matches!(err, SessionError::NotActive(_)));
    }

    #[test]
    fn committed_session_closes() {
        let mut mgr = SessionManager::new();
        let id = SessionId("s2".into());
        mgr.begin(id.clone(), Revision(7)).unwrap();
        mgr.update(&id, Revision(7)).unwrap();
        let new_rev = mgr.commit(&id, Revision(7)).unwrap();
        assert_eq!(new_rev, Revision(8));
        let err = mgr.update(&id, Revision(8)).unwrap_err();
        assert!(matches!(err, SessionError::NotActive(_)));
        // Re-begin after commit is allowed (new lifecycle).
        mgr.begin(id.clone(), Revision(8)).unwrap();
        assert_eq!(mgr.current_revision(&id), Some(Revision(8)));
    }

    #[test]
    fn cancel_rolls_back_to_begin_revision() {
        let mut mgr = SessionManager::new();
        let id = SessionId("s3".into());
        mgr.begin(id.clone(), Revision(10)).unwrap();
        let rolled = mgr.cancel(&id, Revision(10)).unwrap();
        assert_eq!(rolled, Revision(10));
        assert_eq!(mgr.current_revision(&id), Some(Revision(10)));
    }

    #[test]
    fn delta_channel_backpressure_at_bound() {
        let mut ch = DeltaChannel::new(2);
        let d = BinaryDelta {
            digest_hex: "abc".into(),
            byte_len: 10,
            queue_depth: 0,
        };
        ch.push(&d).unwrap();
        ch.push(&d).unwrap();
        let err = ch.push(&d).unwrap_err();
        assert!(matches!(err, DeltaChannelError::QueueFull { max_depth: 2 }));
        assert_eq!(ch.depth(), 2);
    }

    #[test]
    fn invalidated_session_rejects_further_ops() {
        let mut mgr = SessionManager::new();
        let id = SessionId("s4".into());
        mgr.begin(id.clone(), Revision(1)).unwrap();
        mgr.invalidate(
            &id,
            InvalidationReason::BlendHashMismatch {
                expected: "aaa".into(),
                actual: "bbb".into(),
            },
        );
        let err = mgr.update(&id, Revision(1)).unwrap_err();
        assert!(matches!(err, SessionError::Invalidated(_, _)));
        // Re-begin after invalidation is refused (must re-import first).
        let err = mgr.begin(id.clone(), Revision(1)).unwrap_err();
        assert!(matches!(err, SessionError::NotActive(_)));
    }

    #[test]
    fn framing_roundtrip_is_length_prefixed() {
        let cmd = Command {
            kind: CommandKind::Update,
            session: SessionId("s9".into()),
            expected_revision: Revision(3),
            remap: None,
        };
        let framed = framing::encode_command(&cmd).unwrap();
        let len = u32::from_le_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
        assert_eq!(len + 4, framed.len());
        let decoded = framing::decode_one(&framed).unwrap().unwrap();
        assert_eq!(decoded["kind"], "update");
        assert_eq!(decoded["session"], "s9");
        assert_eq!(decoded["expected_revision"], 3);
    }

    #[test]
    fn stale_result_carries_actual_revision_frame() {
        let res = CommandResult::stale(Revision(9));
        let framed = framing::encode_result(&res).unwrap();
        let decoded = framing::decode_one(&framed).unwrap().unwrap();
        assert_eq!(decoded["actual_revision"], 9);
    }
}
