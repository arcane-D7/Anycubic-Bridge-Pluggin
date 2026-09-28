//! S7-001 AC-4 integration test: the external watchdog must reap the child when
//! heartbeat is lost. Uses a fake "blender" (a batch script) so CI without a
//! real Blender still exercises the watchdog path.

use blender_bridge::discovery::{BlenderInstall, InstallKind};
use blender_bridge::spawn::{spawn_blender, SpawnError, SpawnOptions};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

fn fake_blender_install(label: &str, heartbeat: bool) -> BlenderInstall {
    let dir = std::env::temp_dir().join(format!("bb-test-{label}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp");
    let shim = dir.join("blender.cmd");
    let body = if heartbeat {
        // A well-behaved worker: touches %BLENDER_BRIDGE_HEARTBEAT% every
        // ~300 ms then exits after ~3 s (never killed by the watchdog).
        "@echo off\r\nfor /L %%i in (1,1,9) do (\r\n  if defined BLENDER_BRIDGE_HEARTBEAT type nul >> \"%BLENDER_BRIDGE_HEARTBEAT%\"\r\n  timeout /t 1 /nobreak >nul\r\n)\r\nexit /b 0\r\n"
    } else {
        // A hung worker: never touches the heartbeat (watchdog must kill it).
        "@echo off\r\n:loop\r\ntimeout /t 1 /nobreak >nul\r\ngoto loop\r\n"
    };
    std::fs::write(&shim, body).expect("write shim");
    BlenderInstall {
        exe: shim,
        kind: InstallKind::Classic,
        version: "5.2.2".into(),
    }
}

#[test]
fn watchdog_reaps_child_on_heartbeat_loss() {
    let install = fake_blender_install("hung", false);
    let script = PathBuf::from("dummy.py");
    let opts = SpawnOptions {
        label: "watchdog-test".into(),
        wall_clock_ms: Some(10_000),
        heartbeat_timeout_ms: Some(1_200),
        ..Default::default()
    };

    let mut worker = spawn_blender(&install, &script, &[], &opts).expect("spawn");
    // Wait for the watchdog window to elapse.
    std::thread::sleep(Duration::from_millis(2_500));
    let result = worker.finish(10_000);
    match result {
        Err(SpawnError::Watchdog { pid }) => {
            assert!(pid > 0);
            // Child must no longer be running. taskkill /T is async; allow a
            // short grace window and retry a few times before asserting.
            let mut alive = true;
            for _ in 0..40 {
                std::thread::sleep(Duration::from_millis(100));
                let out = Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {pid}")])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                    .unwrap_or_default();
                // "INFO: No tasks are running" means not alive.
                alive = out.contains(&format!("{pid}")) && !out.contains("No tasks are running");
                if !alive {
                    break;
                }
            }
            assert!(!alive, "watchdog should have reaped child {pid}");
        }
        Ok(_) => panic!("expected watchdog kill, got clean exit"),
        Err(other) => panic!("expected watchdog kill, got {other:?}"),
    }
    worker.cleanup_scratch();
}

#[test]
fn watchdog_does_not_kill_heartbeat_honoring_worker() {
    let install = fake_blender_install("healthy", true);
    let script = PathBuf::from("dummy.py");
    let opts = SpawnOptions {
        label: "watchdog-healthy".into(),
        wall_clock_ms: Some(15_000),
        heartbeat_timeout_ms: Some(2_000),
        output_cap: Some(1024),
        ..Default::default()
    };
    let mut worker = spawn_blender(&install, &script, &[], &opts).expect("spawn");
    // The healthy shim finishes (exits 0) before any timeout; finish returns 0.
    let code = worker.finish(15_000).unwrap();
    assert_eq!(code, 0, "healthy worker should exit cleanly");
    worker.cleanup_scratch();
}

#[test]
fn wall_clock_cap_kills_hung_worker() {
    let install = fake_blender_install("wallclock", false);
    let script = PathBuf::from("dummy.py");
    let opts = SpawnOptions {
        label: "wallclock-test".into(),
        wall_clock_ms: Some(8_000),
        heartbeat_timeout_ms: Some(60_000), // watchdog effectively disabled
        ..Default::default()
    };
    let mut worker = spawn_blender(&install, &script, &[], &opts).expect("spawn");
    // Much shorter cap than the watchdog, to exercise WallClock.
    let result = worker.finish(2_000);
    assert!(
        matches!(result, Err(SpawnError::WallClock { .. })),
        "expected wall-clock kill, got {result:?}"
    );
    worker.cleanup_scratch();
}
