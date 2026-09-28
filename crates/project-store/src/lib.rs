//! Project store — S6-004.
//!
//! Versioned project schema (slicing_mode per project, §3.0a), ops journal,
//! revisions, and a content-addressed artifact store (hash → path; blobs live
//! outside the DB). Undo graph = append-only journal + monotonic revisions.

use broker::{DbHandle, MigrationError};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub mod recovery;
pub use recovery::{RecoveryStore, Snapshot, SnapshotError};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("migration: {0}")]
    Migration(#[from] MigrationError),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Content-addressed artifact store: write mesh bytes at `blobs/<sha256>.stl`,
/// register the reference in the DB. Re-writing identical bytes → same hash →
/// dedupe (one blob, idempotent DB row).
pub struct ArtifactStore {
    blobs_dir: PathBuf,
    db: DbHandle,
}

impl ArtifactStore {
    pub fn new(db: DbHandle, blobs_dir: impl AsRef<Path>) -> Self {
        let blobs_dir = blobs_dir.as_ref().to_path_buf();
        fs::create_dir_all(&blobs_dir).expect("blobs dir");
        ArtifactStore { blobs_dir, db }
    }

    fn sha256(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex::encode(h.finalize())
    }

    /// Store mesh bytes content-addressed. Returns the sha256 + blob path.
    pub fn put_mesh(&self, data: &[u8]) -> Result<(String, String), ProjectError> {
        let hash = Self::sha256(data);
        let rel = format!("{hash}.stl");
        let path = self.blobs_dir.join(&rel);
        if !path.exists() {
            fs::write(&path, data)?;
        }
        self.db.put_artifact(&hash, &rel, data.len() as u64)?;
        Ok((hash, rel))
    }

    /// Read a blob by hash (None when missing).
    pub fn get_mesh(&self, hash: &str) -> Result<Option<Vec<u8>>, ProjectError> {
        let Some(rel) = self.db.artifact_path(hash)? else {
            return Ok(None);
        };
        let path = self.blobs_dir.join(rel);
        if path.exists() {
            Ok(Some(fs::read(path)?))
        } else {
            Ok(None)
        }
    }

    pub fn db(&self) -> &DbHandle {
        &self.db
    }
}

/// Append-only ops journal with monotonic revision cursor (undo-graph stub).
pub struct Journal {
    db: DbHandle,
}

impl Journal {
    pub fn new(db: DbHandle) -> Self {
        Journal { db }
    }

    /// Test/dev helper: create a project through the journal's DB.
    pub fn db_create_project(&self, id: &str) -> Result<(), ProjectError> {
        self.db.create_project(id, "project")?;
        Ok(())
    }

    /// Expose the underlying DB for recovery/read paths.
    pub fn db_ref(&self) -> &DbHandle {
        &self.db
    }

    /// Append an op; returns its seq (next after current max).
    pub fn append(
        &self,
        project_id: &str,
        op_type: &str,
        payload: &str,
    ) -> Result<u64, ProjectError> {
        let seq = self.db.max_op_seq(project_id)? + 1;
        self.db.append_op(project_id, seq, op_type, payload)?;
        Ok(seq)
    }

    /// Current op count for a project (revision cursor).
    pub fn revision(&self, project_id: &str) -> Result<u64, ProjectError> {
        Ok(self.db.max_op_seq(project_id)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_dedupe_two_identical_meshes_one_blob() {
        let dir = tempfile::tempdir().unwrap();
        let db = DbHandle::open_in_memory().unwrap();
        db.create_project("p", "x").unwrap();
        let store = ArtifactStore::new(db, dir.path().join("blobs"));
        let mesh = vec![1u8; 64];

        let (h1, r1) = store.put_mesh(&mesh).unwrap();
        let (h2, r2) = store.put_mesh(&mesh).unwrap();
        assert_eq!(h1, h2, "content addressing must dedupe same bytes");
        assert_eq!(r1, r2);

        let blobs = fs::read_dir(dir.path().join("blobs")).unwrap().count();
        assert_eq!(blobs, 1, "only one blob on disk");
        let _ = store.get_mesh(&h1).unwrap();
    }

    #[test]
    fn artifact_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let db = DbHandle::open_in_memory().unwrap();
        db.create_project("p", "x").unwrap();
        let store = ArtifactStore::new(db, dir.path().join("blobs"));
        let mesh = b"solid cube".to_vec();
        let (hash, _) = store.put_mesh(&mesh).unwrap();
        assert_eq!(store.get_mesh(&hash).unwrap().unwrap(), mesh);
        assert!(store.get_mesh("deadbeef").unwrap().is_none());
    }

    #[test]
    fn journal_append_and_revision() {
        let db = DbHandle::open_in_memory().unwrap();
        db.create_project("p", "x").unwrap();
        let journal = Journal::new(DbHandle::open_in_memory().unwrap());
        // journal owns its own DB connection; seed the project there too
        journal.db_create_project("p").unwrap();
        assert_eq!(journal.revision("p").unwrap(), 0);
        let seq = journal.append("p", "add_object", r#"{"id":"o1"}"#).unwrap();
        assert_eq!(seq, 1);
        assert_eq!(journal.revision("p").unwrap(), 1);
        let seq2 = journal
            .append("p", "move_object", r#"{"id":"o1","dz":2}"#)
            .unwrap();
        assert_eq!(seq2, 2);
    }
}
