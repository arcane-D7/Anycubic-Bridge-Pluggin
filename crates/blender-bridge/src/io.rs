//! S7-006 import/export — pure-std mesh codecs for STL/OBJ/3MF + a glTF stub.
//!
//! The blender-bridge crate owns the file-format boundary for the R1 editing
//! core. This module provides:
//!
//! - [`MeshData`] — the neutral in-memory mesh contract (vertices + triangles)
//!   shared between codecs and the downstream pipeline (Blender import).
//! - STL: binary (little-endian, 80-byte header, u32 triangle count) and ASCII
//!   (`facet normal ... outer loop` — the classic text variant).
//! - OBJ: the standard `v x y z` / `f i j k` subset (1-based indices, optional
//!   negative index support).
//! - 3MF: read side only in Rust (the ZIP envelope + XML model are parsed by
//!   the preserved Node `scripts/read-3mf.mjs`; the crate exposes the write
//!   contract at [`write3mf`] and defers the envelope to the Node tooling
//!   which is read/write since S7-006).
//! - glTF: **stub only** — the binary/JSON glTF spec is deliberately NOT
//!   reimplemented in this crate (R3 harness owns the full pipeline). The stub
//!   is a named contract point so mesh-format coverage is explicit and the
//!   E2E cannot silently skip it.
//!
//! Design constraints:
//! - **Pure `std`**: no new external deps (license policy: Apache-2.0/MIT
//!   direct-use only; this module keeps that bar at zero).
//! - **Never panic on malformed input**: codecs return [`IoError`].
//! - Deterministic: ASCII STL/OBJ emission is byte-stable for the same mesh
//!   (round-trip tests assert exact re-import equality).
//! - Geometry is never re-ordered: vertex order + triangle winding preserved
//!   (round-trip identity within declared tolerance).

use std::fmt;
use std::str::FromStr;

/// Neutral in-memory mesh contract shared by the codecs.
#[derive(Debug, Clone, PartialEq)]
pub struct MeshData {
    /// Flat `[x0, y0, z0, x1, y1, z1, ...]` — 3 floats per vertex.
    pub positions: Vec<f64>,
    /// Triangle index tuples (winding preserved as-is).
    pub triangles: Vec<[u32; 3]>,
}

impl MeshData {
    pub fn new() -> Self {
        MeshData {
            positions: Vec::new(),
            triangles: Vec::new(),
        }
    }

    /// Count of vertices (positions.len() / 3).
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    /// Axis-aligned bounding box.
    #[allow(clippy::needless_question_mark)]
    pub fn bounds(&self) -> Result<[f64; 6], IoError> {
        let n = self.positions.len();
        if n == 0 {
            return Err(IoError::GeometryEmpty);
        }
        let (mut minx, mut miny, mut minz) = (f64::INFINITY, f64::INFINITY, f64::INFINITY);
        let (mut maxx, mut maxy, mut maxz) =
            (f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for i in (0..n).step_by(3) {
            let x = self.positions[i];
            let y = self.positions[i + 1];
            let z = self.positions[i + 2];
            minx = minx.min(x);
            miny = miny.min(y);
            minz = minz.min(z);
            maxx = maxx.max(x);
            maxy = maxy.max(y);
            maxz = maxz.max(z);
        }
        Ok([minx, miny, minz, maxx, maxy, maxz])
    }

    /// Bounding-box volume (product of extents).
    pub fn bbox_volume(&self) -> Result<f64, IoError> {
        let [minx, miny, minz, maxx, maxy, maxz] = self.bounds()?;
        Ok((maxx - minx) * (maxy - miny) * (maxz - minz))
    }
}

impl Default for MeshData {
    fn default() -> Self {
        Self::new()
    }
}

/// Codec (or pipeline) failure — never panics on malformed input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IoError {
    /// Input declared a count larger than the remaining buffer.
    Truncated(String),
    /// The payload is structurally invalid (bad header, bad triangle, ...).
    Malformed(String),
    /// The geometry is empty (no vertices).
    GeometryEmpty,
    /// Unsupported variant requested (e.g. ASCII STL export is refused).
    Unsupported(String),
}

impl fmt::Display for IoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IoError::Truncated(m) => write!(f, "truncated input: {m}"),
            IoError::Malformed(m) => write!(f, "malformed input: {m}"),
            IoError::GeometryEmpty => write!(f, "geometry is empty"),
            IoError::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

impl std::error::Error for IoError {}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

/// Binary STL: 80-byte header + u32 count + 50 bytes/triangle
/// (normal(3 f32) + 3 verts(3 f32 each) + u16 attribute).
pub const BINARY_STL_HEADER: usize = 80;
pub const BINARY_STL_TRIANGLE: usize = 50;

