//! Continuous-learning job journal v1 — S9-005 (§3.5).
//!
//! Every slice→print job is an APPEND-ONLY record: input hashes
//! (mesh/profile/material/environment), schema + content revisions,
//! machine/material, telemetry with `source = sensor | human` provenance,
//! timestamps, outcome labels and explicit uncertainty. Human labels NEVER
//! silently overwrite sensor data (and vice versa): conflicts are STORED,
//! not resolved in place. The retrieval gate ("find similar past jobs") is
//! read-only — the lowest gate.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// Provenance of a single evidence item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceSource {
    Sensor,
    Human,
}

/// One telemetry/observation value with provenance and explicit uncertainty.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EvidenceItem {
    pub key: String,
    pub value: Json,
    pub source: EvidenceSource,
    pub timestamp_ms: u64,
    /// 0..=1 explicit uncertainty; `None` = unknown.
    pub uncertainty: Option<f64>,
}

/// Input hashes of one job (content-addressed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputHashes {
    pub mesh: String,
    pub profile: String,
    pub material: String,
    pub environment: String,
}

/// A stored conflict between sensor and human evidence for the same key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictFlag {
    pub key: String,
    pub sources: Vec<EvidenceSource>,
}

/// Immutable job record (§3.5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JobRecord {
    pub job_id: String,
    pub input_hashes: InputHashes,
    pub schema_rev: String,
    pub content_rev: String,
    pub machine: String,
    pub material: String,
    pub created_ms: u64,
    pub telemetry: Vec<EvidenceItem>,
    pub outcome_label: Option<String>,
    pub conflicts: Vec<ConflictFlag>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum JournalError {
    #[error("job not found: {0}")]
    NotFound(String),
    #[error("job id already present: {0}")]
    DuplicateId(String),
}

/// APPEND-ONLY job journal. Records are never modified in place; the
/// retrieval gate only reads.
#[derive(Clone, Debug, Default)]
pub struct JobJournal {
    records: Vec<JobRecord>,
    index: std::collections::HashMap<String, usize>,
}

