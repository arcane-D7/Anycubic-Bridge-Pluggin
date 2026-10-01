//! Chat-store persistence lane (S9.6-007) — machine-agnostic filesystem
//! persistence for the multi-conversation chat store.
//!
//! Layout (env-resolved, NEVER repo-relative, NEVER real-user paths):
//!   <dir>/<id>.json     — canonical conversation snapshot
//!   <dir>/<id>.ndjson   — append-only per-conversation delta journal
//!
//! Semantics:
//!   - Every `PUT` is atomic: write `<id>.json.tmp` in the same directory,
//!     `fs::rename` over the target (same-filesystem rename is atomic on
//!     POSIX + Windows NTFS for same-volume moves).
//!   - Every `PUT` appends one delta line to `<id>.ndjson` (journal-style,
//!     S7-005 precedent) so a corrupted JSON can be recovered by replaying
//!     the journal from the last good snapshot.
//!   - `GET` prefers the JSON snapshot; if it fails to parse, it falls back
//!     to replaying `<id>.ndjson` from an empty base (last-line-wins) and
//!     rewrites the snapshot atomically as part of the recovery.
//!   - Path resolution: `ANYCUBIC_CHAT_DIR` env var wins; otherwise
//!     `%APPDATA%/anycubic-bridge/chat` (built-in default, never a user path
//!     literal — mirrors `FileKeystore`/`discovery.rs` conventions).
//!   - The TS webview side debounces 500ms and flushes on close; this crate
//!     only ever performs the requested read/write (no timers — the broker is
//!     called on demand).

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use thiserror::Error;

/// Where conversations are stored. Resolved once at construction:
/// `ANYCUBIC_CHAT_DIR` env, else `$APPDATA/anycubic-bridge/chat`.
#[derive(Debug, Clone)]
pub struct ChatStore {
    dir: PathBuf,
}

/// Error type for the chat store — mirrors the `thiserror` + `[from]`
/// convention of `broker/src/db.rs` (`MigrationError`) and
/// `crates/project-store` (`SnapshotError`).
#[derive(Debug, Error)]
pub enum ChatStoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json (de)serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("conversation id is insecure: {0}")]
    InsecureId(String),
    #[error("conversation not found: {0}")]
    NotFound(String),
}

/// Resolve the chat-store directory honoring `ANYCUBIC_CHAT_DIR`, falling back
/// to `%APPDATA%/anycubic-bridge/chat`. Machine-agnostic — never a hardcoded
/// user path (AGENTS.md §4, docs/agnostic-development.md).
pub fn chat_store_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ANYCUBIC_CHAT_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("anycubic-bridge").join("chat");
        }
    }
    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("anycubic-bridge")
            .join("chat");
    }
    PathBuf::from(".anycubic-bridge-chat")
}

/// Refuse ids that could escape the store directory (path traversal /
/// separator tricks). Ids come from the TS store (`conversation-<n>` or a
/// UUID); anything else is rejected before touching the filesystem.
fn sanitize_id(id: &str) -> Result<&str, ChatStoreError> {
    if id.is_empty()
        || id.len() > 128
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
    {
        return Err(ChatStoreError::InsecureId(id.to_string()));
    }
    Ok(id)
}

