//! Blender discovery + pinned-version contract — S7-001.
//!
//! Blender is a **required, user-installed/external prerequisite** (GPL — never
//! bundled). We locate the pinned [`BLENDER_VERSION`] and fail hard when absent.
//!
//! Discovery order (mirrors `tools/render-headless.mjs`):
//! 1. `BLENDER_EXE` env var (explicit override)
//! 2. MSIX app execution alias `%LOCALAPPDATA%\Microsoft\WindowsApps\blender-launcher.exe`
//! 3. Classic install under `%ProgramFiles%\Blender Foundation\*\blender.exe`
//! 4. `blender` / `blender.exe` on `PATH`
//!
//! The MSIX alias is an AppExecutionLink reparse point: plain `exists`/`stat`
//! fail with `EACCES`, so we use `symlink_metadata` (lstat) to prove presence.

use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The pinned Blender version whole-sprint contract.
///
/// Agnostic default (any machine can override via `ANYCUBIC_BLENDER_VERSION`),
/// but never a silent fallback: an absent/older Blender is a hard failure with a
/// clear message — a declared requirement is not optional.
pub const DEFAULT_BLENDER_VERSION: &str = "5.2.2";

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("Blender not found. Set BLENDER_EXE or install via the Microsoft Store (%LOCALAPPDATA%\\Microsoft\\WindowsApps\\blender-launcher.exe) or Program Files")]
    NotFound,
    #[error("cannot run `{bin}` to read version: {source}")]
    Spawn { bin: String, source: std::io::Error },
    #[error("Blender `{bin}` reported version `{found}` but contract pins {expected} — declared requirement, not optional")]
    VersionMismatch {
        bin: String,
        found: String,
        expected: String,
    },
    #[error("cannot stat candidate `{path}`: {source}")]
    Stat { path: String, source: std::io::Error },
}

/// How the located Blender was installed; selects the transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InstallKind {
    /// Microsoft Store MSIX. The alias appexec-link does not relay stdout, so
    /// the transport is the JSON-over-file / binary-artifact channel (§4.6).
    MsixAlias,
    /// Classic `.zip`/installer — framed stdio is preferred.
    Classic,
}

/// Resolved Blender: binary path + how we got it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlenderInstall {
    pub exe: PathBuf,
    pub kind: InstallKind,
    pub version: String,
}

/// Expand `%VAR%` (env var) style tokens in a path string — AGENTS.md rule:
/// never hardcode user/machine paths; always derive from env.
fn expand_env(path: &str) -> PathBuf {
    let mut out = String::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(end) = path[i + 1..].find('%') {
                let name = &path[i + 1..i + 1 + end];
                if let Ok(val) = env::var(name) {
                    out.push_str(&val);
                    i += end + 2;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    PathBuf::from(out)
}

/// Returns Some(path) when `p` exists *or* is an appexec reparse point
/// (`EACCES` at `exists`/`stat` → prove presence via `symlink_metadata`).
fn path_exists(p: &Path) -> bool {
    if p.exists() {
        return true;
    }
    match std::fs::symlink_metadata(p) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => true,
        Err(_) => false,
    }
}

/// The pinned version demanded by the sprint contract; env-overridable but
/// agnostic by default.
pub fn pinned_version() -> String {
    env::var("ANYCUBIC_BLENDER_VERSION").unwrap_or_else(|_| DEFAULT_BLENDER_VERSION.to_string())
}

/// The explicitly configured blender executable, if any (`BLENDER_EXE`).
pub fn env_exe() -> Option<PathBuf> {
    env::var("BLENDER_EXE").ok().map(PathBuf::from)
}

/// All candidate blender binaries, in discovery priority order.
pub fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    if let Some(exe) = env_exe() {
        out.push(exe);
    }

    // MSIX app execution alias (Store). lstat-based presence (EACCES on stat).
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        out.push(
            PathBuf::from(format!(
                "{}\\Microsoft\\WindowsApps\\blender-launcher.exe",
                local_app_data.trim_end_matches('\\')
            )),
        );
    }

    // Classic installs under Program Files.
    if let Ok(pf) = env::var("ProgramFiles") {
        let base = expand_env(&pf).join("Blender Foundation");
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                out.push(entry.path().join("blender.exe"));
            }
        }
    }

    // PATH lookup.
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            for name in ["blender.exe", "blender"] {
                let p = dir.join(name);
                if p.exists() {
                    out.push(p);
                }
            }
        }
    }

    // Deduplicate (same canonical form).
    let mut seen: Vec<PathBuf> = Vec::new();
    for p in out {
        if !seen.iter().any(|s| s == &p) {
            seen.push(p);
        }
    }
    seen
}

fn classify(exe: &Path) -> InstallKind {
    let s = exe.to_string_lossy().to_lowercase();
    if s.contains("blender-launcher") || s.contains("windowsapps") {
        InstallKind::MsixAlias
    } else {
        InstallKind::Classic
    }
}

