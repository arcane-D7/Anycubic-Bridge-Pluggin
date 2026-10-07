// R0 lib crate — exposes the Tauri Builder facade so check-rust can verify the
// crate compiles and so a future broker-facing command surface has a stable
// home (commands never touch secrets; the broker owns them). S6-001 ships the
// shell only: no commands are registered yet.
//
// S9.6-007 — Broker chat-store persistence lane: the shell exposes thin
// `#[tauri::command]` wrappers over `broker::chat_store::ChatStore`. The
// cmd surface is the ONLY wiring the webview uses (no direct fs from the
// React side); the Rust side owns env-resolved path + atomic writes.

use std::path::PathBuf;
use std::sync::Mutex;

use broker::chat_store::ChatStore;
use broker::DbHandle;
use project_store::{
    AuthorityError, ProjectAuthority, ProjectDocument, ProjectOperation, ProjectSnapshot,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// Managed handle to the shared chat store (single-writer, like the DB).
struct ChatStoreState(Mutex<ChatStore>);

struct ProjectAuthorityState(Mutex<Result<ProjectAuthority, String>>);

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Anycubic Bridge Editor",
        "r0": true,
        "slicing_modes": ["standard", "nonplanar"],
    })
}

/// Resolve the persisted chat directory (env-resolved in Rust — the webview
/// never computes machine paths).
#[tauri::command]
fn chat_store_dir(state: State<'_, ChatStoreState>) -> Result<String, String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    Ok(store.dir().to_string_lossy().into_owned())
}

/// Persist one conversation snapshot + append its NDJSON delta.
#[tauri::command]
fn chat_store_put(
    state: State<'_, ChatStoreState>,
    id: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    store.put(&id, &value).map_err(|e| e.to_string())
}

/// Read one conversation (snapshot preferred; corrupt → journal replay).
#[tauri::command]
fn chat_store_get(
    state: State<'_, ChatStoreState>,
    id: String,
) -> Result<Option<serde_json::Value>, String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    store
        .get::<serde_json::Value>(&id)
        .map_err(|e| e.to_string())
}

/// Delete a conversation (snapshot + journal), idempotent.
#[tauri::command]
fn chat_store_delete(state: State<'_, ChatStoreState>, id: String) -> Result<(), String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    store.delete(&id).map_err(|e| e.to_string())
}

/// List all persisted conversation ids.
#[tauri::command]
fn chat_store_list(state: State<'_, ChatStoreState>) -> Result<Vec<String>, String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    store.list().map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
struct ChatStoreInfo {
    dir: String,
    conversations: Vec<String>,
}

/// Diagnostics: report the resolved dir + current persisted ids.
#[tauri::command]
fn chat_store_info(state: State<'_, ChatStoreState>) -> Result<ChatStoreInfo, String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    Ok(ChatStoreInfo {
        dir: store.dir().to_string_lossy().into_owned(),
        conversations: store.list().map_err(|e| e.to_string())?,
    })
}

fn workspace_db_path() -> Result<PathBuf, String> {
    let data_root = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .ok_or_else(|| "application data directory is unavailable".to_owned())?;
    let app_dir = PathBuf::from(data_root).join("AnycubicBridge");
    std::fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
    Ok(app_dir.join("workspace.db"))
}

fn open_project_authority() -> Result<ProjectAuthority, String> {
    let db_path = workspace_db_path()?;
    let data_dir = db_path
        .parent()
        .ok_or_else(|| "workspace database directory is unavailable".to_owned())?;
    let db = DbHandle::open(&db_path).map_err(|error| error.to_string())?;
    ProjectAuthority::open_with_artifact_dir(
        db,
        "local-project",
        "Local Project",
        Some(data_dir.join("project-blobs")),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_authority_read(
    state: State<'_, ProjectAuthorityState>,
) -> Result<ProjectSnapshot, String> {
    let guard = state.0.lock().map_err(|error| error.to_string())?;
    guard
        .as_ref()
        .map_err(Clone::clone)?
        .snapshot()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_authority_journal(
    state: State<'_, ProjectAuthorityState>,
) -> Result<Vec<ProjectOperation>, String> {
    let guard = state.0.lock().map_err(|error| error.to_string())?;
    guard
        .as_ref()
        .map_err(Clone::clone)?
        .journal()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_authority_commit(
    state: State<'_, ProjectAuthorityState>,
    expected_revision: u64,
    operation: ProjectOperation,
    project: ProjectDocument,
) -> Result<ProjectCommitReply, String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;
    let authority = guard.as_mut().map_err(|error| (*error).clone())?;
    match authority.commit(expected_revision, operation, project) {
        Ok(snapshot) => Ok(ProjectCommitReply {
            status: if snapshot.revision == expected_revision {
                "no_op"
            } else {
                "committed"
            }
            .to_owned(),
            actual_revision: snapshot.revision,
            snapshot: Some(snapshot),
            diagnostics: Vec::new(),
        }),
        Err(AuthorityError::Conflict { actual, .. }) => Ok(ProjectCommitReply {
            status: "conflict".to_owned(),
            actual_revision: actual,
            snapshot: Some(authority.snapshot().map_err(|error| error.to_string())?),
            diagnostics: vec!["project_revision_conflict".to_owned()],
        }),
        Err(error) => Ok(ProjectCommitReply {
            status: "failed".to_owned(),
            actual_revision: authority
                .snapshot()
                .map(|snapshot| snapshot.revision)
                .unwrap_or(expected_revision),
            snapshot: None,
            diagnostics: vec![error.to_string()],
        }),
    }
}

#[derive(Serialize)]
struct ProjectCommitReply {
    status: String,
    actual_revision: u64,
    snapshot: Option<ProjectSnapshot>,
    diagnostics: Vec<String>,
}

pub fn run() {
    tauri::Builder::default()
        .manage(ChatStoreState(Mutex::new(
            ChatStore::open_default().expect("chat store dir"),
        )))
        .manage(ProjectAuthorityState(Mutex::new(open_project_authority())))
        .invoke_handler(tauri::generate_handler![
            app_info,
            chat_store_dir,
            chat_store_put,
            chat_store_get,
            chat_store_delete,
            chat_store_list,
            chat_store_info,
            project_authority_read,
            project_authority_journal,
            project_authority_commit,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            window.set_title("Anycubic Bridge Editor").ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Anycubic Bridge editor");
}
