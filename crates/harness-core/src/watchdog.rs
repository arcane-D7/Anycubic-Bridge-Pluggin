//! Mandatory external watchdog for T1/T3a workers — S9-002.
//!
//! Fuel/epoch interrupts cannot cover blocking host calls, so EVERY worker
//! gets a separate watchdog process (or OS-level deadline) that kills the
//! worker when it exceeds its deadline. The watchdog is external by design —
//! the worker cannot pause, clear, or disable it.

use crate::capability::SandboxError;
use std::time::{Duration, Instant};

pub type Pid = u32;

/// Deadline policy for a worker.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DeadlinePolicy {
    /// Hard wall-clock deadline before the watchdog kills the worker.
    pub wall_clock: Duration,
}

impl DeadlinePolicy {
    pub fn seconds(secs: u64) -> Self {
        Self {
            wall_clock: Duration::from_secs(secs),
        }
    }
}

/// Result of watchdog arbitration.
#[derive(Debug, PartialEq)]
pub enum WatchdogVerdict {
    /// Worker finished within the deadline.
    WithinDeadline,
    /// Worker exceeded the deadline and was killed.
    KilledByDeadline,
}

/// The watchdog contract: given a started worker (their liveness probe),
/// wait until either the worker signals completion or the deadline expires.
/// On expiry the watchdog MUST kill the runner (platform hook) and return
/// [`WatchdogVerdict::KilledByDeadline`]. `checked` receives a closure that
/// returns true when the worker completed; `kill` runs the kill action.
pub fn run_watchdog<F, K>(policy: &DeadlinePolicy, mut checked: F, mut kill: K) -> WatchdogVerdict
where
    F: FnMut() -> bool,
    K: FnMut(),
{
    let start = Instant::now();
    loop {
        if checked() {
            return WatchdogVerdict::WithinDeadline;
        }
        if start.elapsed() >= policy.wall_clock {
            kill();
            return WatchdogVerdict::KilledByDeadline;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Track a supervised worker for the watchdog (pure bookkeeping + deadline).
#[derive(Debug)]
pub struct WorkerGuard {
    pub pid: Pid,
    pub policy: DeadlinePolicy,
    started: Instant,
}

impl WorkerGuard {
    pub fn new(pid: Pid, policy: DeadlinePolicy) -> Self {
        Self {
            pid,
            policy,
            started: Instant::now(),
        }
    }

    /// True when the deadline has already passed.
    pub fn expired(&self) -> bool {
        self.started.elapsed() >= self.policy.wall_clock
    }

    /// Convert to the invariant error when a worker is killed by deadline.
    pub fn deadline_error(&self) -> SandboxError {
        SandboxError::DeadlineExceeded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn watchdog_kills_on_deadline_when_worker_hangs() {
        let policy = DeadlinePolicy::seconds(1);
        let mut calls = 0u32;
        let killed = Arc::new(AtomicBool::new(false));
        let killed_clone = killed.clone();
        let verdict = run_watchdog(
            &policy,
            || {
                calls += 1;
                false // never completes
            },
            move || killed_clone.store(true, Ordering::SeqCst),
        );
        assert_eq!(verdict, WatchdogVerdict::KilledByDeadline);
        assert!(
            killed.load(Ordering::SeqCst),
            "kill action must run on expiry"
        );
        assert!(calls > 0);
    }

    #[test]
    fn watchdog_completes_within_deadline() {
        let policy = DeadlinePolicy::seconds(5);
        let mut completed = false;
        let verdict = run_watchdog(
            &policy,
            || {
                completed = true;
                true
            },
            || unreachable!("worker completed; kill must not run"),
        );
        assert_eq!(verdict, WatchdogVerdict::WithinDeadline);
        assert!(completed);
    }

    #[test]
    fn worker_guard_tracks_deadline() {
        let guard = WorkerGuard::new(42, DeadlinePolicy::seconds(3600));
        assert!(!guard.expired());
        assert_eq!(guard.deadline_error(), SandboxError::DeadlineExceeded);
        let short = WorkerGuard::new(7, DeadlinePolicy::seconds(0));
        // 0-second policy is already expired (or expires immediately).
        std::thread::sleep(Duration::from_millis(5));
        assert!(short.expired());
    }
}
