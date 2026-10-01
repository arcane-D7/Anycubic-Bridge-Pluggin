//! Broker crate skeleton — S6-002.
//!
//! Trusted orchestrator of the new editor: owns the workspace DB (rusqlite,
//! single-writer), exposes a typed command façade, and never touches auth or
//! BYOK keys (keystore boundary, see [`keystore`]).

pub mod chat_store;
pub mod db;
pub mod keystore;

pub use chat_store::{chat_store_dir, ChatStore, ChatStoreError};
pub use db::{DbHandle, MigrationError};
pub use keystore::{Keystore, KeystoreError, MemoryKeystore};

/// Broker version surfaced by the MCP-style capability catalog.
pub const BROKER_VERSION: &str = env!("CARGO_PKG_VERSION");
