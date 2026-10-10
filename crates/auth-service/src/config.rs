//! Auth DB path/config resolution — single owner for CLI, Tauri and tests.
//!
//! Precedence (highest first), documented as the stable contract:
//!   1. explicit CLI `--db <path>` (passed by the caller)
//!   2. `ANYCUBIC_AUTH_DB` (repo-convention env var, AGENTS.md §4)
//!   3. legacy `AUTH_DB` (back-compat; additive, never removed)
//!   4. platform app-data safe default:
//!      - Windows: `%APPDATA%\AnycubicBridge\auth.db` (existing convention —
//!        the same data dir as `workspace.db`; the two *files* stay distinct)
//!      - Unix:    `$XDG_DATA_HOME/anycubic-bridge/auth.db`, falling back to
//!        `$HOME/.local/share/anycubic-bridge/auth.db`; error if none.
//!
//! Rules:
//! - Resolving a path NEVER opens, moves, copies or creates the DB or its
//!   directory; only `AuthDb::open` (and the caller's dir bootstrap) touch
//!   disk. Existing user/token contents are never read here — this module
//!   only answers "which path", and the database file is left untouched.
//! - Relative explicit config (CLI or env) is normalized against the startup
//!   working directory — this preserves the existing CLI convention where
//!   the default `"auth.db"` meant `<cwd>/auth.db`.
//! - Unset env/flag skips to the next precedence level; an env var or CLI
//!   flag that is explicitly SET but EMPTY is a typed [`ConfigError::EmptyPath`]
//!   — never silently treated as unset (fail-closed, avoids a footgun where an
//!   empty value points at the platform default).
//! - [`ensure_distinct_from`] refuses a resolved auth path that aliases the
//!   workspace DB (lexical + best-effort canonical normalization, case and
//!   separator folded on Windows-style paths). Used by the Tauri writer
//!   authority before any open. This is DB separation only — no symlink-walk
//!   traversal hardening is attempted (out of scope by design).

use std::path::{Component, Path, PathBuf};

/// Explicit platform convention for the app-data default. Kept as an enum so
/// tests can exercise the Windows and Unix fallbacks without depending on the
/// host OS (no Windows-specific defaults leak into Unix tests and vice versa).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

/// Typed configuration errors — a caller (CLI or Tauri writer authority) can
/// map these to a stable user-facing reason without string-matching.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("auth db path was explicitly set but is empty")]
    EmptyPath,
    #[error("resolved auth db path equals the workspace db path: {0}")]
    SameAsWorkspaceDb(PathBuf),
    #[error(
        "no application-data directory is available (APPDATA/LOCALAPPDATA on Windows, \
         XDG_DATA_HOME/HOME on Unix)"
    )]
    NoDataDir,
}

/// Current platform convention (Windows else Unix) — used by prod callers.
pub fn current_platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Unix
    }
}

/// Startup working directory for relative-explicit normalization. Falls back
/// to `.` only if the cwd itself is unavailable (never a hard failure).
pub fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Pure arg scan for the `--db <path>` CLI flag (so precedence is testable
/// without spawning the binary). Last occurrence wins, matching `main.rs`
/// before this slice.
pub fn cli_db_from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    let mut value = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--db" {
            if let Some(p) = iter.next() {
                value = Some(p);
            }
        }
    }
    value
}

/// Platform app-data directory (exists by convention; not created here).
pub fn platform_data_dir(
    env: &dyn Fn(&str) -> Option<String>,
    platform: Platform,
) -> Result<PathBuf, ConfigError> {
    match platform {
        Platform::Windows => env("APPDATA")
            .or_else(|| env("LOCALAPPDATA"))
            .map(PathBuf::from)
            .ok_or(ConfigError::NoDataDir),
        Platform::Unix => env("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
            })
            .ok_or(ConfigError::NoDataDir),
    }
}

/// Default auth DB file under a resolved data dir. `AnycubicBridge` preserves
/// the existing Windows convention (same dir as `workspace.db`), while Unix
/// uses the lowercase `anycubic-bridge` directory (matching the existing
/// chat-store convention).
pub fn default_auth_db_under(data_dir: &Path, platform: Platform) -> PathBuf {
    match platform {
        Platform::Windows => data_dir.join("AnycubicBridge").join("auth.db"),
        Platform::Unix => data_dir.join("anycubic-bridge").join("auth.db"),
    }
}

