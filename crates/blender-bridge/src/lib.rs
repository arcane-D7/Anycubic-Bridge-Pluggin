//! blender-bridge — S7-001/002/005: T2 Blender worker bridge.
//!
//! Blender is an external, user-installed prerequisite (GPL, never bundled).
//! This crate provides:
//! - [`discovery`]: pinned-version discovery (MSIX alias → classic → PATH) with
//!   a hard version contract.
//! - [`spawn`]: T2 spawn wrapper (wall-clock/output caps, killable group, no
//!   secrets in env, scratch via temp junction, host-firewall egress note) and
//!   the **external watchdog** (heartbeat loss → child reaped).
//! - [`ipc`]: the versioned begin/update/commit/cancel command contract with
//!   `expected_revision`, topology remap tables and a binary delta channel.
//!   (S7-002 — populated as tickets land.)
//! - [`journal`]: the command journal as the undo/redo/recovery authority
//!   (bpy has no UI undo stack) with validated undo plans (refuses
//!   stale-selection), committed-only redo and snapshot-based crash recovery.
//!   (S7-005)

pub mod discovery;
pub mod ipc;
pub mod journal;
pub mod spawn;

pub use discovery::{resolve, BlenderInstall, DiscoveryError, InstallKind};
pub use journal::{Journal, JournalEntry, JournalError, OpKind, Snapshot, UndoPlan};
pub use spawn::{
    spawn_blender, transport_for, BlenderWorker, CapturedOutput, SpawnError, SpawnOptions,
    Transport,
};
