//! Writer action registry — the single owner of the mapping from a stored
//! approval `action` name to the auth scope that guards it (DEV-10).
//!
//! Every writable effect has exactly one required scope, derived from the
//! **action** (closed, backend-owned) — never from a caller-supplied
//! parameter. The approval authority, the control dispatch gate and the job
//! dispatch gate all resolve the scope through this registry, so issuance,
//! consume-time identity and effect dispatch can never disagree.
//!
//! Scope classes (see `auth_service::Scope::is_session_capability`):
//! - `device_control` — the nine physical control actions.
//! - `device_upload`   — artifact uploads (separate account write scope).
//! - `print_job`       — queue / start / stop print-job effects.

use auth_service::Scope;

/// The nine physical device-control actions.
pub const DEVICE_CONTROL_ACTIONS: [&str; 9] = [
    "nozzle",
    "bed",
    "part_fan",
    "speed",
    "light_set_enabled",
    "light_brightness",
    "ace_dry",
    "ace_auto_feed",
    "ace_bind_slot",
];

/// Artifact-upload action (writes the account cloud shelf).
pub const UPLOAD_ACTIONS: [&str; 1] = ["upload"];

/// Print-job actions (queue / start / stop — physical prints).
pub const PRINT_JOB_ACTIONS: [&str; 3] = ["job.queue", "job.start", "job.stop"];

/// Required scope for a stored approval action, or `None` when the action is
/// unknown. Unknown names are never grantable through the session entry —
/// `issue_for_session_scoped` refuses them before any session lookup result
/// can mint anything.
pub fn required_scope(action: &str) -> Option<Scope> {
    if UPLOAD_ACTIONS.contains(&action) {
        return Some(Scope::DeviceUpload);
    }
    if PRINT_JOB_ACTIONS.contains(&action) {
        return Some(Scope::PrintJob);
    }
    if DEVICE_CONTROL_ACTIONS.contains(&action) {
        return Some(Scope::DeviceControl);
    }
    None
}

/// `true` when the action is a known writable effect (i.e. has a required
/// scope). Used by the dispatch gates to refuse unknown/legacy generic
/// command names.
pub fn is_writer_action(action: &str) -> bool {
    required_scope(action).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_maps_every_class_without_overlap() {
        // Each known action maps to exactly its class.
        for name in DEVICE_CONTROL_ACTIONS {
            assert_eq!(required_scope(name), Some(Scope::DeviceControl), "{name}");
        }
        for name in UPLOAD_ACTIONS {
            assert_eq!(required_scope(name), Some(Scope::DeviceUpload), "{name}");
        }
        for name in PRINT_JOB_ACTIONS {
            assert_eq!(required_scope(name), Some(Scope::PrintJob), "{name}");
        }
        // No action belongs to two classes.
        for a in DEVICE_CONTROL_ACTIONS
            .iter()
            .chain(UPLOAD_ACTIONS.iter())
            .chain(PRINT_JOB_ACTIONS.iter())
        {
            let matches: usize = usize::from(DEVICE_CONTROL_ACTIONS.contains(a))
                + usize::from(UPLOAD_ACTIONS.contains(a))
                + usize::from(PRINT_JOB_ACTIONS.contains(a));
            assert_eq!(matches, 1, "action {a} must belong to exactly one class");
        }
    }

    #[test]
    fn unknown_action_has_no_scope() {
        for bad in [
            "device.command",
            "job",
            "job.anything",
            "uploader",
            "rename",
            "",
        ] {
            assert_eq!(required_scope(bad), None, "must refuse {bad:?}");
            assert!(!is_writer_action(bad), "must refuse {bad:?}");
        }
    }
}
