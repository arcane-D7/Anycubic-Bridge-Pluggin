//! Polygon offsetting — own implementation (no external geometry crates;
//! Apache/MIT direct use only).
//!
//! Insets a simple (non-self-intersecting) polygon by `distance` using
//! Minkowski-corner rounding: each edge is translated inward by
//! `distance / sin(θ/2)` along its own normal, corners are joined. For the
//! planar-core wall loops we only need **insets of convex-ish loops** (the
//! part outline per layer), so corner cases beyond a simple inward offset
//! (holes, self-intersections from large offsets) are rejected explicitly.

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

impl Pt {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Debug, Error)]
pub enum OffsetError {
    #[error("polygon must have at least 3 vertices")]
    TooFewVertices,
    #[error("offset {0:?} is not positive")]
    NonPositive(f64),
    #[error("offset collapsed the polygon (no inset remains)")]
    Collapsed,
    #[error("resulting polygon has fewer than 3 vertices")]
    Degenerate,
}

/// Signed area (positive = CCW). The sign is used to fix the inward
/// direction: we always inset such that the ring area shrinks.
pub fn signed_area(ring: &[Pt]) -> f64 {
    let mut s = 0.0;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        s += a.x * b.y - b.x * a.y;
    }
    s / 2.0
}

/// Left-hand unit normal (interior side for a CCW ring).
fn edge_normal(a: Pt, b: Pt) -> (f64, f64) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-12 {
        return (0.0, 0.0);
    }
    // Left-hand normal (rotate 90° CCW): (-dy, dx) / len — points INTO a CCW
    // ring (verified: 20×20 square inset 0.45 → corners (0.45,0.45), width
    // 19.1).
    (-dy / len, dx / len)
}

/// Right-hand unit normal (exterior side for a CCW ring) — used for outward
/// offsets (skirt).
fn edge_normal_out(a: Pt, b: Pt) -> (f64, f64) {
    let (x, y) = edge_normal(a, b);
    (-x, -y)
}

/// Inset `ring` (assumed simple) by `distance` along inward normals. The
/// inward direction is chosen so the ring area decreases (works for both CW
/// and CCW winding — the caller's winding is normalized first).
pub fn inset_ring(ring: &[Pt], distance: f64) -> Result<Vec<Pt>, OffsetError> {
    if ring.len() < 3 {
        return Err(OffsetError::TooFewVertices);
    }
    if distance <= 0.0 {
        return Err(OffsetError::NonPositive(distance));
    }
    // Normalize orientation: ensure CCW so the inward normal is consistently
    // the right-hand normal.
    let mut oriented: Vec<Pt> = ring.to_vec();
    if signed_area(&oriented) < 0.0 {
        oriented.reverse();
    }
    let n = oriented.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let a = oriented[(i + n - 1) % n];
        let b = oriented[i];
        let c = oriented[(i + 1) % n];
        let (ax, ay) = edge_normal(a, b);
        let (bx2, by2) = edge_normal(b, c);
        // Miter corner join: the offset vertex is the intersection of the two
        // inset edge lines, each `distance` from its edge. Closed form
        // (verified: 20×20 square inset 0.45 → corners (19.55, 0.45), width
        // 19.1): M = b + (n̂1+n̂2)·d/(1 + n̂1·n̂2).
        let denom = 1.0 + ax * bx2 + ay * by2;
        if denom.abs() < 1e-12 {
            return Err(OffsetError::Collapsed);
        }
        let scale = distance / denom;
        out.push(Pt::new(b.x + (ax + bx2) * scale, b.y + (ay + by2) * scale));
    }
    // Collapse guard: a true inward inset of a convex ring must lie inside
    // the input bbox. If the miter passes the centroid (inset > feature
    // size), the corners flip and the result spuriously grows → reject.
    let (i_min_x, i_max_x, i_min_y, i_max_y) = bbox_of(&oriented);
    let (o_min_x, o_max_x, o_min_y, o_max_y) = bbox_of(&out);
    let tol = 1e-9;
    if o_min_x < i_min_x - tol
        || o_min_y < i_min_y - tol
        || o_max_x > i_max_x + tol
        || o_max_y > i_max_y + tol
    {
        return Err(OffsetError::Collapsed);
    }
    if out.len() < 3 {
        return Err(OffsetError::Degenerate);
    }
    Ok(out)
}

