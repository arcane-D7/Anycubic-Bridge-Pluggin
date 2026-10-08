//! Planar slice engine — uniform layers, wall loops (inset), grid infill,
//! brim/skirt basic. Extrusion from §3.3 closed-form (see `extrusion`).

use std::collections::BTreeMap;
use std::collections::{HashMap, HashSet};
use std::fmt;

use geo::{
    BooleanOps, Buffer, Contains, Coord, LineString, MultiLineString, MultiPolygon, Point, Polygon,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::extrusion::{Bead, FilamentParams};
use crate::infill::{self, GridLines, GridParams, InfillPattern};
use crate::offset::{self, Pt};

/// Build volume carried in slice metadata (serde-able). Derived from the
/// machine profile at slice time — never hardcoded.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BuildVolume {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl From<machine_profile::Volume> for BuildVolume {
    fn from(v: machine_profile::Volume) -> Self {
        Self {
            x: v.x,
            y: v.y,
            z: v.z,
        }
    }
}

/// Job mode — this crate is the *standard* (planar) mode engine only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobMode {
    #[serde(rename = "standard")]
    Standard,
}

/// Slice profile: user-facing settings plus machine-derived constants.
///
/// Build-volume comes from the machine profile (never hardcoded) and is
/// enforced at pre-flight. `dialect` must be one of the supported dialects,
/// otherwise `slice()` rejects pre-flight (S8-004 §5 contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanarProfile {
    /// Slicer dialect (e.g. `"anycubic"`, `"cura"`). Unsupported → rejected
    /// pre-flight (`UnsupportedDialect`).
    pub dialect: String,
    pub mode: JobMode,
    pub layer_height_mm: f64,
    pub wall_loops: u32,
    pub infill_pattern: InfillPattern,
    pub infill_density_pct: f64,
    /// Number of solid (100%-density) shell layers at the top AND bottom of
    /// the part (standard slicer "top/bottom shells"). 0 disables skins.
    /// Non-solid (sparse infill) layers fill the middle.
    #[serde(default = "default_shell_layers")]
    pub top_bottom_layers: u32,
    pub brim_mskirt: Option<f64>, // mm
    /// Toolpath line width (bead width). Standard 0.40 nozzle presets use
    /// 0.45 mm wall/infill line width — independent of the nozzle diameter.
    /// The bead's cross-section is line_width × layer_height (§3.3).
    #[serde(default = "default_line_width")]
    pub line_width_mm: f64,
    pub nozzle_diameter_mm: f64,
    pub filament: FilamentParams,
    #[serde(skip)]
    pub build_volume_mm: Option<machine_profile::Volume>,
}

impl fmt::Display for PlanarProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "PlanarProfile{{dialect={}, layer={}mm, walls={}, infill={:?} {}%, shells={}, brim={:?}}}",
            self.dialect,
            self.layer_height_mm,
            self.wall_loops,
            self.infill_pattern,
            self.infill_density_pct,
            self.top_bottom_layers,
            self.brim_mskirt
        )
    }
}

/// Supported dialect allowlist (S8-004 validator re-uses this contract).
pub const SUPPORTED_DIALECTS: &[&str] = &["anycubic", "cura"];

const fn default_shell_layers() -> u32 {
    4
}

const fn default_line_width() -> f64 {
    0.45
}