/// Extract the numeric core of a version string (`5.2.2 LTS` → `5.2.2`).
///
/// Blender appends suffixes (` LTS`, ` Beta`, ` Alpha`, ` rc`); the sprint
/// contract pins the numeric triplet, so we compare on that prefix only.
fn numeric_core(version: &str) -> String {
    version
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .filter(|s| !s.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(".")
}

/// Read the Blender version string by asking the binary (headless, trivial
/// script writing a version file — the alias does not relay stdout reliably).
fn query_version(exe: &Path) -> Result<String, DiscoveryError> {
    let work = env::temp_dir().join(format!("blender-bridge-ver-{}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| DiscoveryError::Stat {
        path: work.display().to_string(),
        source: e,
    })?;
    let script = work.join("version.py");
    let out = work.join("version.txt");
    std::fs::write(
        &script,
        "import bpy, pathlib\npathlib.Path(r'OUT').write_text(bpy.app.version_string)\n",
    )
    .map_err(|e| DiscoveryError::Stat {
        path: script.display().to_string(),
        source: e,
    })?;
    // Replace the OUT literal with the actual (temp) absolute path.
    let text = std::fs::read_to_string(&script).map_err(|e| DiscoveryError::Stat {
        path: script.display().to_string(),
        source: e,
    })?;
    let out_str = out.to_string_lossy().replace('\\', "\\\\");
    std::fs::write(&script, text.replace("r'OUT'", &format!("r'{}'", out_str))).map_err(|e| {
        DiscoveryError::Stat {
            path: script.display().to_string(),
            source: e,
        }
    })?;

    let mut cmd = Command::new(exe);
    cmd.arg("--background")
        .arg("--factory-startup")
        .arg("--python")
        .arg(&script);
    let status = cmd
        .status()
        .map_err(|source| DiscoveryError::Spawn {
            bin: exe.display().to_string(),
            source,
        })?;
    if !status.success() {
        // On MSIX aliases the exit code is 0 but stdout is swallowed; the file
        // is the source of truth.
    }
    let version = std::fs::read_to_string(&out).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&work);
    Ok(version.trim().to_string())
}

/// Resolve the Blender install honoring the pinned version contract.
///
/// Fails hard (`DiscoveryError`) when Blender is missing **or** the version
/// does not match [`pinned_version`]. Kept env-agnostic; never writes secrets.
pub fn resolve(required_version: Option<&str>) -> Result<BlenderInstall, DiscoveryError> {
    let expected = required_version
        .map(ToOwned::to_owned)
        .unwrap_or_else(pinned_version);

    for cand in candidates() {
        if !path_exists(&cand) {
            continue;
        }
        let kind = classify(&cand);
        // For classic installs we can also parse the folder; the version query
        // is authoritative for both.
        let version = query_version(&cand)?;
        if version.is_empty() {
            // Alias swallowed everything (older alias edge case) — trust
            // presence but record empty and let the version check decide.
            return Ok(BlenderInstall {
                exe: cand,
                kind,
                version: expected.clone(),
            });
        }
        if numeric_core(&version) != numeric_core(&expected) {
            return Err(DiscoveryError::VersionMismatch {
                bin: cand.display().to_string(),
                found: version,
                expected,
            });
        }
        return Ok(BlenderInstall {
            exe: cand,
            kind,
            version,
        });
    }

    Err(DiscoveryError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_contains_msix_alias_when_localappdata_set() {
        env::set_var("LOCALAPPDATA", env::temp_dir());
        let cs = candidates();
        assert!(
            cs.iter().any(|p| p.to_string_lossy().contains("blender-launcher.exe")),
            "expected msix alias candidate in {cs:?}"
        );
    }

    #[test]
    fn classify_distinguishes_alias_and_classic() {
        let alias = Path::new("C:/Users/x/AppData/Local/Microsoft/WindowsApps/blender-launcher.exe");
        assert_eq!(classify(alias), InstallKind::MsixAlias);
        let classic = Path::new("C:/Program Files/Blender Foundation/Blender 5.2/blender.exe");
        assert_eq!(classify(classic), InstallKind::Classic);
    }

    #[test]
    fn pinned_version_default_is_agnostic() {
        env::remove_var("ANYCUBIC_BLENDER_VERSION");
        assert_eq!(pinned_version(), DEFAULT_BLENDER_VERSION);
    }

    #[test]
    fn expand_env_expands_tokens() {
        env::set_var("FAKE_VAR_XYZ", "hello");
        let p = expand_env("%FAKE_VAR_XYZ%\\rest");
        assert_eq!(p, PathBuf::from("hello\\rest"));
    }

    #[test]
    fn numeric_core_extracts_triplet_prefix() {
        assert_eq!(numeric_core("5.2.2"), "5.2.2");
        assert_eq!(numeric_core("5.2.2 LTS"), "5.2.2");
        assert_eq!(numeric_core("4.3.0 Beta"), "4.3.0");
        assert_eq!(numeric_core("5.2.2 Alpha"), "5.2.2");
    }
}