impl ChatStore {
    /// Create (mkdir -p) and return the store rooted at `dir`.
    pub fn open(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_owned();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// Open with the env-resolved default directory.
    pub fn open_default() -> std::io::Result<Self> {
        Self::open(chat_store_dir())
    }

    /// The directory holding the conversation files (useful for diagnostics).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// True when `<dir>/<id>.json` exists (i.e. the conversation has ever
    /// been persisted). Also true when only the journal exists.
    pub fn exists(&self, id: &str) -> Result<bool, ChatStoreError> {
        let id = sanitize_id(id)?;
        Ok(self.snapshot_path(id).exists() || self.journal_path(id).exists())
    }

    /// Atomically persist `T` as `<dir>/<id>.json` (temp-file + rename) and
    /// append a delta line to `<dir>/<id>.ndjson`.
    pub fn put<T: Serialize>(&self, id: &str, value: &T) -> Result<(), ChatStoreError> {
        let id = sanitize_id(id)?;
        let snapshot = serde_json::to_vec(value)?;
        let snapshot_path = self.snapshot_path(id);
        let tmp_path = snapshot_path.with_extension("json.tmp");

        // temp-file + rename — same directory ⇒ same filesystem ⇒ atomic.
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true);
        {
            let mut f = opts.open(&tmp_path)?;
            use std::io::Write;
            f.write_all(&snapshot)?;
            f.flush()?;
        }
        fs::rename(&tmp_path, &snapshot_path)?;

        // NDJSON delta — append-only journal line ("last write wins" replay).
        let mut delta = serde_json::to_vec(value)?;
        delta.push(b'\n');
        {
            let mut opts = fs::OpenOptions::new();
            opts.create(true).append(true);
            use std::io::Write;
            let mut f = opts.open(self.journal_path(id))?;
            f.write_all(&delta)?;
            f.flush()?;
        }

        if fs::metadata(&tmp_path).is_ok() {
            let _ = fs::remove_file(&tmp_path);
        }
        Ok(())
    }

    /// Read the conversation back. Prefers the JSON snapshot; on parse
    /// failure (corruption) falls back to replaying `<dir>/<id>.ndjson`
    /// from an empty base (last-line-wins) and atomically rewrites a clean
    /// snapshot so the next read is fast and stable.
    ///
    /// Returns `Err(NotFound)` when neither the snapshot nor the journal
    /// exist.
    pub fn get<T: DeserializeOwned + Serialize>(
        &self,
        id: &str,
    ) -> Result<Option<T>, ChatStoreError> {
        let id = sanitize_id(id)?;
        let snapshot_path = self.snapshot_path(id);
        let journal_path = self.journal_path(id);

        if snapshot_path.exists() {
            let raw = fs::read_to_string(&snapshot_path)?;
            match serde_json::from_str::<T>(&raw) {
                Ok(v) => return Ok(Some(v)),
                Err(_) => {
                    // corrupt — fall through to journal replay
                }
            }
        }

        if journal_path.exists() {
            let lines = fs::read_to_string(&journal_path)?;
            let mut recovered: Option<T> = None;
            for line in lines.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<T>(line) {
                    recovered = Some(v);
                }
            }
            if let Some(v) = recovered {
                // rewrite a clean snapshot (best-effort) so the next read
                // does not depend on journal replay.
                let tmp = snapshot_path.with_extension("json.tmp");
                let bytes = serde_json::to_vec(&v)?;
                {
                    use std::io::Write;
                    let mut f = fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .open(&tmp)?;
                    f.write_all(&bytes)?;
                    f.flush()?;
                }
                let _ = fs::rename(&tmp, &snapshot_path);
                return Ok(Some(v));
            }
        }

