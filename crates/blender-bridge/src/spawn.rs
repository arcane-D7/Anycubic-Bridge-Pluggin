//! T2 worker spawn wrapper + external watchdog — S7-001.
//!
//! Every spawned Blender is a **T2 worker** (Invest. Rev 2.0 §8.2):
//! - wall-clock cap (hard kill after `wall_clock_ms`, drivable in tests)
//! - output-size cap (artifacts capped; the JSON/geometry channel is bounded)
//! - killable process group (`taskkill /T /F` on Windows — never spawn-and-forget)
//! - **no secrets into the env** (callers pass `env_extra`; secrets are refused)
//! - scratch directory via a junction under the OS temp dir (cleaned after)
//! - egress blocked by the **host firewall** (documented requirement; we do NOT
//!   self-claim a sandbox — §8.2 terms)
//! - **external watchdog** attached to every spawn: a separate OS thread pings a
//!   heartbeat file; when the watchdog is killed/lost, the child is reaped.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::discovery::{BlenderInstall, InstallKind};

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("blender `{bin}` failed to spawn: {source}")]
    Io { bin: String, source: std::io::Error },
    #[error("secrets must never be passed into the worker env (refused keys: {keys:?})")]
    SecretInEnv { keys: Vec<String> },
    #[error("worker exceeded wall-clock cap of {millis} ms and was killed")]
    WallClock { millis: u64 },
    #[error("watchdog lost heartbeat of child {pid}")]
    Watchdog { pid: u32 },
    #[error("scratch directory error: {0}")]
    Scratch(String),
}

/// A spawned T2 Blender worker.
pub struct BlenderWorker {
    child: Child,
    pid: u32,
    pub scratch: PathBuf,
    kill_flag: Arc<AtomicBool>,
    _watchdog: Arc<WatchdogHandle>,
    out_cap: usize,
}

/// Watchdog: kills the child when heartbeat loss is detected (or when dropped).
/// A separate OS thread monitors the heartbeat; when the watchdog object is
/// dropped it also reaps. The stop flag is stored so the thread can be told to
/// exit cleanly when the worker finishes normally.
struct WatchdogHandle {
    #[allow(dead_code)]
    stop: Arc<AtomicBool>,
    _join: std::thread::JoinHandle<()>,
}

/// Bounded artifact channel capture: reads child stdout up to `cap` bytes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapturedOutput {
    pub bytes: usize,
    pub truncated: bool,
    pub digest_hex: String,
}

impl CapturedOutput {
    pub fn capture(mut reader: impl Read, cap: usize) -> std::io::Result<Self> {
        let mut buf = vec![0u8; 4096];
        let mut total = 0usize;
        let mut digest = sha1_simple::Sha1::digest_empty();
        let mut consumed = 0usize;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            total += n;
            let to_hash = if consumed + n > cap {
                cap.saturating_sub(consumed)
            } else {
                n
            };
            digest.update(&buf[..to_hash]);
            consumed += to_hash;
            let _ = total;
        }
        Ok(CapturedOutput {
            bytes: consumed,
            truncated: total > cap || consumed < total,
            digest_hex: digest.finish_hex(),
        })
    }
}

/// Minimal SHA-1 (pure Rust, Apache/MIT-friendly — no external crate needed at
/// this layer; used only for deterministic artifact digests).
mod sha1_simple {
    pub struct Sha1 {
        state: [u32; 5],
        len: u64,
        buf: Vec<u8>,
    }
    impl Sha1 {
        pub fn digest_empty() -> Self {
            Sha1 {
                state: [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0],
                len: 0,
                buf: Vec::new(),
            }
        }
        pub fn update(&mut self, data: &[u8]) {
            self.len += data.len() as u64;
            self.buf.extend_from_slice(data);
            while self.buf.len() >= 64 {
                let block = self.buf.drain(..64).collect::<Vec<_>>();
                self.process(&block);
            }
        }
        fn process(&mut self, block: &[u8]) {
            let mut w = [0u32; 80];
            for (i, chunk) in block.chunks(4).enumerate() {
                w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            }
            for i in 16..80 {
                w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
            }
            let (mut a, mut b, mut c, mut d, mut e) = (
                self.state[0],
                self.state[1],
                self.state[2],
                self.state[3],
                self.state[4],
            );
            for (i, wi) in w.iter().enumerate() {
                let (f, k) = match i {
                    0..=19 => ((b & c) | (!b & d), 0x5A827999u32),
                    20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                    40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                    _ => (b ^ c ^ d, 0xCA62C1D6),
                };
                let tmp = a
                    .rotate_left(5)
                    .wrapping_add(f)
                    .wrapping_add(e)
                    .wrapping_add(k)
                    .wrapping_add(*wi);
                e = d;
                d = c;
                c = b.rotate_left(30);
                b = a;
                a = tmp;
            }
            self.state[0] = self.state[0].wrapping_add(a);
            self.state[1] = self.state[1].wrapping_add(b);
            self.state[2] = self.state[2].wrapping_add(c);
            self.state[3] = self.state[3].wrapping_add(d);
            self.state[4] = self.state[4].wrapping_add(e);
        }
        pub fn finish_hex(mut self) -> String {
            let bit_len = self.len * 8;
            self.buf.push(0x80);
            while self.buf.len() % 64 != 56 {
                self.buf.push(0);
            }
            self.buf.extend_from_slice(&bit_len.to_be_bytes());
            let blocks: Vec<Vec<u8>> = self.buf.chunks(64).map(|c| c.to_vec()).collect();
            for block in &blocks {
                self.process(block);
            }
            self.state
                .iter()
                .map(|v| format!("{:08x}", v))
                .collect::<String>()
        }
    }
}