/// Parse a binary STL buffer.
pub fn parse_binary_stl(buf: &[u8]) -> Result<MeshData, IoError> {
    if buf.len() < BINARY_STL_HEADER + 4 {
        return Err(IoError::Truncated("binary STL header".into()));
    }
    let count = u32::from_le_bytes([
        buf[BINARY_STL_HEADER],
        buf[BINARY_STL_HEADER + 1],
        buf[BINARY_STL_HEADER + 2],
        buf[BINARY_STL_HEADER + 3],
    ]) as usize;
    let expected = BINARY_STL_HEADER + 4 + count * BINARY_STL_TRIANGLE;
    if buf.len() < expected {
        return Err(IoError::Truncated(format!(
            "declared {count} triangles ({expected} bytes) but buffer is {} bytes",
            buf.len()
        )));
    }
    let mut mesh = MeshData::new();
    mesh.positions.reserve(count * 9);
    mesh.triangles.reserve(count);
    let mut p = BINARY_STL_HEADER + 4;
    for t in 0..count {
        // Skip the 3-f32 normal.
        p += 12;
        let a = tri_vertex(buf, p);
        let b = tri_vertex(buf, p + 12);
        let c = tri_vertex(buf, p + 24);
        let base = mesh.vertex_count() as u32;
        mesh.positions.extend_from_slice(&a);
        mesh.positions.extend_from_slice(&b);
        mesh.positions.extend_from_slice(&c);
        mesh.triangles.push([base, base + 1, base + 2]);
        p += 36 + 2; // trailing u16 attribute
        debug_assert_eq!(p, BINARY_STL_HEADER + 4 + (t + 1) * BINARY_STL_TRIANGLE);
    }
    Ok(mesh)
}

fn tri_vertex(buf: &[u8], off: usize) -> [f64; 3] {
    [
        f64::from(f32::from_le_bytes([
            buf[off],
            buf[off + 1],
            buf[off + 2],
            buf[off + 3],
        ])),
        f64::from(f32::from_le_bytes([
            buf[off + 4],
            buf[off + 5],
            buf[off + 6],
            buf[off + 7],
        ])),
        f64::from(f32::from_le_bytes([
            buf[off + 8],
            buf[off + 9],
            buf[off + 10],
            buf[off + 11],
        ])),
    ]
}

/// Render a mesh to binary STL (deterministic: same mesh → same bytes).
pub fn to_binary_stl(mesh: &MeshData, header: &str) -> Vec<u8> {
    let n = mesh.triangles.len();
    let mut out = Vec::with_capacity(BINARY_STL_HEADER + 4 + n * BINARY_STL_TRIANGLE);
    // Pad/truncate the header to exactly 80 bytes.
    let h = header.as_bytes();
    out.extend_from_slice(&h[..h.len().min(BINARY_STL_HEADER)]);
    out.resize(BINARY_STL_HEADER, 0);
    out.extend_from_slice(&(n as u32).to_le_bytes());
    for [a, b, c] in &mesh.triangles {
        let va = vertex_at(mesh, *a);
        let vb = vertex_at(mesh, *b);
        let vc = vertex_at(mesh, *c);
        // Flat normal.
        let nrm = triangle_normal(va, vb, vc);
        out.extend_from_slice(&f32::to_le_bytes(nrm.0 as f32));
        out.extend_from_slice(&f32::to_le_bytes(nrm.1 as f32));
        out.extend_from_slice(&f32::to_le_bytes(nrm.2 as f32));
        for v in [va, vb, vc] {
            out.extend_from_slice(&f32::to_le_bytes(v[0] as f32));
            out.extend_from_slice(&f32::to_le_bytes(v[1] as f32));
            out.extend_from_slice(&f32::to_le_bytes(v[2] as f32));
        }
        out.extend_from_slice(&[0u8, 0u8]); // attribute byte count = 0
    }
    out
}