impl JobJournal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a new immutable record. Duplicate ids are refused — no
    /// overwrite ever.
    pub fn append(&mut self, record: JobRecord) -> Result<(), JournalError> {
        if self.index.contains_key(&record.job_id) {
            return Err(JournalError::DuplicateId(record.job_id.clone()));
        }
        self.index.insert(record.job_id.clone(), self.records.len());
        self.records.push(record);
        Ok(())
    }

    pub fn get(&self, job_id: &str) -> Option<&JobRecord> {
        self.index.get(job_id).map(|&i| &self.records[i])
    }

    pub fn records(&self) -> &[JobRecord] {
        &self.records
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Append an evidence item to an existing job. If the same key already
    /// exists from the OTHER source, BOTH values are stored and a conflict
    /// flag is added — conflicts are stored, never resolved in place.
    /// Returns the conflict flag when a conflict was detected.
    pub fn append_evidence(
        &mut self,
        job_id: &str,
        item: EvidenceItem,
    ) -> Result<Option<ConflictFlag>, JournalError> {
        let idx = self
            .index
            .get(job_id)
            .copied()
            .ok_or_else(|| JournalError::NotFound(job_id.to_string()))?;
        let mut flag = None;
        for existing in &self.records[idx].telemetry {
            if existing.key == item.key && existing.source != item.source {
                flag = Some(ConflictFlag {
                    key: item.key.clone(),
                    sources: vec![existing.source, item.source],
                });
                break;
            }
        }
        self.records[idx].telemetry.push(item);
        if let Some(f) = &flag {
            self.records[idx].conflicts.push(f.clone());
        }
        Ok(flag)
    }

    /// Retrieval gate — LOWEST gate, strictly read-only.
    pub fn find_similar(&self, machine: &str, material: &str) -> Vec<&JobRecord> {
        self.records
            .iter()
            .filter(|r| r.machine == machine && r.material == material)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(job_id: &str, machine: &str, material: &str) -> JobRecord {
        JobRecord {
            job_id: job_id.to_string(),
            input_hashes: InputHashes {
                mesh: "mesh".into(),
                profile: "profile".into(),
                material: material.into(),
                environment: "env".into(),
            },
            schema_rev: "1".into(),
            content_rev: "1".into(),
            machine: machine.into(),
            material: material.into(),
            created_ms: 0,
            telemetry: vec![],
            outcome_label: None,
            conflicts: vec![],
        }
    }

    #[test]
    fn journal_is_append_only_and_no_overwrite() {
        let mut journal = JobJournal::new();
        journal.append(job("j1", "kobra-s1", "pla")).unwrap();
        journal.append(job("j2", "kobra-4", "abs")).unwrap();
        assert_eq!(journal.len(), 2);
        assert_eq!(journal.get("j1").unwrap().machine, "kobra-s1");
        assert_eq!(journal.get("j2").unwrap().material, "abs");
        assert!(journal.get("nope").is_none());
        // duplicate id refused — the record is never overwritten
        assert_eq!(
            journal.append(job("j1", "kobra-s1", "pla")).unwrap_err(),
            JournalError::DuplicateId("j1".to_string())
        );
        assert_eq!(journal.len(), 2);
    }

    #[test]
    fn human_sensor_conflict_stored_not_overwritten() {
        let mut journal = JobJournal::new();
        journal.append(job("j1", "kobra-s1", "pla")).unwrap();
        journal
            .append_evidence(
                "j1",
                EvidenceItem {
                    key: "bed_temp_c".into(),
                    value: Json::from(60),
                    source: EvidenceSource::Sensor,
                    timestamp_ms: 1,
                    uncertainty: Some(0.05),
                },
            )
            .unwrap();
        // human label arrives for the same key — it must NOT overwrite.
        let flag = journal
            .append_evidence(
                "j1",
                EvidenceItem {
                    key: "bed_temp_c".into(),
                    value: Json::from(62),
                    source: EvidenceSource::Human,
                    timestamp_ms: 2,
                    uncertainty: Some(0.2),
                },
            )
            .unwrap();
        let f = flag.expect("conflict must be flagged");
        assert_eq!(f.key, "bed_temp_c");
        assert_eq!(
            f.sources,
            vec![EvidenceSource::Sensor, EvidenceSource::Human]
        );
        let rec = journal.get("j1").unwrap();
        // BOTH values stored
        assert_eq!(rec.telemetry.len(), 2);
        assert_eq!(rec.telemetry[0].value, Json::from(60));
        assert_eq!(rec.telemetry[1].value, Json::from(62));
        assert_eq!(rec.conflicts.len(), 1);
    }

    #[test]
    fn same_source_evidence_does_not_conflict() {
        let mut journal = JobJournal::new();
        journal.append(job("j1", "kobra-s1", "pla")).unwrap();
        journal
            .append_evidence(
                "j1",
                EvidenceItem {
                    key: "fan_pct".into(),
                    value: Json::from(70),
                    source: EvidenceSource::Sensor,
                    timestamp_ms: 1,
                    uncertainty: None,
                },
            )
            .unwrap();
        let flag = journal
            .append_evidence(
                "j1",
                EvidenceItem {
                    key: "fan_pct".into(),
                    value: Json::from(75),
                    source: EvidenceSource::Sensor,
                    timestamp_ms: 2,
                    uncertainty: None,
                },
            )
            .unwrap();
        assert!(flag.is_none(), "same source must not flag a conflict");
        assert_eq!(journal.get("j1").unwrap().conflicts.len(), 0);
    }

    #[test]
    fn outcome_and_uncertainty_rowndtripped() {
        let mut journal = JobJournal::new();
        let mut rec = job("j9", "kobra-s1", "petg");
        rec.outcome_label = Some("success".into());
        rec.telemetry.push(EvidenceItem {
            key: "layer_drop_um".into(),
            value: Json::from(0.9),
            source: EvidenceSource::Sensor,
            timestamp_ms: 99,
            uncertainty: Some(0.5),
        });
        journal.append(rec).unwrap();
        let got = journal.get("j9").unwrap();
        assert_eq!(got.outcome_label.as_deref(), Some("success"));
        assert_eq!(got.telemetry[0].uncertainty, Some(0.5));
    }

    #[test]
    fn retrieval_gate_readonly_finds_similar() {
        let mut journal = JobJournal::new();
        journal.append(job("a", "kobra-s1", "pla")).unwrap();
        journal.append(job("b", "kobra-s1", "pla")).unwrap();
        journal.append(job("c", "kobra-4", "pla")).unwrap();
        let before = journal.len();
        let similar = journal.find_similar("kobra-s1", "pla");
        assert_eq!(similar.len(), 2);
        assert_eq!(similar[0].job_id, "a");
        assert_eq!(similar[1].job_id, "b");
        // read-only: the journal is untouched by the query
        assert_eq!(journal.len(), before);
    }

    #[test]
    fn evidence_on_missing_job_rejected() {
        let mut journal = JobJournal::new();
        let err = journal
            .append_evidence(
                "ghost",
                EvidenceItem {
                    key: "k".into(),
                    value: Json::from(1),
                    source: EvidenceSource::Sensor,
                    timestamp_ms: 1,
                    uncertainty: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, JournalError::NotFound("ghost".to_string()));
    }
}