/// The single resolution chain (CLI > new env > legacy env > platform default).
/// Pure over its inputs — no process-global env mutation, no disk writes.
pub fn resolve_auth_db_path(
    cli_db: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
    platform: Platform,
    cwd: &Path,
) -> Result<PathBuf, ConfigError> {
    if let Some(value) = cli_db {
        return explicit(value, cwd);
    }
    if let Some(value) = env("ANYCUBIC_AUTH_DB") {
        return explicit(&value, cwd);
    }
    if let Some(value) = env("AUTH_DB") {
        return explicit(&value, cwd);
    }
    let data_dir = platform_data_dir(env, platform)?;
    Ok(default_auth_db_under(&data_dir, platform))
}

/// Production convenience: standard environment + current platform + cwd.
pub fn default_auth_db_path() -> Result<PathBuf, ConfigError> {
    resolve_auth_db_path(None, &|key| std::env::var(key).ok(), current_platform(), &current_dir())
}

/// Explicit config (CLI or env): empty strings are typed errors (never the
/// same as unset); relative paths anchor at `cwd`.
fn explicit(value: &str, cwd: &Path) -> Result<PathBuf, ConfigError> {
    if value.is_empty() {
        return Err(ConfigError::EmptyPath);
    }
    let path = PathBuf::from(value);
    Ok(if path.is_relative() { cwd.join(path) } else { path })
}

/// Best-effort normalization for alias comparison: canonicalize when the path
/// exists (resolves symlinks/`.`/`..`), otherwise fold components lexically.
/// On Windows-style inputs the case and the separator are folded so
/// `C:\A\B` == `c:/a/b`.
pub fn normalize_path_for_compare(path: &Path, platform: Platform) -> PathBuf {
    let resolved = if path.exists() {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    } else {
        lexical_normalize(path)
    };
    if platform == Platform::Windows {
        PathBuf::from(resolved.to_string_lossy().replace('\\', "/").to_lowercase())
    } else {
        resolved
    }
}

/// Fold `.` components and collapse `..` without touching the filesystem.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::Prefix(_) => {
                out = PathBuf::from(component.as_os_str());
            }
            Component::Normal(segment) => out.push(segment),
        }
    }
    out
}