fn bbox_of(ring: &[Pt]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in ring {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    (min_x, max_x, min_y, max_y)
}

/// Outset `ring` outward by `distance` (skirt). Deterministic miter join with
/// outward unit normals (mirror of `inset_ring`). No reverse-inset tricks —
/// those would re-normalize orientation and shrink instead of grow.
pub fn outset_ring(ring: &[Pt], distance: f64) -> Result<Vec<Pt>, OffsetError> {
    if ring.len() < 3 {
        return Err(OffsetError::TooFewVertices);
    }
    if distance <= 0.0 {
        return Err(OffsetError::NonPositive(distance));
    }
    let mut oriented: Vec<Pt> = ring.to_vec();
    if signed_area(&oriented) < 0.0 {
        oriented.reverse();
    }
    let n = oriented.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let a = oriented[(i + n - 1) % n];
        let b = oriented[i];
        let c = oriented[(i + 1) % n];
        let (ax, ay) = edge_normal_out(a, b);
        let (bx2, by2) = edge_normal_out(b, c);
        let denom = 1.0 + ax * bx2 + ay * by2;
        if denom.abs() < 1e-12 {
            return Err(OffsetError::Collapsed);
        }
        let scale = distance / denom;
        out.push(Pt::new(b.x + (ax + bx2) * scale, b.y + (ay + by2) * scale));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(s: f64) -> Vec<Pt> {
        vec![
            Pt::new(0.0, 0.0),
            Pt::new(s, 0.0),
            Pt::new(s, s),
            Pt::new(0.0, s),
        ]
    }

    #[test]
    fn inset_square_shrinks_by_offset() {
        let ring = square(20.0);
        let inner = inset_ring(&ring, 0.45).unwrap();
        // 20×20 square inset by 0.45 → 19.1×19.1.
        assert!(inner.len() == 4);
        let xs: Vec<f64> = inner.iter().map(|p| p.x).collect();
        let ys: Vec<f64> = inner.iter().map(|p| p.y).collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!((max_x - min_x - 19.1).abs() < 1e-9, "got {}", max_x - min_x);
        assert!((max_y - min_y - 19.1).abs() < 1e-9);
    }

    #[test]
    fn inset_rejects_collapse() {
        // A 0.45 mm inset on a 0.2 mm square must fail (degenerate).
        let ring = square(0.2);
        assert!(inset_ring(&ring, 0.45).is_err());
    }

    #[test]
    fn area_decreases_for_both_windings() {
        for winding in [
            square(10.0),
            square(10.0).iter().rev().copied().collect::<Vec<_>>(),
        ] {
            let a0 = signed_area(&winding).abs();
            let inner = inset_ring(&winding, 1.0).unwrap();
            let a1 = signed_area(&inner).abs();
            assert!(a1 < a0 - 1e-9);
        }
    }

    #[test]
    fn too_few_vertices() {
        assert!(matches!(
            inset_ring(&[Pt::new(0.0, 0.0), Pt::new(1.0, 0.0)], 1.0),
            Err(OffsetError::TooFewVertices)
        ));
    }

    #[test]
    fn outset_square_grows_by_offset() {
        let ring = square(20.0);
        let outer = outset_ring(&ring, 0.45).unwrap();
        let xs: Vec<f64> = outer.iter().map(|p| p.x).collect();
        let ys: Vec<f64> = outer.iter().map(|p| p.y).collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        // 20×20 outset by 0.45 → 20.9×20.9.
        assert!((max_x - min_x - 20.9).abs() < 1e-9, "got {}", max_x - min_x);
        assert!((max_y - min_y - 20.9).abs() < 1e-9);
    }

    #[test]
    fn outset_area_grows() {
        let ring = square(10.0);
        let a0 = signed_area(&ring).abs();
        let outer = outset_ring(&ring, 1.0).unwrap();
        let a1 = signed_area(&outer).abs();
        assert!(a1 > a0 + 1e-9, "{} vs {}", a1, a0);
    }
}
