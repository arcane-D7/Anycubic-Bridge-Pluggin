// R0 lib crate — exposes the Tauri Builder facade so check-rust can verify the
// crate compiles and so a future broker-facing command surface has a stable
// home (commands never touch secrets; the broker owns them). S6-001 ships the
// shell only: no commands are registered yet.
//
// S9.6-007 — Broker chat-store persistence lane: the shell exposes thin
// `#[tauri::command]` wrappers over `broker::chat_store::ChatStore`. The
// cmd surface is the ONLY wiring the webview uses (no direct fs from the
// React side); the Rust side owns env-resolved path + atomic writes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use blender_bridge::geometry::{execute, GeometryInput, GeometryOperation, GeometryOutput};
use blender_bridge::spawn::transport_for;
use blender_bridge::BlenderInstall;
use broker::chat_store::ChatStore;
use broker::DbHandle;
use planar_core::extrusion::FilamentParams;
use planar_core::infill::InfillPattern;
use planar_core::slice::{slice_with_progress, JobMode, PlanarProfile, Pt3, SliceMesh, Triangle};
use project_store::{
    AuthorityError, ProjectAuthority, ProjectDocument, ProjectOperation, ProjectSnapshot,
    ProjectSummary, ReprintDestination, ReprintDestinationProvider, ReprintIntentResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

// S9.18-003 continuation slice — typed Tauri approval bridge (device control).
// Backend-managed compound authority: separate `auth.db` + the same
// `workspace.db` the project store owns, with a trusted-resolver gate.
mod device_control;
use device_control::{
    device_control_approve, device_control_availability, device_control_dispatch,
    device_control_preflight,
};

/// Managed handle to the shared chat store (single-writer, like the DB).
struct ChatStoreState(Mutex<ChatStore>);

struct ProjectAuthorityState(Mutex<Result<ProjectAuthority, String>>);

struct GeometryWorkerState(Mutex<()>);

struct SliceJobsState(Mutex<HashMap<String, Arc<SliceJobControl>>>);

struct SliceJobControl {
    cancelled: AtomicBool,
    publication: Mutex<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SliceJobRequest {
    job_id: String,
    expected_revision: u64,
    slicing_mode: String,
    coordinate_frame: String,
    editor_to_slice_frame: SliceFrame,
    plate_id: String,
    profile_id: String,
    profile_version: String,
    build_volume_x_mm: f64,
    build_volume_y_mm: f64,
    build_volume_z_mm: f64,
    dialect: String,
    layer_height_mm: f64,
    line_width_mm: f64,
    nozzle_diameter_mm: f64,
    wall_loops: u32,
    top_bottom_layers: u32,
    infill_density_pct: f64,
    infill_pattern: String,
    brim_width_mm: f64,
    filament_diameter_mm: f64,
    material_id: String,
    material_type: String,
    nozzle_temperature_c: f64,
    bed_temperature_c: f64,
    fan_pct: f64,
    print_speed_mm_s: f64,
    travel_speed_mm_s: f64,
    supports: bool,
    target_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SliceFrame {
    origin_mm: [f64; 3],
    x_axis: [f64; 3],
    y_axis: [f64; 3],
    z_axis: [f64; 3],
}

#[derive(Debug, Serialize)]
struct SliceJobReply {
    job_id: String,
    status: String,
    compatibility: String,
    source_revision: u64,
    target_ids: Vec<String>,
    input_digest: String,
    artifact_id: String,
    layer_count: usize,
    segment_count: usize,
    stats: SliceJobStats,
    ir: serde_json::Value,
    program: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SliceJobStats {
    layers: usize,
    estimated_minutes: u32,
    material_grams: Option<f64>,
    volume_mm3: f64,
    per_object_mm3: HashMap<String, f64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedObject {
    name: Option<String>,
    vertices: Option<u64>,
    triangles: Option<u64>,
    bounds: Option<serde_json::Value>,
    #[serde(rename = "sizeMm")]
    size_mm: Option<serde_json::Value>,
    #[serde(rename = "volumeMm3")]
    volume_mm3: Option<f64>,
    #[serde(rename = "surfaceAreaMm2")]
    surface_area_mm2: Option<f64>,
    watertight: Option<bool>,
    #[serde(rename = "objectId")]
    object_id: Option<String>,
    #[serde(rename = "plateId")]
    plate_id: Option<String>,
    visible: Option<bool>,
    locked: Option<bool>,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    #[serde(rename = "filamentId")]
    filament_id: Option<String>,
    #[serde(rename = "materialBinding")]
    material_binding: Option<serde_json::Value>,
    #[serde(rename = "geometrySpace")]
    geometry_space: Option<String>,
    #[serde(rename = "artifactSha256")]
    artifact_sha256: Option<String>,
    provenance: Option<String>,
    #[serde(rename = "printSettings")]
    print_settings: Option<serde_json::Value>,
    geometry: Option<PersistedGeometry>,
    transform: Option<PersistedTransform>,
    #[serde(flatten)]
    unknown_fields: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedGeometry {
    positions: Vec<f64>,
    normals: Option<Vec<f64>>,
    indices: Vec<u32>,
    #[serde(flatten)]
    unknown_fields: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct PersistedTransform {
    x: f64,
    y: f64,
    z: f64,
    rx: f64,
    ry: f64,
    rz: f64,
    sx: f64,
    sy: f64,
    sz: f64,
    #[serde(flatten)]
    unknown_fields: HashMap<String, serde_json::Value>,
}

impl Default for PersistedTransform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            rx: 0.0,
            ry: 0.0,
            rz: 0.0,
            sx: 1.0,
            sy: 1.0,
            sz: 1.0,
            unknown_fields: HashMap::new(),
        }
    }
}

#[tauri::command]
fn slice_job_run(
    state: State<'_, ProjectAuthorityState>,
    jobs: State<'_, SliceJobsState>,
    request: SliceJobRequest,
) -> Result<SliceJobReply, String> {
    validate_slice_request(&request)?;
    let captured = {
        let authority_guard = state.0.lock().map_err(|error| error.to_string())?;
        authority_guard
            .as_ref()
            .map_err(Clone::clone)?
            .snapshot()
            .map_err(|error| error.to_string())?
    };
    if captured.revision != request.expected_revision {
        return Err(format!(
            "stale slice capture: expected revision {}, actual {}",
            request.expected_revision, captured.revision
        ));
    }
    if request.target_ids.is_empty() {
        return Err("slice preflight: no target object IDs were captured".into());
    }
    if request.material_id.trim().is_empty() {
        return Err("slice preflight: project material ID is missing".into());
    }
    if request.material_type.trim().is_empty() {
        return Err("slice preflight: selected material type is missing".into());
    }
    let targets = capture_meshes(&captured, &request)?;
    let target_ids = targets.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let input_digest = slice_input_digest(captured.revision, &request, &targets, &target_ids)?;
    if request.job_id.trim().is_empty() {
        return Err("slice preflight: opaque job ID is required".into());
    }
    if !matches!(
        request.material_type.as_str(),
        "PLA" | "PETG" | "ABS" | "ASA" | "TPU"
    ) {
        return Err(format!(
            "unsupported material type: {}",
            request.material_type
        ));
    }
    let job_id = request.job_id.clone();

    let cached = {
        let authority_guard = state.0.lock().map_err(|error| error.to_string())?;
        authority_guard
            .as_ref()
            .map_err(Clone::clone)?
            .cached_slice_job(captured.revision, &input_digest)
            .map_err(|error| error.to_string())?
    };
    if let Some(record) = cached {
        if record
            .get("artifact_id")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            let artifact_bytes = {
                let authority_guard = state.0.lock().map_err(|error| error.to_string())?;
                authority_guard
                    .as_ref()
                    .map_err(Clone::clone)?
                    .get_artifact(record["artifact_id"].as_str().unwrap_or_default())
                    .map_err(|error| error.to_string())?
            };
            if let Some(bytes) = artifact_bytes {
                let artifact: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("cached slice artifact is invalid: {error}"))?;
                if artifact["source_revision"].as_u64() != Some(captured.revision)
                    || artifact["input_digest"].as_str() != Some(input_digest.as_str())
                    || artifact["target_ids"] != serde_json::json!(target_ids)
                    || artifact["provider"].as_str() != Some("planar-core-section-v2")
                {
                    return Err(
                        "cached slice artifact provenance does not match this capture".into(),
                    );
                }
                let ir = artifact
                    .get("ir")
                    .cloned()
                    .ok_or("cached artifact has no IR")?;
                let program = artifact
                    .get("program")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("cached artifact has no emitted program")?
                    .to_owned();
                let stats = serde_json::from_value(artifact["stats"].clone())
                    .map_err(|error| format!("cached stats are invalid: {error}"))?;
                let cache_record = serde_json::json!({
                    "job_id": job_id,
                    "status": "ready",
                    "source_revision": captured.revision,
                    "target_ids": target_ids,
                    "input_digest": input_digest,
                    "artifact_id": record["artifact_id"],
                });
                {
                    let authority_guard = state.0.lock().map_err(|error| error.to_string())?;
                    authority_guard
                        .as_ref()
                        .map_err(Clone::clone)?
                        .put_slice_job(
                            &job_id,
                            captured.revision,
                            &input_digest,
                            "ready",
                            &cache_record,
                        )
                        .map_err(|error| error.to_string())?;
                }
                return Ok(SliceJobReply {
                    job_id,
                    status: "ready".into(),
                    compatibility: "preview-only".into(),
                    source_revision: captured.revision,
                    target_ids,
                    input_digest,
                    artifact_id: record["artifact_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    layer_count: artifact["layer_count"]
                        .as_u64()
                        .ok_or("cached artifact has no layer count")?
                        as usize,
                    segment_count: ir["segments"].as_array().map_or(0, Vec::len),
                    stats,
                    ir,
                    program,
                });
            }
        }
    }

    let control = Arc::new(SliceJobControl {
        cancelled: AtomicBool::new(false),
        publication: Mutex::new(false),
    });
    jobs.0
        .lock()
        .map_err(|error| error.to_string())?
        .insert(job_id.clone(), Arc::clone(&control));
    let result = run_slice_job(
        &state,
        &request,
        targets,
        &target_ids,
        &input_digest,
        &job_id,
        &control,
    );
    jobs.0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&job_id);
    result
}

#[tauri::command]
fn slice_job_cancel(jobs: State<'_, SliceJobsState>, job_id: String) -> Result<bool, String> {
    let jobs = jobs.0.lock().map_err(|error| error.to_string())?;
    let Some(control) = jobs.get(&job_id) else {
        return Ok(false);
    };
    let published = control
        .publication
        .lock()
        .map_err(|error| error.to_string())?;
    if *published {
        return Ok(false);
    }
    control.cancelled.store(true, Ordering::SeqCst);
    Ok(true)
}

fn capture_meshes(
    snapshot: &ProjectSnapshot,
    request: &SliceJobRequest,
) -> Result<Vec<(String, PersistedObject)>, String> {
    let mut targets = Vec::new();
    for value in &snapshot.project.objects {
        let object: PersistedObject = serde_json::from_value(value.clone())
            .map_err(|error| format!("slice preflight: invalid project object: {error}"))?;
        let on_plate = object.plate_id.as_deref().unwrap_or("plate-1") == request.plate_id;
        let visible = object.visible.unwrap_or(true);
        if !on_plate || !visible {
            continue;
        }
        let id = object
            .object_id
            .clone()
            .ok_or("slice preflight: target object is missing a stable project ID")?;
        if !request.target_ids.contains(&id) {
            return Err(format!(
                "slice capture mismatch: target {id} was not captured by the caller"
            ));
        }
        if object.parent_id.is_some() {
            return Err(format!(
                "unsupported geometry: object {id} has an unevaluated parent transform"
            ));
        }
        if object.print_settings.is_some() {
            return Err(format!(
                "unsupported feature: object {id} has per-object print settings"
            ));
        }
        if object
            .transform
            .as_ref()
            .is_some_and(|transform| !transform.unknown_fields.is_empty())
        {
            return Err(format!("unsupported transform fields on object {id}"));
        }
        if object
            .filament_id
            .as_deref()
            .is_some_and(|id| id != request.material_id)
        {
            return Err(format!(
                "unsupported material mix: object {id} is assigned to another project material"
            ));
        }
        if object.material_binding.is_some() {
            return Err(format!(
                "unsupported feature: object {id} has a physical tool/slot binding"
            ));
        }
        if !object.unknown_fields.is_empty() {
            let fields = object
                .unknown_fields
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "unsupported project object fields on {id}: {fields}"
            ));
        }
        if let Some(geometry) = &object.geometry {
            if !geometry.unknown_fields.is_empty() {
                return Err(format!("unsupported geometry fields on object {id}"));
            }
            if geometry.positions.len() % 3 != 0 || geometry.indices.len() % 3 != 0 {
                return Err(format!(
                    "slice preflight: object {id} has malformed indexed geometry"
                ));
            }
            targets.push((id, object));
        } else {
            return Err(format!(
                "slice preflight: object {id} has no evaluated mesh geometry"
            ));
        }
    }
    targets.sort_by(|left, right| left.0.cmp(&right.0));
    let mut requested = request.target_ids.clone();
    requested.sort();
    requested.dedup();
    let actual = targets.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    if actual != requested {
        return Err(format!(
            "slice capture mismatch: captured target IDs do not match plate {} ({} requested, {} current)",
            request.plate_id,
            requested.len(),
            actual.len()
        ));
    }
    Ok(targets)
}