#[derive(Debug, Error)]
pub enum JobError {
    #[error("unsupported dialect `{0}` (allowlist: {1:?})")]
    UnsupportedDialect(String, &'static [&'static str]),
    #[error("unsupported infill pattern for planar-core: {0:?}")]
    UnsupportedInfillPattern(InfillPattern),
    #[error("no build volume in machine profile (pre-flight §5)")]
    MissingBuildVolume,
    #[error("layer height {0} must be > 0")]
    NonPositiveLayerHeight(f64),
    #[error("layer height {0} must not exceed build volume z {1}")]
    LayerHeightExceedsVolume(f64, f64),
    #[error("wall loops {0} must be >= 1")]
    ZeroWallLoops(u32),
    #[error("mesh has no valid triangles")]
    EmptyMesh,
    #[error("mesh section at z={z} mm is not a closed 2-manifold contour: {reason}")]
    InvalidSliceContour { z: f64, reason: String },
    #[error("slice job cancelled")]
    Cancelled,
    #[error("slice job exceeds layer limit {0}")]
    LayerLimit(u32),
    #[error("mesh bounds exceed build volume: {axis} extent {min}..{max} mm, allowed {allowed_min}..{allowed_max} mm")]
    OutOfBuildVolume {
        axis: &'static str,
        min: f64,
        max: f64,
        allowed_min: f64,
        allowed_max: f64,
    },
    #[error("triangle normal is degenerate at index {0}")]
    DegenerateTriangle(usize),
    #[error("polygon offset failed for wall loop {loop}: {source}")]
    Offset {
        r#loop: u32,
        #[source]
        source: offset::OffsetError,
    },
    #[error("infill spacing: {0}")]
    Infill(#[from] infill::InfillError),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MeshValidationError {
    #[error("mesh has no triangles")]
    Empty,
    #[error("mesh triangle {triangle} has a non-finite vertex")]
    NonFiniteVertex { triangle: usize },
    #[error("mesh triangle {triangle} is geometrically degenerate")]
    DegenerateTriangle { triangle: usize },
    #[error("mesh edge {edge:?} has incidence {incidence}, expected exactly 2")]
    NonManifoldEdge {
        edge: ((i64, i64, i64), (i64, i64, i64)),
        incidence: usize,
    },
}

/// A triangle from the input mesh (owned copy — the slicer never borrows
/// caller memory beyond the call).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Triangle {
    pub v: [Pt3; 3],
    pub n: Pt3,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Pt3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Pt3 {
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
}

/// Independently check the indexed topology boundary used by native slice
/// preflight. Vertices are welded at a scale-aware tolerance; every undirected
/// edge must belong to exactly two non-degenerate triangles.
pub fn validate_watertight_mesh(mesh: &SliceMesh) -> Result<(), MeshValidationError> {
    if mesh.triangles.is_empty() {
        return Err(MeshValidationError::Empty);
    }
    let mut bounds = BBox::new();
    for (triangle_index, triangle) in mesh.triangles.iter().enumerate() {
        for vertex in triangle.v {
            if !vertex.x.is_finite() || !vertex.y.is_finite() || !vertex.z.is_finite() {
                return Err(MeshValidationError::NonFiniteVertex {
                    triangle: triangle_index,
                });
            }
            bounds.extend(&vertex);
        }
        let [a, b, c] = triangle.v;
        let ab = [b.x - a.x, b.y - a.y, b.z - a.z];
        let ac = [c.x - a.x, c.y - a.y, c.z - a.z];
        let cross = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        if cross.iter().map(|value| value * value).sum::<f64>() <= 1e-24 {
            return Err(MeshValidationError::DegenerateTriangle {
                triangle: triangle_index,
            });
        }
    }
    let scale = (bounds.max_x - bounds.min_x)
        .hypot((bounds.max_y - bounds.min_y).hypot(bounds.max_z - bounds.min_z))
        .max(1.0);
    let tolerance = scale * 1e-9;
    let key = |point: Pt3| {
        (
            (point.x / tolerance).round() as i64,
            (point.y / tolerance).round() as i64,
            (point.z / tolerance).round() as i64,
        )
    };
    let mut incidence = HashMap::new();
    for triangle in &mesh.triangles {
        let vertices = triangle.v.map(key);
        for (a, b) in [
            (vertices[0], vertices[1]),
            (vertices[1], vertices[2]),
            (vertices[2], vertices[0]),
        ] {
            let edge = if a < b { (a, b) } else { (b, a) };
            *incidence.entry(edge).or_insert(0usize) += 1;
        }
    }
    if let Some((edge, count)) = incidence.into_iter().find(|(_, count)| *count != 2) {
        return Err(MeshValidationError::NonManifoldEdge {
            edge,
            incidence: count,
        });
    }
    Ok(())
}

