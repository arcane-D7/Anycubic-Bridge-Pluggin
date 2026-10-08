use crate::discovery::{resolve, BlenderInstall, DiscoveryError};
use crate::io::MeshData;
use crate::spawn::{spawn_blender, SpawnError, SpawnOptions};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_VERTICES: usize = 250_000;
const MAX_TRIANGLES: usize = 500_000;
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 128 * 1024 * 1024;
const WORKER_TIMEOUT_MS: u64 = 120_000;
const MAX_COORDINATE_MM: f64 = 1_000_000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryOperation {
    Repair,
    BooleanUnion,
    BooleanSubtract,
    BooleanIntersect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeometryInput {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    #[serde(default)]
    pub transform: [f64; 9],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeometryOutput {
    pub positions: Vec<f64>,
    pub triangles: Vec<[u32; 3]>,
    pub watertight: bool,
    pub volume_mm3: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum GeometryError {
    #[error("Blender unavailable: {0}")]
    Discovery(String),
    #[error("worker failed: {0}")]
    Worker(String),
    #[error("invalid geometry input: {0}")]
    InvalidInput(String),
    #[error("independent geometry validation failed: {0}")]
    InvalidOutput(String),
}

impl From<DiscoveryError> for GeometryError {
    fn from(value: DiscoveryError) -> Self {
        Self::Discovery(value.to_string())
    }
}

impl From<SpawnError> for GeometryError {
    fn from(value: SpawnError) -> Self {
        Self::Worker(value.to_string())
    }
}

/// Run a fixed named operation in the pinned external Blender process.
pub fn execute(
    operation: GeometryOperation,
    inputs: Vec<GeometryInput>,
) -> Result<(GeometryOutput, BlenderInstall), GeometryError> {
    validate_inputs(&operation, &inputs)?;
    let install = resolve(None)?;
    let work = scratch_dir()?;
    let input_path = work.join("input.json");
    let output_path = work.join("output.json");
    let script_path = work.join("worker.py");
    fs::write(&script_path, include_str!("geometry_worker.py"))
        .map_err(|error| GeometryError::Worker(error.to_string()))?;
    let input = serde_json::json!({ "operation": operation, "inputs": inputs });
    let encoded = serde_json::to_vec(&input)
        .map_err(|error| GeometryError::InvalidInput(error.to_string()))?;
    if encoded.len() > MAX_INPUT_BYTES {
        let _ = fs::remove_dir_all(&work);
        return Err(GeometryError::InvalidInput(
            "input byte limit exceeded".to_owned(),
        ));
    }
    fs::write(&input_path, encoded).map_err(|error| GeometryError::Worker(error.to_string()))?;

    let result = run_worker(&install, &work, &script_path, &input_path, &output_path)
        .and_then(|output| {
            validate_output(&output)?;
            Ok(output)
        });
    let _ = fs::remove_dir_all(&work);
    result.map(|output| (output, install))
}

fn run_worker(
    install: &BlenderInstall,
    work: &PathBuf,
    script: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
) -> Result<GeometryOutput, GeometryError> {
    let mut worker = spawn_blender(
        install,
        script,
        &["--", &input.to_string_lossy(), &output.to_string_lossy()],
        &SpawnOptions {
            label: "project-geometry".to_owned(),
            wall_clock_ms: Some(WORKER_TIMEOUT_MS),
            output_cap: Some(64 * 1024),
            cwd: Some(work.clone()),
            heartbeat_timeout_ms: Some(30_000),
            ..SpawnOptions::default()
        },
    )?;
    let exit_code = match worker.finish(WORKER_TIMEOUT_MS) {
        Ok(code) => code,
        Err(error) => {
            return Err(error.into());
        }
    };
    if exit_code != 0 {
        let diagnostic = fs::read(output)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("Blender exited with {exit_code}"));
        return Err(GeometryError::Worker(diagnostic));
    }
    let metadata =
        fs::metadata(output).map_err(|error| GeometryError::Worker(error.to_string()))?;
    if metadata.len() > MAX_OUTPUT_BYTES {
        return Err(GeometryError::Worker(
            "output byte limit exceeded".to_owned(),
        ));
    }
    serde_json::from_slice(
        &fs::read(output).map_err(|error| GeometryError::Worker(error.to_string()))?,
    )
    .map_err(|error| GeometryError::Worker(format!("invalid worker artifact: {error}")))
}

fn scratch_dir() -> Result<PathBuf, GeometryError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| GeometryError::Worker(error.to_string()))?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("project-geometry-{nonce}"));
    fs::create_dir_all(&path).map_err(|error| GeometryError::Worker(error.to_string()))?;
    Ok(path)
}

