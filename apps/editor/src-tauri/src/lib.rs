// R0 lib crate — exposes the Tauri Builder facade so check-rust can verify the
// crate compiles and so a future broker-facing command surface has a stable
// home (commands never touch secrets; the broker owns them). S6-001 ships the
// shell only: no commands are registered yet.

use tauri::Manager;

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Anycubic Bridge Editor",
        "r0": true,
        "slicing_modes": ["standard", "nonplanar"],
    })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            window.set_title("Anycubic Bridge Editor").ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Anycubic Bridge editor");
}
