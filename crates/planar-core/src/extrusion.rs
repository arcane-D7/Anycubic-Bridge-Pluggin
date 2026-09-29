//! Extrusion model — §3.3 closed-form formulas.
//!
//! - `V = ∫A_bead(s)ds` : deposited volume = path length × local bead area.
//! - `ΔE = V/A_filament` : filament-length E required to deposit `V`.
//! - `Q = A_bead·v`      : volumetric flow at tool speed v (steady state).

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Filament geometry (diameter drives the filament cross-section).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct FilamentParams {
    /// Filament diameter in mm (e.g. 1.75).
    pub diameter_mm: f64,
}

impl Default for FilamentParams {
    fn default() -> Self {
        Self { diameter_mm: 1.75 }
    }
}

impl FilamentParams {
    /// Cross-sectional area of the filament: π(d/2)².
    pub fn area(&self) -> f64 {
        let r = self.diameter_mm / 2.0;
        std::f64::consts::PI * r * r
    }
}

/// A bead profile: the cross-section of deposited material along a path.
/// `width_mm x height_mm` approximates the local bead as a rectangle
/// (constant-section assumption preserved for the closed-form parity tests).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Bead {
    pub width_mm: f64,
    pub height_mm: f64,
}

impl Bead {
    /// Cross-sectional area (mm²): width × height (rectangle approx).
    pub fn area(&self) -> f64 {
        self.width_mm * self.height_mm
    }
}

#[derive(Debug, Error)]
pub enum ExtrusionError {
    #[error("non-positive dimensions: width={width}, height={height}")]
    NonPositiveBead { width: f64, height: f64 },
    #[error("non-positive filament diameter: {0}")]
    NonPositiveFilament(f64),
    #[error("non-positive path length: {0}")]
    NonPositiveLength(f64),
}

/// Deposited volume for a straight segment: `V = ∫A_bead(s)ds = A_bead · L`
/// (constant section along the segment → closed form).
pub fn extrusion_volume(length_mm: f64, bead: &Bead) -> Result<f64, ExtrusionError> {
    if length_mm < 0.0 {
        return Err(ExtrusionError::NonPositiveLength(length_mm));
    }
    if bead.width_mm <= 0.0 || bead.height_mm <= 0.0 {
        return Err(ExtrusionError::NonPositiveBead {
            width: bead.width_mm,
            height: bead.height_mm,
        });
    }
    Ok(length_mm * bead.area())
}

/// Filament-length E for a straight segment: `ΔE = V/A_filament`.
pub fn extrusion_length_e(
    length_mm: f64,
    bead: &Bead,
    filament: &FilamentParams,
) -> Result<f64, ExtrusionError> {
    let v = extrusion_volume(length_mm, bead)?;
    let a = filament.area();
    if a <= 0.0 {
        return Err(ExtrusionError::NonPositiveFilament(filament.diameter_mm));
    }
    Ok(v / a)
}

/// Volumetric flow at steady state: `Q = A_bead · v` (mm³/s).
pub fn steady_state_q(speed_mm_s: f64, bead: &Bead) -> f64 {
    speed_mm_s * bead.area()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIL: FilamentParams = FilamentParams { diameter_mm: 1.75 };

    #[test]
    fn bead_area_rectangle() {
        let b = Bead {
            width_mm: 0.45,
            height_mm: 0.20,
        };
        assert!((b.area() - 0.09).abs() < 1e-12);
    }

    #[test]
    fn extrusion_volume_closed_form() {
        // 100 mm at 0.45×0.20 bead → V = 100 × 0.09 = 9.0 mm³.
        let b = Bead {
            width_mm: 0.45,
            height_mm: 0.20,
        };
        let v = extrusion_volume(100.0, &b).unwrap();
        assert!((v - 9.0).abs() < 1e-9);
    }

    #[test]
    fn e_from_volume_conservation() {
        // A_filament = π(0.875)² ≈ 2.4053 mm².
        // E = 9.0 / 2.4053 ≈ 3.7417 mm filament.
        let b = Bead {
            width_mm: 0.45,
            height_mm: 0.20,
        };
        let e = extrusion_length_e(100.0, &b, &FIL).unwrap();
        let expected = 9.0 / (std::f64::consts::PI * 0.875_f64.powi(2));
        assert!((e - expected).abs() < 1e-9);
        // Material conservation check: E × A_filament == V.
        let back = e * FIL.area();
        assert!((back - 9.0).abs() < 1e-9);
    }

    #[test]
    fn steady_flow_q() {
        // Q = A_bead × v = 0.09 × 60 = 5.4 mm³/s.
        let b = Bead {
            width_mm: 0.45,
            height_mm: 0.20,
        };
        let q = steady_state_q(60.0, &b);
        assert!((q - 5.4).abs() < 1e-9);
    }

    #[test]
    fn rejects_non_positive() {
        let bad = Bead {
            width_mm: 0.0,
            height_mm: 0.2,
        };
        assert!(matches!(
            extrusion_volume(10.0, &bad),
            Err(ExtrusionError::NonPositiveBead { .. })
        ));
        assert!(matches!(
            extrusion_length_e(-1.0, &bad, &FIL),
            Err(ExtrusionError::NonPositiveLength(_))
        ));
    }
}
