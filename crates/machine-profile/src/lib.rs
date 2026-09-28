//! Machine capability contract v1 — S6-003.
//!
//! Single source of truth for what a machine can do. Unknowns are
//! null/"unknown", never a default that hides ignorance. Feature requiring an
//! undeclared capability → fail-closed pre-flight rejection with the named
//! capability and profile id.

use serde::{Deserialize, Serialize};

pub mod store;
pub use store::{ProfileStore, StoreError};

#[cfg(test)]
mod tests_support;

pub const CONTRACT_VERSION: &str = "1.0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceClass {
    /// Declared by the user/operator (manual form).
    Src,
    /// Pulled live from the printer API/property catalog.
    Measured,
    /// From the online catalog; may be stale — hash-checked + version-pinned.
    Catalog,
}

/// One capability declaration. `value` is null when unknown.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Capability {
    pub name: String,
    pub value: Option<serde_json::Value>,
    pub source_class: SourceClass,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub tolerance: Option<serde_json::Value>,
    #[serde(default)]
    pub provenance: Option<String>,
    pub unknown: bool,
}

/// Machine profile: qualified/unqualified lifecycle + capabilities map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MachineProfile {
    pub id: String,
    pub machine_type: Option<String>,
    pub firmware_version: Option<String>,
    pub qualification: Qualification,
    #[serde(default)]
    pub revoked_reason: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Qualification {
    Unqualified,
    Shadow,
    Qualified,
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// Fail-closed: capability `{capability}` required by feature but not
    /// declared on profile `{profile_id}`.
    #[error("capability '{capability}' not declared on profile '{profile_id}'")]
    MissingCapability { capability: String, profile_id: String },
    #[error("profile '{0}' has no capability named '{1}'")]
    UnnamedCapability(String, String),
}

impl MachineProfile {
    /// Fail-closed pre-flight: require `capability` present, non-unknown and
    /// non-null.
    pub fn require_capability(&self, capability: &str) -> Result<&Capability, ProfileError> {
        let cap = self
            .capabilities
            .iter()
            .find(|c| c.name == capability)
            .ok_or_else(|| ProfileError::MissingCapability {
                capability: capability.to_string(),
                profile_id: self.id.clone(),
            })?;
        if cap.unknown || cap.value.is_none() {
            return Err(ProfileError::MissingCapability {
                capability: capability.to_string(),
                profile_id: self.id.clone(),
            });
        }
        Ok(cap)
    }

    /// Named accessor that requires a non-null value.
    pub fn capability_value(&self, name: &str) -> Result<&serde_json::Value, ProfileError> {
        let cap = self
            .capabilities
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| ProfileError::UnnamedCapability(self.id.clone(), name.to_string()))?;
        cap.value
            .as_ref()
            .ok_or_else(|| ProfileError::UnnamedCapability(self.id.clone(), name.to_string()))
    }

    /// Qualification lifecycle: any hardware-change event should demote to
    /// unqualified with a reason (nozzle/firmware/toolhead swap).
    pub fn revoke(&mut self, reason: &str) {
        self.qualification = Qualification::Unqualified;
        self.revoked_reason = Some(reason.to_string());
    }

    /// Build-volume shorthand: required for slicing pre-flight.
    pub fn build_volume(&self) -> Option<Volume> {
        let x = self.capability_value("build_volume_x").ok()?.as_f64()?;
        let y = self.capability_value("build_volume_y").ok()?.as_f64()?;
        let z = self.capability_value("build_volume_z").ok()?.as_f64()?;
        Some(Volume { x, y, z })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Volume {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_profile() -> MachineProfile {
        MachineProfile {
            id: "p-1".into(),
            machine_type: Some("<MACHINE_TYPE>".into()),
            firmware_version: None,
            qualification: Qualification::Shadow,
            revoked_reason: None,
            capabilities: vec![
                Capability {
                    name: "build_volume_x".into(),
                    value: Some(220.0.into()),
                    source_class: SourceClass::Measured,
                    confidence: Some(1.0),
                    tolerance: None,
                    provenance: Some("[?] measured".to_string()),
                    unknown: false,
                },
                Capability {
                    name: "build_volume_y".into(),
                    value: Some(220.0.into()),
                    source_class: SourceClass::Measured,
                    confidence: Some(1.0),
                    tolerance: None,
                    provenance: None,
                    unknown: false,
                },
                Capability {
                    name: "build_volume_z".into(),
                    value: Some(250.0.into()),
                    source_class: SourceClass::Measured,
                    confidence: Some(1.0),
                    tolerance: None,
                    provenance: None,
                    unknown: false,
                },
            ],
        }
    }

    #[test]
    fn fail_closed_missing_capability() {
        let p = base_profile();
        let err = p.require_capability("continuous_z").unwrap_err();
        assert!(matches!(err, ProfileError::MissingCapability { .. }));
    }

    #[test]
    fn fail_closed_null_volume() {
        let mut p = base_profile();
        p.capabilities[0].value = None;
        p.capabilities[0].unknown = true;
        assert!(p.require_capability("build_volume_x").is_err());
        assert!(p.build_volume().is_none());
    }

    #[test]
    fn qualification_lifecycle_revoke() {
        let mut p = base_profile();
        p.qualification = Qualification::Qualified;
        p.revoke("nozzle swap (0.4 -> 0.6)");
        assert_eq!(p.qualification, Qualification::Unqualified);
        assert!(p.revoked_reason.as_deref().unwrap().contains("nozzle"));
    }

    #[test]
    fn build_volume_present_only_when_all_three() {
        let p = base_profile();
        let v = p.build_volume().unwrap();
        assert_eq!(v, Volume { x: 220.0, y: 220.0, z: 250.0 });
    }
}