/// Input mesh: a triangle soup (convex, watertight for the subset we slice).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SliceMesh {
    pub triangles: Vec<Triangle>,
}

/// A printed path segment (one wall loop or one infill line). **Standard
/// mode: z is constant across the segment** (no Z-ramp ever emitted; the
/// S8-004 validator rejects any segment with z variation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub from: Pt3,
    pub to: Pt3,
    /// Deposited volume mm³ = ∫A_bead(s)ds over the segment.
    pub volume_mm3: f64,
    /// Filament length mm = V/A_filament.
    pub delta_e_mm: f64,
    /// Volumetric flow mm³/s at the tool speed.
    pub q_mm3_s: f64,
    pub kind: SegmentKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SegmentKind {
    Wall,
    Infill,
    Brim,
    Skirt,
}

/// One layer of the slice result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub index: u32,
    pub z: f64,
    pub segments: Vec<Segment>,
    /// Per-loop wall counts (for parity: outer wall = 0).
    pub per_loop_wall: Vec<u32>,
}

/// Deterministic slice metadata — this is what S8-004's IR validator and the
/// S8-005 postprocessor consume.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SliceMeta {
    pub version: String,
    pub dialect: String,
    pub mode: JobMode,
    pub profile_fingerprint: String,
    pub build_volume: BuildVolume,
    pub layers: Vec<Layer>,
}

