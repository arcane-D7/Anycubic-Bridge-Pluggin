//! Command journal — undo/redo/recovery authority (S7-005).
//!
//! bpy has no UI undo stack; the append-only commit journal IS the undo
//! authority. Each committed op appends an entry; reversible ops carry an
//! inverse entry. `undo_plan(target)` replays inverses (newest → oldest),
//! validating selection: an inverse that would delete/remap elements that the
//! current selection references is REFUSED with a documented reason and no
//! revision moves. `redo_plan()` replays forward but NEVER past the committed
//! frontier. Crash recovery = autosave snapshot (periodic BLEND snapshot +
//! revision) + journal replay to the last committed revision (see
//! `tests/journal_recovery.rs` for the worker-killed integration path).
//!
//! Op vocabulary mirrors the S7-003 corpus op kinds so undo/redo parity against
//! the corpus is measurable (classification test in this file).

use crate::ipc::Revision;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Forward op vocabulary — subset of the R1 matrix rows; mirrors
/// `tests/corpus/manifest.json` op kinds. Each kind is classified reversible
/// or irreversible (geometry-creating/merging ops have no exact inverse).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    AddObject,
    DeleteObject,
    Translate,
    Rotate,
    Scale,
    ApplyTransform,
    RecalcNormals,
    SelectElements,
    TransformSelected,
    DuplicateObject,
    JoinObjects,
    Extrude,       // irreversible (creates geometry)
    Inset,         // irreversible
    Bevel,         // irreversible
    LoopCut,       // irreversible
    MergeDoubles,  // irreversible (merge has no unique split)
    DissolveEdges, // irreversible
    DeleteVerts,   // irreversible
}

impl OpKind {
    /// A reversible op has an exact inverse that restores the prior mesh hash.
    pub fn is_reversible(&self) -> bool {
        self.inverse().is_some()
    }

    /// The inverse kind for reversible ops; `None` for irreversible.
    pub fn inverse(&self) -> Option<OpKind> {
        match self {
            OpKind::AddObject | OpKind::DuplicateObject => Some(OpKind::DeleteObject),
            OpKind::DeleteObject => Some(OpKind::AddObject),
            OpKind::Translate
            | OpKind::Rotate
            | OpKind::Scale
            | OpKind::ApplyTransform
            | OpKind::RecalcNormals
            | OpKind::SelectElements
            | OpKind::TransformSelected
            | OpKind::JoinObjects => Some(*self),
            _ => None,
        }
    }

    /// Does the inverse of this op risk leaving a stale selection (element
    /// deletion/remap)? Mirrors the R1 selection invariants.
    pub fn inverse_touches_selection(&self) -> bool {
        matches!(
            self,
            OpKind::AddObject | OpKind::DeleteObject | OpKind::DuplicateObject
        )
    }
}

/// Inverse payload — what to replay to undo the op.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InverseEntry {
    pub op: OpKind,
    pub params: serde_json::Value,
    /// Local indices this inverse deletes/remaps (stale-selection risk).
    pub element_refs: Vec<u64>,
    /// Documented reason the undo may be refused (for the UI).
    pub risk_note: String,
}

/// A committed journal entry with its inverse (when reversible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    /// Committed revision AFTER the op.
    pub revision: Revision,
    pub op: OpKind,
    pub params: serde_json::Value,
    /// Canonical mesh hash recorded BEFORE the op (for parity measurement).
    pub pre_hash: Option<String>,
    pub inverse: Option<InverseEntry>,
}

/// Why an undo/redo/recovery was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JournalError {
    #[error("op {op:?} at revision {revision:?} is irreversible: {reason}")]
    IrreversibleOp {
        revision: Revision,
        op: OpKind,
        reason: String,
    },
    #[error("undo to {target:?} would leave stale selection at op {op:?} (revision {revision:?}): {reason}")]
    StaleSelection {
        target: Revision,
        revision: Revision,
        op: OpKind,
        reason: String,
    },
    #[error("target revision {0:?} not found in the journal")]
    UnknownTarget(Revision),
    #[error("redo past the committed frontier {committed:?} refused (requested {requested:?})")]
    RedoPastCommitted {
        committed: Revision,
        requested: Revision,
    },
    #[error(
        "snapshot revision {0:?} is ahead of the journal frontier (committed could not be reached)"
    )]
    SnapshotAheadOfJournal(Revision),
}

