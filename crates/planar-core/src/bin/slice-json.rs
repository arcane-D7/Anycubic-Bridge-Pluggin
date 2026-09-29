//! slice-json — S8-002 parity bridge binary.
//!
//! Reads a binary STL mesh + a profile JSON (with machine `build_volume`),
//! runs the planar-core slice engine, and prints the deterministic
//! `SliceMeta` JSON to stdout. This is what `scripts/slices-runner.mjs`
//! invokes to get the own-planar-core candidate summary.
//!
//! STL format: 80-byte header, little-endian u32 triangle count, then per
//! triangle 12 × little-endian f32 (normal + 3 vertices) + u16 attribute.
//!
//! Profile JSON shape (mirrors `PlanarProfile` with `build_volume` lifted
//! out of the serde-skipped machine profile):
//! ```json
//! {
//!   "dialect": "anycubic",
//!   "mode": "standard",
//!   "layer_height_mm": 0.2,
//!   "wall_loops": 2,
//!   "infill_pattern": "Grid",
//!   "infill_density_pct": 15.0,
//!   "brim_mskirt": null,
//!   "nozzle_diameter_mm": 0.4,
//!   "filament": { "diameter_mm": 1.75 },
//!   "build_volume": { "x": 220.0, "y": 220.0, "z": 250.0 }
//! }
//! ```
use std::env;
use std::fs;
use std::io;

use serde::Deserialize;

use planar_core::extrusion::FilamentParams;
use planar_core::slice::{slice, JobMode, PlanarProfile, SliceMesh, Triangle};

#[derive(Debug, Deserialize)]
struct ProfileInput {
    dialect: String,
    #[serde(default = "default_mode")]
    mode: String,
    layer_height_mm: f64,
    #[serde(default = "default_wall_loops")]
    wall_loops: u32,
    #[serde(default = "default_infill_pattern")]
    infill_pattern: String,
    #[serde(default = "default_infill_density")]
    infill_density_pct: f64,
    #[serde(default = "default_shell_layers")]
    top_bottom_layers: u32,
    #[serde(default)]
    brim_mskirt: Option<f64>,
    #[serde(default = "default_line_width")]
    line_width_mm: f64,
    #[serde(default = "default_nozzle")]
    nozzle_diameter_mm: f64,
    #[serde(default = "default_filament")]
    filament: FilamentParams,
    /// Machine build volume, from the machine profile (never hardcoded).
    #[serde(default)]
    build_volume: Option<serde_json::Value>,
}

fn default_mode() -> String {
    "standard".to_string()
}
fn default_wall_loops() -> u32 {
    2
}
fn default_infill_pattern() -> String {
    "Grid".to_string()
}
fn default_infill_density() -> f64 {
    15.0
}
fn default_shell_layers() -> u32 {
    4
}
fn default_line_width() -> f64 {
    0.45
}
fn default_nozzle() -> f64 {
    0.4
}
fn default_filament() -> FilamentParams {
    FilamentParams { diameter_mm: 1.75 }
}

/// Parse a binary STL file. Returns the triangle soup (vertices + normals).
fn parse_binary_stl(bytes: &[u8]) -> io::Result<Vec<Triangle>> {
    if bytes.len() < 84 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "STL too short (no 84-byte header+count)",
        ));
    }
    // Check for the classic ASCII-STL "solid" signature — we support binary only.
    if bytes.starts_with(b"solid") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ASCII STL not supported (binary only)",
        ));
    }
    let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    let expected = 84 + count * 50;
    if bytes.len() < expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("STL truncated: need {expected} bytes, have {}", bytes.len()),
        ));
    }
    let mut tris = Vec::with_capacity(count);
    for i in 0..count {
        let off = 84 + i * 50;
        let b = &bytes[off..off + 50];
        let f32at = |idx: usize| f32::from_le_bytes([b[idx], b[idx + 1], b[idx + 2], b[idx + 3]]);
        // Normal (3) + 3 vertices (9) = 12 floats, then u16 attribute.
        let n = (f32at(0) as f64, f32at(4) as f64, f32at(8) as f64);
        let v = [
            (f32at(12) as f64, f32at(16) as f64, f32at(20) as f64),
            (f32at(24) as f64, f32at(28) as f64, f32at(32) as f64),
            (f32at(36) as f64, f32at(40) as f64, f32at(44) as f64),
        ]
        .map(|(x, y, z)| planar_core::slice::Pt3::new(x, y, z));
        tris.push(Triangle {
            v,
            n: planar_core::slice::Pt3::new(n.0, n.1, n.2),
        });
    }
    Ok(tris)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: slice-json <input.stl> <profile.json>");
        std::process::exit(2);
    }
    let stl_path = &args[1];
    let profile_path = &args[2];

    let stl = match fs::read(stl_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[slice-json] cannot read {stl_path}: {e}");
            std::process::exit(1);
        }
    };
    let triangles = match parse_binary_stl(&stl) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[slice-json] STL parse failed: {e}");
            std::process::exit(1);
        }
    };
    if triangles.is_empty() {
        eprintln!("[slice-json] STL has no triangles");
        std::process::exit(1);
    }
    let mesh = SliceMesh { triangles };

    let profile_raw = match fs::read_to_string(profile_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[slice-json] cannot read {profile_path}: {e}");
            std::process::exit(1);
        }
    };
    let profile: ProfileInput = match serde_json::from_str(&profile_raw) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[slice-json] profile JSON invalid: {e}");
            std::process::exit(1);
        }
    };
    let mode = if profile.mode == "standard" {
        JobMode::Standard
    } else {
        eprintln!("[slice-json] unsupported mode: {}", profile.mode);
        std::process::exit(1);
    };
    let pattern = match profile.infill_pattern.as_str() {
        "Grid" => planar_core::infill::InfillPattern::Grid,
        "GyroidSubset" => planar_core::infill::InfillPattern::GyroidSubset,
        other => {
            eprintln!("[slice-json] unsupported infill pattern: {other}");
            std::process::exit(1);
        }
    };
    let build_volume_mm = profile.build_volume.as_ref().map(|v| {
        let x = v.get("x").and_then(|n| n.as_f64()).unwrap_or(0.0);
        let y = v.get("y").and_then(|n| n.as_f64()).unwrap_or(0.0);
        let z = v.get("z").and_then(|n| n.as_f64()).unwrap_or(0.0);
        machine_profile::Volume { x, y, z }
    });
    let p = PlanarProfile {
        dialect: profile.dialect.clone(),
        mode,
        layer_height_mm: profile.layer_height_mm,
        wall_loops: profile.wall_loops,
        infill_pattern: pattern,
        infill_density_pct: profile.infill_density_pct,
        top_bottom_layers: profile.top_bottom_layers,
        brim_mskirt: profile.brim_mskirt,
        line_width_mm: profile.line_width_mm,
        nozzle_diameter_mm: profile.nozzle_diameter_mm,
        filament: profile.filament,
        build_volume_mm,
    };

    match slice(&mesh, &p) {
        Ok(meta) => {
            let json = match meta.to_json() {
                Ok(j) => j,
                Err(e) => {
                    eprintln!("[slice-json] serialize failed: {e}");
                    std::process::exit(1);
                }
            };
            println!("{json}");
        }
        Err(e) => {
            eprintln!("[slice-json] pre-flight rejected: {e}");
            std::process::exit(1);
        }
    }
}
