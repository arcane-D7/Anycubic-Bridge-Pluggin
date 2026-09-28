//! Test-only helpers shared by store/lib tests.

use crate::{Capability, MachineProfile, Qualification, SourceClass};

/// A synthetic demo profile — `<MACHINE_TYPE>` placeholder only, sanitizer-clean.
pub fn demo_profile() -> MachineProfile {
    MachineProfile {
        id: "demo".into(),
        machine_type: Some("<MACHINE_TYPE>".into()),
        firmware_version: Some("<FW_VERSION>".into()),
        qualification: Qualification::Unqualified,
        revoked_reason: None,
        capabilities: vec![
            Capability {
                name: "build_volume_x".into(),
                value: Some(220.0.into()),
                source_class: SourceClass::Measured,
                confidence: Some(1.0),
                tolerance: None,
                provenance: None,
                unknown: false,
            },
            Capability {
                name: "continuous_z".into(),
                value: None,
                source_class: SourceClass::Src,
                confidence: Some(0.3),
                tolerance: None,
                provenance: None,
                unknown: true,
            },
        ],
    }
}
