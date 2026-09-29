//! Harness core — R3 (Sprint 9).
//!
//! S9-001: BYOK provider registry (keys in broker Keystore only), egress
//! pinning, loopback enforcement for local models, quota/cost accounting.
//! S9-002: T1/T3a capability sandbox (deny-by-default, bpy excluded, T3b
//! off by default) + mandatory external watchdog.
//! Later modules (S9-003+): tool lifecycle, capability proxy, learning
//! journal + safety box.

pub mod capability;
pub mod http;
pub mod lifecycle;
pub mod provider;
pub mod proxy;
pub mod sandbox;
pub mod watchdog;

pub use capability::{
    grant_subset, is_allowed, Capability, GeometryOp, GrantedCapabilities, RequestedCapabilities,
    SandboxError,
};
pub use http::{call_chat, ChatMessage, ChatRequest, HttpResponse, HttpTransport, StubTransport};
pub use lifecycle::{LifecycleError, LifecycleJournalEntry, Stage, ToolRecord, ToolRegistry};
pub use provider::{resolve_key, Provider, ProviderError, ProviderKind, ProviderRegistry};
pub use proxy::{
    content_hash, CapabilityRegistry, CapabilitySchema, GeometryBroker, GeometryCapabilityKind,
    GeometryWorker, GrantedGeometryCapabilities, ProxyError, SessionId, SessionState,
    StubGeometryWorker, WorkerKind, WorkerOutput, WorkerSession,
};
pub use sandbox::{backend_available, run_sandboxed, t3b_available, watch_worker, SandboxConfig};
pub use watchdog::{run_watchdog, DeadlinePolicy, WatchdogVerdict, WorkerGuard};

/// Harness version (increments per feature wave).
pub const HARNESS_VERSION: &str = "0.1.0";
