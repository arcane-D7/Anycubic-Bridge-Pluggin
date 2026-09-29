//! Own planar slice core (S8-002) — standard (planar) mode.
//!
//! A thin, deterministic Rust slice engine: uniform layers, wall loops,
//! infill (grid subset), brim/skirt basic. Extrusion follows §3.3 —
//! `V = ∫A_bead(s)ds` along real 3D path length, `ΔE = V/A_filament` in
//! filament-length mode, `Q = A_bead·v` steady state.
//!
//! Design constraints:
//! - **Standard mode only**: this crate never emits a Z-ramp or non-planar
//!   segment; the independent validator (S8-004) enforces that contract.
//! - **Deterministic**: same input + profile → byte-identical slice metadata
//!   (no `f64` nondeterminism; everything is closed-form with fixed order).
//! - **No machine hardcoding**: build volume comes from the machine profile
//!   (`machine-profile::MachineProfile::build_volume`). Unsupported dialect
//!   → pre-flight rejection.
//! - **License**: pure std + serde/serde_json/thiserror = Apache/MIT direct
//!   use only. No geometry-offset external crate (implemented in `offset.rs`).

pub mod extrusion;
pub mod infill;
pub mod offset;
pub mod slice;

pub use extrusion::{
    extrusion_length_e, extrusion_volume, steady_state_q, Bead, ExtrusionError, FilamentParams,
};
pub use slice::{slice, JobError, Layer, PlanarProfile, SliceMesh, SliceMeta};

/// Contract version of the planar slice metadata (consumed by S8-004 IR).
pub const PLANAR_CORE_VERSION: &str = "1.0";

#[cfg(test)]
mod tests_meta;