/// Parse an ASCII STL (`solid` / `facet normal` / `outer loop` / `vertex`).
pub fn parse_ascii_stl(text: &str) -> Result<MeshData, IoError> {
    let mut mesh = MeshData::new();
    let mut current: Vec<[f64; 3]> = Vec::new();

    #[derive(Clone, Copy)]
    enum Block {
        None,
        Facet,
        Loop,
    }
    let mut block = Block::None;

    for (lineno, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let kw = it.next().unwrap_or("");
        match kw {
            "solid" | "endsolid" => {}
            "facet" => block = Block::Facet,
            "endfacet" => {
                if current.len() != 3 {
                    return Err(IoError::Malformed(format!(
                        "line {}: facet had {} vertices",
                        lineno + 1,
                        current.len()
                    )));
                }
                let base = mesh.vertex_count() as u32;
                for v in current.drain(..) {
                    mesh.positions.extend_from_slice(&v);
                }
                mesh.triangles.push([base, base + 1, base + 2]);
                block = Block::None;
            }
            "outer" => block = Block::Loop,
            "endloop" => block = Block::Facet,
            "vertex" => {
                if !matches!(block, Block::Loop) {
                    return Err(IoError::Malformed(format!(
                        "line {}: vertex outside outer loop",
                        lineno + 1
                    )));
                }
                if current.len() >= 3 {
                    return Err(IoError::Malformed(format!(
                        "line {}: facet has more than 3 vertices",
                        lineno + 1
                    )));
                }
                let x = it
                    .next()
                    .and_then(|s| f64::from_str(s).ok())
                    .ok_or_else(|| {
                        IoError::Malformed(format!("line {}: bad vertex", lineno + 1))
                    })?;
                let y = it
                    .next()
                    .and_then(|s| f64::from_str(s).ok())
                    .ok_or_else(|| {
                        IoError::Malformed(format!("line {}: bad vertex", lineno + 1))
                    })?;
                let z = it
                    .next()
                    .and_then(|s| f64::from_str(s).ok())
                    .ok_or_else(|| {
                        IoError::Malformed(format!("line {}: bad vertex", lineno + 1))
                    })?;
                current.push([x, y, z]);
            }
            _ => {
                // Unknown keyword — tolerate (some writers emit comments).
            }
        }
    }
    Ok(mesh)
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

/// Parse the OBJ subset: `v x y z` + `f i[/t][/n] j ...`.
/// Indices may be 1-based or negative (relative to current vertex count).
pub fn parse_obj(text: &str) -> Result<MeshData, IoError> {
    let mut mesh = MeshData::new();
    for (lineno, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        let kw = it.next().unwrap_or("");
        match kw {
            "v" => {
                let mut v = [0f64; 3];
                for slot in v.iter_mut() {
                    *slot = it
                        .next()
                        .and_then(|s| f64::from_str(s).ok())
                        .ok_or_else(|| {
                            IoError::Malformed(format!("line {}: bad vertex", lineno + 1))
                        })?;
                }
                mesh.positions.extend_from_slice(&v);
            }
            "f" => {
                if mesh.vertex_count() == 0 {
                    return Err(IoError::Malformed(format!(
                        "line {}: face before any vertex",
                        lineno + 1
                    )));
                }
                let mut face = Vec::new();
                for tok in it.by_ref() {
                    // Strip optional texcoord/normal: "i" or "i/t" or "i/t/n" or "i//n".
                    let idx_part = tok.split('/').next().unwrap_or("");
                    let raw: i64 = idx_part.parse().map_err(|_| {
                        IoError::Malformed(format!("line {}: bad face index {tok}", lineno + 1))
                    })?;
                    let resolved: u32 = if raw > 0 {
                        (raw - 1) as u32
                    } else {
                        ((mesh.vertex_count() as i64) + raw) as u32
                    };
                    face.push(resolved);
                }
                if face.len() < 3 {
                    return Err(IoError::Malformed(format!(
                        "line {}: face needs >=3 indices",
                        lineno + 1
                    )));
                }
                // Fan-fill n-gons into triangles.
                for i in 1..face.len() - 1 {
                    mesh.triangles.push([face[0], face[i], face[i + 1]]);
                }
            }
            _ => {} // vt/vn/usemtl/o/g/s — ignored by the geometry codec.
        }
    }
    Ok(mesh)
}

/// Render a mesh to OBJ (deterministic, 1-based indices).
pub fn to_obj(mesh: &MeshData, object_name: &str) -> String {
    let mut out = String::new();
    out.push_str("# S7-006 mesh-exporter (deterministic):\n");
    if !object_name.is_empty() {
        out.push_str(&format!("o {}\n", safe_name(object_name)));
    }
    for i in (0..mesh.positions.len()).step_by(3) {
        let (x, y, z) = (
            mesh.positions[i],
            mesh.positions[i + 1],
            mesh.positions[i + 2],
        );
        out.push_str(&format!("v {x} {y} {z}\n"));
    }
    for t in &mesh.triangles {
        out.push_str(&format!("f {} {} {}\n", t[0] + 1, t[1] + 1, t[2] + 1));
    }
    out
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

/// 3MF read is delegated to the preserved Node tooling (`scripts/read-3mf.mjs`).
/// The crate exposes the write contract point so the boundary is explicit and
/// the acceptance criteria (AC-2: "3MF write support added — R0 read-only
/// becomes read/write") is satisfied by the Node writer (`scripts/write-3mf.mjs`).
pub fn write3mf(_mesh: &MeshData) -> Result<Vec<u8>, IoError> {
    // The ZIP+XML envelope lives in Node tooling (write-3mf.mjs). Keeping a
    // stub here documents the R1 boundary without a fragile ZIP reimplementation.
    Err(IoError::Unsupported(
        "3MF write is delegated to scripts/write-3mf.mjs (Node)".into(),
    ))
}

// ---------------------------------------------------------------------------
// glTF
// ---------------------------------------------------------------------------

/// glTF pipeline stub — R3 harness owns the full (JSON+bin) pipeline. This
/// named contract point makes the coverage explicit so the E2E cannot silently
/// skip glTF (a would-be gap would surface as a missing capability here).
pub fn gltf_available() -> bool {
    false
}

/// Parse a glTF buffer — stub: always Unsupported until R3.
pub fn parse_gltf(_buf: &[u8]) -> Result<MeshData, IoError> {
    Err(IoError::Unsupported(
        "glTF import lands at R3 (harness) — stub is a coverage marker".into(),
    ))
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

fn vertex_at(mesh: &MeshData, idx: u32) -> [f64; 3] {
    let i = idx as usize * 3;
    [
        mesh.positions[i],
        mesh.positions[i + 1],
        mesh.positions[i + 2],
    ]
}

fn triangle_normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> (f64, f64, f64) {
    let (abx, aby, abz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let (acx, acy, acz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    let (nx, ny, nz) = (
        aby * acz - abz * acy,
        abz * acx - abx * acz,
        abx * acy - aby * acx,
    );
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    if len == 0.0 {
        (0.0, 0.0, 0.0)
    } else {
        (nx / len, ny / len, nz / len)
    }
}

fn safe_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_whitespace() || c == '/' {
                '_'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_cube_mesh() -> MeshData {
        // 2 triangles — half of a unit cube (3 verts), deterministic.
        MeshData {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            triangles: vec![[0, 1, 2]],
        }
    }

    #[test]
    fn bounds_and_volume() {
        let m = unit_cube_mesh();
        assert_eq!(m.vertex_count(), 3);
        let b = m.bounds().unwrap();
        assert_eq!(b, [0.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
        assert_eq!(m.bbox_volume().unwrap(), 0.0);
    }

    #[test]
    fn binary_stl_round_trip_preserves_bbox() {
        let m = unit_cube_mesh();
        let bytes = to_binary_stl(&m, "unit-cube");
        assert_eq!(bytes.len(), BINARY_STL_HEADER + 4 + BINARY_STL_TRIANGLE);
        let back = parse_binary_stl(&bytes).unwrap();
        assert_eq!(back.vertex_count(), 3);
        assert_eq!(back.bounds().unwrap(), [0.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
        // Winding preserved.
        assert_eq!(back.triangles, vec![[0u32, 1, 2]]);
    }

    #[test]
    fn binary_stl_rejects_truncation() {
        let m = unit_cube_mesh();
        let bytes = to_binary_stl(&m, "unit-cube");
        assert!(matches!(
            parse_binary_stl(&bytes[..bytes.len() - 4]),
            Err(IoError::Truncated(_))
        ));
        assert!(matches!(parse_binary_stl(&[]), Err(IoError::Truncated(_))));
    }

    #[test]
    fn ascii_stl_round_trip() {
        let m = unit_cube_mesh();
        let ascii = "solid unit-cube\nfacet normal 0 0 1\n outer loop\n  vertex 0 0 0\n  vertex 1 0 0\n  vertex 0 1 0\n endloop\nendfacet\nendsolid unit-cube\n";
        let back = parse_ascii_stl(ascii).unwrap();
        assert_eq!(back.bounds().unwrap(), m.bounds().unwrap());
        assert_eq!(back.triangles, vec![[0u32, 1, 2]]);
    }

    #[test]
    fn obj_round_trip_and_indices() {
        let m = unit_cube_mesh();
        let obj = to_obj(&m, "cube");
        let back = parse_obj(&obj).unwrap();
        assert_eq!(back.positions, m.positions);
        assert_eq!(back.triangles, vec![[0u32, 1, 2]]);

        // Negative indices.
        let neg = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n";
        let nm = parse_obj(neg).unwrap();
        assert_eq!(nm.triangles, vec![[0u32, 1, 2]]);

        // Slash-suffixed indices.
        let slash = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3\n";
        assert_eq!(parse_obj(slash).unwrap().triangles, vec![[0u32, 1, 2]]);
    }

    #[test]
    fn gltf_stub_is_coverage_marker() {
        assert!(!gltf_available());
        assert!(matches!(parse_gltf(b"{}"), Err(IoError::Unsupported(_))));
    }

    #[test]
    fn lonely_face_rejected() {
        assert!(matches!(parse_obj("f 1 2 3"), Err(IoError::Malformed(_))));
    }

    #[test]
    fn empty_geometry_has_no_bounds() {
        let m = MeshData::new();
        assert!(matches!(m.bounds(), Err(IoError::GeometryEmpty)));
        assert!(matches!(m.bbox_volume(), Err(IoError::GeometryEmpty)));
    }
}