impl SliceMeta {
    /// Canonical, deterministic serialization (serde field order — stable
    /// across runs for identical inputs). Used by the determinism test.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

/// Run a planar slice. Pre-flight checks (fail-closed): dialect allowlist,
/// build volume present, numeric sanity. Then uniform layers, wall insets,
/// grid infill, brim/skirt.
pub fn slice(mesh: &SliceMesh, profile: &PlanarProfile) -> Result<SliceMeta, JobError> {
    slice_with_progress(mesh, profile, || false, |_, _| {})
}

pub fn slice_with_progress<C, P>(
    mesh: &SliceMesh,
    profile: &PlanarProfile,
    mut cancelled: C,
    mut progress: P,
) -> Result<SliceMeta, JobError>
where
    C: FnMut() -> bool,
    P: FnMut(u32, u32),
{
    // ---- Pre-flight (fail-closed) ----
    if !SUPPORTED_DIALECTS.contains(&profile.dialect.as_str()) {
        return Err(JobError::UnsupportedDialect(
            profile.dialect.clone(),
            SUPPORTED_DIALECTS,
        ));
    }
    if profile.infill_pattern != InfillPattern::Grid
        && profile.infill_pattern != InfillPattern::GyroidSubset
    {
        return Err(JobError::UnsupportedInfillPattern(profile.infill_pattern));
    }
    let volume: BuildVolume = profile
        .build_volume_mm
        .ok_or(JobError::MissingBuildVolume)?
        .into();
    if profile.layer_height_mm <= 0.0 {
        return Err(JobError::NonPositiveLayerHeight(profile.layer_height_mm));
    }
    if profile.layer_height_mm > volume.z + 1e-9 {
        return Err(JobError::LayerHeightExceedsVolume(
            profile.layer_height_mm,
            volume.z,
        ));
    }
    if profile.wall_loops == 0 {
        return Err(JobError::ZeroWallLoops(profile.wall_loops));
    }
    if mesh.triangles.is_empty() {
        return Err(JobError::EmptyMesh);
    }

    // Mesh bounds (degenerate-normal check on every triangle).
    let mut bbox = BBox::new();
    for (i, t) in mesh.triangles.iter().enumerate() {
        if ultra_degenerate(&t.n) {
            return Err(JobError::DegenerateTriangle(i));
        }
        for v in &t.v {
            bbox.extend(v);
        }
    }
    if !bbox.valid() {
        return Err(JobError::EmptyMesh);
    }
    for (axis, min, max, allowed_min, allowed_max) in [
        ("x", bbox.min_x, bbox.max_x, -volume.x / 2.0, volume.x / 2.0),
        ("y", bbox.min_y, bbox.max_y, -volume.y / 2.0, volume.y / 2.0),
        ("z", bbox.min_z, bbox.max_z, 0.0, volume.z),
    ] {
        if min < allowed_min - 1e-9 || max > allowed_max + 1e-9 {
            return Err(JobError::OutOfBuildVolume {
                axis,
                min,
                max,
                allowed_min,
                allowed_max,
            });
        }
    }

    // ---- Layer generation (uniform) ----
    // Layer count comes from the PART height (mesh bbox z), not the full
    // build volume — real slicers slice the part. Build volume is a cap
    // (checked above), and each layer's z must stay within it.
    let part_height = bbox.max_z - bbox.min_z;
    if part_height <= 0.0 {
        return Err(JobError::EmptyMesh);
    }
    let layer_count = (part_height / profile.layer_height_mm).ceil() as u32;
    let layer_count = layer_count.clamp(1, (volume.z / profile.layer_height_mm).floor() as u32);
    if layer_count > 5000 {
        return Err(JobError::LayerLimit(5000));
    }
    let bead = Bead {
        width_mm: profile.line_width_mm,
        height_mm: profile.layer_height_mm,
    };

    let mut layers = Vec::with_capacity(layer_count as usize);
    let z0 = bbox.min_z;
    for i in 0..layer_count {
        if cancelled() {
            return Err(JobError::Cancelled);
        }
        progress(i, layer_count);
        let z = z0 + (i as f64 + 1.0) * profile.layer_height_mm;
        layers.push(build_layer(i, z, layer_count, &bbox, profile, &bead, mesh)?);
    }
    progress(layer_count, layer_count);

    let profile_fingerprint = profile_fingerprint(profile);

    Ok(SliceMeta {
        version: crate::PLANAR_CORE_VERSION.to_string(),
        dialect: profile.dialect.clone(),
        mode: JobMode::Standard,
        profile_fingerprint,
        build_volume: volume,
        layers,
    })
}

/// Shrink-safe bounds over the union of layer cross-sections. Each layer
/// slices at its own z → the footprint is the mesh's XY bbox (for the convex
/// part subset we support). This bbox doubles as the infill clip region.
#[derive(Debug, Clone)]
struct BBox {
    min_x: f64,
    min_y: f64,
    min_z: f64,
    max_x: f64,
    max_y: f64,
    max_z: f64,
    touched: bool,
}

impl BBox {
    fn new() -> Self {
        Self {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            min_z: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
            max_z: f64::NEG_INFINITY,
            touched: false,
        }
    }
    fn extend(&mut self, p: &Pt3) {
        self.min_x = self.min_x.min(p.x);
        self.min_y = self.min_y.min(p.y);
        self.min_z = self.min_z.min(p.z);
        self.max_x = self.max_x.max(p.x);
        self.max_y = self.max_y.max(p.y);
        self.max_z = self.max_z.max(p.z);
        self.touched = true;
    }
    fn valid(&self) -> bool {
        self.touched
            && self.min_x.is_finite()
            && self.max_x.is_finite()
            && self.max_x > self.min_x
            && self.max_y > self.min_y
            && self.max_z >= self.min_z
    }
}

fn ultra_degenerate(n: &Pt3) -> bool {
    let l2 = n.x * n.x + n.y * n.y + n.z * n.z;
    !l2.is_finite() || l2 <= 1e-24
}

/// Build one layer from the actual mesh section. Coplanar triangle edges use
/// a half-open rule (z-min exclusive, z-max inclusive); section endpoints are
/// welded within a scale-aware tolerance. Open or branching sections fail
/// closed rather than being replaced by a bounding rectangle.
fn build_layer(
    index: u32,
    z: f64,
    layer_count: u32,
    bbox: &BBox,
    profile: &PlanarProfile,
    bead: &Bead,
    mesh: &SliceMesh,
) -> Result<Layer, JobError> {
    let region = section_region(mesh, z, bbox)?;
    let mut segments: Vec<Segment> = Vec::new();
    let mut per_loop_wall: Vec<u32> = Vec::new();

    let speed_mm_s = 30.0; // conservative default tool speed (mm/s)

    // ---- Wall loops (inset) ----
    for loop_idx in 0..profile.wall_loops {
        let inset = region.buffer(-profile.line_width_mm * (loop_idx as f64 + 0.5));
        if inset.0.is_empty() {
            break;
        }
        emit_region_boundaries(
            &mut segments,
            &inset,
            z,
            bead,
            profile,
            speed_mm_s,
            SegmentKind::Wall,
        );
        per_loop_wall.push(loop_idx);
    }

    // ---- Infill (grid or gyroid-subset), or a solid shell layer ----
    let shells = profile.top_bottom_layers.min(layer_count / 2);
    let is_solid = index < shells || index >= layer_count.saturating_sub(shells);
    if profile.infill_density_pct > 0.0 || is_solid {
        let inset_distance = profile.line_width_mm * (profile.wall_loops as f64 + 0.5);
        let interior = region.buffer(-inset_distance);
        let Some((clip_min_x, clip_min_y, clip_max_x, clip_max_y)) = region_bounds(&interior)
        else {
            return Ok(Layer {
                index,
                z,
                segments,
                per_loop_wall,
            });
        };
        let size_x = clip_max_x - clip_min_x;
        let size_y = clip_max_y - clip_min_y;
        let gp = GridParams {
            // Solid shells printed at 100% density (line spacing = bead
            // width → touching beads, single orientation).
            density_pct: if is_solid {
                100.0
            } else {
                profile.infill_density_pct
            },
            line_width_mm: bead.width_mm,
            bbox_min_x: clip_min_x,
            bbox_min_y: clip_min_y,
            bbox_size_x: size_x,
            bbox_size_y: size_y,
        };
        match profile.infill_pattern {
            InfillPattern::Grid => {
                // Solid shells: single orientation, touching beads (spacing
                // exactly = line width → true 100% cover). Sparse grid keeps
                // the two-orientation 2·w/s spacing.
                let lines: GridLines =
                    infill::grid_lines(&gp, if is_solid { Some(bead.width_mm) } else { None })?;
                let mut candidates = Vec::new();
                if is_solid {
                    for x in &lines.vertical {
                        candidates.push(LineString::new(vec![
                            Coord {
                                x: *x,
                                y: clip_min_y,
                            },
                            Coord {
                                x: *x,
                                y: clip_max_y,
                            },
                        ]));
                    }
                } else {
                    for x in &lines.vertical {
                        candidates.push(LineString::new(vec![
                            Coord {
                                x: *x,
                                y: clip_min_y,
                            },
                            Coord {
                                x: *x,
                                y: clip_max_y,
                            },
                        ]));
                    }
                    for y in &lines.horizontal {
                        candidates.push(LineString::new(vec![
                            Coord {
                                x: clip_min_x,
                                y: *y,
                            },
                            Coord {
                                x: clip_max_x,
                                y: *y,
                            },
                        ]));
                    }
                }
                emit_clipped_lines(
                    &mut segments,
                    &interior,
                    &candidates,
                    z,
                    bead,
                    profile,
                    speed_mm_s,
                );
            }
            InfillPattern::GyroidSubset => {
                // Gyroid period = spacing (one wavelength per inter-line gap).
                let period = infill::grid_spacing(
                    if is_solid {
                        100.0
                    } else {
                        profile.infill_density_pct
                    },
                    bead.width_mm,
                    size_x,
                    size_y,
                )?;
                if period.is_finite() {
                    let curves = infill::gyroid_lines(&gp, None, period)?;
                    let candidates: Vec<_> = curves
                        .iter()
                        .map(|line| {
                            LineString::new(
                                line.pts
                                    .iter()
                                    .map(|(x, y)| Coord { x: *x, y: *y })
                                    .collect(),
                            )
                        })
                        .collect();
                    emit_clipped_lines(
                        &mut segments,
                        &interior,
                        &candidates,
                        z,
                        bead,
                        profile,
                        speed_mm_s,
                    );
                }
            }
        }
    }

    // ---- Brim / skirt (first layer only) ----
    // `brim_mskirt` = brim width in mm. A brim is a lattice of outset rings
    // attached to the part; a skirt is a single detached ring outside the
    // part. Both are approximated deterministically here:
    //   - skirt: one outset ring at distance w from the part edge
    //   - brim:  one outset ring at distance w/2 (touches the part)
    // (basic subset — multi-ring lattices are out of scope for S8-002.)
    if index == 0 {
        if let Some(w) = profile.brim_mskirt {
            if w > 0.0 {
                let kind = if w <= 0.5 {
                    SegmentKind::Skirt
                } else {
                    SegmentKind::Brim
                };
                let dist = if w <= 0.5 { w } else { w / 2.0 };
                let adhesion = region.buffer(dist);
                emit_region_boundaries(
                    &mut segments,
                    &adhesion,
                    z,
                    bead,
                    profile,
                    speed_mm_s,
                    kind,
                );
            }
        }
    }

    Ok(Layer {
        index,
        z,
        segments,
        per_loop_wall,
    })
}

fn section_region(mesh: &SliceMesh, z: f64, bbox: &BBox) -> Result<MultiPolygon<f64>, JobError> {
    let tolerance = ((bbox.max_x - bbox.min_x).hypot(bbox.max_y - bbox.min_y) * 1e-9).max(1e-8);
    let mut points = Vec::new();
    let mut raw_segments = Vec::new();
    for triangle in &mesh.triangles {
        let mut intersections = Vec::with_capacity(2);
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            let start = triangle.v[a];
            let end = triangle.v[b];
            let start_side = if (start.z - z).abs() <= tolerance || start.z > z {
                1
            } else {
                -1
            };
            let end_side = if (end.z - z).abs() <= tolerance || end.z > z {
                1
            } else {
                -1
            };
            if start_side == end_side {
                continue;
            }
            let t = ((z - start.z) / (end.z - start.z)).clamp(0.0, 1.0);
            let point = Pt::new(
                start.x + (end.x - start.x) * t,
                start.y + (end.y - start.y) * t,
            );
            if intersections
                .iter()
                .all(|other: &Pt| distance(other, &point) > tolerance)
            {
                intersections.push(point);
            }
        }
        if intersections.len() == 2 && distance(&intersections[0], &intersections[1]) > tolerance {
            raw_segments.push((intersections[0], intersections[1]));
        }
    }
    if raw_segments.is_empty() {
        return Err(JobError::InvalidSliceContour {
            z,
            reason: "section contains no crossing edges".to_owned(),
        });
    }

