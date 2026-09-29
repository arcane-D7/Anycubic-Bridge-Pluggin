//! Planar slice engine — uniform layers, wall loops (inset), grid infill,
//! brim/skirt basic. Extrusion from §3.3 closed-form (see `extrusion`).

use std::collections::BTreeMap;
use std::fmt;

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
    let bead = Bead {
        width_mm: profile.line_width_mm,
        height_mm: profile.layer_height_mm,
    };

    let mut layers = Vec::with_capacity(layer_count as usize);
    let z0 = bbox.min_z;
    for i in 0..layer_count {
        let z = z0 + (i as f64 + 1.0) * profile.layer_height_mm;
        layers.push(build_layer(i, z, layer_count, &bbox, profile, &bead, mesh)?);
    }

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
    fn footprint(&self) -> [Pt; 4] {
        [
            Pt::new(self.min_x, self.min_y),
            Pt::new(self.max_x, self.min_y),
            Pt::new(self.max_x, self.max_y),
            Pt::new(self.min_x, self.max_y),
        ]
    }
}

fn ultra_degenerate(n: &Pt3) -> bool {
    let l2 = n.x * n.x + n.y * n.y + n.z * n.z;
    !l2.is_finite() || l2 <= 1e-24
}

/// Build one layer: walls (inset loops) + infill (grid/gyroid, or a solid
/// top/bottom shell) + brim/skirt on first layer. Extrusion per §3.3.
fn build_layer(
    index: u32,
    z: f64,
    layer_count: u32,
    bbox: &BBox,
    profile: &PlanarProfile,
    bead: &Bead,
    _mesh: &SliceMesh,
) -> Result<Layer, JobError> {
    let footprint = bbox.footprint();
    let mut segments: Vec<Segment> = Vec::new();
    let mut per_loop_wall: Vec<u32> = Vec::new();

    let speed_mm_s = 30.0; // conservative default tool speed (mm/s)

    // ---- Wall loops (inset) ----
    let mut current: Vec<Pt> = footprint.to_vec();
    for loop_idx in 0..profile.wall_loops {
        // Outer wall inset by half the line width; each inner wall an
        // additional full line width (standard slicer semantics).
        let inset = profile.line_width_mm * (loop_idx as f64 + 0.5);
        let inner = offset::inset_ring(&current, inset).map_err(|source| JobError::Offset {
            r#loop: loop_idx,
            source,
        })?;
        for w in 0..inner.len() {
            let a = inner[w];
            let b = inner[(w + 1) % inner.len()];
            let from = Pt3::new(a.x, a.y, z);
            let to = Pt3::new(b.x, b.y, z);
            let len = dist2(&from, &to);
            if len > 0.0 {
                let v = crate::extrusion::extrusion_volume(len, bead).unwrap_or(0.0);
                segments.push(Segment {
                    from,
                    to,
                    volume_mm3: v,
                    delta_e_mm: v / profile.filament.area(),
                    q_mm3_s: crate::extrusion::steady_state_q(speed_mm_s, bead),
                    kind: SegmentKind::Wall,
                });
            }
        }
        per_loop_wall.push(loop_idx);
        current = inner;
    }

    // ---- Infill (grid or gyroid-subset), or a solid shell layer ----
    let shells = profile.top_bottom_layers.min(layer_count / 2);
    let is_solid = index < shells || index >= layer_count.saturating_sub(shells);
    if profile.infill_density_pct > 0.0 || is_solid {
        // Infill is clipped to the interior of the innermost wall ring
        // (standard slicer semantics — infill never crosses the walls).
        // Falls back to the mesh bbox when there are no walls.
        let (clip_min_x, clip_min_y, clip_max_x, clip_max_y) = if !current.is_empty() {
            let mnx = current.iter().fold(f64::INFINITY, |a, p| a.min(p.x));
            let mny = current.iter().fold(f64::INFINITY, |a, p| a.min(p.y));
            let mxx = current.iter().fold(f64::NEG_INFINITY, |a, p| a.max(p.x));
            let mxy = current.iter().fold(f64::NEG_INFINITY, |a, p| a.max(p.y));
            (mnx, mny, mxx, mxy)
        } else {
            (bbox.min_x, bbox.min_y, bbox.max_x, bbox.max_y)
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
                if is_solid {
                    for x in &lines.vertical {
                        let from = Pt3::new(*x, clip_min_y, z);
                        let to = Pt3::new(*x, clip_max_y, z);
                        push_segment(
                            &mut segments,
                            from,
                            to,
                            bead,
                            profile,
                            speed_mm_s,
                            SegmentKind::Infill,
                        );
                    }
                } else {
                    for x in &lines.vertical {
                        let from = Pt3::new(*x, clip_min_y, z);
                        let to = Pt3::new(*x, clip_max_y, z);
                        push_segment(
                            &mut segments,
                            from,
                            to,
                            bead,
                            profile,
                            speed_mm_s,
                            SegmentKind::Infill,
                        );
                    }
                    for y in &lines.horizontal {
                        let from = Pt3::new(clip_min_x, *y, z);
                        let to = Pt3::new(clip_max_x, *y, z);
                        push_segment(
                            &mut segments,
                            from,
                            to,
                            bead,
                            profile,
                            speed_mm_s,
                            SegmentKind::Infill,
                        );
                    }
                }
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
                    for line in &curves {
                        for pair in line.pts.windows(2) {
                            let (x0, y0) = pair[0];
                            let (x1, y1) = pair[1];
                            let from = Pt3::new(x0, y0, z);
                            let to = Pt3::new(x1, y1, z);
                            push_segment(
                                &mut segments,
                                from,
                                to,
                                bead,
                                profile,
                                speed_mm_s,
                                SegmentKind::Infill,
                            );
                        }
                    }
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
                let ring =
                    offset::outset_ring(&footprint, dist).map_err(|source| JobError::Offset {
                        r#loop: u32::MAX,
                        source,
                    })?;
                for w_ in 0..ring.len() {
                    let a = ring[w_];
                    let b = ring[(w_ + 1) % ring.len()];
                    let from = Pt3::new(a.x, a.y, z);
                    let to = Pt3::new(b.x, b.y, z);
                    let len = dist2(&from, &to);
                    if len > 0.0 {
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
                }
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
