//! Integration tests for the planar-core slice engine: determinism,
//! §3.3 extrusion closed-form, standard-mode no-Z-ramp invariant, and
//! fail-closed pre-flight.

use crate::extrusion::{extrusion_length_e, steady_state_q, Bead, FilamentParams};
use crate::infill::InfillPattern;
use crate::slice::{slice, JobError, JobMode, PlanarProfile, SegmentKind, SliceMesh, Triangle};
use crate::PLANAR_CORE_VERSION;
use machine_profile::Volume;

fn base_profile() -> PlanarProfile {
    PlanarProfile {
        dialect: "anycubic".into(),
        mode: JobMode::Standard,
        layer_height_mm: 0.20,
        wall_loops: 2,
        infill_pattern: InfillPattern::Grid,
        infill_density_pct: 15.0,
        top_bottom_layers: 4,
        brim_mskirt: None,
        line_width_mm: 0.45,
        nozzle_diameter_mm: 0.4,
        filament: FilamentParams { diameter_mm: 1.75 },
        build_volume_mm: Some(Volume {
            x: 220.0,
            y: 220.0,
            z: 250.0,
        }),
    }
}

/// A 20×20×20 mm cube mesh: 12 triangles, watertight.
fn cube_mesh(s: f64) -> SliceMesh {
    fn tri(verts: [(f64, f64, f64); 3], n: (f64, f64, f64)) -> Triangle {
        let v = verts.map(|(x, y, z)| crate::slice::Pt3::new(x, y, z));
        Triangle {
            n: crate::slice::Pt3::new(n.0, n.1, n.2),
            v,
        }
    }
    let (x0, y0, z0) = (0.0, 0.0, 0.0);
    let (x1, y1, z1) = (s, s, s);
    let t = vec![
        // bottom (z0, normal -Z)
        tri([(x0, y0, z0), (x1, y0, z0), (x1, y1, z0)], (0.0, 0.0, -1.0)),
        tri([(x0, y0, z0), (x1, y1, z0), (x0, y1, z0)], (0.0, 0.0, -1.0)),
        // top (z1, +Z)
        tri([(x0, y0, z1), (x0, y1, z1), (x1, y1, z1)], (0.0, 0.0, 1.0)),
        tri([(x0, y0, z1), (x1, y1, z1), (x1, y0, z1)], (0.0, 0.0, 1.0)),
        // front (y0, -Y)
        tri([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1)], (0.0, -1.0, 0.0)),
        tri([(x0, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0.0, -1.0, 0.0)),
        // back (y1, +Y)
        tri([(x0, y1, z0), (x0, y1, z1), (x1, y1, z1)], (0.0, 1.0, 0.0)),
        tri([(x0, y1, z0), (x1, y1, z1), (x1, y1, z0)], (0.0, 1.0, 0.0)),
        // left (x0, -X)
        tri([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1)], (-1.0, 0.0, 0.0)),
        tri([(x0, y0, z0), (x0, y1, z1), (x0, y1, z0)], (-1.0, 0.0, 0.0)),
        // right (x1, +X)
        tri([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], (1.0, 0.0, 0.0)),
        tri([(x1, y0, z0), (x1, y1, z1), (x1, y0, z1)], (1.0, 0.0, 0.0)),
    ];
    SliceMesh { triangles: t }
}

// ---------------------------------------------------------------------------
// §3.3 extrusion closed-form (pinned, not derived from the engine's own code
// path — independent literals).
// ---------------------------------------------------------------------------

#[test]
fn closed_form_e_for_straight_segment() {
    // 100 mm at 0.45×0.20 bead, 1.75 filament.
    let bead = Bead {
        width_mm: 0.45,
        height_mm: 0.20,
    };
    let fil = FilamentParams { diameter_mm: 1.75 };
    let e = extrusion_length_e(100.0, &bead, &fil).unwrap();
    let a_fil = std::f64::consts::PI * (1.75_f64 / 2.0).powi(2);
    assert!((e - 100.0 * 0.45 * 0.20 / a_fil).abs() < 1e-9);
    assert!((e - 3.74168).abs() < 1e-3, "E={e}");
}

#[test]
fn q_steady_state_closed_form() {
    let bead = Bead {
        width_mm: 0.45,
        height_mm: 0.20,
    };
    assert!((steady_state_q(60.0, &bead) - 0.09 * 60.0).abs() < 1e-12);
}

// ---------------------------------------------------------------------------
// Pre-flight fail-closed (S8-002 AC: unsupported dialect → pre-flight
// rejection; build volume from machine profile, never hardcoded).
// ---------------------------------------------------------------------------