/// DB separation gate for the writer authority: refuse an auth DB path that
/// aliases the workspace DB (`workspace.db`), so a misconfiguration can never
/// point both stores at the same file. Returns the auth path unchanged on
/// success (convenient for the caller's `AuthDb::open`).
pub fn ensure_distinct_from(
    auth_path: &Path,
    workspace_path: &Path,
    platform: Platform,
) -> Result<PathBuf, ConfigError> {
    let auth = normalize_path_for_compare(auth_path, platform);
    let workspace = normalize_path_for_compare(workspace_path, platform);
    if auth == workspace {
        return Err(ConfigError::SameAsWorkspaceDb(auth_path.to_path_buf()));
    }
    Ok(auth_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Empty env map (nothing set) — every test supplies its own entries.
    fn empty_env() -> impl for<'a> Fn(&'a str) -> Option<String> {
        |_| None
    }

    fn lookup<'e>(entries: &'e [(&'e str, &'e str)]) -> impl for<'a> Fn(&'a str) -> Option<String> + 'e {
        move |key: &str| entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    fn win_env() -> impl for<'a> Fn(&'a str) -> Option<String> {
        lookup(&[("APPDATA", "C:\\Users\\alice\\AppData\\Roaming")])
    }

    fn resolve_with(
        cli_db: Option<&str>,
        env: &dyn Fn(&str) -> Option<String>,
        platform: Platform,
        cwd: &Path,
    ) -> Result<PathBuf, ConfigError> {
        resolve_auth_db_path(cli_db, env, platform, cwd)
    }

    #[test]
    fn cli_flag_beats_new_env_beats_legacy() {
        let cwd = Path::new("/srv/app");
        // 1. CLI flag wins over every env entry.
        let path = resolve_with(
            Some("cli.db"),
            &win_env(),
            Platform::Unix,
            cwd,
        )
        .unwrap();
        assert_eq!(path, cwd.join("cli.db"));
        // 2. New env beats legacy env.
        let path = resolve_with(
            None,
            &lookup(&[
                ("ANYCUBIC_AUTH_DB", "/data/anycubic.auth.db"),
                ("AUTH_DB", "/data/legacy.auth.db"),
            ]),
            Platform::Unix,
            cwd,
        )
        .unwrap();
        assert_eq!(path, PathBuf::from("/data/anycubic.auth.db"));
        // 3. Legacy env used when the new var is absent.
        let path = resolve_with(
            None,
            &lookup(&[("AUTH_DB", "/data/legacy.auth.db")]),
            Platform::Unix,
            cwd,
        )
        .unwrap();
        assert_eq!(path, PathBuf::from("/data/legacy.auth.db"));
    }

    #[test]
    fn unset_falls_back_to_windows_appdata_default() {
        let dir = resolve_with(None, &win_env(), Platform::Windows, Path::new("/srv"))
            .unwrap();
        assert_eq!(
            dir,
            PathBuf::from("C:\\Users\\alice\\AppData\\Roaming\\AnycubicBridge\\auth.db")
        );
    }

    #[test]
    fn unix_default_uses_xdg_data_home() {
        let path = resolve_with(
            None,
            &lookup(&[("XDG_DATA_HOME", "/home/alice/.local/share")]),
            Platform::Unix,
            Path::new("/srv"),
        )
        .unwrap();
        assert_eq!(
            path,
            PathBuf::from("/home/alice/.local/share/anycubic-bridge/auth.db")
        );
    }

    #[test]
    fn unix_default_falls_back_to_home_local_share() {
        let path = resolve_with(
            None,
            &lookup(&[("HOME", "/home/alice")]),
            Platform::Unix,
            Path::new("/srv"),
        )
        .unwrap();
        assert_eq!(
            path,
            PathBuf::from("/home/alice/.local/share/anycubic-bridge/auth.db")
        );
        // XDG wins over HOME when both are present.
        let path = resolve_with(
            None,
            &lookup(&[
                ("XDG_DATA_HOME", "/xdg/data"),
                ("HOME", "/home/alice"),
            ]),
            Platform::Unix,
            Path::new("/srv"),
        )
        .unwrap();
        assert_eq!(path, PathBuf::from("/xdg/data/anycubic-bridge/auth.db"));
    }

    #[test]
    fn missing_data_dir_is_a_typed_absence_error() {
        // Windows without APPDATA/LOCALAPPDATA; Unix without XDG/HOME.
        let err = resolve_with(None, &empty_env(), Platform::Windows, Path::new("/srv"))
            .unwrap_err();
        assert_eq!(err, ConfigError::NoDataDir);
        let err = resolve_with(None, &empty_env(), Platform::Unix, Path::new("/srv"))
            .unwrap_err();
        assert_eq!(err, ConfigError::NoDataDir);
    }

    #[test]
    fn empty_explicit_env_is_typed_error_not_silent_fallback() {
        // Set-but-empty is NOT the same as unset: it must fail closed instead
        // of silently resolving to the platform default or another file.
        let cwd = Path::new("/srv");
        for (key, entries) in [
            ("ANYCUBIC_AUTH_DB", vec![("ANYCUBIC_AUTH_DB", "")]),
            ("AUTH_DB", vec![("AUTH_DB", "")]),
        ] {
            let err = resolve_with(None, &lookup(&entries), Platform::Unix, cwd).unwrap_err();
            assert_eq!(err, ConfigError::EmptyPath, "env {key} must be typed EmptyPath");
        }
    }

    #[test]
    fn empty_cli_flag_is_typed_error() {
        let err = resolve_with(Some(""), &empty_env(), Platform::Unix, Path::new("/srv"))
            .unwrap_err();
        assert_eq!(err, ConfigError::EmptyPath);
    }

    #[test]
    fn relative_explicit_normalizes_against_cwd() {
        let cwd = Path::new("/srv/app");
        // Existing CLI convention: a bare "auth.db" is <cwd>/auth.db.
        let path = resolve_with(Some("auth.db"), &empty_env(), Platform::Unix, cwd).unwrap();
        assert_eq!(path, cwd.join("auth.db"));
        // Legacy env relative values normalize the same way.
        let path = resolve_with(
            None,
            &lookup(&[("AUTH_DB", "auth.db")]),
            Platform::Unix,
            cwd,
        )
        .unwrap();
        assert_eq!(path, cwd.join("auth.db"));
    }

    #[test]
    fn resolution_never_creates_files_or_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("absent-dir").join("auth.db");
        let resolved = resolve_with(Some(cli.to_str().unwrap()), &empty_env(), Platform::Unix, Path::new("/srv")).unwrap();
        assert_eq!(resolved, cli);
        assert!(!cli.exists(), "resolution must not create the DB file");
        assert!(
            !cli.parent().unwrap().exists(),
            "resolution must not create directories"
        );
    }

    #[test]
    fn existing_db_is_never_overwritten_by_resolution() {
        // Create + seed a real auth DB, resolve the same path again and reopen
        // it: the resolver must not truncate or move user contents.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("auth.db");
        {
            let mut db = crate::AuthDb::open(&path).unwrap();
            db.upsert_user("u1", "Editor User").unwrap();
        }
        let resolved = resolve_with(Some(path.to_str().unwrap()), &empty_env(), Platform::Unix, Path::new("/srv")).unwrap();
        assert_eq!(resolved, path);
        let reopened = crate::AuthDb::open(&resolved).unwrap();
        assert_eq!(
            reopened.users().unwrap(),
            vec![("u1".to_string(), "Editor User".to_string())],
            "existing user rows must survive re-resolution"
        );
    }

    #[test]
    fn windows_case_and_separator_aliases_are_denied() {
        let cwd = Path::new("/srv");
        let auth = resolve_with(
            Some(r"C:\AppData\AnycubicBridge\auth.db"),
            &empty_env(),
            Platform::Windows,
            cwd,
        )
        .unwrap();
        // Same file written differently: forward slashes + different case.
        let workspace = PathBuf::from(r"c:/appdata/anycubicbridge/AUTH.DB");
        let err = ensure_distinct_from(&auth, &workspace, Platform::Windows).unwrap_err();
        assert_eq!(
            err,
            ConfigError::SameAsWorkspaceDb(PathBuf::from(r"C:\AppData\AnycubicBridge\auth.db"))
        );
    }

    #[test]
    fn lexical_aliases_are_denied() {
        let cwd = Path::new("/srv");
        let auth = resolve_with(Some("b/auth.db"), &empty_env(), Platform::Unix, cwd).unwrap();
        assert_eq!(auth, cwd.join("b").join("auth.db"));
        let workspace = cwd.join("a/../b/auth.db");
        let err = ensure_distinct_from(&auth, &workspace, Platform::Unix).unwrap_err();
        assert_eq!(err, ConfigError::SameAsWorkspaceDb(auth.clone()));
        // A genuinely different file is accepted and the auth path returned.
        let distinct = ensure_distinct_from(
            &auth,
            &cwd.join("b/workspace.db"),
            Platform::Unix,
        )
        .unwrap();
        assert_eq!(distinct, auth);
    }

    #[test]
    fn canonical_alias_is_denied_when_files_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let auth = tmp.path().join("auth.db");
        std::fs::File::create(&auth).unwrap();
        // `tmp/./auth.db` is the same file as `tmp/auth.db`; the `.` collapses
        // via canonicalization because the file exists.
        let alias = tmp.path().join(".").join("auth.db");
        let err = ensure_distinct_from(&auth, &alias, Platform::Unix).unwrap_err();
        assert_eq!(err, ConfigError::SameAsWorkspaceDb(auth.clone()));
    }

    #[test]
    fn cli_parser_returns_last_db_flag() {
        let args = vec![
            "--db".to_string(),
            "first.db".to_string(),
            "--other".to_string(),
            "--db".to_string(),
            "last.db".to_string(),
        ];
        assert_eq!(cli_db_from_args(args).as_deref(), Some("last.db"));
        assert_eq!(cli_db_from_args(Vec::<String>::new()), None);
        // A trailing `--db` without a value is a no-op (nothing to consume).
        assert_eq!(cli_db_from_args(vec!["--db".to_string()]), None);
        assert_eq!(
            cli_db_from_args(vec!["--db".to_string(), "x.db".to_string()]),
            Some("x.db".to_string())
        );
    }
}
