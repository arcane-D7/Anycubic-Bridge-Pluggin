//! Workspace DB — S6-002.
//!
//! Versioned rusqlite schema (`PRAGMA user_version` enforced). Auth never
//! touches this DB; BYOK keys never do either (see [`crate::keystore`]).

use rusqlite::Connection;
use std::path::Path;

/// Current schema version. Bump + add a migration arm when evolving.
pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("schema is newer ({found}) than this build ({SCHEMA_VERSION})")]
    NewerSchema { found: i64 },
    #[error("failed to apply migration v{version}: {source}")]
    Apply { version: i64, source: rusqlite::Error },
}

/// A checked, single-writer handle to the workspace DB.
pub struct DbHandle {
    conn: Connection,
}

impl DbHandle {
    /// Open (or create) the workspace DB at `path` and bring it to
    /// [`SCHEMA_VERSION`] via embedded migrations.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MigrationError> {
        let conn = Connection::open(path)?;
        let mut db = DbHandle { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Open an in-memory DB (tests).
    pub fn open_in_memory() -> Result<Self, MigrationError> {
        let conn = Connection::open_in_memory()?;
        let mut db = DbHandle { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> Result<(), MigrationError> {
        let current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(MigrationError::NewerSchema { found: current });
        }
        if current < 1 {
            self.apply_v1()?;
        }
        Ok(())
    }

    fn apply_v1(&mut self) -> Result<(), MigrationError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
                id          TEXT PRIMARY KEY,   -- UUID v4
                name        TEXT NOT NULL,
                created_ms  INTEGER NOT NULL,
                updated_ms  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS objects (
                id          TEXT PRIMARY KEY,   -- stable UUID
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                mesh_sha256 TEXT                  -- content-addressed artifact ref, null = not yet snapshotted
            );
            CREATE TABLE IF NOT EXISTS ops (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- append-only journal
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                op_type     TEXT NOT NULL,
                payload     TEXT NOT NULL,        -- serialized op
                seq         INTEGER NOT NULL,
                created_ms  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS revisions (
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                rev         INTEGER NOT NULL,
                op_seq_max  INTEGER NOT NULL,
                created_ms  INTEGER NOT NULL,
                PRIMARY KEY (project_id, rev)
            );
            CREATE TABLE IF NOT EXISTS artifacts (
                sha256  TEXT PRIMARY KEY,
                path    TEXT NOT NULL,           -- blob lives outside DB
                bytes   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_objects_project ON objects(project_id);
            CREATE INDEX IF NOT EXISTS idx_ops_project_seq ON ops(project_id, seq);
            "#,
        )?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
        Ok(())
    }

    /// Report the enforced schema version.
    pub fn schema_version(&self) -> Result<i64, rusqlite::Error> {
        self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))
    }

    /// Create a project row. Returns the project id (caller-provided UUID).
    pub fn create_project(&self, id: &str, name: &str) -> Result<(), rusqlite::Error> {
        let now = chrono_ms();
        self.conn.execute(
            "INSERT INTO projects (id, name, created_ms, updated_ms) VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![id, name, now],
        )?;
        Ok(())
    }

    /// Append an op to the journal under `project_id` + `seq`.
    pub fn append_op(
        &self,
        project_id: &str,
        seq: u64,
        op_type: &str,
        payload: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO ops (project_id, op_type, payload, seq, created_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![project_id, op_type, payload, seq as i64, chrono_ms()],
        )?;
        Ok(())
    }

    /// Max op seq for a project (0 when empty).
    pub fn max_op_seq(&self, project_id: &str) -> Result<u64, rusqlite::Error> {
        let v: Option<i64> = self.conn.query_row(
            "SELECT MAX(seq) FROM ops WHERE project_id = ?1",
            [project_id],
            |r| r.get(0),
        )?;
        Ok(v.unwrap_or(0) as u64)
    }
}

fn chrono_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_creates_v1_and_persists() {
        let db = DbHandle::open_in_memory().expect("migrate ok");
        assert_eq!(db.schema_version().unwrap(), 1);
        db.create_project("p-1", "demo").unwrap();
        db.append_op("p-1", 1, "add_object", r#"{"id":"o-1"}"#).unwrap();
        assert_eq!(db.max_op_seq("p-1").unwrap(), 1);
    }

    #[test]
    fn max_seq_zero_when_no_ops() {
        let db = DbHandle::open_in_memory().unwrap();
        db.create_project("p-2", "empty").unwrap();
        assert_eq!(db.max_op_seq("p-2").unwrap(), 0);
    }
}
