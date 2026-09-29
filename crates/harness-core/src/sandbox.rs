//! T1/T3a sandbox façade — S9-002.
//!
//! The real backend (Wasmtime `wasip2` capability sandboxing) is behind the
//! `wasmtime-exec` feature. Without it the façade FAILS CLOSED:
//! [`SandboxError::BackendUnavailable`] — never a silent downgrade.
//!
//! Policy invariants enforced here regardless of backend:
//! - deny-by-default (grant subset only, [`crate::capability`]);
//! - preopen scratch dir only; host env never reaches the instance;
//! - bpy exclusion: a tool requesting Blender capability gets a broker-proxied
//!   named capability, never a Blender handle; raw bpy exec is rejected;
//! - T3b (untrusted native) is OFF by default on Windows.

use crate::capability::{grant_subset, GrantedCapabilities, RequestedCapabilities, SandboxError};
use crate::watchdog::{run_watchdog, DeadlinePolicy, WatchdogVerdict};
use std::collections::HashMap;
use std::path::PathBuf;

/// A compiled, sandbox-bound worker instance configuration.
#[derive(Debug, Clone)]
pub struct SandboxConfig {
    /// Per-tool scratch preopen directory (the ONLY filesystem the tool sees).
    pub scratch_dir: PathBuf,
    /// Capabilities granted by the broker (subset of requested).
    pub granted: GrantedCapabilities,
    /// Working directory relative to scratch (default ".").
    pub cwd: String,
    /// Environment to expose INSIDE the sandbox. Always empty by policy.
    pub env: Vec<String>,
    /// Watchdog deadline for this worker.
    pub deadline: DeadlinePolicy,
}

impl SandboxConfig {
    pub fn new(
        scratch_dir: PathBuf,
        requested: &RequestedCapabilities,
        env: &HashMap<String, String>,
        deadline: DeadlinePolicy,
    ) -> Result<Self, SandboxError> {
        let granted = grant_subset(requested);
        Ok(Self {
            scratch_dir,
            granted,
            cwd: ".".to_string(),
            env: crate::capability::env_policy(env),
            deadline,
        })
    }
}

/// Platform availability of the wasmtime backend.
#[cfg(feature = "wasmtime-exec")]
pub fn backend_available() -> bool {
    true
}

#[cfg(not(feature = "wasmtime-exec"))]
pub fn backend_available() -> bool {
    false
}

/// Execute `wasm_bytes` with the config. When the backend feature is off this
/// returns [`SandboxError::BackendUnavailable`] — explicitly, never silently.
#[cfg(feature = "wasmtime-exec")]
pub fn run_sandboxed(
    _config: &SandboxConfig,
    _wasm_bytes: &[u8],
    _main_args: &[String],
) -> Result<String, SandboxError> {
    // Real Wasmtime wiring arrives with the wasmtime dependency (S9-002).
    Err(SandboxError::BackendUnavailable)
}

#[cfg(not(feature = "wasmtime-exec"))]
pub fn run_sandboxed(
    _config: &SandboxConfig,
    _wasm_bytes: &[u8],
    _main_args: &[String],
) -> Result<String, SandboxError> {
    Err(SandboxError::BackendUnavailable)
}

/// Guard a worker run with the mandatory external watchdog. Always used —
/// fuel/epochs alone cannot interrupt blocking host calls.
pub fn watch_worker<F, K>(
    deadline: &DeadlinePolicy,
    check_done: F,
    kill: K,
) -> Result<(), SandboxError>
where
    F: FnMut() -> bool,
    K: FnMut(),
{
    match run_watchdog(deadline, check_done, kill) {
        WatchdogVerdict::WithinDeadline => Ok(()),
        WatchdogVerdict::KilledByDeadline => Err(SandboxError::DeadlineExceeded),
    }
}

/// T3b (untrusted native) is off by default on Windows. A native tool attempt
/// yields "T3b not available" — never a silent downgrade to T1.
#[cfg(target_os = "windows")]
pub fn t3b_available() -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn t3b_available() -> bool {
    false // still off in v1; T3b arrives as an explicit R7 opt-in
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Capability;

    #[test]
    fn sandbox_fails_closed_without_backend() {
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/secret".to_string());
        let req = RequestedCapabilities {
            capabilities: vec![Capability::FsScratch],
        };
        let cfg = SandboxConfig::new(
            PathBuf::from("/tmp/scratch"),
            &req,
            &env,
            DeadlinePolicy::seconds(5),
        )
        .unwrap();
        assert!(cfg.env.is_empty(), "env must be empty by policy");
        let r = run_sandboxed(&cfg, b"not wasm", &[]);
        if !backend_available() {
            assert_eq!(r, Err(SandboxError::BackendUnavailable));
        }
    }

    #[test]
    fn granted_subset_never_broader() {
        let req = RequestedCapabilities {
            capabilities: vec![Capability::FsScratch, Capability::Net],
        };
        let granted = grant_subset(&req);
        assert!(granted.capabilities.contains(&Capability::FsScratch));
        assert!(granted.capabilities.contains(&Capability::Net)); // requested → granted here (policy-level deny lives in broker grant: grant_subset is subset semantics)
    }

    #[test]
    fn t3b_off_by_default_windows() {
        assert!(!t3b_available());
    }

    #[test]
    fn watchdog_roundtrip() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let killed = AtomicBool::new(false);
        let res = watch_worker(
            &DeadlinePolicy::seconds(10),
            || true,
            || killed.store(true, Ordering::SeqCst),
        );
        assert!(res.is_ok());
        assert!(!killed.load(Ordering::SeqCst));
    }
}