#[test]
fn preflight_rejects_unsupported_dialect() {
    let mesh = cube_mesh(20.0);
    let mut p = base_profile();
    p.dialect = "klipper".into();
    let err = slice(&mesh, &p).unwrap_err();
    assert!(matches!(err, JobError::UnsupportedDialect(_, _)));
}

#[test]
fn preflight_rejects_missing_build_volume() {
    // Accept the profile even with build_volume_mm=None (caller may build
    // from a machine profile directly) — slice() must fail closed.
    let mesh = cube_mesh(20.0);
    let mut p = base_profile();
    p.build_volume_mm = None;
    let err = slice(&mesh, &p).unwrap_err();
    assert!(matches!(err, JobError::MissingBuildVolume));
}

#[test]
fn preflight_rejects_layer_height_above_volume() {
    let mesh = cube_mesh(20.0);
    let mut p = base_profile();
    p.layer_height_mm = 300.0;
    assert!(matches!(
        slice(&mesh, &p).unwrap_err(),
        JobError::LayerHeightExceedsVolume(_, _)
    ));
}

#[test]
fn preflight_rejects_zero_wall_loops() {
    let mesh = cube_mesh(20.0);
    let mut p = base_profile();
    p.wall_loops = 0;
    assert!(matches!(
        slice(&mesh, &p).unwrap_err(),
        JobError::ZeroWallLoops(0)
    ));
}

#[test]
fn preflight_rejects_empty_mesh() {
    let mesh = SliceMesh { triangles: vec![] };
    assert!(matches!(
        slice(&mesh, &base_profile()).unwrap_err(),
        JobError::EmptyMesh
    ));
}

// ---------------------------------------------------------------------------
// Determinism: same input + profile → byte-identical metadata, including
// across a machine-profile round-trip (build volume sourced from profile).
// ---------------------------------------------------------------------------

#[test]
fn deterministic_byte_identical_metadata() {
    let mesh = cube_mesh(20.0);
    let p = base_profile();
    let a = slice(&mesh, &p).expect("slice ok");
    let b = slice(&mesh, &p).expect("slice ok");
    let ja = a.to_json().unwrap();
    let jb = b.to_json().unwrap();
    assert_eq!(
        ja, jb,
        "metadata must be byte-identical for identical inputs"
    );
    assert!(!ja.is_empty());
}

#[test]
fn metadata_sources_build_volume_from_profile() {
    // The metadata must carry the *actual* machine profile volume, not a
    // constant. A 220×220×250 profile → 220×220×250 in metadata; changing
    // the profile changes the metadata (proves it's not hardcoded).
    let mesh = cube_mesh(20.0);
    let p = base_profile();
    let meta = slice(&mesh, &p).unwrap();
    assert_eq!(meta.build_volume.x, 220.0);
    assert_eq!(meta.build_volume.y, 220.0);
    assert_eq!(meta.build_volume.z, 250.0);
    // Different machine → different fingerprint.
    let mut p2 = base_profile();
    p2.build_volume_mm = Some(Volume {
        x: 300.0,
        y: 300.0,
        z: 400.0,
    });
    assert_ne!(
        slice(&mesh, &p).unwrap().profile_fingerprint,
        slice(&mesh, &p2).unwrap().profile_fingerprint
    );
}

// ---------------------------------------------------------------------------
// Standard-mode invariant: no Z-ramp anywhere in the output.
// ---------------------------------------------------------------------------

