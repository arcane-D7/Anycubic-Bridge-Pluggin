//! Workspace DB — S6-002.
//!
//! Versioned rusqlite schema (`PRAGMA user_version` enforced). Auth never
//! touches this DB; BYOK keys never do either (see [`crate::keystore`]).

use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// Current schema version. Bump + add a migration arm when evolving.
pub const SCHEMA_VERSION: i64 = 6;

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("schema is newer ({found}) than this build ({SCHEMA_VERSION})")]
    NewerSchema { found: i64 },
    #[error("failed to apply migration v{version}: {source}")]
    Apply {
        version: i64,
        source: rusqlite::Error,
    },
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
        if current < 2 {
            self.apply_v2()?;
        }
        if current < 3 {
            self.apply_v3()?;
        }
        if current < 4 {
            self.apply_v4()?;
        }
        if current < 5 {
            self.apply_v5()?;
        }
        if current < 6 {
            self.apply_v6()?;
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

    /// v2: `slicing_mode` per project — the dual-mode requirement is data from
    /// day one (§3.0a). Typed enum column, validated at the API layer; default
    /// `standard`.
    fn apply_v2(&mut self) -> Result<(), MigrationError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            r#"
            ALTER TABLE projects ADD COLUMN slicing_mode TEXT NOT NULL DEFAULT 'standard';
            CREATE TABLE IF NOT EXISTS revisions_v2_check (dummy INTEGER);
            DROP TABLE revisions_v2_check;
            "#,
        )
        .map_err(|source| MigrationError::Apply { version: 2, source })?;
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
        Ok(())
    }

    fn apply_v3(&mut self) -> Result<(), MigrationError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            "CREATE TABLE project_state (
                project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL DEFAULT 0,
                state_json TEXT NOT NULL
            );
            CREATE TABLE project_events (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL,
                op_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_ms INTEGER NOT NULL,
                PRIMARY KEY (project_id, revision)
            );
            CREATE TABLE project_operation_keys (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                operation_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                request_hash TEXT NOT NULL,
                PRIMARY KEY (project_id, operation_id)
            );",
        )
        .map_err(|source| MigrationError::Apply { version: 3, source })?;
        tx.pragma_update(None, "user_version", 3)?;
        tx.commit()?;
        Ok(())
    }

    fn apply_v4(&mut self) -> Result<(), MigrationError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            "CREATE TABLE slice_jobs (
                job_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                source_revision INTEGER NOT NULL,
                input_digest TEXT NOT NULL,
                status TEXT NOT NULL,
                record_json TEXT NOT NULL,
                created_ms INTEGER NOT NULL,
                updated_ms INTEGER NOT NULL
            );
            CREATE INDEX idx_slice_jobs_cache ON slice_jobs(project_id, source_revision, input_digest, status);",
        )
        .map_err(|source| MigrationError::Apply { version: 4, source })?;
        tx.pragma_update(None, "user_version", 4)?;
        tx.commit()?;
        Ok(())
    }

    /// v5: one-use, expiring, payload-bound approvals (S9.18-003 slice). Only the
    /// SHA-256 hash of the raw token is persisted — never the token itself.
    fn apply_v5(&mut self) -> Result<(), MigrationError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS approvals (
                token_hash      TEXT PRIMARY KEY,  -- sha256(token) hex; raw token never stored
                principal       TEXT NOT NULL,     -- bound editor-user identity
                action          TEXT NOT NULL,
                payload_digest  TEXT NOT NULL,     -- sha256 of canonicalized args JSON
                target          TEXT NOT NULL,
                purpose         TEXT NOT NULL,     -- human-readable effect for the UI
                session_ref     TEXT,
                revision        INTEGER,
                artifact        TEXT,
                material        TEXT,
                issued_ms       INTEGER NOT NULL,
                expires_ms      INTEGER NOT NULL,
                consumed_ms     INTEGER,
                revoked         INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_approvals_principal ON approvals(principal, issued_ms);",
        )
        .map_err(|source| MigrationError::Apply { version: 5, source })?;
        tx.pragma_update(None, "user_version", 5)?;
        tx.commit()?;
        Ok(())
    }

    /// v6 (S9.18-003 continuation slice): dedicated nullable snapshot + project
    /// bindings on approvals. `device_snapshot_ms` is the exact moment the
    /// trusted resolver captured the context the approval was issued over, and
    /// `project_id` is the trusted project id — both are FIRST-CLASS nullable
    /// columns, deliberately NOT overloaded onto `revision`/`artifact`/`material`
    /// string/raw fields. Legacy v5 rows keep NULL for both; NULL must never
    /// authorize a device write when the consume context carries Some (the
    /// broker compares at consume → ContextChanged). Generic job paths that
    /// carry None/None keep working unchanged.
    fn apply_v6(&mut self) -> Result<(), MigrationError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            "ALTER TABLE approvals ADD COLUMN device_snapshot_ms INTEGER;
             ALTER TABLE approvals ADD COLUMN project_id TEXT;",
        )
        .map_err(|source| MigrationError::Apply { version: 6, source })?;
        tx.pragma_update(None, "user_version", 6)?;
        tx.commit()?;
        Ok(())
    }

    /// Crate-internal access to the underlying connection (used by the approval
    /// authority for its own atomic transactions).
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
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

    pub fn list_projects(&self) -> Result<Vec<(String, String, i64)>, rusqlite::Error> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, updated_ms FROM projects ORDER BY updated_ms DESC, id ASC",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect()
    }

    pub fn list_slice_jobs(
        &self,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let mut statement = self.conn.prepare(
            "SELECT record_json FROM slice_jobs WHERE project_id = ?1 ORDER BY updated_ms DESC, job_id ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(rusqlite::params![project_id, limit.min(100)], |row| {
            row.get(0)
        })?;
        rows.collect()
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

    /// Read the persisted slicing mode for a project. Unknown/missing project →
    /// default `standard` per contract §3.0a.
    pub fn slicing_mode(&self, project_id: &str) -> Result<String, rusqlite::Error> {
        let v: Option<String> = self.conn.query_row(
            "SELECT slicing_mode FROM projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )?;
        Ok(v.unwrap_or_else(|| "standard".to_string()))
    }

    /// Set the slicing mode; validates the enum (`standard` | `nonplanar`).
    pub fn set_slicing_mode(&self, project_id: &str, mode: &str) -> Result<(), rusqlite::Error> {
        if mode != "standard" && mode != "nonplanar" {
            return Err(rusqlite::Error::InvalidParameterName(
                "slicing_mode must be 'standard' or 'nonplanar'".into(),
            ));
        }
        self.conn.execute(
            "UPDATE projects SET slicing_mode = ?1, updated_ms = ?2 WHERE id = ?3",
            rusqlite::params![mode, chrono_ms(), project_id],
        )?;
        Ok(())
    }

    /// Record an artifact (content-addressed) reference.
    pub fn put_artifact(
        &self,
        sha256: &str,
        path: &str,
        bytes: u64,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO artifacts (sha256, path, bytes) VALUES (?1, ?2, ?3) ON CONFLICT(sha256) DO UPDATE SET path=?2, bytes=?3",
            rusqlite::params![sha256, path, bytes as i64],
        )?;
        Ok(())
    }

    /// Look up an artifact path by hash.
    pub fn artifact_path(&self, sha256: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT path FROM artifacts WHERE sha256 = ?1",
                [sha256],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
    }

    pub fn put_slice_job(
        &self,
        job_id: &str,
        project_id: &str,
        source_revision: u64,
        input_digest: &str,
        status: &str,
        record_json: &str,
    ) -> Result<(), rusqlite::Error> {
        let now = chrono_ms();
        self.conn.execute(
            "INSERT INTO slice_jobs (job_id, project_id, source_revision, input_digest, status, record_json, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(job_id) DO UPDATE SET project_id=excluded.project_id, source_revision=excluded.source_revision, input_digest=excluded.input_digest, status=excluded.status, record_json=excluded.record_json, updated_ms=excluded.updated_ms",
            rusqlite::params![job_id, project_id, source_revision as i64, input_digest, status, record_json, now],
        )?;
        Ok(())
    }

    pub fn slice_job(
        &self,
        project_id: &str,
        job_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT record_json FROM slice_jobs WHERE project_id = ?1 AND job_id = ?2",
                rusqlite::params![project_id, job_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn cached_slice_job(
        &self,
        project_id: &str,
        source_revision: u64,
        input_digest: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT record_json FROM slice_jobs WHERE project_id = ?1 AND source_revision = ?2 AND input_digest = ?3 AND status = 'ready' ORDER BY updated_ms DESC LIMIT 1",
                rusqlite::params![project_id, source_revision as i64, input_digest],
                |row| row.get(0),
            )
            .optional()
    }

    /// Read the durable project document and its monotonic revision.
    pub fn project_state(
        &self,
        project_id: &str,
    ) -> Result<Option<(u64, String)>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT revision, state_json FROM project_state WHERE project_id = ?1",
                [project_id],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?)),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
    }

    pub fn project_operations(&self, project_id: &str) -> Result<Vec<String>, rusqlite::Error> {
        let mut statement = self.conn.prepare(
            "SELECT payload FROM project_events WHERE project_id = ?1 ORDER BY revision ASC",
        )?;
        let rows = statement.query_map([project_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn legacy_project_objects(
        &self,
        project_id: &str,
    ) -> Result<Vec<(String, String, Option<String>)>, rusqlite::Error> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, mesh_sha256 FROM objects WHERE project_id = ?1 ORDER BY id ASC",
        )?;
        let rows = statement.query_map([project_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect()
    }

    pub fn put_project_object(
        &self,
        id: &str,
        project_id: &str,
        name: &str,
        mesh_sha256: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO objects (id, project_id, name, mesh_sha256) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, project_id, name, mesh_sha256],
        )?;
        Ok(())
    }

    /// Atomically compare revision, persist the actual state, and append its
    /// operation record. A conflict performs no writes.
    pub fn commit_project_state(
        &mut self,
        project_id: &str,
        expected_revision: u64,
        operation_id: &str,
        request_hash: &str,
        op_type: &str,
        payload: &str,
        state_json: &str,
        artifacts: &[(String, String, u64)],
    ) -> Result<Result<u64, u64>, rusqlite::Error> {
        let tx = self.conn.transaction()?;
        let prior: Option<(i64, String)> = tx
            .query_row(
                "SELECT revision, request_hash FROM project_operation_keys WHERE project_id = ?1 AND operation_id = ?2",
                rusqlite::params![project_id, operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((_prior_revision, prior_hash)) = prior {
            if prior_hash != request_hash {
                return Err(rusqlite::Error::InvalidParameterName(
                    "operation_id reused with different request content".to_owned(),
                ));
            }
            let current: i64 = tx.query_row(
                "SELECT revision FROM project_state WHERE project_id = ?1",
                [project_id],
                |row| row.get(0),
            )?;
            return Ok(Ok(current as u64));
        }
        let persisted: Option<(i64, String)> = tx
            .query_row(
                "SELECT revision, state_json FROM project_state WHERE project_id = ?1",
                [project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((current, persisted_state)) = persisted else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        let current = current as u64;
        if current != expected_revision {
            return Ok(Err(current));
        }
        if persisted_state == state_json {
            return Ok(Ok(current));
        }
        let next = current + 1;
        tx.execute(
            "UPDATE project_state SET revision = ?1, state_json = ?2 WHERE project_id = ?3",
            rusqlite::params![next as i64, state_json, project_id],
        )?;
        tx.execute(
            "INSERT INTO project_events (project_id, revision, op_type, payload, created_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![project_id, next as i64, op_type, payload, chrono_ms()],
        )?;
        tx.execute(
            "INSERT INTO project_operation_keys (project_id, operation_id, revision, request_hash) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![project_id, operation_id, next as i64, request_hash],
        )?;
        for (sha256, path, bytes) in artifacts {
            tx.execute(
                "INSERT INTO artifacts (sha256, path, bytes) VALUES (?1, ?2, ?3) ON CONFLICT(sha256) DO UPDATE SET path=excluded.path, bytes=excluded.bytes",
                rusqlite::params![sha256, path, *bytes as i64],
            )?;
        }
        tx.commit()?;
        Ok(Ok(next))
    }

    /// Initialize a project and its canonical empty document exactly once.
    pub fn ensure_project_state(
        &mut self,
        project_id: &str,
        name: &str,
        initial_state: &str,
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO projects (id, name, created_ms, updated_ms) VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![project_id, name, chrono_ms()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO project_state (project_id, revision, state_json) VALUES (?1, 0, ?2)",
            rusqlite::params![project_id, initial_state],
        )?;
        tx.commit()?;
        Ok(())
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
    fn migration_creates_v2_and_persists() {
        let db = DbHandle::open_in_memory().expect("migrate ok");
        assert_eq!(db.schema_version().unwrap(), 6);
        db.create_project("p-1", "demo").unwrap();
        db.append_op("p-1", 1, "add_object", r#"{"id":"o-1"}"#)
            .unwrap();
        assert_eq!(db.max_op_seq("p-1").unwrap(), 1);
        assert_eq!(db.slicing_mode("p-1").unwrap(), "standard"); // default
        assert!(db.set_slicing_mode("p-1", "bogus").is_err()); // validated
        db.set_slicing_mode("p-1", "nonplanar").unwrap();
        assert_eq!(db.slicing_mode("p-1").unwrap(), "nonplanar");
    }

    #[test]
    fn max_seq_zero_when_no_ops() {
        let db = DbHandle::open_in_memory().unwrap();
        db.create_project("p-2", "empty").unwrap();
        assert_eq!(db.max_op_seq("p-2").unwrap(), 0);
        assert_eq!(db.slicing_mode("p-2").unwrap(), "standard");
    }

    #[test]
    fn v1_to_v2_migration_preserves_data() {
        // Simulate a v1 DB: create schema v1 in a temp file, insert a project,
        // then open with the current code → data survives + slicing_mode added.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ws.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
                CREATE TABLE objects (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, mesh_sha256 TEXT);
                CREATE TABLE ops (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, op_type TEXT NOT NULL, payload TEXT NOT NULL, seq INTEGER NOT NULL, created_ms INTEGER NOT NULL);
                CREATE TABLE revisions (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, rev INTEGER NOT NULL, op_seq_max INTEGER NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY (project_id, rev));
                CREATE TABLE artifacts (sha256 TEXT PRIMARY KEY, path TEXT NOT NULL, bytes INTEGER NOT NULL);
                CREATE INDEX idx_objects_project ON objects(project_id);
                CREATE INDEX idx_ops_project_seq ON ops(project_id, seq);
                PRAGMA user_version = 1;
                "#,
            )
            .unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, created_ms, updated_ms) VALUES ('legacy-1', 'kept', 1, 1)",
                [],
            )
            .unwrap();
        }
        let db = DbHandle::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 6);
        assert_eq!(db.slicing_mode("legacy-1").unwrap(), "standard");
        // data survived
        let n: i64 = db
            .conn
            .query_row("SELECT count(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn artifacts_content_addressed_dedupe() {
        let db = DbHandle::open_in_memory().unwrap();
        let sha = "abc123";
        db.put_artifact(sha, "blobs/abc123.stl", 42).unwrap();
        db.put_artifact(sha, "blobs/abc123.stl", 42).unwrap(); // dedupe idempotent
        assert_eq!(db.artifact_path(sha).unwrap().unwrap(), "blobs/abc123.stl");
        assert!(db.artifact_path("nope").unwrap().is_none());
    }

    #[test]
    fn slice_jobs_persist_and_cache_only_ready_matching_inputs() {
        let db = DbHandle::open_in_memory().unwrap();
        db.create_project("project-1", "project").unwrap();
        db.put_slice_job(
            "job-1",
            "project-1",
            7,
            "digest-a",
            "running",
            "{\"status\":\"running\"}",
        )
        .unwrap();
        assert!(db
            .cached_slice_job("project-1", 7, "digest-a")
            .unwrap()
            .is_none());
        db.put_slice_job(
            "job-1",
            "project-1",
            7,
            "digest-a",
            "ready",
            "{\"status\":\"ready\"}",
        )
        .unwrap();
        assert_eq!(
            db.slice_job("project-1", "job-1").unwrap().as_deref(),
            Some(r#"{"status":"ready"}"#)
        );
        assert_eq!(
            db.cached_slice_job("project-1", 7, "digest-a")
                .unwrap()
                .as_deref(),
            Some(r#"{"status":"ready"}"#)
        );
        assert!(db
            .cached_slice_job("project-1", 8, "digest-a")
            .unwrap()
            .is_none());
        assert!(db
            .cached_slice_job("project-1", 7, "digest-b")
            .unwrap()
            .is_none());
    }
}
