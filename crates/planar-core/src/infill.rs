//! Infill generation — grid (rectilinear) and gyroid subsets for planar-core.
//!
//! The full slicer supports grid/gyroid/honeycomb/etc.; planar-core scopes a
//! **grid** (cross-hatch) and a **gyroid subset** (planar sine-wave lines in
//! the XY plane). Both stay strictly planar (constant z within a layer), are
//! deterministic, and are derived from the part bbox + closed-form spacing.

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum InfillPattern {
    Grid,
    /// Gyroid subset — planar sine-wave lines (see `gyroid_lines`).
    GyroidSubset,
}

#[derive(Debug, Error, PartialEq)]
pub enum InfillError {
    #[error("density % out of range [0,100]: {0}")]
    DensityOutOfRange(f64),
    #[error("grid spacing must be > 0: {0}")]
    NonPositiveSpacing(f64),
}

/// Parameters for one infill layer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridParams {
    pub density_pct: f64,
    /// Toolpath area width (the bead width) — used to rescale the effective
    /// line spacing so the printed volume matches the requested density.
    pub line_width_mm: f64,
    pub bbox_min_x: f64,
    pub bbox_min_y: f64,
    pub bbox_size_x: f64,
    pub bbox_size_y: f64,
}

/// A set of horizontal or vertical grid lines whose spacing derives from the
/// requested density. Deterministic: computed in fixed order from the bbox.
#[derive(Debug, Clone, PartialEq)]
pub struct GridLines {
    pub vertical: Vec<f64>,   // x positions of 0° (vertical) lines
    pub horizontal: Vec<f64>, // y positions of 90° (horizontal) lines
    pub actual_density_pct: f64,
}

/// Line spacing for a requested density and bead width (closed form).
///
/// Orientations/paths share one spacing `s`. Two perpendicular sets (grid):
/// total printed line length
///   L = (w/s)·d + (d/s)·w = 2·w·d/s
/// printed fraction (single bead width):
///   F = line_width · L / (w·d) = 2·line_width / s
/// Requiring F == density  →  s = 2·line_width / density.
///
/// For the gyroid subset (one sine-wave set per layer, amplitude a = s/2),
/// the same fraction formula holds per layer with one orientation.
pub fn grid_spacing(
    density_pct: f64,
    line_width_mm: f64,
    _bbox_size_x: f64,
    _bbox_size_y: f64,
) -> Result<f64, InfillError> {
    if !(0.0..=100.0).contains(&density_pct) {
        return Err(InfillError::DensityOutOfRange(density_pct));
    }
    if line_width_mm <= 0.0 {
        return Err(InfillError::NonPositiveSpacing(line_width_mm));
    }
    let density = density_pct / 100.0;
    if density <= 0.0 {
        // No infill requested: caller skips line generation.
        return Ok(f64::INFINITY);
    }
    let s = 2.0 * line_width_mm / density;
    if s.is_finite() && s > 0.0 {
        Ok(s)
    } else {
        Err(InfillError::NonPositiveSpacing(s))
    }
}

/// Densities below this are considered "sparse enough to skip" → return the
/// largest practical spacing (no lines).
pub const MAX_LINE_SPACING_MM: f64 = 1000.0;

/// Generate grid lines for a layer (deterministic order).
pub fn grid_lines(params: &GridParams, spacing_mm: Option<f64>) -> Result<GridLines, InfillError> {
    let s = match spacing_mm {
        Some(s) => s,
        None => grid_spacing(
            params.density_pct,
            params.line_width_mm,
            params.bbox_size_x,
            params.bbox_size_y,
        )?,
    };
    if s <= 0.0 || (!s.is_finite() && s != f64::INFINITY) {
        return Err(InfillError::NonPositiveSpacing(s));
    }
    if s == f64::INFINITY || s >= MAX_LINE_SPACING_MM {
        return Ok(GridLines {
            vertical: vec![],
            horizontal: vec![],
            actual_density_pct: 0.0,
        });
    }
    let mut vertical = Vec::new();
    let mut x = params.bbox_min_x;
    while x <= params.bbox_min_x + params.bbox_size_x + 1e-9 {
        vertical.push(x);
        x += s;
    }
    let mut horizontal = Vec::new();
    let mut y = params.bbox_min_y;
    while y <= params.bbox_min_y + params.bbox_size_y + 1e-9 {
        horizontal.push(y);
        y += s;
    }
    // Actual density (percent), computed from the generated lines (bbox
    // rounding changes the count): F% = 100 · line_width · (Σ line lengths)
    // / (w·d).
    let total_len =
        vertical.len() as f64 * params.bbox_size_y + horizontal.len() as f64 * params.bbox_size_x;
    let actual = (100.0 * params.line_width_mm * total_len
        / (params.bbox_size_x * params.bbox_size_y))
        .min(100.0);
    Ok(GridLines {
        vertical,
        horizontal,
        actual_density_pct: actual,
    })
}