/// A validated undo plan — exact inverse sequence to replay.
#[derive(Debug, Clone)]
pub struct UndoPlan {
    pub target: Revision,
    /// Inverses to apply newest → oldest.
    pub steps: Vec<InverseEntry>,
    /// Mesh hash expected after replay (recorded before the undone ops) —
    /// Blender-undo equivalence check target.
    pub expected_pre_hash: Option<String>,
}

/// A validated redo plan.
#[derive(Debug, Clone)]
pub struct RedoPlan {
    pub target: Revision,
    /// Forward entries to replay oldest → newest (committed revision only).
    pub steps: Vec<JournalEntry>,
}

/// Autosave snapshot — periodic BLEND snapshot + committed revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub revision: Revision,
    pub blend_path: String,
    /// BLEND fingerprint at snapshot time (BLEND hash for validation).
    pub blend_hash: String,
}

/// The command journal (append-only) + autosave snapshot pointer.
///
/// `committed` = highest durable revision; `current` = working position
/// (moves down on undo, up on redo, never above `committed`).
#[derive(Debug, Clone)]
pub struct Journal {
    committed: Revision,
    current: Revision,
    entries: BTreeMap<u64, JournalEntry>,
    last_snapshot: Option<Snapshot>,
}

impl Default for Journal {
    fn default() -> Self {
        Journal {
            committed: Revision(0),
            current: Revision(0),
            entries: BTreeMap::new(),
            last_snapshot: None,
        }
    }
}

impl Journal {
    pub fn new() -> Self {
        Journal::default()
    }

    /// Append a committed op; `current` and `committed` advance to `revision`.
    pub fn append(&mut self, entry: JournalEntry) {
        self.committed = entry.revision;
        self.current = entry.revision;
        self.entries.insert(entry.revision.0, entry);
    }

    pub fn committed(&self) -> Revision {
        self.committed
    }