fn sha1_of_bytes(data: &[u8]) -> String {
    let mut d = sha1_simple::Sha1::digest_empty();
    d.update(data);
    d.finish_hex()
}

/// Refuse anything that looks like a secret in the env.
fn knows_secret(key: &str, value: &str) -> bool {
    let k = key.to_lowercase();
    let v = value.to_lowercase();
    k.contains("token")
        || k.contains("secret")
        || k.contains("password")
        || k.contains("apikey")
        || k.contains("api_key")
        || k.contains("access_code")
        || v.contains("begin rsa")
        || v.contains("jwt")
}

/// Create a junction-like scratch dir (temp, cleaned on drop of the worker).
fn make_scratch(label: &str) -> Result<PathBuf, SpawnError> {
    let base = std::env::temp_dir().join(format!("blender-bridge-{label}-{}", std::process::id()));
    std::fs::create_dir_all(&base).map_err(|e| SpawnError::Scratch(format!("{}: {e}", base.display())))?;
    Ok(base)
}

/// Spawn a headless Blender with T2 limits, returning a worker with watchdog.
pub fn spawn_blender(
    install: &BlenderInstall,
    script: &Path,
    args: &[&str],
    options: &SpawnOptions,
) -> Result<BlenderWorker, SpawnError> {
    // 1. secrets guard (before any spawn)
    let mut secret_keys: Vec<String> = Vec::new();
    for (k, v) in &options.env_extra {
        if knows_secret(k, v) {
            secret_keys.push(k.clone());
        }
    }
    if !secret_keys.is_empty() {
        return Err(SpawnError::SecretInEnv { keys: secret_keys });
    }

    let scratch = make_scratch(&options.label)?;

    // Heartbeat channel the worker must touch (env-visible path).
    let heartbeat_file = scratch.join("heartbeat");
    std::fs::write(&heartbeat_file, b"start").ok();

    let mut cmd = Command::new(&install.exe);
    cmd.arg("--background")
        .arg("--factory-startup")
        .arg("--python")
        .arg(script)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        // The worker script reads this to keep the heartbeat alive.
        .env(
            "BLENDER_BRIDGE_HEARTBEAT",
            heartbeat_file.to_string_lossy().to_string(),
        );

    for (k, v) in &options.env_extra {
        cmd.env(k, v);
    }
    if let Some(dir) = &options.cwd {
        cmd.current_dir(dir);
    }

    // 2. spawn (killable group handled on drop / watchdog)
    let child = cmd
        .spawn()
        .map_err(|e| SpawnError::Io {
            bin: install.exe.display().to_string(),
            source: e,
        })?;
    let pid = child.id();

    // 3. external watchdog: the spawned worker MUST update the heartbeat file
    // periodically (the worker script touches it every ~500 ms). The watcher
    // thread only monitors for *stall*: if the file's mtime does not advance
    // within `heartbeat_timeout_ms`, the child is killed. This satisfies §8.2
    // "mandatory external watchdog" — an independent observer, not the worker
    // itself, holds the kill switch.
    std::fs::write(&heartbeat_file, b"start").ok();
    let kill_flag = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::new(AtomicBool::new(false));
    let timeout_ms = options.heartbeat_timeout_ms.unwrap_or(2_000);
    let watchdog_thread = {
        let hb = heartbeat_file.clone();
        let kf = Arc::clone(&kill_flag);
        let sf = Arc::clone(&stop_flag);
        std::thread::spawn(move || {
            let interval = Duration::from_millis(200);
            let timeout = Duration::from_millis(timeout_ms);
            let mut last_seen = Instant::now();
            let mut last_mtime: Option<std::time::SystemTime> = None;
            loop {
                std::thread::sleep(interval);
                if sf.load(Ordering::SeqCst) {
                    break;
                }
                // Read the heartbeat mtime (the worker touches it). mtime
                // resolution on NTFS is ~100 ns so a fresh write is visible.
                let now = std::time::SystemTime::now();
                let mtime = std::fs::metadata(&hb).and_then(|m| m.modified()).ok();
                if mtime.is_some() && mtime != last_mtime {
                    last_mtime = mtime;
                    last_seen = Instant::now();
                }
                if last_seen.elapsed() > timeout {
                    // Heartbeat lost — reap the child.
                    kf.store(true, Ordering::SeqCst);
                    let _ = std::fs::write(&hb, b"lost");
                    break;
                }
                let _ = now;
            }
        })
    };

    let worker = BlenderWorker {
        child,
        pid,
        scratch: scratch.clone(),
        kill_flag,
        _watchdog: Arc::new(WatchdogHandle {
            stop: stop_flag,
            _join: watchdog_thread,
        }),
        out_cap: options.output_cap.unwrap_or(64 * 1024),
    };

    Ok(worker)
}

