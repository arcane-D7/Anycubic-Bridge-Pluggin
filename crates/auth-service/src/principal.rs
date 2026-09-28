//! Auth tenant principal — S6-006.
//!
//! The auth tenant is the *editor user* (who may use the local machine), NOT
//! the printer/cloud credential holder. Printer tokens flow through the
//! preserved `scripts/auth-login.mjs` DPAPI path; this service can never see
//! them (they are outside its store by construction).

use serde::{Deserialize, Serialize};

/// Who the editor-core is acting as. `Anonymous` is the fail-closed state:
/// auth absent/killed → never fall back to another user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Principal {
    /// No authenticated editor user — default when the auth service is off.
    Anonymous,
    /// A local editor user, identified by id. No password material here.
    Local { user_id: String },
}

impl Principal {
    /// True when the principal is not anonymous — gates `synced` reads.
    pub fn is_identified(&self) -> bool {
        matches!(self, Principal::Local { .. })
    }
}