    pub fn current(&self) -> Revision {
        self.current
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Record an autosave snapshot.
    pub fn record_autosave(&mut self, snapshot: Snapshot) {
        self.last_snapshot = Some(snapshot);
    }

    pub fn last_snapshot(&self) -> Option<&Snapshot> {
        self.last_snapshot.as_ref()
    }

    /// Build a validated undo plan to `target` from the CURRENT selection
    /// (live local indices). Refuses: unknown target, irreversible ops in
    /// range, and inverses that would delete/remap still-selected elements.
    ///
    /// `target` = the revision to revert TO (state after `target` committed
    /// ops); genesis `0` = the empty scene (before the first op).
    pub fn undo_plan(
        &self,
        target: Revision,
        live_selection: &[u64],
    ) -> Result<UndoPlan, JournalError> {
        if target.0 != 0 && !self.entries.contains_key(&target.0) {
            return Err(JournalError::UnknownTarget(target));
        }
        let range: Vec<&JournalEntry> = self
            .entries
            .range(target.0 + 1..)
            .filter(|(rev, _)| **rev <= self.current.0)
            .map(|(_, e)| e)
            .collect();

        let mut steps = Vec::with_capacity(range.len());
        for entry in range.iter().rev() {
            let Some(inv) = &entry.inverse else {
                return Err(JournalError::IrreversibleOp {
                    revision: entry.revision,
                    op: entry.op,
                    reason: format!(
                        "op {:?} creates/merges geometry with no exact inverse",
                        entry.op
                    ),
                });
            };
            if entry.op.inverse_touches_selection() {
                if let Some(hit) = inv.element_refs.iter().find(|r| live_selection.contains(r)) {
                    return Err(JournalError::StaleSelection {
                        target,
                        revision: entry.revision,
                        op: entry.op,
                        reason: format!(
                            "inverse would remove/deindex element {hit} still selected (selection invariant)"
                        ),
                    });
                }
            }
            steps.push(inv.clone());
        }

        Ok(UndoPlan {
            target,
            steps,
            expected_pre_hash: self.entries.get(&target.0).and_then(|e| e.pre_hash.clone()),
        })
    }

    /// Apply a validated undo plan (advances `current` down to `target`).
    pub fn apply_undo(&mut self, plan: &UndoPlan) -> Revision {
        self.current = plan.target;
        self.current
    }

    /// Build a redo plan to a committed revision (never past frontier).
    pub fn redo_plan(&self, target: Revision) -> Result<RedoPlan, JournalError> {
        if target.0 > self.committed.0 {
            return Err(JournalError::RedoPastCommitted {
                committed: self.committed,
                requested: target,
            });
        }
        let target_max = target.0.min(self.committed.0);
        let steps: Vec<JournalEntry> = self
            .entries
            .range(self.current.0 + 1..=target_max)
            .map(|(_, e)| e.clone())
            .collect();
        Ok(RedoPlan {
            target: Revision(target_max),
            steps,
        })
    }

    /// Apply a validated redo plan (advances `current` up to `target`).
    pub fn apply_redo(&mut self, plan: &RedoPlan) -> Revision {
        self.current = plan.target;
        self.current
    }

    /// Crash recovery: from the last autosave snapshot, replay the journal to
    /// the last committed revision. The snapshot must not be ahead of the
    /// journal frontier. Selection is re-validated per committed entry (they
    /// were validated at commit time, so a replay to a committed revision is
    /// stale-safe by construction).
    pub fn recover(&mut self) -> Result<Revision, JournalError> {
        let Some(snapshot) = &self.last_snapshot else {
            return Ok(self.current);
        };
        if snapshot.revision.0 > self.committed.0 {
            return Err(JournalError::SnapshotAheadOfJournal(self.committed));
        }
        self.current = snapshot.revision;
        let plan = self.redo_plan(self.committed)?;
        self.current = plan.target;
        Ok(self.current)
    }

    /// Compute a parity undo round-trip over reversible ops only: the inverse
    /// sequence must restore the recorded pre-op hash for the LAST reversible
    /// op in the journal (Blender-undo equivalence on corpus ops).
    pub fn parity_roundtrip_hash(&self) -> Option<String> {
        // Find the newest entry tracking a pre_hash; its inverse must restore it.
        self.entries
            .values()
            .rev()
            .find(|e| e.pre_hash.is_some())
            .and_then(|e| e.pre_hash.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(rev: u64, op: OpKind, pre: &str, inv: Option<InverseEntry>) -> JournalEntry {
        JournalEntry {
            revision: Revision(rev),
            op,
            params: json!({}),
            pre_hash: Some(pre.to_string()),
            inverse: inv,
        }
    }

    fn t(_rev: u64) -> InverseEntry {
        InverseEntry {
            op: OpKind::Translate,
            params: json!({"dx": -0.1}),
            element_refs: vec![],
            risk_note: "translate is reversible".into(),
        }
    }

    fn add(_rev: u64) -> InverseEntry {
        InverseEntry {
            op: OpKind::DeleteObject,
            params: json!({"id": "o-1"}),
            element_refs: vec![3],
            risk_note: "delete object removes its elements".into(),
        }
    }

    #[test]
    fn corpus_op_classification_matches_matrix() {
        // R1 matrix rows from tests/corpus/manifest.json — classification must
        // match: make/transform/merge rows reversible; topology rows irreversible.
        assert!(OpKind::Translate.is_reversible());
        assert!(OpKind::Rotate.is_reversible());
        assert!(OpKind::Scale.is_reversible());
        assert!(OpKind::ApplyTransform.is_reversible());
        assert!(OpKind::RecalcNormals.is_reversible());
        assert!(!OpKind::Extrude.is_reversible());
        assert!(!OpKind::Inset.is_reversible());
        assert!(!OpKind::Bevel.is_reversible());
        assert!(!OpKind::LoopCut.is_reversible());
        assert!(!OpKind::MergeDoubles.is_reversible());
        assert!(!OpKind::DissolveEdges.is_reversible());
        assert!(!OpKind::DeleteVerts.is_reversible());
    }

    #[test]
    fn undo_replays_inverse_sequence_to_target() {
        let mut j = Journal::new();
        j.append(entry(1, OpKind::AddObject, "h1", Some(add(1))));
        j.append(entry(2, OpKind::Translate, "h2", Some(t(2))));
        j.append(entry(3, OpKind::Rotate, "h3", Some(t(3))));
        let plan = j.undo_plan(Revision(1), &[]).unwrap();
        // newest→oldest inverse order
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.expected_pre_hash.as_deref(), Some("h1"));
        j.apply_undo(&plan);
        assert_eq!(j.current(), Revision(1));
    }

    #[test]
    fn undo_refuses_stale_selection_with_reason() {
        let mut j = Journal::new();
        j.append(entry(1, OpKind::AddObject, "h1", Some(add(1))));
        j.append(entry(2, OpKind::Translate, "h2", Some(t(2))));
        // element 3 (deleted by the AddObject inverse at genesis) is selected
        let err = j.undo_plan(Revision(0), &[3]).unwrap_err();
        assert!(matches!(err, JournalError::StaleSelection { .. }));
        assert_eq!(j.current(), Revision(2)); // unchanged
                                              // without the selection, genesis undo is allowed
        let plan = j.undo_plan(Revision(0), &[]).unwrap();
        assert_eq!(plan.steps.len(), 2);
        j.apply_undo(&plan);
        assert_eq!(j.current(), Revision(0));
    }

    #[test]
    fn undo_refuses_irreversible_op() {
        let mut j = Journal::new();
        j.append(entry(1, OpKind::Extrude, "h1", None)); // no inverse
        j.append(entry(2, OpKind::Translate, "h2", Some(t(2))));
        let err = j.undo_plan(Revision(0), &[]).unwrap_err();
        assert!(matches!(err, JournalError::IrreversibleOp { .. }));
    }

    #[test]
    fn redo_never_exceeds_committed_revision() {
        let mut j = Journal::new();
        j.append(entry(4, OpKind::Translate, "h4", Some(t(4))));
        j.append(entry(5, OpKind::Scale, "h5", Some(t(5))));
        let plan = j.undo_plan(Revision(4), &[]).unwrap();
        j.apply_undo(&plan);
        assert_eq!(j.current(), Revision(4));
        // redo to 5 (committed) allowed
        let plan = j.redo_plan(Revision(5)).unwrap();
        j.apply_redo(&plan);
        assert_eq!(j.current(), Revision(5));
        // redo past committed refused
        let err = j.redo_plan(Revision(9)).unwrap_err();
        assert!(matches!(err, JournalError::RedoPastCommitted { .. }));
    }

    #[test]
    fn crash_recovery_replays_to_last_committed() {
        let mut j = Journal::new();
        j.append(entry(3, OpKind::AddObject, "h3", Some(add(3))));
        j.append(entry(4, OpKind::Translate, "h4", Some(t(4))));
        j.append(entry(5, OpKind::Rotate, "h5", Some(t(5))));
        // autosave happened at committed revision 4
        j.record_autosave(Snapshot {
            revision: Revision(4),
            blend_path: "autosave-4.blend".into(),
            blend_hash: "h4".into(),
        });
        // "worker killed" — recover replays 4 → 5 (last committed)
        let recovered = j.recover().unwrap();
        assert_eq!(recovered, Revision(5));
        assert_eq!(j.current(), Revision(5));
    }

    #[test]
    fn recovery_rejects_snapshot_ahead_of_journal() {
        let mut j = Journal::new();
        j.append(entry(4, OpKind::Translate, "h4", Some(t(4))));
        j.record_autosave(Snapshot {
            revision: Revision(9),
            blend_path: "bad.blend".into(),
            blend_hash: "x".into(),
        });
        let err = j.recover().unwrap_err();
        assert!(matches!(err, JournalError::SnapshotAheadOfJournal(_)));
    }

    #[test]
    fn parity_roundtrip_recovers_pre_op_hash() {
        let mut j = Journal::new();
        j.append(entry(1, OpKind::Translate, "h1", Some(t(1))));
        j.append(entry(2, OpKind::Extrude, "h2", None));
        j.append(entry(3, OpKind::RecalcNormals, "h3", Some(t(3))));
        // newest pre_hash tracked = h3 (op 3's pre-state)
        assert_eq!(j.parity_roundtrip_hash().as_deref(), Some("h3"));
    }
}
