//! Live smoke: resolve the pinned Blender on this machine and print the install.
//!
//! ```text
//! cargo run -p blender-bridge --example resolve
//! ```
//! Prints `Ok(BlenderInstall { exe: ..., kind: ..., version: "5.2.2" })` or the
//! hard error (missing / version mismatch). Validates S7-001 discovery against
//! the real local install (MSIX alias first, then classic, then PATH).

use blender_bridge::discovery;

fn main() {
    match discovery::resolve(None) {
        Ok(install) => {
            println!(
                "BLENDER_OK exe={} kind={:?} version={}",
                install.exe.display(),
                install.kind,
                install.version
            );
        }
        Err(e) => {
            eprintln!("BLENDER_ERROR {e}");
            std::process::exit(1);
        }
    }
}