    let mut node_by_key = HashMap::new();
    let mut edges = Vec::with_capacity(raw_segments.len());
    let mut edge_set = HashSet::new();
    for (a, b) in raw_segments {
        let ai = contour_node(a, tolerance, &mut points, &mut node_by_key);
        let bi = contour_node(b, tolerance, &mut points, &mut node_by_key);
        if ai == bi {
            continue;
        }
        let key = if ai < bi { (ai, bi) } else { (bi, ai) };
        if !edge_set.insert(key) {
            return Err(JobError::InvalidSliceContour {
                z,
                reason: "duplicate section edge".to_owned(),
            });
        }
        edges.push((ai, bi));
    }
    let mut adjacency = vec![Vec::new(); points.len()];
    for (edge_index, (a, b)) in edges.iter().copied().enumerate() {
        adjacency[a].push((b, edge_index));
        adjacency[b].push((a, edge_index));
    }
    if let Some((node, neighbors)) = adjacency
        .iter()
        .enumerate()
        .find(|(_, neighbors)| neighbors.len() != 2)
    {
        return Err(JobError::InvalidSliceContour {
            z,
            reason: format!(
                "welded contour vertex {node} has degree {}, expected 2",
                neighbors.len()
            ),
        });
    }

    let mut used = vec![false; edges.len()];
    let mut rings = Vec::new();
    for start_edge in 0..edges.len() {
        if used[start_edge] {
            continue;
        }
        let (start, mut current) = edges[start_edge];
        let mut previous_edge = start_edge;
        let mut ring = vec![points[start]];
        used[start_edge] = true;
        let mut steps = 0usize;
        while current != start {
            ring.push(points[current]);
            let Some((next, edge)) = adjacency[current]
                .iter()
                .copied()
                .find(|(_, edge)| *edge != previous_edge)
            else {
                break;
            };
            if used[edge] {
                return Err(JobError::InvalidSliceContour {
                    z,
                    reason: "contour revisited an edge before closure".to_owned(),
                });
            }
            used[edge] = true;
            previous_edge = edge;
            current = next;
            steps += 1;
            if steps > edges.len() {
                return Err(JobError::InvalidSliceContour {
                    z,
                    reason: "contour traversal exceeded section edge count".to_owned(),
                });
            }
        }
        if current != start || ring.len() < 3 {
            return Err(JobError::InvalidSliceContour {
                z,
                reason: "open or degenerate contour".to_owned(),
            });
        }
        ring.push(ring[0]);
        rings.push(LineString::new(
            ring.into_iter()
                .map(|point| Coord {
                    x: point.x,
                    y: point.y,
                })
                .collect(),
        ));
    }

