//! Project store — S6-004.
//!
//! Versioned project schema (slicing_mode per project, §3.0a), ops journal,
//! revisions, and a content-addressed artifact store (hash → path; blobs live
//! outside the DB). Undo graph = append-only journal + monotonic revisions.

use broker::{DbHandle, MigrationError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub mod recovery;
pub use recovery::{RecoveryStore, Snapshot, SnapshotError};

pub const SCHEMA_VERSION: u32 = 1;
static ARTIFACT_TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectDocument {
    pub id: String,
    pub name: String,
    pub objects: Vec<Value>,
    #[serde(default)]
    pub legacy_objects: Vec<LegacyProjectObject>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LegacyProjectObject {
    pub id: String,
    pub name: String,
    pub mesh_sha256: Option<String>,
    pub migration_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSnapshot {
    pub project: ProjectDocument,
    pub revision: u64,
    #[serde(default)]
    pub diagnostics: Vec<SnapshotDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotDiagnostic {
    pub code: String,
    pub object_id: String,
    pub artifact_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    Present,
    Missing,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectOperationKind {
    AddObject,
    RemoveObject,
    RenameObject,
    CloneObject,
    SetVisibility,
    SetLock,
    SetMaterial,
    SetPlacement,
    SetTransform,
    SetPlate,
    SetObjectSettings,
    Repair,
    Boolean,
    Checkpoint,
}

impl ProjectOperationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AddObject => "add_object",
            Self::RemoveObject => "remove_object",
            Self::RenameObject => "rename_object",
            Self::CloneObject => "clone_object",
            Self::SetVisibility => "set_visibility",
            Self::SetLock => "set_lock",
            Self::SetMaterial => "set_material",
            Self::SetPlacement => "set_placement",
            Self::SetTransform => "set_transform",
            Self::SetPlate => "set_plate",
            Self::SetObjectSettings => "set_object_settings",
            Self::Repair => "repair",
            Self::Boolean => "boolean",
            Self::Checkpoint => "checkpoint",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectOperation {
    pub operation_id: String,
    pub kind: ProjectOperationKind,
    pub target_ids: Vec<String>,
    pub before: Value,
    pub after: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthorityError {
    #[error("project error: {0}")]
    Project(#[from] ProjectError),
    #[error("invalid project document: {0}")]
    InvalidDocument(#[from] serde_json::Error),
    #[error("project revision conflict: expected {expected}, actual {actual}")]
    Conflict { expected: u64, actual: u64 },
    #[error("project document id does not match the opened project")]
    ProjectIdMismatch,
    #[error("project not found")]
    ProjectNotFound,
}

/// Durable authority for project identity, object state, revision and journal.
pub struct ProjectAuthority {
    db: DbHandle,
    project_id: String,
    blobs_dir: Option<PathBuf>,
}

impl ProjectAuthority {
    pub fn list(db: &DbHandle) -> Result<Vec<ProjectSummary>, AuthorityError> {
        let projects = db.list_projects().map_err(ProjectError::from)?;
        Ok(projects
            .into_iter()
            .map(|(id, name, updated_ms)| ProjectSummary {
                id,
                name,
                updated_ms,
            })
            .collect())
    }

    pub fn list_slice_jobs(
        db: &DbHandle,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<Value>, AuthorityError> {
        db.list_slice_jobs(project_id, limit)
            .map_err(ProjectError::from)?
            .into_iter()
            .map(|record| serde_json::from_str(&record).map_err(AuthorityError::from))
            .collect()
    }

    pub fn list_slice_jobs_with_artifact_status(
        db: &DbHandle,
        project_id: &str,
        limit: u32,
        blobs_dir: Option<&Path>,
    ) -> Result<Vec<Value>, AuthorityError> {
        Self::list_slice_jobs(db, project_id, limit)?
            .into_iter()
            .map(|mut record| {
                let artifact_id = record.get("artifact_id").and_then(Value::as_str);
                let status = artifact_status(db, artifact_id, blobs_dir)?;
                if let Value::Object(fields) = &mut record {
                    fields.insert("artifact_status".to_owned(), serde_json::to_value(status)?);
                    fields.insert(
                        "artifact_origin".to_owned(),
                        Value::String("local".to_owned()),
                    );
                }
                Ok(record)
            })
            .collect()
    }

    pub fn create(
        db: DbHandle,
        project_id: impl Into<String>,
        project_name: &str,
        blobs_dir: Option<PathBuf>,
    ) -> Result<Self, AuthorityError> {
        Self::open_with_artifact_dir(db, project_id, project_name, blobs_dir)
    }

    pub fn open(
        db: DbHandle,
        project_id: impl Into<String>,
        project_name: &str,
    ) -> Result<Self, AuthorityError> {
        Self::open_with_artifact_dir(db, project_id, project_name, None)
    }

    pub fn open_with_artifact_dir(
        db: DbHandle,
        project_id: impl Into<String>,
        project_name: &str,
        blobs_dir: Option<PathBuf>,
    ) -> Result<Self, AuthorityError> {
        let project_id = project_id.into();
        let legacy_objects = db
            .legacy_project_objects(&project_id)
            .map_err(ProjectError::from)?
            .into_iter()
            .map(|(id, name, mesh_sha256)| LegacyProjectObject {
                id,
                name,
                mesh_sha256,
                migration_status: "metadata-retained-geometry-not-hydrated".to_owned(),
            })
            .collect();
        let initial = ProjectDocument {
            id: project_id.clone(),
            name: project_name.to_owned(),
            objects: Vec::new(),
            legacy_objects,
        };
        let encoded = serde_json::to_string(&initial)?;
        let mut db = db;
        db.ensure_project_state(&project_id, project_name, &encoded)
            .map_err(ProjectError::from)?;
        Ok(Self {
            db,
            project_id,
            blobs_dir,
        })
    }

    pub fn reopen_existing(
        db: DbHandle,
        project_id: impl Into<String>,
        blobs_dir: Option<PathBuf>,
    ) -> Result<Self, AuthorityError> {
        let project_id = project_id.into();
        let (_, encoded) = db
            .project_state(&project_id)
            .map_err(ProjectError::from)?
            .ok_or(AuthorityError::ProjectNotFound)?;
        let project: ProjectDocument = serde_json::from_str(&encoded)?;
        if project.id != project_id {
            return Err(AuthorityError::ProjectIdMismatch);
        }
        Ok(Self {
            db,
            project_id,
            blobs_dir,
        })
    }

    pub fn snapshot(&self) -> Result<ProjectSnapshot, AuthorityError> {
        let (revision, encoded) = self
            .db
            .project_state(&self.project_id)
            .map_err(ProjectError::from)?
            .ok_or_else(|| ProjectError::Db(rusqlite::Error::QueryReturnedNoRows))?;
        let mut project: ProjectDocument = serde_json::from_str(&encoded)?;
        let mut diagnostics = Vec::new();
        if let Some(blobs_dir) = &self.blobs_dir {
            for object in &mut project.objects {
                let Some(hash) = object
                    .get("artifactSha256")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                let object_id = object
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let Some(relative_path) =
                    self.db.artifact_path(&hash).map_err(ProjectError::from)?
                else {
                    object
                        .as_object_mut()
                        .expect("project objects are JSON objects")
                        .remove("geometry");
                    diagnostics.push(SnapshotDiagnostic {
                        code: "ARTIFACT_REFERENCE_MISSING".to_owned(),
                        object_id,
                        artifact_sha256: hash.clone(),
                    });
                    continue;
                };
                let path = blobs_dir.join(relative_path);
                if !path.is_file() {
                    object
                        .as_object_mut()
                        .expect("project objects are JSON objects")
                        .remove("geometry");
                    diagnostics.push(SnapshotDiagnostic {
                        code: "ARTIFACT_FILE_MISSING".to_owned(),
                        object_id,
                        artifact_sha256: hash.clone(),
                    });
                    continue;
                }
                let bytes = fs::read(path).map_err(ProjectError::from)?;
                let geometry: Value = serde_json::from_slice(&bytes)?;
                object["geometry"] = geometry;
            }
        }
        Ok(ProjectSnapshot {
            project,
            revision,
            diagnostics,
        })
    }

    pub fn commit(
        &mut self,
        expected_revision: u64,
        mut operation: ProjectOperation,
        mut project: ProjectDocument,
    ) -> Result<ProjectSnapshot, AuthorityError> {
        if project.id != self.project_id {
            return Err(AuthorityError::ProjectIdMismatch);
        }
        let mut artifacts = Vec::new();
        if let Some(blobs_dir) = &self.blobs_dir {
            for object in &mut project.objects {
                content_address_geometry(object, blobs_dir, &mut artifacts)?;
            }
            content_address_geometry(&mut operation.before, blobs_dir, &mut artifacts)?;
            content_address_geometry(&mut operation.after, blobs_dir, &mut artifacts)?;
        }
        let operation_json = serde_json::to_string(&operation)?;
        let project_json = serde_json::to_string(&project)?;
        let mut request_hasher = Sha256::new();
        request_hasher.update(operation_json.as_bytes());
        request_hasher.update([0]);
        request_hasher.update(project_json.as_bytes());
        let request_hash = hex::encode(request_hasher.finalize());
        match self
            .db
            .commit_project_state(
                &self.project_id,
                expected_revision,
                &operation.operation_id,
                &request_hash,
                operation.kind.as_str(),
                &operation_json,
                &project_json,
                &artifacts,
            )
            .map_err(ProjectError::from)?
        {
            Ok(_) => self.snapshot(),
            Err(actual) => Err(AuthorityError::Conflict {
                expected: expected_revision,
                actual,
            }),
        }
    }

    pub fn journal(&self) -> Result<Vec<ProjectOperation>, AuthorityError> {
        let entries = self
            .db
            .project_operations(&self.project_id)
            .map_err(ProjectError::from)?;
        entries
            .into_iter()
            .map(|payload| serde_json::from_str(&payload).map_err(AuthorityError::from))
            .collect()
    }

    /// Persist an immutable job artifact in the same content-addressed blob
    /// store used by project geometry. Returns its SHA-256 digest.
    pub fn put_artifact(&self, bytes: &[u8]) -> Result<String, AuthorityError> {
        let blobs_dir = self
            .blobs_dir
            .as_ref()
            .ok_or_else(|| ProjectError::MissingArtifactDirectory)?;
        let (digest, relative_path) = stage_mesh_blob(blobs_dir, bytes)?;
        self.db
            .put_artifact(&digest, &relative_path, bytes.len() as u64)
            .map_err(ProjectError::from)?;
        Ok(digest)
    }

    pub fn get_artifact(&self, digest: &str) -> Result<Option<Vec<u8>>, AuthorityError> {
        let Some(blobs_dir) = &self.blobs_dir else {
            return Err(ProjectError::MissingArtifactDirectory.into());
        };
        let Some(relative_path) = self.db.artifact_path(digest).map_err(ProjectError::from)? else {
            return Ok(None);
        };
        let path = blobs_dir.join(relative_path);
        if !path.is_file() {
            return Ok(None);
        }
        Ok(Some(fs::read(path).map_err(ProjectError::from)?))
    }

    pub fn put_slice_job(
        &self,
        job_id: &str,
        source_revision: u64,
        input_digest: &str,
        status: &str,
        record: &Value,
    ) -> Result<(), AuthorityError> {
        let encoded = serde_json::to_string(record)?;
        self.db
            .put_slice_job(
                job_id,
                &self.project_id,
                source_revision,
                input_digest,
                status,
                &encoded,
            )
            .map_err(ProjectError::from)?;
        Ok(())
    }

    pub fn get_slice_job(&self, job_id: &str) -> Result<Option<Value>, AuthorityError> {
        self.db
            .slice_job(&self.project_id, job_id)
            .map_err(ProjectError::from)?
            .map(|encoded| serde_json::from_str(&encoded).map_err(AuthorityError::from))
            .transpose()
    }

    pub fn cached_slice_job(
        &self,
        source_revision: u64,
        input_digest: &str,
    ) -> Result<Option<Value>, AuthorityError> {
        self.db
            .cached_slice_job(&self.project_id, source_revision, input_digest)
            .map_err(ProjectError::from)?
            .map(|encoded| serde_json::from_str(&encoded).map_err(AuthorityError::from))
            .transpose()
    }
}

fn artifact_status(
    db: &DbHandle,
    artifact_id: Option<&str>,
    blobs_dir: Option<&Path>,
) -> Result<ArtifactStatus, AuthorityError> {
    let Some(artifact_id) = artifact_id else {
        return Ok(ArtifactStatus::Unavailable);
    };
    let Some(blobs_dir) = blobs_dir else {
        return Ok(ArtifactStatus::Unavailable);
    };
    if artifact_id.len() != 64
        || !artifact_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Ok(ArtifactStatus::Missing);
    }
    let Some(relative_path) = db.artifact_path(artifact_id).map_err(ProjectError::from)? else {
        return Ok(ArtifactStatus::Missing);
    };
    let expected_path = format!("{artifact_id}.mesh");
    if relative_path != expected_path {
        return Ok(ArtifactStatus::Missing);
    }
    Ok(if blobs_dir.join(relative_path).is_file() {
        ArtifactStatus::Present
    } else {
        ArtifactStatus::Missing
    })
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("migration: {0}")]
    Migration(#[from] MigrationError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("project artifact directory is unavailable")]
    MissingArtifactDirectory,
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
        Self::try_new(db, blobs_dir).expect("blobs dir")
    }

    pub fn try_new(db: DbHandle, blobs_dir: impl AsRef<Path>) -> Result<Self, ProjectError> {
        let blobs_dir = blobs_dir.as_ref().to_path_buf();
        fs::create_dir_all(&blobs_dir)?;
        Ok(ArtifactStore { blobs_dir, db })
    }

    fn sha256(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex::encode(h.finalize())
    }

    /// Store mesh bytes content-addressed. Returns the sha256 + blob path.
    pub fn put_mesh(&self, data: &[u8]) -> Result<(String, String), ProjectError> {
        let (hash, rel) = self.stage_mesh(data)?;
        self.db.put_artifact(&hash, &rel, data.len() as u64)?;
        Ok((hash, rel))
    }

    /// Atomically stage a content-addressed blob without registering a DB
    /// reference. The caller commits that reference with its domain state.
    pub fn stage_mesh(&self, data: &[u8]) -> Result<(String, String), ProjectError> {
        stage_mesh_blob(&self.blobs_dir, data)
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

fn stage_mesh_blob(blobs_dir: &Path, data: &[u8]) -> Result<(String, String), ProjectError> {
    fs::create_dir_all(blobs_dir)?;
    let hash = ArtifactStore::sha256(data);
    let relative_path = format!("{hash}.mesh");
    let path = blobs_dir.join(&relative_path);
    if path.exists() {
        return Ok((hash, relative_path));
    }
    let temp = blobs_dir.join(format!(
        ".{hash}.{}.{}.tmp",
        std::process::id(),
        ARTIFACT_TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(data)?;
    file.sync_all()?;
    match fs::rename(&temp, &path) {
        Ok(()) => {}
        Err(_error) if path.exists() => fs::remove_file(&temp)?,
        Err(error) => return Err(error.into()),
    }
    Ok((hash, relative_path))
}

fn content_address_geometry(
    value: &mut Value,
    blobs_dir: &Path,
    artifacts: &mut Vec<(String, String, u64)>,
) -> Result<(), ProjectError> {
    match value {
        Value::Array(items) => {
            for item in items {
                content_address_geometry(item, blobs_dir, artifacts)?;
            }
        }
        Value::Object(fields) => {
            if let Some(geometry) = fields.remove("geometry") {
                let bytes = serde_json::to_vec(&geometry)?;
                let (sha256, relative_path) = stage_mesh_blob(blobs_dir, &bytes)?;
                fields.insert("artifactSha256".to_owned(), Value::String(sha256.clone()));
                artifacts.push((sha256, relative_path, bytes.len() as u64));
            }
            for field in fields.values_mut() {
                content_address_geometry(field, blobs_dir, artifacts)?;
            }
        }
        _ => {}
    }
    Ok(())
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

    fn operation(
        operation_id: &str,
        kind: &str,
        target_id: &str,
        before: Value,
        after: Value,
    ) -> ProjectOperation {
        ProjectOperation {
            operation_id: operation_id.to_owned(),
            kind: match kind {
                "add_object" => ProjectOperationKind::AddObject,
                "set_material" => ProjectOperationKind::SetMaterial,
                "repair" => ProjectOperationKind::Repair,
                "boolean" => ProjectOperationKind::Boolean,
                _ => unreachable!(),
            },
            target_ids: vec![target_id.to_owned()],
            before,
            after,
        }
    }

    #[test]
    fn authority_reopens_actual_domain_state_and_rejects_stale_or_noop_writes() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("workspace.db");
        let project_id = "local-project";
        let object = serde_json::json!({
            "id": "object-stable-1",
            "name": "renamed-part",
            "materialId": "petg-blue",
            "transform": {"x": 12.0, "y": 0.0, "z": -4.0}
        });
        {
            let db = DbHandle::open(&db_path).unwrap();
            let mut authority = ProjectAuthority::open(db, project_id, "Local Project").unwrap();
            let mut document = authority.snapshot().unwrap().project;
            document.objects.push(object.clone());
            let committed = authority
                .commit(
                    0,
                    operation(
                        "op-add",
                        "add_object",
                        "object-stable-1",
                        Value::Null,
                        object.clone(),
                    ),
                    document.clone(),
                )
                .unwrap();
            assert_eq!(committed.revision, 1);

            let no_op = authority
                .commit(
                    1,
                    operation(
                        "op-noop",
                        "set_material",
                        "object-stable-1",
                        object.clone(),
                        object.clone(),
                    ),
                    document.clone(),
                )
                .unwrap();
            assert_eq!(no_op.revision, 1);

            document.objects[0]["materialId"] = Value::String("petg-red".into());
            let material_operation = operation(
                "op-material",
                "set_material",
                "object-stable-1",
                object.clone(),
                document.objects[0].clone(),
            );
            let material_commit = authority
                .commit(1, material_operation.clone(), document.clone())
                .unwrap();
            assert_eq!(material_commit.revision, 2);
            let retry = authority
                .commit(1, material_operation.clone(), document.clone())
                .unwrap();
            assert_eq!(retry.revision, 2);
            assert_eq!(authority.journal().unwrap().len(), 2);

            let mut changed_retry = material_operation.clone();
            changed_retry.after["materialId"] = Value::String("different-payload".into());
            assert!(matches!(
                authority.commit(2, changed_retry, document.clone()),
                Err(AuthorityError::Project(ProjectError::Db(
                    rusqlite::Error::InvalidParameterName(_)
                )))
            ));

            document.objects[0]["watertight"] = Value::Bool(true);
            let repaired = document.objects[0].clone();
            assert_eq!(
                authority
                    .commit(
                        2,
                        operation(
                            "op-repair",
                            "repair",
                            "object-stable-1",
                            Value::Bool(false),
                            Value::Bool(true),
                        ),
                        document.clone(),
                    )
                    .unwrap()
                    .revision,
                3
            );

            let boolean_object = serde_json::json!({
                "id": "boolean-result-1",
                "name": "combined-part",
                "sourceIds": ["object-stable-1", "object-source-2"],
                "provenance": "boolean union",
                "watertight": true
            });
            document.objects.push(boolean_object.clone());
            assert_eq!(
                authority
                    .commit(
                        3,
                        operation(
                            "op-boolean",
                            "boolean",
                            "boolean-result-1",
                            Value::Null,
                            boolean_object,
                        ),
                        document.clone(),
                    )
                    .unwrap()
                    .revision,
                4
            );

            let conflict = authority.commit(
                1,
                operation(
                    "op-stale",
                    "set_material",
                    "object-stable-1",
                    object.clone(),
                    document.objects[0].clone(),
                ),
                document.clone(),
            );
            assert!(matches!(
                conflict,
                Err(AuthorityError::Conflict {
                    expected: 1,
                    actual: 4
                })
            ));
            assert_eq!(authority.journal().unwrap().len(), 4);
            assert_eq!(repaired["watertight"], true);
        }

        let reopened =
            ProjectAuthority::open(DbHandle::open(&db_path).unwrap(), project_id, "Ignored")
                .unwrap();
        let recovered = reopened.snapshot().unwrap();
        assert_eq!(recovered.revision, 4);
        assert_eq!(recovered.project.name, "Local Project");
        assert_eq!(recovered.project.objects[0]["id"], "object-stable-1");
        assert_eq!(recovered.project.objects[0]["materialId"], "petg-red");
        assert_eq!(recovered.project.objects[0]["transform"]["x"], 12.0);
        assert_eq!(recovered.project.objects[0]["watertight"], true);
        assert_eq!(
            recovered.project.objects[1]["sourceIds"][0],
            "object-stable-1"
        );
        let journal = reopened.journal().unwrap();
        assert_eq!(journal.len(), 4);
        assert_eq!(journal[0].kind, ProjectOperationKind::AddObject);
        assert_eq!(journal[0].after["materialId"], "petg-blue");
        assert_eq!(journal[1].kind, ProjectOperationKind::SetMaterial);
        assert_eq!(journal[1].after["materialId"], "petg-red");
        assert_eq!(journal[2].kind, ProjectOperationKind::Repair);
        assert_eq!(journal[2].after, true);
        assert_eq!(journal[3].kind, ProjectOperationKind::Boolean);
        assert_eq!(journal[3].after["provenance"], "boolean union");
    }

    #[test]
    fn authority_commits_geometry_artifact_reference_with_project_revision() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("workspace.db");
        let blobs_dir = dir.path().join("project-blobs");
        let db = DbHandle::open(&db_path).unwrap();
        let mut authority = ProjectAuthority::open_with_artifact_dir(
            db,
            "artifact-project",
            "Artifact Project",
            Some(blobs_dir.clone()),
        )
        .unwrap();
        let geometry = serde_json::json!({
            "positions": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "indices": [0, 1, 2]
        });
        let object = serde_json::json!({
            "id": "object-artifact-1",
            "name": "triangle",
            "geometry": geometry,
            "visible": true
        });
        let mut document = authority.snapshot().unwrap().project;
        document.objects.push(object.clone());
        let committed = authority
            .commit(
                0,
                ProjectOperation {
                    operation_id: "operation-artifact-1".to_owned(),
                    kind: ProjectOperationKind::AddObject,
                    target_ids: vec!["object-artifact-1".to_owned()],
                    before: Value::Null,
                    after: object,
                },
                document,
            )
            .unwrap();
        assert_eq!(committed.revision, 1);
        let hash = committed.project.objects[0]["artifactSha256"]
            .as_str()
            .unwrap();
        let registered_path = committed
            .project
            .objects
            .first()
            .and_then(|_| authority.db.artifact_path(hash).unwrap())
            .unwrap();
        assert!(blobs_dir.join(registered_path).is_file());
        assert_eq!(authority.journal().unwrap().len(), 1);

        drop(authority);
        let reopened = ProjectAuthority::open_with_artifact_dir(
            DbHandle::open(&db_path).unwrap(),
            "artifact-project",
            "Ignored",
            Some(blobs_dir),
        )
        .unwrap();
        let recovered = reopened.snapshot().unwrap();
        assert_eq!(recovered.revision, 1);
        assert_eq!(recovered.project.objects[0]["geometry"]["indices"][0], 0);
    }

    #[test]
    fn snapshot_reports_missing_artifact_reference_without_fabricating_geometry() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("workspace.db");
        let blobs_dir = dir.path().join("project-blobs");
        let db = DbHandle::open(&db_path).unwrap();
        let mut authority = ProjectAuthority::open_with_artifact_dir(
            db,
            "missing-artifact-project",
            "Missing Artifact Project",
            Some(blobs_dir.clone()),
        )
        .unwrap();
        let object = serde_json::json!({
            "id": "stable-object-id",
            "name": "retained-object",
            "sourceIds": ["source-object-id"],
            "geometry": {"positions": [0.0, 0.0, 0.0]}
        });
        let artifact_sha256 = "a".repeat(64);
        let mut project = authority.snapshot().unwrap().project;
        let mut object = object;
        object["artifactSha256"] = Value::String(artifact_sha256.clone());
        object.as_object_mut().unwrap().remove("geometry");
        project.objects.push(object);
        authority
            .db
            .commit_project_state(
                "missing-artifact-project",
                0,
                "missing-reference-fixture",
                "missing-reference-fixture-hash",
                "add_object",
                "{}",
                &serde_json::to_string(&project).unwrap(),
                &[],
            )
            .unwrap()
            .unwrap();
        let snapshot = authority.snapshot().unwrap();
        let recovered = &snapshot.project.objects[0];
        assert_eq!(recovered["id"], "stable-object-id");
        assert_eq!(recovered["sourceIds"][0], "source-object-id");
        assert_eq!(recovered["name"], "retained-object");
        assert!(recovered.get("geometry").is_none());
        assert_eq!(snapshot.diagnostics.len(), 1);
        assert_eq!(snapshot.diagnostics[0].code, "ARTIFACT_REFERENCE_MISSING");
        assert_eq!(snapshot.diagnostics[0].object_id, "stable-object-id");
        assert_eq!(snapshot.diagnostics[0].artifact_sha256, artifact_sha256);
    }

    #[test]
    fn snapshot_reports_deleted_artifact_file_and_keeps_valid_geometry_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("workspace.db");
        let blobs_dir = dir.path().join("project-blobs");
        let mut authority = ProjectAuthority::open_with_artifact_dir(
            DbHandle::open(&db_path).unwrap(),
            "deleted-artifact-project",
            "Deleted Artifact Project",
            Some(blobs_dir.clone()),
        )
        .unwrap();
        let geometry = serde_json::json!({
            "positions": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "indices": [0, 1, 2]
        });
        let valid_object = serde_json::json!({"id": "valid-object", "geometry": geometry});
        let mut project = authority.snapshot().unwrap().project;
        project.objects.push(valid_object.clone());
        authority
            .commit(
                0,
                operation(
                    "valid-add",
                    "add_object",
                    "valid-object",
                    Value::Null,
                    valid_object,
                ),
                project,
            )
            .unwrap();
        let mut project = authority.snapshot().unwrap().project;
        let missing_object = serde_json::json!({
            "id": "deleted-object",
            "name": "retained",
            "sourceIds": ["source-object-id"],
            "geometry": {"positions": [0.0, 0.0, 0.0]}
        });
        project.objects.push(missing_object.clone());
        let committed = authority
            .commit(
                1,
                operation(
                    "deleted-add",
                    "add_object",
                    "deleted-object",
                    Value::Null,
                    missing_object,
                ),
                project,
            )
            .unwrap();
        let missing_hash = committed.project.objects[1]["artifactSha256"]
            .as_str()
            .unwrap()
            .to_owned();
        let relative_path = authority.db.artifact_path(&missing_hash).unwrap().unwrap();
        fs::remove_file(blobs_dir.join(relative_path)).unwrap();

        let snapshot = authority.snapshot().unwrap();
        assert_eq!(snapshot.project.objects[0]["geometry"]["indices"][0], 0);
        assert_eq!(snapshot.project.objects[1]["id"], "deleted-object");
        assert_eq!(snapshot.project.objects[1]["name"], "retained");
        assert_eq!(
            snapshot.project.objects[1]["sourceIds"][0],
            "source-object-id"
        );
        assert!(snapshot.project.objects[1].get("geometry").is_none());
        assert_eq!(snapshot.diagnostics.len(), 1);
        assert_eq!(snapshot.diagnostics[0].code, "ARTIFACT_FILE_MISSING");
        assert_eq!(snapshot.diagnostics[0].object_id, "deleted-object");
        assert_eq!(snapshot.diagnostics[0].artifact_sha256, missing_hash);
    }

    #[test]
    fn reopen_existing_reads_persisted_state_and_rejects_missing_projects() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("workspace.db");
        let project_id = "recover-project";
        {
            let db = DbHandle::open(&db_path).unwrap();
            let mut authority = ProjectAuthority::open(db, project_id, "Persisted Name").unwrap();
            let mut project = authority.snapshot().unwrap().project;
            let object = serde_json::json!({"id": "persisted-object", "materialId": "pla"});
            project.objects.push(object.clone());
            authority
                .commit(
                    0,
                    operation(
                        "recover-add",
                        "add_object",
                        "persisted-object",
                        Value::Null,
                        object,
                    ),
                    project,
                )
                .unwrap();
        }

        let reopened =
            ProjectAuthority::reopen_existing(DbHandle::open(&db_path).unwrap(), project_id, None)
                .unwrap();
        let recovered = reopened.snapshot().unwrap();
        assert_eq!(recovered.revision, 1);
        assert_eq!(recovered.project.name, "Persisted Name");
        assert_eq!(recovered.project.objects[0]["id"], "persisted-object");

        assert!(matches!(
            ProjectAuthority::reopen_existing(
                DbHandle::open(&db_path).unwrap(),
                "missing-project",
                None
            ),
            Err(AuthorityError::ProjectNotFound)
        ));
        assert!(DbHandle::open(&db_path)
            .unwrap()
            .project_state("missing-project")
            .unwrap()
            .is_none());
    }

    #[test]
    fn legacy_object_ids_are_retained_without_claiming_geometry_migration() {
        let dir = tempfile::tempdir().unwrap();
        let db = DbHandle::open(dir.path().join("legacy.db")).unwrap();
        db.create_project("legacy-project", "Existing Project")
            .unwrap();
        db.put_project_object(
            "legacy-object-id",
            "legacy-project",
            "old-name",
            Some("mesh-hash"),
        )
        .unwrap();
        let authority = ProjectAuthority::open(db, "legacy-project", "Ignored").unwrap();
        let migrated = authority.snapshot().unwrap();
        assert_eq!(migrated.project.legacy_objects.len(), 1);
        assert_eq!(migrated.project.legacy_objects[0].id, "legacy-object-id");
        assert_eq!(
            migrated.project.legacy_objects[0].migration_status,
            "metadata-retained-geometry-not-hydrated"
        );
        assert!(migrated.project.objects.is_empty());
    }

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