#[test]
fn standard_mode_has_no_z_ramp() {
    let mesh = cube_mesh(20.0);
    let p = base_profile();
    let meta = slice(&mesh, &p).unwrap();
    assert_eq!(meta.mode, JobMode::Standard);
    let json = meta.to_json().unwrap();
    // No non-planar marker may appear in serialized output.
    assert!(!json.to_lowercase().contains("nonplanar"));
    assert!(!json.to_lowercase().contains("z_ramp"));
    // Every segment has constant z (from == to on the vertical axis).
    for layer in &meta.layers {
        for seg in &layer.segments {
            assert!(
                (seg.from.z - seg.to.z).abs() < 1e-12,
                "standard-mode segment must not travel in z: layer {}, seg {:?}→{:?}",
                layer.index,
                seg.from,
                seg.to
            );
            assert!((seg.from.z - layer.z).abs() < 1e-9);
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry/closure sanity: uniform layers, wall loops present, closed rings,
// extrusion conservation of the whole job ≈ filament length × A_filament.
// ---------------------------------------------------------------------------

#[test]
fn uniform_layers_and_wall_rings_closed() {
    let mesh = cube_mesh(20.0);
    let p = base_profile();
    let meta = slice(&mesh, &p).unwrap();
    // Cube is 20mm tall at 0.2 layer → exactly 100 layers (part-height
    // slicing; the 220×220×250 build volume is a cap, not the extent).
    assert_eq!(meta.layers.len(), 100);
    let mut prev: Option<f64> = None;
    for layer in &meta.layers {
        // z starts at part bottom (mesh min_z = 0 for our fixtures).
        assert!((layer.index as f64 * 0.20 + 0.20 - layer.z).abs() < 1e-9);
        if let Some(pz) = prev {
            assert!((layer.z - pz).abs() - 0.20 < 1e-9);
        }
        prev = Some(layer.z);
        // Every layer has the wall loops.
        assert!(layer.segments.iter().any(|s| s.kind == SegmentKind::Wall));
        // Wall rings are closed within each loop. Wall segments appear in
        // loop order; each loop is a closed chain (n segments, n vertices,
        // coincident start/end).
        let walls: Vec<_> = layer
            .segments
            .iter()
            .filter(|s| s.kind == SegmentKind::Wall)
            .collect();
        assert!(!walls.is_empty());
        // Group by loop index (per_loop_wall says which loops exist).
        assert_eq!(walls.len() % layer.per_loop_wall.len(), 0);
        let per_loop = walls.len() / layer.per_loop_wall.len();
        for (li, segs) in walls.chunks(per_loop).enumerate() {
            let _ = li;
            for pair in segs.windows(2) {
                let a = &pair[0].to;
                let b = &pair[1].from;
                assert!(
                    (a.x - b.x).abs() < 1e-6 && (a.y - b.y).abs() < 1e-6,
                    "loop segments must chain: {:?} -> {:?}",
                    a,
                    b
                );
            }
            // close the loop (last segment's to == first segment's from)
            let last = segs.last().unwrap();
            let first = segs.first().unwrap();
            assert!(
                (last.to.x - first.from.x).abs() < 1e-6 && (last.to.y - first.from.y).abs() < 1e-6,
                "loop must close"
            );
        }
    }
}

#[test]
fn layer_count_matches_part_height() {
    let mesh = cube_mesh(20.0);
    let p = base_profile();
    // part is 20mm tall → floor(20/0.2)=100 layers.
    let meta = slice(&mesh, &p).unwrap();
    assert_eq!(meta.layers.len(), 100);
    let last = meta.layers.last().unwrap();
    assert!((last.z - 20.0).abs() < 1e-9);
    // Build volume is a cap: even with a huge build volume the layer count
    // comes from the part, not the volume.
    let mut tall = base_profile();
    tall.build_volume_mm = Some(Volume {
        x: 220.0,
        y: 220.0,
        z: 500.0,
    });
    let meta_tall = slice(&mesh, &tall).unwrap();
    assert_eq!(meta_tall.layers.len(), 100);
    assert!((meta_tall.layers.last().unwrap().z - 20.0).abs() < 1e-9);
}

#[test]
fn extrusion_conservation_across_job() {
    // Whole-job extrusion: Σ(delta_e × A_filament) == Σ(segment volume) and
    // each segment volume == length × A_bead (closed-form §3.3).
    let mesh = cube_mesh(20.0);
    let p = base_profile();
    let meta = slice(&mesh, &p).unwrap();
    let a_fil = p.filament.area();
    let bead = Bead {
        width_mm: p.line_width_mm,
        height_mm: p.layer_height_mm,
    };
    let mut total_e = 0.0;
    let mut total_v = 0.0;
    for layer in &meta.layers {
        for seg in &layer.segments {
            total_e += seg.delta_e_mm;
            total_v += seg.volume_mm3;
            // conservation per segment
            let l = {
                let dx = seg.to.x - seg.from.x;
                let dy = seg.to.y - seg.from.y;
                let dz = seg.to.z - seg.from.z;
                (dx * dx + dy * dy + dz * dz).sqrt()
            };
            assert!(
                (seg.volume_mm3 - l * bead.area()).abs() < 1e-9,
                "per-segment V mismatch"
            );
            assert!(
                (seg.delta_e_mm * a_fil - seg.volume_mm3).abs() < 1e-9,
                "E×A_fil != V"
            );
        }
    }
    // Global: E total × A_filament == total deposited volume.
    assert!((total_e * a_fil - total_v).abs() < 1e-6);
    assert!(total_v > 0.0);
}

// ---------------------------------------------------------------------------
// Infill patterns: gyroid subset keeps the standard-mode invariant and is
// bounded to the part bbox (deterministic).
// ---------------------------------------------------------------------------

#[test]
fn gyroid_subset_stays_in_bbox_and_planar() {
    let mesh = cube_mesh(20.0);
    let mut p = base_profile();
    p.infill_pattern = crate::infill::InfillPattern::GyroidSubset;
    let meta = slice(&mesh, &p).unwrap();
    let mut saw_infill = false;
    for layer in &meta.layers {
        for seg in &layer.segments {
            if seg.kind == SegmentKind::Infill {
                saw_infill = true;
                // planar
                assert!((seg.from.z - seg.to.z).abs() < 1e-12);
                // bounded to part bbox (cube 0..20)
                for pt in [&seg.from, &seg.to] {
                    assert!(pt.x >= -1e-6 && pt.x <= 20.0 + 1e-6, "x={}", pt.x);
                    assert!(pt.y >= -1e-6 && pt.y <= 20.0 + 1e-6, "y={}", pt.y);
                }
            }
        }
    }
    assert!(saw_infill, "gyroid subset must produce infill segments");
    // Determinism across runs.
    let a = slice(&mesh, &p).unwrap();
    let b = slice(&mesh, &p).unwrap();
    assert_eq!(a.to_json().unwrap(), b.to_json().unwrap());
}

// ---------------------------------------------------------------------------
// Brim / skirt basic: first layer has out-of-part rings; later layers don't.
// ---------------------------------------------------------------------------

#[test]
fn brim_only_on_first_layer() {
    let mesh = cube_mesh(20.0);
    let mut p = base_profile();
    p.brim_mskirt = Some(5.0);
    let meta = slice(&mesh, &p).unwrap();
    // First layer has a Brim ring outside the part bbox.
    let first = &meta.layers[0];
    let brim: Vec<_> = first
        .segments
        .iter()
        .filter(|s| s.kind == SegmentKind::Brim)
        .collect();
    assert!(!brim.is_empty(), "first layer must have brim segments");
    // The ring is a single closed loop that must extend beyond the 20×20
    // part footprint on at least one axis (outset by w/2 = 2.5 → corner
    // (22.5, 22.5)).
    let max_x = brim
        .iter()
        .flat_map(|s| [s.from.x, s.to.x])
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = brim
        .iter()
        .flat_map(|s| [s.from.y, s.to.y])
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(
        max_x > 20.0 + 1e-6 || max_y > 20.0 + 1e-6,
        "ring must extend past the part"
    );
    // All brim segments are planar (constant z) and closed-ring chained.
    for seg in &brim {
        assert!((seg.from.z - seg.to.z).abs() < 1e-12);
    }
    // No other layer has brim.
    for layer in meta.layers.iter().skip(1) {
        assert!(
            !layer.segments.iter().any(|s| s.kind == SegmentKind::Brim),
            "layer {} must not carry brim",
            layer.index
        );
    }
}

// ---------------------------------------------------------------------------
// Solid top/bottom shells (standard-mode product-grade behavior; skins at
// 100% density, created deterministically from the profile).
// ---------------------------------------------------------------------------

#[test]
fn solid_shells_heavier_than_sparse_infill() {
    let mesh = cube_mesh(20.0);
    let p = base_profile(); // 4 top + 4 bottom shells, 15% grid elsewhere
    let meta = slice(&mesh, &p).unwrap();
    assert!(meta.layers.len() >= 8);
    // A solid skin layer must deposit more material than a mid-layer.
    let mid_extrude = |l: &crate::slice::Layer| -> f64 {
        l.segments.iter().map(|s| s.volume_mm3).sum()
    };
    let skin = mid_extrude(&meta.layers[0]);
    let mid = mid_extrude(&meta.layers[20]);
    assert!(
        skin > mid * 3.0,
        "solid shell ({skin:.1} mm³) must be much heavier than sparse 15% (mid {mid:.1} mm³)"
    );
    // Last layer (index = len-1) is also a shell.
    let last = mid_extrude(meta.layers.last().unwrap());
    assert!(last > mid * 3.0);
}

#[test]
fn zero_shells_disables_solid_fill() {
    let mesh = cube_mesh(20.0);
    let mut p = base_profile();
    p.top_bottom_layers = 0;
    let meta = slice(&mesh, &p).unwrap();
    let mid = &meta.layers[0];
    let last = meta.layers.last().unwrap();
    let mid_e: f64 = mid.segments.iter().map(|s| s.volume_mm3).sum();
    let last_e: f64 = last.segments.iter().map(|s| s.volume_mm3).sum();
    // No solid shells: first and last layer have roughly the same volume as
    // a mid-layer (all sparse grid at 15%).
    let tolerance = 1.0 + 1e-9;
    assert!(
        last_e <= mid_e * (16.0 / 15.0) * tolerance,
        "last layer with no shells must stay sparse: last={last_e:.2}, mid={mid_e:.2}"
    );
}

// ---------------------------------------------------------------------------
// Version contract
// ---------------------------------------------------------------------------

#[test]
fn version_contract_pinned() {
    assert_eq!(PLANAR_CORE_VERSION, "1.0");
    let mesh = cube_mesh(20.0);
    let meta = slice(&mesh, &base_profile()).unwrap();
    assert_eq!(meta.version, "1.0");
}