    let ring_polygons: Vec<_> = rings
        .iter()
        .cloned()
        .map(|ring| Polygon::new(ring, vec![]))
        .collect();
    let areas: Vec<_> = ring_polygons.iter().map(geo::Area::unsigned_area).collect();
    let mut parents = vec![None; rings.len()];
    let mut depths = vec![0usize; rings.len()];
    for child in 0..rings.len() {
        let point = ring_polygons[child].exterior().0[0];
        let parent = (0..rings.len())
            .filter(|candidate| *candidate != child && areas[*candidate] > areas[child])
            .filter(|candidate| ring_polygons[*candidate].contains(&Point::new(point.x, point.y)))
            .min_by(|a, b| areas[*a].total_cmp(&areas[*b]));
        parents[child] = parent;
        let mut ancestor = parent;
        while let Some(index) = ancestor {
            depths[child] += 1;
            ancestor = parents[index];
        }
    }
    let mut polygons = Vec::new();
    for outer in 0..rings.len() {
        if depths[outer] % 2 != 0 {
            continue;
        }
        let holes = (0..rings.len())
            .filter(|candidate| parents[*candidate] == Some(outer) && depths[*candidate] % 2 == 1)
            .map(|candidate| rings[candidate].clone())
            .collect();
        polygons.push(Polygon::new(rings[outer].clone(), holes));
    }
    Ok(MultiPolygon(polygons))
}

