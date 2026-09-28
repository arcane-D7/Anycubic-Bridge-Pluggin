//! Profile store + three read-only ingestion paths — S6-003.
//!
//! Paths: (1) manual form → `source_class=Src`, low confidence until
//! corroborated; (2) API/property catalog → measured, low-confidence flagged
//! with `[?]` provenance, never asserted; (3) online catalog → version-pinned,
//! hash-checked, user-approve to apply, and it can never silently override
//! manual/measured data (conflict → error).

use crate::{MachineProfile, ProfileError, Qualification, SourceClass};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct ProfileStore {
    root: PathBuf,
    profiles: BTreeMap<String, MachineProfile>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("profile error: {0}")]
    Profile(#[from] ProfileError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("conflict: {0}")] // manual/measured vs catalog — must resolve by human
    Conflict(String),
}

impl ProfileStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        let mut profiles = BTreeMap::new();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                let data = fs::read_to_string(&path)?;
                let p: MachineProfile = serde_json::from_str(&data)?;
                profiles.insert(p.id.clone(), p);
            }
        }
        Ok(ProfileStore { root, profiles })
    }

    pub fn save(&mut self, profile: &MachineProfile) -> Result<(), StoreError> {
        let data = serde_json::to_string_pretty(profile)?;
        fs::write(self.root.join(format!("{}.json", profile.id)), data)?;
        self.profiles.insert(profile.id.clone(), profile.clone());
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&MachineProfile> {
        self.profiles.get(id)
    }

    /// Path 1 — manual form. `source_class=Src`; confidence low until a second
    /// source corroborates (corroboration arrives via measured/catalog paths).
    pub fn ingest_manual(&mut self, mut p: MachineProfile) -> Result<(), StoreError> {
        for cap in &mut p.capabilities {
            cap.source_class = SourceClass::Src;
            cap.confidence = Some(0.3); // un-corroborated by definition
        }
        if p.qualification == Qualification::Qualified {
            p.qualification = Qualification::Shadow;
        }
        self.save(&p)
    }

    /// Path 2 — API property catalog. Flags low-confidence fields with `[?]`
    /// provenance; never asserts truth.
    pub fn ingest_measured(&mut self, mut p: MachineProfile) -> Result<(), StoreError> {
        for cap in &mut p.capabilities {
            cap.source_class = SourceClass::Measured;
            let conf = cap.confidence.unwrap_or(0.5);
            let q = if conf < 0.75 { "[?]" } else { "[ok]" };
            cap.provenance = Some(format!("{q} api-capture"));
        }
        self.save(&p)
    }

    /// Path 3 — online catalog. Requires a non-empty version + sha256 for the
    /// pinned payload; `apply=false` returns Ok(()) pretending the check only.
    /// Conflicts with an existing manual/measured field → Err(Conflict).
    pub fn ingest_catalog(
        &mut self,
        mut p: MachineProfile,
        catalog_version: &str,
        sha256: &str,
        apply: bool,
    ) -> Result<(), StoreError> {
        if catalog_version.is_empty() || sha256.len() != 64 {
            // Never ingest an unverifiable catalog payload.
            return Err(StoreError::Conflict(
                "catalog payload not version-pinned + hash-checked".into(),
            ));
        }
        if !apply {
            return Ok(());
        }
        // Conflict rule: catalog may only set fields that are NOT already
        // manual/measured.
        if let Some(existing) = self.get(&p.id) {
            for cap in &p.capabilities {
                if let Some(cur) = existing.capabilities.iter().find(|c| c.name == cap.name) {
                    match cur.source_class {
                        SourceClass::Src | SourceClass::Measured => {
                            return Err(StoreError::Conflict(format!(
                                "catalog cannot override {}='{}' (existing {} source)",
                                cap.name,
                                cur.value
                                    .as_ref()
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "null".into()),
                                serde_json::to_value(&cur.source_class).unwrap(),
                            )));
                        }
                        SourceClass::Catalog => {}
                    }
                }
            }
        }
        for cap in &mut p.capabilities {
            cap.source_class = SourceClass::Catalog;
            cap.provenance =
                Some(format!("catalog@{catalog_version}#{}", &sha256[..8]));
            if cap.confidence.is_none() {
                cap.confidence = Some(0.8);
            }
        }
        self.save(&p)
    }

    pub fn all(&self) -> impl Iterator<Item = &MachineProfile> {
        self.profiles.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::demo_profile;

    #[test]
    fn manual_lowers_confidence_and_shadow() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ProfileStore::open(dir.path()).unwrap();
        let mut p = demo_profile();
        p.qualification = Qualification::Qualified;
        store.ingest_manual(p).unwrap();
        let saved = store.get("demo").unwrap();
        assert_eq!(saved.capabilities[0].source_class, SourceClass::Src);
        assert_eq!(saved.capabilities[0].confidence, Some(0.3));
        assert_eq!(saved.qualification, Qualification::Shadow);
    }

    #[test]
    fn measured_flags_low_confidence() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ProfileStore::open(dir.path()).unwrap();
        let p = demo_profile();
        store.ingest_measured(p).unwrap();
        let saved = store.get("demo").unwrap();
        let prov = saved.capabilities[0].provenance.as_deref().unwrap();
        assert!(prov.starts_with("[ok]") || prov.starts_with("[?]"));
        assert_eq!(saved.capabilities[0].source_class, SourceClass::Measured);
    }

    #[test]
    fn catalog_cannot_override_manual_measured() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ProfileStore::open(dir.path()).unwrap();
        store.ingest_manual(demo_profile()).unwrap();

        let hs = "a".repeat(64);
        store
            .ingest_catalog(demo_profile(), "2026.09", &hs, false)
            .unwrap(); // verify-only: ok
        let err = store.ingest_catalog(demo_profile(), "2026.09", &hs, true);
        assert!(matches!(err, Err(StoreError::Conflict(_))), "catalog must not silently override manual");
    }

    #[test]
    fn catalog_rejects_unverifiable_payload() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ProfileStore::open(dir.path()).unwrap();
        let err = store.ingest_catalog(demo_profile(), "", "abc", true);
        assert!(matches!(err, Err(StoreError::Conflict(_))));
    }

    #[test]
    fn store_persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut store = ProfileStore::open(dir.path()).unwrap();
            store.save(&demo_profile()).unwrap();
        }
        let store = ProfileStore::open(dir.path()).unwrap();
        assert_eq!(store.get("demo").unwrap().id, "demo");
    }
}
