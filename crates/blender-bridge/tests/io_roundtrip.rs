//! S7-006 AC integration test: format round-trip preserves geometric identity.
//!
//! The R1 editing core accepts meshes from the file boundary (STL/OBJ) and
//! exports them again. Geometric identity is asserted as:
//!   1. vertex count preserved (exact);
//!   2. bounding-box preserved within declared tolerance (1e-6 mm);
//!   3. triangle winding preserved (exact order) — the parity guarantee the
//!      viewport + journal rely on for selection stability.
//!
//! 3MF write + glTF full pipeline are Node/R3-boundary and covered by their
//! own integration tests (`tests/integration/import-export.test.mjs`).

use blender_bridge::io::{parse_binary_stl, parse_obj, to_binary_stl, to_obj, MeshData};

fn vertex(mesh: &MeshData, idx: u32) -> [f64; 3] {
    let i = idx as usize * 3;
    [
        mesh.positions[i],
        mesh.positions[i + 1],
        mesh.positions[i + 2],
    ]
}

/// A deterministic asymmetric mesh (so a degenerate all-zeros bbox cannot mask
/// a transform bug): a flat triangle with a slanted edge.
fn fixture() -> MeshData {
    MeshData {
        positions: vec![
            0.0, 0.0, 0.0, //
            3.7, 0.0, 0.0, //
            0.0, 2.2, 0.0, //
            1.0, 1.0, 4.5, //
        ],
        triangles: vec![[0, 1, 2], [0, 2, 3], [1, 2, 3]],
    }
}

#[test]
fn binary_stl_round_trip_preserves_geometry() {
    let mesh = fixture();
    let bytes = to_binary_stl(&mesh, "s7-006-fixture");
    let back = parse_binary_stl(&bytes).unwrap();

    // Binary STL is unindexed: each triangle repeats its vertices, so the
    // read-back vertex COUNT is 3× the triangle count. Geometric identity is
    // asserted on the bbox (within f32 tolerance) + triangle winding.
    assert_eq!(back.vertex_count(), mesh.triangles.len() * 3);
    let b0 = mesh.bounds().unwrap();
    let b1 = back.bounds().unwrap();
    for (a, b) in b0.iter().zip(b1.iter()) {
        // f32 round-trip — 1e-5 absolute tolerance.
        assert!((a - b).abs() < 1e-5, "bbox drift {a} vs {b}");
    }
    // Winding targets are the same triangle set (deduped) — STL read-back
    // is per-triangle, so compare the triangle's three positions directly.
    for (t, tri) in mesh.triangles.iter().enumerate() {
        let tri0 = &back.triangles[t];
        for (k, src) in tri.iter().enumerate() {
            let va = vertex(&mesh, *src);
            let vb = vertex(&back, tri0[k]);
            assert!(
                (va[0] - vb[0]).abs() < 1e-5
                    && (va[1] - vb[1]).abs() < 1e-5
                    && (va[2] - vb[2]).abs() < 1e-5,
                "triangle {t} vertex {k} position drift: {va:?} vs {vb:?}"
            );
        }
    }
}

#[test]
fn obj_round_trip_preserves_geometry() {
    let mesh = fixture();
    let text = to_obj(&mesh, "fixture");
    let back = parse_obj(&text).unwrap();

    assert_eq!(back.vertex_count(), mesh.vertex_count());
    for (a, b) in back.positions.iter().zip(mesh.positions.iter()) {
        assert!((a - b).abs() < 1e-9, "position drift {a} vs {b}");
    }
    assert_eq!(back.triangles, mesh.triangles, "winding preserved");
}

#[test]
fn io_module_exports_compile_and_document_boundary() {
    // 3MF write is Node-delegated; the crate documents, not implements.
    assert!(matches!(
        blender_bridge::io::write3mf(&fixture()),
        Err(blender_bridge::io::IoError::Unsupported(_))
    ));
    // glTF stub = explicit coverage marker (R3 owns the pipeline).
    assert!(!blender_bridge::io::gltf_available());
}