fn contour_node(
    point: Pt,
    tolerance: f64,
    points: &mut Vec<Pt>,
    node_by_key: &mut HashMap<(i64, i64), usize>,
) -> usize {
    let key = (
        (point.x / tolerance).round() as i64,
        (point.y / tolerance).round() as i64,
    );
    *node_by_key.entry(key).or_insert_with(|| {
        points.push(point);
        points.len() - 1
    })
}

fn distance(a: &Pt, b: &Pt) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}

fn region_bounds(region: &MultiPolygon<f64>) -> Option<(f64, f64, f64, f64)> {
    let mut bounds: Option<(f64, f64, f64, f64)> = None;
    for polygon in &region.0 {
        for point in polygon
            .exterior()
            .0
            .iter()
            .chain(polygon.interiors().iter().flat_map(|ring| ring.0.iter()))
        {
            bounds = Some(match bounds {
                Some((min_x, min_y, max_x, max_y)) => (
                    min_x.min(point.x),
                    min_y.min(point.y),
                    max_x.max(point.x),
                    max_y.max(point.y),
                ),
                None => (point.x, point.y, point.x, point.y),
            });
        }
    }
    bounds
}

fn emit_region_boundaries(
    segments: &mut Vec<Segment>,
    region: &MultiPolygon<f64>,
    z: f64,
    bead: &Bead,
    profile: &PlanarProfile,
    speed_mm_s: f64,
    kind: SegmentKind,
) {
    for polygon in &region.0 {
        for ring in std::iter::once(polygon.exterior()).chain(polygon.interiors()) {
            for pair in ring.0.windows(2) {
                push_segment(
                    segments,
                    Pt3::new(pair[0].x, pair[0].y, z),
                    Pt3::new(pair[1].x, pair[1].y, z),
                    bead,
                    profile,
                    speed_mm_s,
                    kind,
                );
            }
        }
    }
}