fn run_slice_job(
    authority_state: &ProjectAuthorityState,
    request: &SliceJobRequest,
    targets: Vec<(String, PersistedObject)>,
    target_ids: &[String],
    input_digest: &str,
    job_id: &str,
    control: &SliceJobControl,
) -> Result<SliceJobReply, String> {
    let mut triangles = Vec::new();
    for (object_id, object) in &targets {
        let geometry = object
            .geometry
            .as_ref()
            .ok_or("captured mesh geometry disappeared")?;
        let transform = object.transform.as_ref().cloned().unwrap_or_default();
        if [
            transform.x,
            transform.y,
            transform.z,
            transform.rx,
            transform.ry,
            transform.rz,
            transform.sx,
            transform.sy,
            transform.sz,
        ]
        .iter()
        .any(|value| !value.is_finite())
        {
            return Err(format!(
                "slice preflight: object {object_id} has a non-finite transform"
            ));
        }
        if transform.sx == 0.0 || transform.sy == 0.0 || transform.sz == 0.0 {
            return Err(format!(
                "slice preflight: object {object_id} has zero scale"
            ));
        }
        match object.geometry_space.as_deref() {
            None | Some("object-local") | Some("editor-world") => {}
            Some(space) => {
                return Err(format!(
                    "unsupported geometry coordinate space `{space}` on object {object_id}"
                ));
            }
        }
        let (position_chunks, _) = geometry.positions.as_chunks::<3>();
        let points = position_chunks
            .iter()
            .map(|point| {
                editor_local_to_slice_ir(point, &transform, &request.editor_to_slice_frame)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (triangle_indices, _) = geometry.indices.as_chunks::<3>();
        for [a_index, b_index, c_index] in triangle_indices {
            let a = *points.get(*a_index as usize).ok_or_else(|| {
                format!("slice preflight: object {object_id} index is out of range")
            })?;
            let b = *points.get(*b_index as usize).ok_or_else(|| {
                format!("slice preflight: object {object_id} index is out of range")
            })?;
            let c = *points.get(*c_index as usize).ok_or_else(|| {
                format!("slice preflight: object {object_id} index is out of range")
            })?;
            let n = cross(subtract(b, a), subtract(c, a));
            triangles.push(Triangle { v: [a, b, c], n });
        }
    }
    if triangles.is_empty() {
        return Err("slice preflight: captured geometry has no triangles".into());
    }
    let mesh = SliceMesh { triangles };
    planar_core::slice::validate_watertight_mesh(&mesh)
        .map_err(|error| format!("slice preflight: mesh topology rejected: {error}"))?;
    let pattern = match request.infill_pattern.as_str() {
        "Grid" => InfillPattern::Grid,
        "GyroidSubset" => InfillPattern::GyroidSubset,
        other => return Err(format!("unsupported infill pattern: {other}")),
    };
    let profile = PlanarProfile {
        dialect: request.dialect.clone(),
        mode: JobMode::Standard,
        layer_height_mm: request.layer_height_mm,
        wall_loops: request.wall_loops,
        infill_pattern: pattern,
        infill_density_pct: request.infill_density_pct,
        top_bottom_layers: request.top_bottom_layers,
        brim_mskirt: (request.brim_width_mm > 0.0).then_some(request.brim_width_mm),
        line_width_mm: request.line_width_mm,
        nozzle_diameter_mm: request.nozzle_diameter_mm,
        filament: FilamentParams {
            diameter_mm: request.filament_diameter_mm,
        },
        build_volume_mm: Some(machine_profile::Volume {
            x: request.build_volume_x_mm,
            y: request.build_volume_y_mm,
            z: request.build_volume_z_mm,
        }),
    };
    validate_slice_request(request)?;
    let meta = slice_with_progress(
        &mesh,
        &profile,
        || control.cancelled.load(Ordering::SeqCst),
        |_, _| {},
    )
    .map_err(|error| error.to_string())?;
    if control.cancelled.load(Ordering::SeqCst) {
        return Err("slice job cancelled".into());
    }
    let ir = build_ir(&meta, &profile, request, target_ids)?;
    let program = emit_and_validate_program(&meta, &profile)?;
    let ir_segments = ir["segments"]
        .as_array()
        .ok_or("generated IR has no segments")?;
    if ir_segments.is_empty() {
        return Err("independent output validation: slice produced no toolpath segments".into());
    }
    let mut publication = control
        .publication
        .lock()
        .map_err(|error| error.to_string())?;
    if control.cancelled.load(Ordering::SeqCst) {
        return Err("slice job cancelled before publication".into());
    }
    let authority_guard = authority_state
        .0
        .lock()
        .map_err(|error| error.to_string())?;
    let authority = authority_guard.as_ref().map_err(Clone::clone)?;
    let project_now = authority.snapshot().map_err(|error| error.to_string())?;
    if project_now.revision != request.expected_revision {
        return Err(format!(
            "slice output stale: captured revision {}, current revision {}",
            request.expected_revision, project_now.revision
        ));
    }
    let artifact = serde_json::json!({
        "schema_version": 1,
        "source_revision": request.expected_revision,
        "target_ids": target_ids,
        "input_digest": input_digest,
        "provider": "planar-core-section-v2",
        "layer_count": meta.layers.len(),
        "ir": ir,
        "program": program,
        "stats": slice_stats(&meta),
    });
    let bytes = serde_json::to_vec(&artifact).map_err(|error| error.to_string())?;
    let artifact_id = authority
        .put_artifact(&bytes)
        .map_err(|error| error.to_string())?;
    let record = serde_json::json!({
        "job_id": job_id,
        "status": "ready",
        "source_revision": request.expected_revision,
        "target_ids": target_ids,
        "input_digest": input_digest,
        "artifact_id": artifact_id,
    });
    authority
        .put_slice_job(
            job_id,
            request.expected_revision,
            input_digest,
            "ready",
            &record,
        )
        .map_err(|error| error.to_string())?;
    *publication = true;
    Ok(SliceJobReply {
        job_id: job_id.to_owned(),
        status: "ready".into(),
        compatibility: "preview-only".into(),
        source_revision: request.expected_revision,
        target_ids: target_ids.to_vec(),
        input_digest: input_digest.to_owned(),
        artifact_id,
        layer_count: meta.layers.len(),
        segment_count: ir_segments.len(),
        stats: slice_stats(&meta),
        ir,
        program,
    })
}

fn validate_slice_request(request: &SliceJobRequest) -> Result<(), String> {
    if request.slicing_mode != "standard" {
        return Err(format!(
            "unsupported slicing mode: {}",
            request.slicing_mode
        ));
    }
    if request.supports {
        return Err(
            "unsupported feature: native planar provider does not implement supports".into(),
        );
    }
    if request.dialect != "anycubic" && request.dialect != "cura" {
        return Err(format!("unsupported dialect: {}", request.dialect));
    }
    if request.profile_id.trim().is_empty() || request.profile_version.trim().is_empty() {
        return Err(
            "slice preflight: selected machine profile identity/version is required".into(),
        );
    }
    if request.job_id.trim().is_empty() {
        return Err("slice preflight: opaque job ID is required".into());
    }
    if request.coordinate_frame != "editor-world" {
        return Err("slice preflight: input geometry must declare editor-world coordinates".into());
    }
    let expected_frame = SliceFrame {
        origin_mm: [0.0, 0.0, 0.0],
        x_axis: [1.0, 0.0, 0.0],
        y_axis: [0.0, 0.0, 1.0],
        z_axis: [0.0, -1.0, 0.0],
    };
    if serde_json::to_value(&request.editor_to_slice_frame).ok()
        != serde_json::to_value(expected_frame).ok()
    {
        return Err(
            "slice preflight: editor-to-slice frame does not match the coordinate contract".into(),
        );
    }
    for (name, value, min, max) in [
        ("layer_height_mm", request.layer_height_mm, 0.05, 1.0),
        ("line_width_mm", request.line_width_mm, 0.05, 5.0),
        ("nozzle_diameter_mm", request.nozzle_diameter_mm, 0.1, 5.0),
        ("infill_density_pct", request.infill_density_pct, 0.0, 100.0),
        ("brim_width_mm", request.brim_width_mm, 0.0, 20.0),
        (
            "filament_diameter_mm",
            request.filament_diameter_mm,
            0.5,
            5.0,
        ),
        ("build_volume_x_mm", request.build_volume_x_mm, 1.0, 5000.0),
        ("build_volume_y_mm", request.build_volume_y_mm, 1.0, 5000.0),
        ("build_volume_z_mm", request.build_volume_z_mm, 1.0, 5000.0),
        (
            "nozzle_temperature_c",
            request.nozzle_temperature_c,
            150.0,
            300.0,
        ),
        ("bed_temperature_c", request.bed_temperature_c, 20.0, 120.0),
        ("fan_pct", request.fan_pct, 0.0, 100.0),
        ("print_speed_mm_s", request.print_speed_mm_s, 10.0, 600.0),
        ("travel_speed_mm_s", request.travel_speed_mm_s, 10.0, 600.0),
    ] {
        if !value.is_finite() || value < min || value > max {
            return Err(format!("slice preflight: {name} must be in {min}..={max}"));
        }
    }
    if request.wall_loops == 0 || request.wall_loops > 20 {
        return Err("slice preflight: wall_loops must be in 1..=20".into());
    }
    if request.top_bottom_layers > 30 {
        return Err("slice preflight: top_bottom_layers must be in 0..=30".into());
    }
    if request.nozzle_temperature_c != 210.0
        || request.bed_temperature_c != 60.0
        || request.fan_pct != 100.0
        || request.print_speed_mm_s != 30.0
        || request.travel_speed_mm_s != 120.0
    {
        return Err("unsupported process settings: native preview provider currently supports only its declared 210/60 C, 100% fan, 30/120 mm/s motion profile".into());
    }
    Ok(())
}

fn slice_stats(meta: &planar_core::slice::SliceMeta) -> SliceJobStats {
    let mut volume_mm3 = 0.0;
    let mut seconds = 0.0;
    for segment in meta.layers.iter().flat_map(|layer| &layer.segments) {
        volume_mm3 += segment.volume_mm3;
        let distance = (segment.to.x - segment.from.x)
            .hypot(segment.to.y - segment.from.y)
            .hypot(segment.to.z - segment.from.z);
        seconds += distance / 30.0;
    }
    SliceJobStats {
        layers: meta.layers.len(),
        estimated_minutes: (seconds / 60.0).ceil() as u32,
        material_grams: None,
        volume_mm3,
        per_object_mm3: HashMap::new(),
    }
}

fn editor_local_to_slice_ir(
    point: &[f64],
    transform: &PersistedTransform,
    frame: &SliceFrame,
) -> Result<Pt3, String> {
    if point.len() != 3 || point.iter().any(|value| !value.is_finite()) {
        return Err("slice preflight: mesh vertex is not a finite 3D point".into());
    }
    let [rx, ry, rz] = [transform.rx, transform.ry, transform.rz].map(f64::to_radians);
    let (sin_x, cos_x) = rx.sin_cos();
    let (sin_y, cos_y) = ry.sin_cos();
    let (sin_z, cos_z) = rz.sin_cos();
    let sx = point[0] * transform.sx;
    let sy = point[1] * transform.sy;
    let sz = point[2] * transform.sz;
    let editor_x = transform.x
        + sx * cos_z * cos_y
        + sy * (cos_z * sin_y * sin_x - sin_z * cos_x)
        + sz * (cos_z * sin_y * cos_x + sin_z * sin_x);
    let editor_y = transform.y
        + sx * sin_z * cos_y
        + sy * (cos_z * cos_x + sin_z * sin_y * sin_x)
        + sz * (-cos_z * sin_x + sin_z * sin_y * cos_x);
    let editor_z = transform.z - sx * sin_y + sy * cos_y * sin_x + sz * cos_y * cos_x;
    let editor_world = [editor_x, editor_y, editor_z];
    Ok(Pt3::new(
        frame.origin_mm[0]
            + editor_world[0] * frame.x_axis[0]
            + editor_world[1] * frame.y_axis[0]
            + editor_world[2] * frame.z_axis[0],
        frame.origin_mm[1]
            + editor_world[0] * frame.x_axis[1]
            + editor_world[1] * frame.y_axis[1]
            + editor_world[2] * frame.z_axis[1],
        frame.origin_mm[2]
            + editor_world[0] * frame.x_axis[2]
            + editor_world[1] * frame.y_axis[2]
            + editor_world[2] * frame.z_axis[2],
    ))
}

fn subtract(left: Pt3, right: Pt3) -> Pt3 {
    Pt3::new(left.x - right.x, left.y - right.y, left.z - right.z)
}

fn cross(left: Pt3, right: Pt3) -> Pt3 {
    Pt3::new(
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    )
}

fn build_ir(
    meta: &planar_core::slice::SliceMeta,
    profile: &PlanarProfile,
    request: &SliceJobRequest,
    target_ids: &[String],
) -> Result<serde_json::Value, String> {
    let mut segments = Vec::new();
    let mut execution_order = 0_u64;
    for layer in &meta.layers {
        for (index, segment) in layer.segments.iter().enumerate() {
            let dx = segment.to.x - segment.from.x;
            let dy = segment.to.y - segment.from.y;
            let dz = segment.to.z - segment.from.z;
            let length = (dx * dx + dy * dy + dz * dz).sqrt();
            if !length.is_finite() || length <= 0.0 {
                return Err(
                    "independent IR validation: generated segment has invalid length".into(),
                );
            }
            let bead_area = segment.volume_mm3 / length;
            if !bead_area.is_finite()
                || bead_area <= 0.0
                || !segment.delta_e_mm.is_finite()
                || segment.delta_e_mm <= 0.0
                || !segment.q_mm3_s.is_finite()
                || segment.q_mm3_s <= 0.0
                || (segment.delta_e_mm * profile.filament.area() - segment.volume_mm3).abs() > 1e-6
            {
                return Err(format!("independent IR validation: segment {index} violates extrusion conservation or flow bounds"));
            }
            let kind = match segment.kind {
                planar_core::slice::SegmentKind::Wall => "WALL",
                planar_core::slice::SegmentKind::Infill => "INFILL",
                planar_core::slice::SegmentKind::Brim => "BRIM",
                planar_core::slice::SegmentKind::Skirt => "SKIRT",
            };
            segments.push(serde_json::json!({
                "mode": "standard",
                "kind": kind,
                "layer": layer.index,
                "chain_id": format!("{kind}#{}#{index}", layer.index),
                "execution_order": execution_order,
                "pose": {
                    "from": {"x": segment.from.x, "y": segment.from.y, "z": segment.from.z},
                    "to": {"x": segment.to.x, "y": segment.to.y, "z": segment.to.z},
                },
                "orientation": [dx / length, dy / length, dz / length],
                "bead": {"area_mm2": bead_area, "variable": false},
                "flow": {"q_mm3_s": segment.q_mm3_s, "e_mm": segment.delta_e_mm},
                "speed": {"mm_s": 30.0},
                "layer_height_mm": profile.layer_height_mm,
                "line_width_mm": profile.line_width_mm,
                "provenance": {"generator": "planar-core-section-v2", "revision": request.expected_revision, "layer": layer.index},
            }));
            execution_order += 1;
        }
    }
    if segments.len() > 200_000 {
        return Err("independent IR validation: segment limit exceeded".into());
    }
    for (index, segment) in segments.iter().enumerate() {
        for axis in ["x", "y", "z"] {
            for end in ["from", "to"] {
                let coordinate = segment["pose"][end][axis]
                    .as_f64()
                    .ok_or("IR coordinate missing")?;
                if !coordinate.is_finite() {
                    return Err(format!(
                        "independent IR validation: segment {index} has a non-finite coordinate"
                    ));
                }
                let bound = match axis {
                    "x" => {
                        if coordinate < -meta.build_volume.x / 2.0
                            || coordinate > meta.build_volume.x / 2.0
                        {
                            return Err(format!("independent IR validation: segment {index} leaves the captured X build bounds"));
                        }
                        continue;
                    }
                    "y" => {
                        if coordinate < -meta.build_volume.y / 2.0
                            || coordinate > meta.build_volume.y / 2.0
                        {
                            return Err(format!("independent IR validation: segment {index} leaves the captured Y build bounds"));
                        }
                        continue;
                    }
                    _ => meta.build_volume.z,
                };
                if coordinate < 0.0 || coordinate > bound {
                    return Err(format!("independent IR validation: segment {index} leaves the captured Z build bounds"));
                }
                if axis == "z" && end == "to" {
                    let from_z = segment["pose"]["from"]["z"].as_f64().unwrap_or(f64::NAN);
                    if (coordinate - from_z).abs() > 1e-6 {
                        return Err(format!(
                            "independent IR validation: standard segment {index} contains a Z ramp"
                        ));
                    }
                }
            }
        }
    }
    Ok(serde_json::json!({
        "version": "1.1",
        "mode": "standard",
        "dialect": profile.dialect,
        "coordinate_frame": "slice-ir",
        "units": "mm",
        "job_id": request.job_id,
        "source_revision": request.expected_revision,
        "target_ids": target_ids,
        "placement": null,
        "build_volume": {"x": meta.build_volume.x, "y": meta.build_volume.y, "z": meta.build_volume.z},
        "segments": segments,
    }))
}

fn emit_and_validate_program(
    meta: &planar_core::slice::SliceMeta,
    profile: &PlanarProfile,
) -> Result<String, String> {
    let expected_volume = profile
        .build_volume_mm
        .ok_or("independent program validation: machine build volume is unavailable")?;
    if expected_volume.x != meta.build_volume.x
        || expected_volume.y != meta.build_volume.y
        || expected_volume.z != meta.build_volume.z
    {
        return Err(
            "independent program validation: captured profile volume does not match slice metadata"
                .into(),
        );
    }
    let mut lines = vec!["G21".to_owned(), "G90".to_owned(), "M82".to_owned()];
    let mut extrusion = 0.0;
    let mut previous: Option<Pt3> = None;
    for layer in &meta.layers {
        for segment in &layer.segments {
            let gap = previous.is_none_or(|point| {
                (point.x - segment.from.x)
                    .hypot(point.y - segment.from.y)
                    .hypot(point.z - segment.from.z)
                    > 1e-6
            });
            if gap {
                lines.push(format!(
                    "G0 X{:.4} Y{:.4} Z{:.4} F7200",
                    segment.from.x, segment.from.y, segment.from.z
                ));
            }
            extrusion += segment.delta_e_mm;
            lines.push(format!(
                "G1 X{:.4} Y{:.4} Z{:.4} E{:.5} F1800",
                segment.to.x, segment.to.y, segment.to.z, extrusion
            ));
            previous = Some(segment.to);
        }
    }
    if lines.len() <= 3 {
        return Err("independent program validation: no motion was emitted".into());
    }
    let mut position = [0.0; 3];
    let mut extrusion = 0.0;
    for (index, line) in lines.iter().enumerate() {
        let command = line.split_whitespace().next().unwrap_or_default();
        if !matches!(command, "G21" | "G90" | "M82" | "G0" | "G1") {
            return Err(format!(
                "independent program validation: unsupported command at line {index}"
            ));
        }
        let mut has_e = false;
        for word in line.split_whitespace().skip(1) {
            if word.len() < 2 || !word[1..].parse::<f64>().is_ok_and(f64::is_finite) {
                return Err(format!(
                    "independent program validation: malformed word at line {index}"
                ));
            }
            let value = word[1..]
                .parse::<f64>()
                .map_err(|_| "malformed program number")?;
            match word.as_bytes()[0] {
                b'X' => position[0] = value,
                b'Y' => position[1] = value,
                b'Z' => position[2] = value,
                b'E' => {
                    has_e = true;
                    if command != "G1" || value < extrusion {
                        return Err(format!(
                            "independent program validation: invalid extrusion at line {index}"
                        ));
                    }
                    extrusion = value;
                }
                _ => {}
            }
        }
        if command == "G0" || command == "G1" {
            let volume = expected_volume;
            if position[0] < -volume.x / 2.0
                || position[0] > volume.x / 2.0
                || position[1] < -volume.y / 2.0
                || position[1] > volume.y / 2.0
                || position[2] < 0.0
                || position[2] > volume.z
            {
                return Err(format!("independent program validation: motion leaves the captured build volume at line {index}"));
            }
            if (command == "G1") != has_e {
                return Err(format!(
                    "independent program validation: motion/extrusion mismatch at line {index}"
                ));
            }
        }
    }
    let expected_extrusion: f64 = meta
        .layers
        .iter()
        .flat_map(|layer| &layer.segments)
        .map(|segment| segment.delta_e_mm)
        .sum();
    if (extrusion - expected_extrusion).abs() > 1e-4 {
        return Err(
            "independent program validation: emitted extrusion does not match captured path flow"
                .into(),
        );
    }
    Ok(lines.join("\n") + "\n")
}

fn digest_json(value: &serde_json::Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn slice_input_digest(
    revision: u64,
    request: &SliceJobRequest,
    targets: &[(String, PersistedObject)],
    target_ids: &[String],
) -> Result<String, String> {
    let mut output = serde_json::to_value(request).map_err(|error| error.to_string())?;
    output
        .as_object_mut()
        .ok_or("slice request serialization was not an object")?
        .remove("job_id");
    digest_json(&serde_json::json!({
        "source_revision": revision,
        "plate_id": request.plate_id,
        "target_ids": target_ids,
        "target_objects": targets.iter().map(|(_, object)| object).collect::<Vec<_>>(),
        "request": output,
        "provider": "planar-core-section-v2",
    }))
}

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
    store
        .get::<serde_json::Value>(&id)
        .map_err(|e| e.to_string())
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

fn workspace_db_path() -> Result<PathBuf, String> {
    let data_root = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .ok_or_else(|| "application data directory is unavailable".to_owned())?;
    let app_dir = PathBuf::from(data_root).join("AnycubicBridge");
    std::fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
    Ok(app_dir.join("workspace.db"))
}

pub(crate) fn workspace_data_dir() -> Result<PathBuf, String> {
    let db_path = workspace_db_path()?;
    db_path
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "workspace database directory is unavailable".to_owned())
}

fn open_project_authority(
    project_id: &str,
    project_name: &str,
) -> Result<ProjectAuthority, String> {
    let data_dir = workspace_data_dir()?;
    let db_path = workspace_db_path()?;
    let db = DbHandle::open(&db_path).map_err(|error| error.to_string())?;
    ProjectAuthority::open_with_artifact_dir(
        db,
        project_id,
        project_name,
        Some(data_dir.join("project-blobs")),
    )
    .map_err(|error| error.to_string())
}

fn reopen_project_authority(project_id: &str) -> Result<ProjectAuthority, String> {
    let data_dir = workspace_data_dir()?;
    let db = DbHandle::open(workspace_db_path()?).map_err(|error| error.to_string())?;
    ProjectAuthority::reopen_existing(db, project_id, Some(data_dir.join("project-blobs")))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_list() -> Result<Vec<ProjectSummary>, String> {
    let db = DbHandle::open(workspace_db_path()?).map_err(|error| error.to_string())?;
    ProjectAuthority::list(&db).map_err(|error| error.to_string())
}

#[tauri::command]
fn project_slice_history(
    project_id: String,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let db = DbHandle::open(workspace_db_path()?).map_err(|error| error.to_string())?;
    let blobs_dir = workspace_data_dir()?.join("project-blobs");
    ProjectAuthority::list_slice_jobs_with_artifact_status(
        &db,
        &project_id,
        limit.unwrap_or(20).min(100),
        Some(&blobs_dir),
    )
    .map_err(|error| error.to_string())
}

struct UnavailableReprintDestination;

impl ReprintDestinationProvider for UnavailableReprintDestination {
    fn current_destination(&self) -> Option<ReprintDestination> {
        None
    }
}

#[tauri::command]
fn project_reprint_preflight(
    source_job_id: String,
    intent_id: String,
) -> Result<ReprintIntentResult, String> {
    if source_job_id.trim().is_empty() || intent_id.trim().is_empty() {
        return Err("source job id and new intent id are required".into());
    }
    let db = DbHandle::open(workspace_db_path()?).map_err(|error| error.to_string())?;
    let project_id = ProjectAuthority::list(&db)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|project| project.id == "local-project")
        .map(|project| project.id)
        .ok_or_else(|| "active project is unavailable".to_owned())?;
    let authority = reopen_project_authority(&project_id)?;
    authority
        .preflight_reprint(&source_job_id, &intent_id, &UnavailableReprintDestination)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_create(
    state: State<'_, ProjectAuthorityState>,
    project_id: String,
    name: String,
) -> Result<ProjectSnapshot, String> {
    let name = name.trim();
    if project_id.trim().is_empty() || name.is_empty() || name.len() > 120 {
        return Err("project id and a name of 1..=120 characters are required".into());
    }
    let data_dir = workspace_data_dir()?;
    let db = DbHandle::open(workspace_db_path()?).map_err(|error| error.to_string())?;
    let authority =
        ProjectAuthority::create(db, project_id, name, Some(data_dir.join("project-blobs")))
            .map_err(|error| error.to_string())?;
    let snapshot = authority.snapshot().map_err(|error| error.to_string())?;
    *state.0.lock().map_err(|error| error.to_string())? = Ok(authority);
    Ok(snapshot)
}

#[tauri::command]
fn project_open(
    state: State<'_, ProjectAuthorityState>,
    project_id: String,
) -> Result<ProjectSnapshot, String> {
    let db = DbHandle::open(workspace_db_path()?).map_err(|error| error.to_string())?;
    let summary = ProjectAuthority::list(&db)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| "project not found".to_owned())?;
    let authority = open_project_authority(&summary.id, &summary.name)?;
    let snapshot = authority.snapshot().map_err(|error| error.to_string())?;
    *state.0.lock().map_err(|error| error.to_string())? = Ok(authority);
    Ok(snapshot)
}

#[tauri::command]
fn project_authority_read(
    state: State<'_, ProjectAuthorityState>,
) -> Result<ProjectSnapshot, String> {
    let guard = state.0.lock().map_err(|error| error.to_string())?;
    guard
        .as_ref()
        .map_err(Clone::clone)?
        .snapshot()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_authority_recover(
    state: State<'_, ProjectAuthorityState>,
    project_id: String,
) -> Result<ProjectSnapshot, String> {
    let authority = reopen_project_authority(&project_id)?;
    let snapshot = authority.snapshot().map_err(|error| error.to_string())?;
    *state.0.lock().map_err(|error| error.to_string())? = Ok(authority);
    Ok(snapshot)
}

#[tauri::command]
fn project_authority_journal(
    state: State<'_, ProjectAuthorityState>,
) -> Result<Vec<ProjectOperation>, String> {
    let guard = state.0.lock().map_err(|error| error.to_string())?;
    guard
        .as_ref()
        .map_err(Clone::clone)?
        .journal()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn project_authority_commit(
    state: State<'_, ProjectAuthorityState>,
    expected_revision: u64,
    operation: ProjectOperation,
    project: ProjectDocument,
) -> Result<ProjectCommitReply, String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;
    let authority = guard.as_mut().map_err(|error| (*error).clone())?;
    match authority.commit(expected_revision, operation, project) {
        Ok(snapshot) => Ok(ProjectCommitReply {
            status: if snapshot.revision == expected_revision {
                "no_op"
            } else {
                "committed"
            }
            .to_owned(),
            actual_revision: snapshot.revision,
            snapshot: Some(snapshot),
            diagnostics: Vec::new(),
        }),
        Err(AuthorityError::Conflict { actual, .. }) => Ok(ProjectCommitReply {
            status: "conflict".to_owned(),
            actual_revision: actual,
            snapshot: Some(authority.snapshot().map_err(|error| error.to_string())?),
            diagnostics: vec!["project_revision_conflict".to_owned()],
        }),
        Err(error) => Ok(ProjectCommitReply {
            status: "failed".to_owned(),
            actual_revision: authority
                .snapshot()
                .map(|snapshot| snapshot.revision)
                .unwrap_or(expected_revision),
            snapshot: None,
            diagnostics: vec![error.to_string()],
        }),
    }
}

#[derive(Serialize)]
struct GeometryExecutionReply {
    output: GeometryOutput,
    blender_version: String,
    transport: String,
}

#[tauri::command]
fn project_geometry_execute(
    state: State<'_, GeometryWorkerState>,
    operation: GeometryOperation,
    inputs: Vec<GeometryInput>,
) -> Result<GeometryExecutionReply, String> {
    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    let (output, install): (GeometryOutput, BlenderInstall) =
        execute(operation, inputs).map_err(|error| error.to_string())?;
    let transport = format!("{:?}", transport_for(&install)).to_lowercase();
    Ok(GeometryExecutionReply {
        output,
        blender_version: install.version,
        transport,
    })
}

#[derive(Serialize)]
struct ProjectCommitReply {
    status: String,
    actual_revision: u64,
    snapshot: Option<ProjectSnapshot>,
    diagnostics: Vec<String>,
}

// S9.17-004 — Workbench Live backend slice. `live_job_binding` is a
// REGISTERED read-only command that always replies with a typed view; this
// build has no physical job publisher (no login, no device binding
// publisher), so the reply is EXPLICITLY `available: false` with
// `unavailable_reason: "no-physical-job-source"`. Absence is never a
// swallowed unknown command, and no binding/printer id is ever invented.
// `live_artifact_read` serves the artifact BLOCK from the project-owned CAS
// (project-blobs); the frontend strict-parses the IR (parseIrDocument 1.1)
// before any preview routes.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveJobBindingArgs {
    project_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveJobBindingReply {
    observed_job_id: Option<String>,
    observed_printer_id: Option<String>,
    job_binding: Option<serde_json::Value>,
    artifact: Option<serde_json::Value>,
    source: String,
    available: bool,
    unavailable_reason: String,
}

#[tauri::command]
fn live_job_binding(_args: LiveJobBindingArgs) -> LiveJobBindingReply {
    LiveJobBindingReply {
        observed_job_id: None,
        observed_printer_id: None,
        job_binding: None,
        artifact: None,
        source: "tauri".to_owned(),
        available: false,
        unavailable_reason: "no-physical-job-source".to_owned(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveArtifactReadArgs {
    project_id: String,
    artifact_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveArtifactReadView {
    artifact_id: String,
    source_revision: u64,
    current_revision: u64,
    ir: serde_json::Value,
}

#[tauri::command]
fn live_artifact_read(args: LiveArtifactReadArgs) -> Result<LiveArtifactReadView, String> {
    if args.project_id.trim().is_empty() || args.artifact_id.trim().is_empty() {
        return Err("project id and artifact id are required".into());
    }
    let authority = reopen_project_authority(&args.project_id)?;
    let current_revision = authority.snapshot().map_err(|error| error.to_string())?.revision;
    let artifact_bytes = authority
        .get_artifact(&args.artifact_id)
        .map_err(|error| error.to_string())?;
    let artifact_bytes = artifact_bytes.ok_or_else(|| "artifact not found".to_owned())?;
    let artifact: serde_json::Value =
        serde_json::from_slice(&artifact_bytes).map_err(|error| error.to_string())?;
    let source_revision = artifact
        .get("source_revision")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| artifact.get("sourceRevision").and_then(serde_json::Value::as_u64))
        .ok_or_else(|| "artifact records no source revision".to_owned())?;
    let ir = artifact
        .get("ir")
        .cloned()
        .ok_or_else(|| "artifact has no IR payload".to_owned())?;
    Ok(LiveArtifactReadView {
        artifact_id: args.artifact_id,
        source_revision,
        current_revision,
        ir,
    })
}

pub fn run() {
    tauri::Builder::default()
        .manage(ChatStoreState(Mutex::new(
            ChatStore::open_default().expect("chat store dir"),
        )))
        .manage(ProjectAuthorityState(Mutex::new(open_project_authority(
            "local-project",
            "Local Project",
        ))))
        .manage(GeometryWorkerState(Mutex::new(())))
        .manage(SliceJobsState(Mutex::new(HashMap::new())))
        .manage(device_control::DeviceAuthorityState::open())
        .invoke_handler(tauri::generate_handler![
            device_control_availability,
            device_control_preflight,
            device_control_approve,
            device_control_dispatch,
            app_info,
            chat_store_dir,
            chat_store_put,
            chat_store_get,
            chat_store_delete,
            chat_store_list,
            chat_store_info,
            project_authority_read,
            project_authority_recover,
            project_authority_journal,
            project_authority_commit,
            project_list,
            project_slice_history,
            project_reprint_preflight,
            project_create,
            project_open,
            project_geometry_execute,
            slice_job_run,
            slice_job_cancel,
            live_job_binding,
            live_artifact_read,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            window.set_title("Anycubic Bridge Editor").ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Anycubic Bridge editor");
}

#[cfg(test)]
mod slice_job_tests {
    use super::*;

    fn request() -> SliceJobRequest {
        SliceJobRequest {
            job_id: "slice-test".into(),
            expected_revision: 4,
            slicing_mode: "standard".into(),
            coordinate_frame: "editor-world".into(),
            editor_to_slice_frame: SliceFrame {
                origin_mm: [0.0, 0.0, 0.0],
                x_axis: [1.0, 0.0, 0.0],
                y_axis: [0.0, 0.0, 1.0],
                z_axis: [0.0, -1.0, 0.0],
            },
            plate_id: "plate-test".into(),
            profile_id: "machine-test".into(),
            profile_version: "catalog-v1".into(),
            build_volume_x_mm: 250.0,
            build_volume_y_mm: 250.0,
            build_volume_z_mm: 250.0,
            dialect: "anycubic".into(),
            layer_height_mm: 1.0,
            line_width_mm: 0.45,
            nozzle_diameter_mm: 0.4,
            wall_loops: 1,
            top_bottom_layers: 0,
            infill_density_pct: 15.0,
            infill_pattern: "Grid".into(),
            brim_width_mm: 0.0,
            filament_diameter_mm: 1.75,
            material_id: "material-test".into(),
            material_type: "PLA".into(),
            nozzle_temperature_c: 210.0,
            bed_temperature_c: 60.0,
            fan_pct: 100.0,
            print_speed_mm_s: 30.0,
            travel_speed_mm_s: 120.0,
            supports: false,
            target_ids: vec!["object-test".into()],
        }
    }

    fn triangle(vertices: [[f64; 3]; 3]) -> Triangle {
        let points = vertices.map(|point| Pt3::new(point[0], point[1], point[2]));
        Triangle {
            v: points,
            n: cross(
                subtract(points[1], points[0]),
                subtract(points[2], points[0]),
            ),
        }
    }

    fn quad(output: &mut Vec<Triangle>, corners: [[f64; 3]; 4]) {
        output.push(triangle([corners[0], corners[1], corners[2]]));
        output.push(triangle([corners[0], corners[2], corners[3]]));
    }

    fn l_prism() -> SliceMesh {
        let outline = [
            [0.0, 0.0],
            [20.0, 0.0],
            [20.0, 10.0],
            [10.0, 10.0],
            [10.0, 20.0],
            [0.0, 20.0],
        ];
        let mut triangles = Vec::new();
        for tri in [
            [[0.0, 0.0], [20.0, 0.0], [20.0, 10.0]],
            [[0.0, 0.0], [20.0, 10.0], [10.0, 10.0]],
            [[0.0, 0.0], [10.0, 10.0], [10.0, 20.0]],
            [[0.0, 0.0], [10.0, 20.0], [0.0, 20.0]],
        ] {
            triangles.push(triangle(tri.map(|point| [point[0], point[1], 0.0])));
            triangles.push(triangle(tri.map(|point| [point[0], point[1], 10.0])));
        }
        for index in 0..outline.len() {
            let a = outline[index];
            let b = outline[(index + 1) % outline.len()];
            quad(
                &mut triangles,
                [
                    [a[0], a[1], 0.0],
                    [a[0], a[1], 10.0],
                    [b[0], b[1], 10.0],
                    [b[0], b[1], 0.0],
                ],
            );
        }
        SliceMesh { triangles }
    }

    #[test]
    fn editor_frame_is_applied_after_object_transform_once() {
        let point = editor_local_to_slice_ir(
            &[1.0, 2.0, 3.0],
            &PersistedTransform::default(),
            &request().editor_to_slice_frame,
        )
        .unwrap();
        assert_eq!((point.x, point.y, point.z), (1.0, -3.0, 2.0));
    }

    #[test]
    fn current_object_transform_is_applied_to_world_axis_baked_geometry() {
        let mut transform = PersistedTransform::default();
        transform.x = 5.0;
        let point = editor_local_to_slice_ir(
            &[1.0, 2.0, 3.0],
            &transform,
            &request().editor_to_slice_frame,
        )
        .unwrap();
        assert_eq!((point.x, point.y, point.z), (6.0, -3.0, 2.0));
    }

    #[test]
    fn unsupported_process_values_are_named_preflight_failures() {
        let mut input = request();
        input.print_speed_mm_s = 45.0;
        assert!(validate_slice_request(&input)
            .unwrap_err()
            .contains("unsupported process settings"));
    }

    #[test]
    fn preflight_names_unsupported_supports_and_nonplanar_mode() {
        let mut input = request();
        input.supports = true;
        assert!(validate_slice_request(&input)
            .unwrap_err()
            .contains("does not implement supports"));
        input.supports = false;
        input.slicing_mode = "nonplanar".into();
        assert!(validate_slice_request(&input)
            .unwrap_err()
            .contains("unsupported slicing mode"));
    }

    #[test]
    fn cache_digest_excludes_job_id_but_includes_captured_settings() {
        let target: PersistedObject = serde_json::from_value(persisted_object()).unwrap();
        let targets = vec![("object-test".to_owned(), target)];
        let ids = vec!["object-test".to_owned()];
        let first = request();
        let first_digest = slice_input_digest(4, &first, &targets, &ids).unwrap();
        let mut another_job = first.clone();
        another_job.job_id = "different-job".into();
        assert_eq!(
            first_digest,
            slice_input_digest(4, &another_job, &targets, &ids).unwrap()
        );
        let mut another_profile = first;
        another_profile.layer_height_mm = 0.2;
        assert_ne!(
            first_digest,
            slice_input_digest(4, &another_profile, &targets, &ids).unwrap()
        );
    }

    fn snapshot_with_object(object: serde_json::Value) -> ProjectSnapshot {
        ProjectSnapshot {
            project: ProjectDocument {
                id: "project-test".into(),
                name: "Test project".into(),
                objects: vec![object],
                legacy_objects: Vec::new(),
            },
            revision: 4,
            diagnostics: Vec::new(),
        }
    }

    fn persisted_object() -> serde_json::Value {
        serde_json::json!({
            "name": "part",
            "objectId": "object-test",
            "plateId": "plate-test",
            "visible": true,
            "locked": false,
            "vertices": 3,
            "triangles": 1,
            "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]},
            "sizeMm": [1, 1, 1],
            "volumeMm3": 0.1,
            "surfaceAreaMm2": 1.0,
            "watertight": true,
            "transform": {"x": 0, "y": 0, "z": 0},
            "geometry": {"positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "indices": [0, 1, 2]}
        })
    }

    #[test]
    fn slice_history_reports_artifact_availability_without_changing_job_metadata() {
        let root = std::env::temp_dir().join(format!(
            "editor-history-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let blobs = root.join("blobs");
        std::fs::create_dir_all(&blobs).unwrap();
        let db_path = root.join("workspace.db");
        let authority = ProjectAuthority::open_with_artifact_dir(
            DbHandle::open(&db_path).unwrap(),
            "project-test",
            "Test project",
            Some(blobs.clone()),
        )
        .unwrap();
        let present_id = authority.put_artifact(b"synthetic slice artifact").unwrap();
        let missing_id = authority
            .put_artifact(b"missing synthetic artifact")
            .unwrap();
        std::fs::remove_file(blobs.join(format!("{missing_id}.mesh"))).unwrap();
        authority
            .put_slice_job(
                "job-present",
                4,
                "digest-a",
                "ready",
                &serde_json::json!({"job_id":"job-present", "status":"ready", "source_revision":4, "artifact_id":present_id}),
            )
            .unwrap();
        authority
            .put_slice_job(
                "job-missing",
                5,
                "digest-b",
                "failed",
                &serde_json::json!({"job_id":"job-missing", "status":"failed", "source_revision":5, "artifact_id":missing_id}),
            )
            .unwrap();
        authority
            .put_slice_job(
                "job-no-artifact",
                6,
                "digest-c",
                "cancelled",
                &serde_json::json!({"job_id":"job-no-artifact", "status":"cancelled", "source_revision":6}),
            )
            .unwrap();

        drop(authority);
        let db = DbHandle::open(&db_path).unwrap();
        let baseline = ProjectAuthority::list_slice_jobs(&db, "project-test", 10).unwrap();
        let history = ProjectAuthority::list_slice_jobs_with_artifact_status(
            &db,
            "project-test",
            10,
            Some(&blobs),
        )
        .unwrap();

        assert_eq!(history.len(), 3);
        assert_eq!(
            history
                .iter()
                .map(|row| row["job_id"].clone())
                .collect::<Vec<_>>(),
            baseline
                .iter()
                .map(|row| row["job_id"].clone())
                .collect::<Vec<_>>()
        );
        for (row, original) in history.iter().zip(&baseline) {
            assert_eq!(row["status"], original["status"]);
            assert_eq!(row["source_revision"], original["source_revision"]);
            assert_eq!(row["artifact_id"], original["artifact_id"]);
            assert_eq!(row["artifact_origin"], "local");
            let expected_status = match row["job_id"].as_str().unwrap() {
                "job-present" => "present",
                "job-missing" => "missing",
                "job-no-artifact" => "unavailable",
                _ => panic!("unexpected synthetic job"),
            };
            assert_eq!(row["artifact_status"], expected_status);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn capture_accepts_current_project_object_schema() {
        let targets = capture_meshes(&snapshot_with_object(persisted_object()), &request())
            .expect("known project fields should be captured");
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, "object-test");
    }

    #[test]
    fn capture_rejects_unknown_modifier_fields_instead_of_ignoring_them() {
        let mut object = persisted_object();
        object["modifiers"] = serde_json::json!([{"kind": "support-blocker"}]);
        let error = capture_meshes(&snapshot_with_object(object), &request()).unwrap_err();
        assert!(error.contains("unsupported project object fields"));
        assert!(error.contains("modifiers"));
    }

    #[test]
    fn authority_to_slice_job_persists_real_concave_ir_and_program() {
        let root = std::env::temp_dir().join(format!(
            "editor-slice-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let blobs = root.join("blobs");
        std::fs::create_dir_all(&root).unwrap();
        let mut authority = ProjectAuthority::open_with_artifact_dir(
            DbHandle::open_in_memory().unwrap(),
            "project-test",
            "Test project",
            Some(blobs),
        )
        .unwrap();
        let mesh = l_prism();
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for triangle in &mesh.triangles {
            for vertex in triangle.v {
                positions.extend([vertex.x, vertex.z, -vertex.y]);
                indices.push(indices.len() as u32);
            }
        }
        let object = serde_json::json!({
            "name": "concave-part",
            "objectId": "object-test",
            "plateId": "plate-test",
            "visible": true,
            "locked": false,
            "vertices": positions.len() / 3,
            "triangles": indices.len() / 3,
            "bounds": {"min": [0, 0, -20], "max": [20, 10, 0]},
            "sizeMm": [20, 10, 20],
            "volumeMm3": 3000,
            "surfaceAreaMm2": 0,
            "watertight": true,
            "filamentId": "material-test",
            "transform": {"x": 0, "y": 0, "z": 0, "rx": 0, "ry": 0, "rz": 0, "sx": 1, "sy": 1, "sz": 1},
            "geometry": {"positions": positions, "indices": indices}
        });
        let initial = authority.snapshot().unwrap();
        let saved = authority
            .commit(
                initial.revision,
                ProjectOperation {
                    operation_id: "add-test-object".into(),
                    kind: project_store::ProjectOperationKind::AddObject,
                    target_ids: vec!["object-test".into()],
                    before: serde_json::json!([]),
                    after: serde_json::json!([object.clone()]),
                },
                ProjectDocument {
                    id: "project-test".into(),
                    name: "Test project".into(),
                    objects: vec![object],
                    legacy_objects: Vec::new(),
                },
            )
            .unwrap();
        let mut request = request();
        request.expected_revision = saved.revision;
        let captured = authority.snapshot().unwrap();
        let targets = capture_meshes(&captured, &request).unwrap();
        let ids = targets.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        let digest = slice_input_digest(captured.revision, &request, &targets, &ids).unwrap();
        let mut stale_request = request.clone();
        stale_request.job_id = "slice-stale-test".into();
        let stale_targets = capture_meshes(&captured, &stale_request).unwrap();
        let stale_ids = stale_targets
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let stale_digest = slice_input_digest(
            captured.revision,
            &stale_request,
            &stale_targets,
            &stale_ids,
        )
        .unwrap();
        let mut cancelled_request = request.clone();
        cancelled_request.job_id = "slice-cancelled-test".into();
        let cancelled_targets = capture_meshes(&captured, &cancelled_request).unwrap();
        let cancelled_ids = cancelled_targets
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let cancelled_digest = slice_input_digest(
            captured.revision,
            &cancelled_request,
            &cancelled_targets,
            &cancelled_ids,
        )
        .unwrap();
        let control = SliceJobControl {
            cancelled: AtomicBool::new(false),
            publication: Mutex::new(false),
        };
        let state = ProjectAuthorityState(Mutex::new(Ok(authority)));
        let reply = run_slice_job(
            &state,
            &request,
            targets,
            &ids,
            &digest,
            &request.job_id,
            &control,
        )
        .expect("captured project should produce a validated Preview artifact");
        assert_eq!(reply.compatibility, "preview-only");
        assert!(reply.segment_count > 0);
        assert!(reply.program.contains("G1 "));
        assert!(reply.stats.material_grams.is_none());
        assert_eq!(reply.source_revision, saved.revision);
        assert!(reply.ir["segments"]
            .as_array()
            .unwrap()
            .iter()
            .all(|segment| {
                let from = &segment["pose"]["from"];
                let to = &segment["pose"]["to"];
                let x = (from["x"].as_f64().unwrap() + to["x"].as_f64().unwrap()) / 2.0;
                let y = (from["y"].as_f64().unwrap() + to["y"].as_f64().unwrap()) / 2.0;
                segment["kind"] != "INFILL" || x <= 10.0 || y <= 10.0
            }));

        let mut guard = state.0.lock().unwrap();
        let authority = guard.as_mut().unwrap();
        let current = authority.snapshot().unwrap();
        assert_eq!(reply.ir["job_id"], reply.job_id);
        assert_eq!(reply.ir["source_revision"], reply.source_revision);
        assert_eq!(reply.ir["target_ids"], serde_json::json!(reply.target_ids));
        assert!(reply.ir["placement"].is_null());
        let ir_segments = reply.ir["segments"].as_array().unwrap();
        assert!(ir_segments.iter().enumerate().all(|(index, segment)| {
            segment["execution_order"].as_u64() == Some(index as u64)
                && segment["layer_height_mm"].as_f64() == Some(request.layer_height_mm)
                && segment["line_width_mm"].as_f64() == Some(request.line_width_mm)
                && segment["provenance"]["revision"].as_u64() == Some(reply.source_revision)
        }));
        let mut changed_project = current.project.clone();
        changed_project.name = "Edited during slice".into();
        authority
            .commit(
                current.revision,
                ProjectOperation {
                    operation_id: "edit-after-capture".into(),
                    kind: project_store::ProjectOperationKind::Checkpoint,
                    target_ids: vec![],
                    before: serde_json::json!({"name": current.project.name}),
                    after: serde_json::json!({"name": changed_project.name}),
                },
                changed_project,
            )
            .unwrap();
        drop(guard);
        let stale_control = SliceJobControl {
            cancelled: AtomicBool::new(false),
            publication: Mutex::new(false),
        };
        let stale_error = run_slice_job(
            &state,
            &stale_request,
            stale_targets,
            &stale_ids,
            &stale_digest,
            &stale_request.job_id,
            &stale_control,
        )
        .unwrap_err();
        assert!(stale_error.contains("slice output stale"));

        let cancelled_control = SliceJobControl {
            cancelled: AtomicBool::new(true),
            publication: Mutex::new(false),
        };
        let cancelled_error = run_slice_job(
            &state,
            &cancelled_request,
            cancelled_targets,
            &cancelled_ids,
            &cancelled_digest,
            &cancelled_request.job_id,
            &cancelled_control,
        )
        .unwrap_err();
        assert!(cancelled_error.contains("cancelled"));
        let authority = state.0.lock().unwrap();
        let authority = authority.as_ref().unwrap();
        assert!(authority
            .get_slice_job(&stale_request.job_id)
            .unwrap()
            .is_none());
        assert!(authority
            .get_slice_job(&cancelled_request.job_id)
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concave_mesh_generates_real_ir_and_validated_motion_not_bbox_paths() {
        let profile = PlanarProfile {
            dialect: "anycubic".into(),
            mode: JobMode::Standard,
            layer_height_mm: 1.0,
            wall_loops: 1,
            infill_pattern: InfillPattern::Grid,
            infill_density_pct: 15.0,
            top_bottom_layers: 0,
            brim_mskirt: None,
            line_width_mm: 0.45,
            nozzle_diameter_mm: 0.4,
            filament: FilamentParams { diameter_mm: 1.75 },
            build_volume_mm: Some(machine_profile::Volume {
                x: 250.0,
                y: 250.0,
                z: 250.0,
            }),
        };
        let meta = planar_core::slice::slice(&l_prism(), &profile).expect("L prism should slice");
        let request = SliceJobRequest {
            job_id: "test-job".into(),
            expected_revision: 4,
            slicing_mode: "standard".into(),
            coordinate_frame: "editor-world".into(),
            editor_to_slice_frame: SliceFrame {
                origin_mm: [0.0; 3],
                x_axis: [1.0, 0.0, 0.0],
                y_axis: [0.0, 0.0, 1.0],
                z_axis: [0.0, -1.0, 0.0],
            },
            plate_id: "plate-1".into(),
            profile_id: "test-profile".into(),
            profile_version: "test-version".into(),
            build_volume_x_mm: 250.0,
            build_volume_y_mm: 250.0,
            build_volume_z_mm: 250.0,
            dialect: "anycubic".into(),
            layer_height_mm: 1.0,
            line_width_mm: 0.45,
            nozzle_diameter_mm: 0.4,
            wall_loops: 1,
            top_bottom_layers: 0,
            infill_density_pct: 15.0,
            infill_pattern: "Grid".into(),
            brim_width_mm: 0.0,
            filament_diameter_mm: 1.75,
            material_id: "test-material".into(),
            material_type: "PLA".into(),
            nozzle_temperature_c: 210.0,
            bed_temperature_c: 60.0,
            fan_pct: 100.0,
            print_speed_mm_s: 30.0,
            travel_speed_mm_s: 120.0,
            supports: false,
            target_ids: vec!["object-a".into()],
        };
        let ir = build_ir(&meta, &profile, &request, &request.target_ids).expect("IR validation");
        let program = emit_and_validate_program(&meta, &profile).expect("program validation");
        let segments = ir["segments"].as_array().expect("IR segments");
        assert!(!segments.is_empty());
        assert!(program.lines().any(|line| line.starts_with("G1 ")));
        for segment in segments
            .iter()
            .filter(|segment| segment["kind"] == "INFILL")
        {
            let from = &segment["pose"]["from"];
            let to = &segment["pose"]["to"];
            let midpoint_x = (from["x"].as_f64().unwrap() + to["x"].as_f64().unwrap()) / 2.0;
            let midpoint_y = (from["y"].as_f64().unwrap() + to["y"].as_f64().unwrap()) / 2.0;
            assert!(
                midpoint_x <= 10.0 || midpoint_y <= 10.0,
                "bbox-only path entered missing L quadrant"
            );
        }
    }
}
