// R0 lib crate — exposes the Tauri Builder facade so check-rust can verify the
// crate compiles and so a future broker-facing command surface has a stable
// home (commands never touch secrets; the broker owns them). S6-001 ships the
// shell only: no commands are registered yet.
//
// S9.6-007 — Broker chat-store persistence lane: the shell exposes thin
// `#[tauri::command]` wrappers over `broker::chat_store::ChatStore`. The
// cmd surface is the ONLY wiring the webview uses (no direct fs from the
// React side); the Rust side owns env-resolved path + atomic writes.

use std::sync::Mutex;

use broker::chat_store::ChatStore;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// Managed handle to the shared chat store (single-writer, like the DB).
struct ChatStoreState(Mutex<ChatStore>);

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
    store.get::<serde_json::Value>(&id).map_err(|e| e.to_string())
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

pub fn run() {
    tauri::Builder::default()
        .manage(ChatStoreState(Mutex::new(
            ChatStore::open_default().expect("chat store dir"),
        )))
        .invoke_handler(tauri::generate_handler![
            app_info,
            chat_store_dir,
            chat_store_put,
            chat_store_get,
            chat_store_delete,
            chat_store_list,
            chat_store_info,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            window.set_title("Anycubic Bridge Editor").ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Anycubic Bridge editor");
}