fn validate_inputs(
    operation: &GeometryOperation,
    inputs: &[GeometryInput],
) -> Result<(), GeometryError> {
    let expected = if matches!(operation, GeometryOperation::Repair) {
        1
    } else {
        2
    };
    if inputs.len() != expected {
        return Err(GeometryError::InvalidInput(
            "wrong operand count".to_owned(),
        ));
    }
    for mesh in inputs {
        if mesh.positions.is_empty()
            || mesh.positions.len() % 3 != 0
            || mesh.positions.len() / 3 > MAX_VERTICES
            || mesh.indices.is_empty()
            || mesh.indices.len() % 3 != 0
            || mesh.indices.len() / 3 > MAX_TRIANGLES
            || mesh
                .positions
                .iter()
                .any(|value| !value.is_finite() || value.abs() > MAX_COORDINATE_MM)
            || mesh
                .indices
                .iter()
                .any(|index| *index as usize >= mesh.positions.len() / 3)
            || mesh
                .transform
                .iter()
                .any(|value| !value.is_finite() || value.abs() > MAX_COORDINATE_MM)
            || mesh.transform[6..].iter().any(|scale| scale.abs() < 1e-9)
        {
            return Err(GeometryError::InvalidInput(
                "mesh bounds or values invalid".to_owned(),
            ));
        }
        if !matches!(operation, GeometryOperation::Repair) {
            validate_closed_input(mesh)?;
        }
    }
    Ok(())
}

fn validate_closed_input(mesh: &GeometryInput) -> Result<(), GeometryError> {
    let mut edges = std::collections::BTreeMap::<(u32, u32), (u32, i64)>::new();
    for triangle in mesh.indices.chunks_exact(3) {
        let [a, b, c] = [triangle[0], triangle[1], triangle[2]];
        if a == b || b == c || a == c {
            return Err(GeometryError::InvalidInput(
                "boolean input has a degenerate triangle".to_owned(),
            ));
        }
        for (left, right) in [(a, b), (b, c), (c, a)] {
            let edge = if left < right {
                (left, right)
            } else {
                (right, left)
            };
            let entry = edges.entry(edge).or_default();
            entry.0 += 1;
            entry.1 += if left < right { 1 } else { -1 };
        }
    }
    if edges
        .values()
        .any(|(count, orientation)| *count != 2 || *orientation != 0)
    {
        return Err(GeometryError::InvalidInput(
            "boolean requires a consistently oriented closed two-manifold input".to_owned(),
        ));
    }
    Ok(())
}