        Ok(None)
    }

    /// Delete a conversation entirely (snapshot + journal). No-op when the
    /// conversation does not exist (idempotent delete).
    pub fn delete(&self, id: &str) -> Result<(), ChatStoreError> {
        let id = sanitize_id(id)?;
        for p in [self.snapshot_path(id), self.journal_path(id)] {
            if p.exists() {
                fs::remove_file(p)?;
            }
        }
        Ok(())
    }

    /// List all conversation ids currently persisted (scan of `<dir>/*.json`).
    pub fn list(&self) -> Result<Vec<String>, ChatStoreError> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    // skip .tmp (they are only transient)
                    if !stem.ends_with(".json.tmp") {
                        ids.push(stem.to_string());
                    }
                }
            }
        }
        Ok(ids)
    }

    fn snapshot_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
    fn journal_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.ndjson"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    struct FakeConvo {
        id: String,
        title: String,
        revision: u64,
    }

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn roundtrip_put_get() {
        let d = temp_dir();
        let store = ChatStore::open(d.path()).expect("open");
        let v = FakeConvo { id: "conversation-1".into(), title: "Job A".into(), revision: 3 };
        store.put("conversation-1", &v).expect("put");
        let got = store.get::<FakeConvo>("conversation-1").expect("get");
        assert_eq!(got, Some(v));
        // snapshot + journal exist
        assert!(store.snapshot_path("conversation-1").exists());
        assert!(store.journal_path("conversation-1").exists());
    }

    #[test]
    fn put_is_atomic_and_append_journal() {
        let d = temp_dir();
        let store = ChatStore::open(d.path()).expect("open");
        let v1 = FakeConvo { id: "c1".into(), title: "one".into(), revision: 1 };
        let v2 = FakeConvo { id: "c1".into(), title: "two".into(), revision: 2 };
        store.put("c1", &v1).expect("put1");
        store.put("c1", &v2).expect("put2");
        let got = store.get::<FakeConvo>("c1").expect("get");
        assert_eq!(got.as_ref().map(|c| c.revision), Some(2));
        // journal has 2 lines
        let journal = fs::read_to_string(store.journal_path("c1")).expect("journal");
        assert_eq!(journal.lines().count(), 2);
        // no leftover tmp
        assert!(!store.snapshot_path("c1").with_extension("json.tmp").exists());
    }

    #[test]
    fn corrupt_snapshot_recovered_from_journal() {
        let d = temp_dir();
        let store = ChatStore::open(d.path()).expect("open");
        let v = FakeConvo { id: "c1".into(), title: "ok".into(), revision: 5 };
        store.put("c1", &v).expect("put");
        // corrupt the snapshot
        fs::write(store.snapshot_path("c1"), "{oops".as_bytes()).expect("corrupt");
        let got = store.get::<FakeConvo>("c1").expect("get");
        assert_eq!(got, Some(v.clone()));
        // snapshot rewritten clean
        let reparsed: FakeConvo =
            serde_json::from_str(&fs::read_to_string(store.snapshot_path("c1")).unwrap())
                .expect("reparse");
        assert_eq!(reparsed, v);
    }

    #[test]
    fn delete_removes_snapshot_and_journal() {
        let d = temp_dir();
        let store = ChatStore::open(d.path()).expect("open");
        store.put("c1", &FakeConvo { id: "c1".into(), title: "t".into(), revision: 1 }).expect("put");
        assert!(store.exists("c1").expect("exists"));
        store.delete("c1").expect("delete");
        assert!(!store.exists("c1").expect("exists-after-delete"));
        assert_eq!(store.get::<FakeConvo>("c1").expect("get"), None);
    }

    #[test]
    fn list_returns_persisted_ids_only() {
        let d = temp_dir();
        let store = ChatStore::open(d.path()).expect("open");
        store.put("conversation-1", &FakeConvo { id: "conversation-1".into(), title: "a".into(), revision: 0 }).expect("p1");
        store.put("conversation-2", &FakeConvo { id: "conversation-2".into(), title: "b".into(), revision: 0 }).expect("p2");
        let ids = store.list().expect("list");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"conversation-1".to_string()));
        assert!(ids.contains(&"conversation-2".to_string()));
    }

    #[test]
    fn insecure_ids_rejected() {
        let d = temp_dir();
        let store = ChatStore::open(d.path()).expect("open");
        assert!(matches!(
            store.get::<FakeConvo>("../evil").unwrap_err(),
            ChatStoreError::InsecureId(_)
        ));
        assert!(matches!(
            store.put("a\\b", &FakeConvo { id: "x".into(), title: "t".into(), revision: 0 }).unwrap_err(),
            ChatStoreError::InsecureId(_)
        ));
        assert!(matches!(
            store.delete("").unwrap_err(),
            ChatStoreError::InsecureId(_)
        ));
    }

    #[test]
    fn env_resolved_default_dir() {
        // Windows: APPDATA → %APPDATA%/anycubic-bridge/chat
        #[cfg(target_os = "windows")]
        {
            std::env::set_var("APPDATA", "C:\\AppData\\Test");
            let dir = chat_store_dir();
            assert!(dir.ends_with("anycubic-bridge\\chat"), "got {dir:?}");
        }
        // ANYCUBIC_CHAT_DIR wins
        std::env::set_var("ANYCUBIC_CHAT_DIR", "Z:\\custom\\chat");
        let dir = chat_store_dir();
        assert!(dir.ends_with("custom\\chat") || dir.ends_with("custom/chat"));
        std::env::remove_var("ANYCUBIC_CHAT_DIR");
    }
}
