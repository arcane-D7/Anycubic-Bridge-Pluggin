use blender_bridge::geometry::{execute, GeometryInput, GeometryOperation};

fn cube(offset_x: f64, omit_top: bool) -> GeometryInput {
    let positions = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0,
        1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
    ];
    let mut triangles = vec![
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6,
        3, 0, 4, 3, 4, 7,
    ];
    if omit_top {
        triangles.truncate(30);
    }
    GeometryInput {
        positions,
        indices: triangles,
        transform: [offset_x, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0],
    }
}

fn transformed_cube() -> GeometryInput {
    let mut mesh = cube(0.0, false);
    mesh.transform = [10.0, 2.0, -3.0, 0.0, 0.0, 45.0, 2.0, 1.0, 1.0];
    mesh
}

#[test]
#[ignore = "requires the pinned external Blender installation; run with --ignored"]
fn pinned_blender_repairs_and_executes_real_booleans_on_scratch_meshes() {
    let (repaired, install) = execute(GeometryOperation::Repair, vec![transformed_cube()])
        .expect("pinned Blender must repair the open cube and pass independent validation");
    assert_eq!(install.version.split_whitespace().next(), Some("5.2.2"));
    assert!(repaired.watertight);
    assert!(repaired.triangles.len() >= 12);
    assert!((repaired.volume_mm3 - 1.0).abs() < 1e-6);

    for operation in [
        GeometryOperation::BooleanUnion,
        GeometryOperation::BooleanSubtract,
        GeometryOperation::BooleanIntersect,
    ] {
        let (result, _) = execute(operation.clone(), vec![cube(0.0, false), cube(0.5, false)])
            .expect("pinned Blender must emit independently validated boolean geometry");
        assert!(result.watertight);
        assert!(result.volume_mm3 > 0.0);
        assert_ne!(
            result.triangles.len(),
            12,
            "operation must produce new geometry"
        );
        let expected_volume = match operation {
            GeometryOperation::BooleanUnion => 1.5,
            GeometryOperation::BooleanSubtract | GeometryOperation::BooleanIntersect => 0.5,
            GeometryOperation::Repair => unreachable!(),
        };
        assert!(
            (result.volume_mm3 - expected_volume).abs() < 1e-5,
            "{operation:?}: expected volume {expected_volume}, got {}",
            result.volume_mm3
        );
    }

    let (world_union, _) = execute(
        GeometryOperation::BooleanUnion,
        vec![transformed_cube(), cube(20.0, false)],
    )
    .expect("transformed operands must produce world-baked union geometry");
    assert!((world_union.volume_mm3 - 3.0).abs() < 1e-5);
}