fn emit_clipped_lines(
    segments: &mut Vec<Segment>,
    region: &MultiPolygon<f64>,
    candidates: &[LineString<f64>],
    z: f64,
    bead: &Bead,
    profile: &PlanarProfile,
    speed_mm_s: f64,
) {
    let clipped = region.clip(&MultiLineString(candidates.to_vec()), false);
    for line in &clipped.0 {
        for pair in line.0.windows(2) {
            push_segment(
                segments,
                Pt3::new(pair[0].x, pair[0].y, z),
                Pt3::new(pair[1].x, pair[1].y, z),
                bead,
                profile,
                speed_mm_s,
                SegmentKind::Infill,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn push_segment(
    segments: &mut Vec<Segment>,
    from: Pt3,
    to: Pt3,
    bead: &Bead,
    profile: &PlanarProfile,
    speed_mm_s: f64,
    kind: SegmentKind,
) {
    let len = dist2(&from, &to);
    if len <= 0.0 {
        return;
    }
    let v = crate::extrusion::extrusion_volume(len, bead).unwrap_or(0.0);
    segments.push(Segment {
        from,
        to,
        volume_mm3: v,
        delta_e_mm: v / profile.filament.area(),
        q_mm3_s: crate::extrusion::steady_state_q(speed_mm_s, bead),
        kind,
    });
}

fn dist2(a: &Pt3, b: &Pt3) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let dz = b.z - a.z;
    (dx * dx + dy * dy + dz * dz).sqrt()
}

/// Deterministic 16-char fingerprint of the effective profile (all fields
/// that change output, including the machine build volume: layer count and
/// bounds come from it). `serde_json::to_string` on the derived Serialize is
/// stable in field order → byte-identical hashes.
pub fn profile_fingerprint(profile: &PlanarProfile) -> String {
    let mut s = Vec::new();
    s.extend_from_slice(profile.dialect.as_bytes());
    s.push(b'|');
    s.extend_from_slice(
        format!(
            "{}:{}:{}:{}:{}:{}",
            profile.layer_height_mm,
            profile.wall_loops,
            profile.infill_density_pct,
            profile.nozzle_diameter_mm,
            profile.line_width_mm,
            profile.filament.diameter_mm
        )
        .as_bytes(),
    );
    s.push(b'|');
    s.extend_from_slice(match profile.infill_pattern {
        InfillPattern::Grid => b"grid",
        InfillPattern::GyroidSubset => b"gyroid_subset",
    });
    s.extend_from_slice(format!("|shells:{}", profile.top_bottom_layers).as_bytes());
    s.extend_from_slice(format!("|{:?}", profile.brim_mskirt).as_bytes());
    if let Some(v) = profile.build_volume_mm {
        s.extend_from_slice(format!("|vol:{}x{}x{}", v.x, v.y, v.z).as_bytes());
    } else {
        s.extend_from_slice(b"|vol:none");
    }
    let mut out = String::with_capacity(16);
    for b in fnv1a(&s).to_le_bytes() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Sort a BTreeMap-preserved JSON object for human display (unused in
/// serialized metadata — kept for tests).
pub fn sorted_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let sorted: BTreeMap<String, serde_json::Value> =
                map.into_iter().map(|(k, v)| (k, sorted_json(v))).collect();
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(sorted_json).collect())
        }
        other => other,
    }
}