/// A single planar-gyroid-subset line: a sine wave along x at constant z.
#[derive(Debug, Clone, PartialEq)]
pub struct GyroidLine {
    pub y: f64,
    pub pts: Vec<(f64, f64)>, // (x, y_wave) sampled control points
}

/// Gyroid subset lines for a layer: `n` sine waves at y = min_y + k·s.
///
/// The true gyroid implicit surface is non-planar; the *subset* keeps the
/// wave in the XY plane at constant z (amplitude along y only):
/// `y_wave(x) = A·sin(2π·(x - x0)/T)`, `A = s/2`. Like real slicers, the
/// wave is **clipped to the part bbox** (a gyroid is always globally clipped
/// to the part region; deterministic `clamp` here keeps the subset planar and
/// bounded). Deterministic: fixed sample count, fixed period, fixed phase.
pub fn gyroid_lines(
    params: &GridParams,
    spacing_mm: Option<f64>,
    period_mm: f64,
) -> Result<Vec<GyroidLine>, InfillError> {
    let s = match spacing_mm {
        Some(s) => s,
        None => grid_spacing(
            params.density_pct,
            params.line_width_mm,
            params.bbox_size_x,
            params.bbox_size_y,
        )?,
    };
    if s <= 0.0 || !s.is_finite() {
        return Err(InfillError::NonPositiveSpacing(s));
    }
    if s >= MAX_LINE_SPACING_MM || period_mm <= 0.0 || !period_mm.is_finite() {
        return Ok(vec![]);
    }
    let amp = s / 2.0;
    let omega = 2.0 * std::f64::consts::PI / period_mm;
    let samples = 64usize;
    let (ylo, yhi) = (params.bbox_min_y, params.bbox_min_y + params.bbox_size_y);
    let mut lines = Vec::new();
    let mut y = params.bbox_min_y;
    while y <= params.bbox_min_y + params.bbox_size_y + 1e-9 {
        let mut pts = Vec::with_capacity(samples + 1);
        for i in 0..=samples {
            let tau = i as f64 / samples as f64;
            let x = params.bbox_min_x + tau * params.bbox_size_x;
            let y_wave = (y + amp * (omega * (x - params.bbox_min_x)).sin()).clamp(ylo, yhi);
            pts.push((x, y_wave));
        }
        lines.push(GyroidLine { y, pts });
        y += s;
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square_params(density: f64) -> GridParams {
        GridParams {
            density_pct: density,
            line_width_mm: 0.45,
            bbox_min_x: 0.0,
            bbox_min_y: 0.0,
            bbox_size_x: 20.0,
            bbox_size_y: 20.0,
        }
    }

    #[test]
    fn spacing_closed_form() {
        let s = grid_spacing(15.0, 0.45, 20.0, 20.0).unwrap();
        assert!((s - 2.0 * 0.45 / 0.15).abs() < 1e-12); // 6.0 mm
    }

    #[test]
    fn zero_density_skips_lines() {
        let g = grid_lines(&square_params(0.0), None).unwrap();
        assert!(g.vertical.is_empty() && g.horizontal.is_empty());
        assert_eq!(g.actual_density_pct, 0.0);
    }

    #[test]
    fn grid_lines_deterministic_and_bounded() {
        let a = grid_lines(&square_params(15.0), None).unwrap();
        let b = grid_lines(&square_params(15.0), None).unwrap();
        assert_eq!(a, b);
        assert!(!a.vertical.is_empty());
        assert!(!a.horizontal.is_empty());
        for x in &a.vertical {
            assert!(*x >= -1e-9 && *x <= 20.0 + 1e-9);
        }
        // actual density computed from generated lines: for 4+4 lines over a
        // 20×20 bbox with 0.45 width → 0.45·160/400 = 18%.
        assert!(
            (a.actual_density_pct - 18.0).abs() < 1e-9,
            "got {}",
            a.actual_density_pct
        );
    }

    #[test]
    fn gyroid_lines_bounded_and_deterministic() {
        let a = gyroid_lines(&square_params(15.0), None, 5.0).unwrap();
        let b = gyroid_lines(&square_params(15.0), None, 5.0).unwrap();
        assert_eq!(a, b);
        assert!(!a.is_empty());
        let s = grid_spacing(15.0, 0.45, 20.0, 20.0).unwrap();
        let amp = s / 2.0;
        for line in &a {
            assert_eq!(line.pts.len(), 65);
            for (x, yp) in &line.pts {
                // x spans the bbox
                assert!(*x >= -1e-9 && *x <= 20.0 + 1e-9);
                // interior lines oscillate within amp of their baseline; edge
                // lines clamp to the bbox — the invariant is staying inside.
                assert!(*yp >= -1e-9 && *yp <= 20.0 + 1e-9, "yp={yp}");
                // No unbounded wave: never further than amp+ε from the line's
                // own sample baseline after clamping.
                assert!((yp - line.y).abs() <= amp + 1e-9);
            }
        }
    }

    #[test]
    fn rejects_bad_density() {
        assert!(matches!(
            grid_spacing(-1.0, 0.45, 20.0, 20.0),
            Err(InfillError::DensityOutOfRange(_))
        ));
    }
}
