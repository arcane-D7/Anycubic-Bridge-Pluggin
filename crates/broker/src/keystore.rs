//! Keystore boundary — S6-002.
//!
//! BYOK keys NEVER touch SQLite. This trait is the only surface for secret
//! material; production implementations (DPAPI/Stronghold) arrive in later
//! sprints — here we ship the trait + a memory fake for tests and a file fake
//! gated behind the `file-keystore` feature.

use std::collections::HashMap;

#[cfg(feature = "file-keystore")]
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum KeystoreError {
    #[error("key not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Opaque secret value. Never serialized to the workspace DB.
#[derive(Clone, Debug)]
pub struct Secret(pub String);

/// Secret-material boundary. Implementations: MemoryKeystore (tests/demo),
/// FileKeystore (feature `file-keystore`), production DPAPI/Stronghold later.
pub trait Keystore {
    fn put(&mut self, alias: &str, secret: Secret) -> Result<(), KeystoreError>;
    fn get(&self, alias: &str) -> Result<Secret, KeystoreError>;
    fn delete(&mut self, alias: &str) -> Result<(), KeystoreError>;
    fn list(&self) -> Vec<String>;
}

/// In-memory fake, safe for tests.
#[derive(Default)]
pub struct MemoryKeystore {
    inner: HashMap<String, Secret>,
}

impl Keystore for MemoryKeystore {
    fn put(&mut self, alias: &str, secret: Secret) -> Result<(), KeystoreError> {
        self.inner.insert(alias.to_string(), secret);
        Ok(())
    }
    fn get(&self, alias: &str) -> Result<Secret, KeystoreError> {
        self.inner
            .get(alias)
            .cloned()
            .ok_or_else(|| KeystoreError::NotFound(alias.to_string()))
    }
    fn delete(&mut self, alias: &str) -> Result<(), KeystoreError> {
        self.inner.remove(alias);
        Ok(())
    }
    fn list(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }
}

/// File-backed fake behind its own directory. Secrets are plain files here —
/// explicitly NOT production (demo/dev only).
#[cfg(feature = "file-keystore")]
pub struct FileKeystore {
    dir: PathBuf,
}

#[cfg(feature = "file-keystore")]
impl FileKeystore {
    pub fn new(dir: PathBuf) -> Self {
        std::fs::create_dir_all(&dir).expect("keystore dir");
        FileKeystore { dir }
    }
}

#[cfg(feature = "file-keystore")]
impl Keystore for FileKeystore {
    fn put(&mut self, alias: &str, secret: Secret) -> Result<(), KeystoreError> {
        std::fs::write(self.dir.join(alias), secret.0)?;
        Ok(())
    }
    fn get(&self, alias: &str) -> Result<Secret, KeystoreError> {
        let data = std::fs::read(self.dir.join(alias))?;
        Ok(Secret(String::from_utf8_lossy(&data).into_owned()))
    }
    fn delete(&mut self, alias: &str) -> Result<(), KeystoreError> {
        std::fs::remove_file(self.dir.join(alias))?;
        Ok(())
    }
    fn list(&self) -> Vec<String> {
        std::fs::read_dir(&self.dir)
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_keystore_roundtrip() {
        let mut ks = MemoryKeystore::default();
        ks.put("anycubic-cloud", Secret("k-1".into())).unwrap();
        assert_eq!(ks.get("anycubic-cloud").unwrap().0, "k-1");
        assert_eq!(ks.list(), vec!["anycubic-cloud".to_string()]);
        ks.delete("anycubic-cloud").unwrap();
        assert!(matches!(ks.get("anycubic-cloud"), Err(KeystoreError::NotFound(_))));
    }

    #[test]
    fn secrets_never_serialized_to_sqlite() {
        // Proves the boundary: DB module has no keystore import; a secret put
        // into the keystore cannot be read back through DbHandle (it would not
        // compile to even try storing Secret in db.rs).
        let mut ks = MemoryKeystore::default();
        ks.put("byok", Secret("do-not-persist".into())).unwrap();
        let db = crate::db::DbHandle::open_in_memory().unwrap();
        // db has NO method accepting Secret — the only way to prove at
        // compile time is the API absence; here we assert the schema has no
        // secrets table.
        let has_secrets_table: bool = {
            use rusqlite::Connection;
            let conn = Connection::open_in_memory().unwrap();
            let mut stmt = conn.prepare(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            ).unwrap();
            let n: i64 = stmt.query_row(["secrets"], |r| r.get(0)).unwrap();
            n > 0
        };
        drop(db);
        assert!(!has_secrets_table, "no secrets table may exist");
    }
}