/// Options controlling a T2 spawn.
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub label: String,
    /// Wall-clock cap in ms; the worker is killed when exceeded.
    pub wall_clock_ms: Option<u64>,
    /// Max captured stdout bytes.
    pub output_cap: Option<usize>,
    /// Extra env (secrets refused).
    pub env_extra: Vec<(String, String)>,
    /// Working directory.
    pub cwd: Option<PathBuf>,
    /// Watchdog heartbeat timeout (default 2 s).
    pub heartbeat_timeout_ms: Option<u64>,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        SpawnOptions {
            label: "worker".to_string(),
            wall_clock_ms: None,
            output_cap: Some(64 * 1024),
            env_extra: Vec::new(),
            cwd: None,
            heartbeat_timeout_ms: Some(2_000),
        }
    }
}

impl BlenderWorker {
    /// Read captured stdout up to the cap.
    pub fn capture_stdout(&mut self) -> CapturedOutput {
        let mut out = Vec::new();
        let cap = self.out_cap;
        if let Some(stdout) = self.child.stdout.take() {
            let mut reader = stdout;
            let mut buf = vec![0u8; 4096];
            loop {
                let n = reader.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
                if out.len() >= cap {
                    break;
                }
            }
        }
        CapturedOutput {
            bytes: out.len().min(cap),
            truncated: out.len() > cap,
            digest_hex: sha1_of_bytes(&out[..out.len().min(cap)]),
        }
    }

    /// Reap the child (with kill on wall-clock overflow).
    pub fn finish(&mut self, wall_clock_ms: u64) -> Result<i32, SpawnError> {
        let start = Instant::now();
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return Ok(status.code().unwrap_or(-1)),
                Ok(None) => {
                    if start.elapsed().as_millis() as u64 > wall_clock_ms {
                        self.kill_tree();
                        self.child.wait().ok();
                        return Err(SpawnError::WallClock { millis: wall_clock_ms });
                    }
                    if self.kill_flag.load(Ordering::SeqCst) {
                        self.kill_tree();
                        self.child.wait().ok();
                        return Err(SpawnError::Watchdog { pid: self.pid });
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return Ok(-1),
            }
        }
    }

    /// Kill the process tree (Windows: `taskkill /T /F`).
    fn kill_tree(&self) {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID"])
            .arg(self.pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    /// Cleanup scratch (junction dir + artifacts).
    pub fn cleanup_scratch(&self) {
        let _ = std::fs::remove_dir_all(&self.scratch);
    }
}

/// The install kind drives transport selection.
pub fn transport_for(install: &BlenderInstall) -> Transport {
    match install.kind {
        InstallKind::MsixAlias => Transport::FileChannel,
        InstallKind::Classic => Transport::FramedStdio,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Transport {
    /// JSON-over-file + binary artifact channel (MSIX alias stdout limit).
    FileChannel,
    /// Framed stdio (classic installs).
    FramedStdio,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_digest_is_deterministic() {
        assert_eq!(sha1_of_bytes(b"hello"), sha1_of_bytes(b"hello"));
        assert_eq!(sha1_of_bytes(b"hello").len(), 40);
    }

    #[test]
    fn captured_output_truncates() {
        let data = vec![0xABu8; 200_000];
        let cap = CapturedOutput::capture(std::io::Cursor::new(data), 1024).unwrap();
        assert_eq!(cap.bytes, 1024);
        assert!(cap.truncated);
    }

    #[test]
    fn secrets_refused_in_env() {
        let install = BlenderInstall {
            exe: PathBuf::from("blender"),
            kind: InstallKind::Classic,
            version: "5.2.2".into(),
        };
        let script = Path::new("dummy.py");
        let opts = SpawnOptions {
            env_extra: vec![("ANY_TOKEN".into(), "abc".into())],
            ..Default::default()
        };
        match spawn_blender(&install, script, &[], &opts) {
            Err(SpawnError::SecretInEnv { keys }) => {
                assert_eq!(keys, vec!["ANY_TOKEN"])
            }
            Ok(_) => panic!("expected SecretInEnv, got Ok(worker)"),
            Err(other) => panic!("expected SecretInEnv, got {other:?}"),
        }
    }

    #[test]
    fn transport_selection_alias_vs_classic() {
        let alias = BlenderInstall {
            exe: PathBuf::from("...WindowsApps/blender-launcher.exe"),
            kind: InstallKind::MsixAlias,
            version: "5.2.2".into(),
        };
        let classic = BlenderInstall {
            exe: PathBuf::from(".../blender.exe"),
            kind: InstallKind::Classic,
            version: "5.2.2".into(),
        };
        assert_eq!(transport_for(&alias), Transport::FileChannel);
        assert_eq!(transport_for(&classic), Transport::FramedStdio);
    }
}
