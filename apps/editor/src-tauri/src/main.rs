// R0 shell binary — delegates to the lib facade (`editor_lib::run`, the single
// builder home). Desktop-only for now (no mobile targets in R0).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    editor_lib::run();
}