/// Independent edge-incidence, finite-coordinate and non-zero-volume check.
pub fn validate_output(output: &GeometryOutput) -> Result<(), GeometryError> {
    let mesh = MeshData {
        positions: output.positions.clone(),
        triangles: output.triangles.clone(),
    };
    if mesh.positions.is_empty()
        || mesh.positions.len() % 3 != 0
        || mesh.positions.len() / 3 > MAX_VERTICES
        || mesh.triangles.is_empty()
        || mesh.triangles.len() > MAX_TRIANGLES
        || mesh
            .positions
            .iter()
            .any(|value| !value.is_finite() || value.abs() > MAX_COORDINATE_MM)
        || mesh
            .triangles
            .iter()
            .flatten()
            .any(|index| *index as usize >= mesh.positions.len() / 3)
    {
        return Err(GeometryError::InvalidOutput(
            "mesh dimensions or coordinates invalid".to_owned(),
        ));
    }
    let mut edges = std::collections::BTreeMap::<(u32, u32), (u32, i64)>::new();
    let mut signed_volume = 0.0;
    for [a, b, c] in &mesh.triangles {
        if a == b || b == c || a == c {
            return Err(GeometryError::InvalidOutput(
                "degenerate triangle".to_owned(),
            ));
        }
        for (left, right) in [(*a, *b), (*b, *c), (*c, *a)] {
            let edge = if left < right {
                (left, right)
            } else {
                (right, left)
            };
            let entry = edges.entry(edge).or_default();
            entry.0 += 1;
            entry.1 += if left < right { 1 } else { -1 };
        }
        let point = |index: u32| {
            let offset = index as usize * 3;
            [
                mesh.positions[offset],
                mesh.positions[offset + 1],
                mesh.positions[offset + 2],
            ]
        };
        let (pa, pb, pc) = (point(*a), point(*b), point(*c));
        signed_volume += dot(pa, cross(pb, pc)) / 6.0;
    }
    if edges
        .values()
        .any(|(count, orientation)| *count != 2 || *orientation != 0)
    {
        return Err(GeometryError::InvalidOutput(
            "output is not a consistently oriented closed two-manifold".to_owned(),
        ));
    }
    let volume = signed_volume.abs();
    if !volume.is_finite()
        || volume <= 1e-9
        || (volume - output.volume_mm3).abs() > volume.max(1.0) * 1e-5
    {
        return Err(GeometryError::InvalidOutput(format!(
            "volume is zero or inconsistent (independent={volume}, worker={})",
            output.volume_mm3
        )));
    }
    if !output.watertight {
        return Err(GeometryError::InvalidOutput(
            "worker did not report closed geometry".to_owned(),
        ));
    }
    Ok(())
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tetrahedron() -> GeometryOutput {
        GeometryOutput {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            triangles: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            watertight: true,
            volume_mm3: 1.0 / 6.0,
        }
    }

    #[test]
    fn independent_validator_accepts_closed_tetrahedron() {
        assert!(validate_output(&tetrahedron()).is_ok());
    }

    #[test]
    fn independent_validator_rejects_open_surface_even_when_flagged_closed() {
        let mut output = tetrahedron();
        output.triangles.pop();
        assert!(matches!(
            validate_output(&output),
            Err(GeometryError::InvalidOutput(_))
        ));
    }

    #[test]
    fn independent_validator_rejects_inconsistent_face_orientation() {
        let mut output = tetrahedron();
        output.triangles[0].swap(1, 2);
        assert!(matches!(
            validate_output(&output),
            Err(GeometryError::InvalidOutput(_))
        ));
    }

    #[test]
    fn input_limits_and_operand_count_fail_closed() {
        let mesh = GeometryInput {
            positions: vec![0.0, 0.0, 0.0],
            indices: vec![0, 0, 1],
            transform: [0.0; 9],
        };
        assert!(validate_inputs(&GeometryOperation::Repair, &[mesh.clone()]).is_err());
        assert!(validate_inputs(&GeometryOperation::BooleanUnion, &[mesh]).is_err());
    }

    #[test]
    fn oversized_vertex_buffer_is_rejected_before_worker_start() {
        let mesh = GeometryInput {
            positions: vec![0.0; (MAX_VERTICES + 1) * 3],
            indices: vec![0, 1, 2],
            transform: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0],
        };
        assert!(matches!(
            validate_inputs(&GeometryOperation::Repair, &[mesh]),
            Err(GeometryError::InvalidInput(_))
        ));
    }
}
