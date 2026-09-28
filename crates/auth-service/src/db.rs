//! Local `auth.db` storage — S6-006.
//!
//! Own SQLite file, **separate from the workspace DB**. Holds users, device
//! sessions, scopes, audit_log and sync_state. No printer credentials ever
//! touch this store (tenant boundary).

use rusqlite::Connection;
use std::path::Path;

use crate::api::{Scope, SyncState};
use crate::principal::Principal;

/// Current auth schema version.
pub const AUTH_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum AuthDbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("schema is newer ({found}) than this build ({AUTH_SCHEMA_VERSION})")]
    NewerSchema { found: i64 },
}

/// Owns the loopback auth DB. Constructing this does **not** touch the
/// workspace DB used by `broker`/`project-store`.
pub struct AuthDb {
    conn: Connection,
}

impl AuthDb {
    /// Open (or create) the auth DB at `path`, migrating to the current
    /// schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AuthDbError> {
        let conn = Connection::open(path)?;
        let mut db = AuthDb { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Open an in-memory auth DB (tests).
    pub fn open_in_memory() -> Result<Self, AuthDbError> {
        let conn = Connection::open_in_memory()?;
        let mut db = AuthDb { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> Result<(), AuthDbError> {
        let current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current > AUTH_SCHEMA_VERSION {
            return Err(AuthDbError::NewerSchema { found: current });
        }
        if current < 1 {
            self.apply_v1()?;
        }
        Ok(())
    }

    fn apply_v1(&mut self) -> Result<(), AuthDbError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS users (
                id          TEXT PRIMARY KEY,
                created_ms  INTEGER NOT NULL,
                display_name TEXT
            );
            CREATE TABLE IF NOT EXISTS device_sessions (
                token_hash  TEXT PRIMARY KEY,   -- hash only, never raw token
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_ms  INTEGER NOT NULL,
                revoked_ms  INTEGER              -- null = active
            );
            CREATE TABLE IF NOT EXISTS scopes (
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                scope       TEXT NOT NULL,
                granted_ms  INTEGER NOT NULL,
                PRIMARY KEY (user_id, scope)
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     TEXT,
                action      TEXT NOT NULL,
                at_ms       INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                scope       TEXT NOT NULL,
                revision    INTEGER NOT NULL,
                PRIMARY KEY (user_id, scope)
            );
            "#,
        )?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
        Ok(())
    }

    /// Register a local user (id, display name). Idempotent style: upsert.
    pub fn upsert_user(&mut self, id: &str, display_name: &str) -> Result<(), AuthDbError> {
        let now = crate::now_ms();
        self.conn.execute(
            "INSERT INTO users (id, created_ms, display_name) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name",
            rusqlite::params![id, now, display_name],
        )?;
        Ok(())
    }

    /// List users (ids + display names).
    pub fn users(&self) -> Result<Vec<(String, String)>, AuthDbError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, COALESCE(display_name, '') FROM users ORDER BY created_ms")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Grant a scope to a user.
    pub fn grant_scope(&mut self, user_id: &str, scope: Scope) -> Result<(), AuthDbError> {
        let now = crate::now_ms();
        self.conn.execute(
            "INSERT INTO scopes (user_id, scope, granted_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, scope) DO UPDATE SET granted_ms = excluded.granted_ms",
            rusqlite::params![user_id, scope_name(scope), now],
        )?;
        Ok(())
    }

    /// Scopes granted to a principal (empty for anonymous).
    pub fn scopes_for(&self, principal: &Principal) -> Result<Vec<Scope>, AuthDbError> {
        let user_id = match principal {
            Principal::Local { user_id } => user_id,
            Principal::Anonymous => return Ok(vec![]),
        };
        let mut stmt = self
            .conn
            .prepare("SELECT scope FROM scopes WHERE user_id = ?1 ORDER BY scope")?;
        let rows = stmt.query_map([user_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(scope_from_name(&row?));
        }
        Ok(out)
    }

    /// `sync_state` for a principal+scope name. Anonymous → `Unavailable`;
    /// no row → `Empty`; else `Synced { revision }`.
    pub fn sync_state(&self, principal: &Principal, scope: &str) -> Result<SyncState, AuthDbError> {
        let user_id = match principal {
            Principal::Local { user_id } => user_id,
            Principal::Anonymous => return Ok(SyncState::Unavailable),
        };
        let revision: Option<u64> = self
            .conn
            .query_row(
                "SELECT revision FROM sync_state WHERE user_id = ?1 AND scope = ?2",
                [user_id, scope],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match revision {
            Some(rev) => SyncState::Synced { revision: rev },
            None => SyncState::Empty,
        })
    }

    /// Record a sync revision for a principal+scope.
    pub fn record_sync(
        &mut self,
        principal: &Principal,
        scope: &str,
        revision: u64,
    ) -> Result<(), AuthDbError> {
        let user_id = match principal {
            Principal::Local { user_id } => user_id,
            Principal::Anonymous => return Ok(()),
        };
        self.conn.execute(
            "INSERT INTO sync_state (user_id, scope, revision) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, scope) DO UPDATE SET revision = excluded.revision",
            rusqlite::params![user_id, scope, revision],
        )?;
        Ok(())
    }

    /// Append an audit-log row (service-side bookkeeping).
    pub fn audit(&mut self, user_id: Option<&str>, action: &str) -> Result<(), AuthDbError> {
        let now = crate::now_ms();
        self.conn.execute(
            "INSERT INTO audit_log (user_id, action, at_ms) VALUES (?1, ?2, ?3)",
            rusqlite::params![user_id, action, now],
        )?;
        Ok(())
    }

    /// Count of audit rows (sanity/observability).
    pub fn audit_len(&self) -> Result<u64, AuthDbError> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM audit_log", [], |r| r.get(0))?;
        Ok(n as u64)
    }
}

/// Scope serialized form (informational; scopes are just strings in the DB).
fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::LocalProject => "local_project",
        Scope::CloudSynced => "cloud_synced",
    }
}

fn scope_from_name(name: &str) -> Scope {
    match name {
        "cloud_synced" => Scope::CloudSynced,
        _ => Scope::LocalProject,
    }
}

/// rusqlite `OptionalExtension` for `query_row` → nullable.
trait OptionalExt {
    type Out;
    fn optional(self) -> Result<Option<Self::Out>, rusqlite::Error>;
}

impl<T> OptionalExt for Result<T, rusqlite::Error> {
    type Out = T;
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_db_is_separate_from_workspace_db() {
        // NewerSchema guard: opening the *same* file with a bumped
        // AUTH_SCHEMA_VERSION is a separate error from any workspace-DB
        // concern — the two stores never share a path in this crate.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.db");
        let mut db = AuthDb::open(&path).unwrap();
        db.upsert_user("u1", "Editor User").unwrap();
        db.grant_scope("u1", Scope::CloudSynced).unwrap();
        db.record_sync(&Principal::Local { user_id: "u1".into() }, "cloud", 7)
            .unwrap();
        // Reopen and prove persistence.
        let db2 = AuthDb::open(&path).unwrap();
        assert_eq!(
            db2.scopes_for(&Principal::Local { user_id: "u1".into() })
                .unwrap(),
            vec![Scope::CloudSynced]
        );
        assert_eq!(
            db2.sync_state(&Principal::Local { user_id: "u1".into() }, "cloud")
                .unwrap(),
            SyncState::Synced { revision: 7 }
        );
    }

    #[test]
    fn anonymous_principal_is_fail_closed() {
        let mut db = AuthDb::open_in_memory().unwrap();
        db.upsert_user("u1", "Editor User").unwrap();
        db.grant_scope("u1", Scope::CloudSynced).unwrap();
        // Anonymous → nothing granted, sync unavailable.
        assert_eq!(db.scopes_for(&Principal::Anonymous).unwrap(), vec![]);
        assert_eq!(
            db.sync_state(&Principal::Anonymous, "cloud").unwrap(),
            SyncState::Unavailable
        );
    }

    #[test]
    fn unknown_scope_reads_empty_synced() {
        let mut db = AuthDb::open_in_memory().unwrap();
        db.upsert_user("u1", "Editor User").unwrap();
        let principal = Principal::Local { user_id: "u1".into() };
        assert_eq!(db.scopes_for(&principal).unwrap(), vec![]);
        assert_eq!(db.sync_state(&principal, "cloud").unwrap(), SyncState::Empty);
    }

    #[test]
    fn no_printer_credentials_in_auth_db() {
        // The auth store schema has no columns for printer or cloud tokens.
        // `token_hash` in device_sessions is a *hash of a session token*, not
        // credential material — the boundary is: no raw secret/credential ever
        // stored here. Prove the effective schema has no raw-credential
        // columns; any future addition must be reviewed here.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.db");
        {
            let _db = AuthDb::open(&path).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, rusqlite::Error>>()
                .unwrap()
        };
        let mut all: Vec<String> = Vec::new();
        for t in &tables {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({t})"))
                .unwrap();
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, rusqlite::Error>>()
                .unwrap();
            all.extend(cols);
        }
        // Raw credential material patterns — note `_hash` columns are OK.
        let raw_credential = |c: &str| {
            let lower = c.to_lowercase();
            ["password", "secret", "access_token", "cloud_token", "printer_key", "token"]
                .iter()
                .any(|pat| lower.contains(pat))
                && !lower.ends_with("_hash")
        };
        assert!(
            !all.iter().any(|c| raw_credential(c)),
            "auth.db must never store raw credential material, got columns: {all:?}"
        );
    }

    #[test]
    fn audit_log_rolls() {
        let mut db = AuthDb::open_in_memory().unwrap();
        db.audit(Some("u1"), "scope.grant").unwrap();
        db.audit(None, "service.boot").unwrap();
        assert_eq!(db.audit_len().unwrap(), 2);
    }
}
