//! Broker crate skeleton — S6-002.
//!
//! Trusted orchestrator of the new editor: owns the workspace DB (rusqlite,
//! single-writer), exposes a typed command façade, and never holds auth
//! credentials or BYOK keys (keystore boundary, see [`keystore`]). Approval
//! identity is typed against the auth tenant's `Principal` (see
//! [`approval`]), but the broker never sees credentials.

pub mod action_registry;
pub mod approval;
pub mod chat_store;
pub mod db;
pub mod dispatch;
pub mod job_dispatch;
pub mod keystore;
pub mod resolve;

pub use approval::{
    ApprovalAuthority, ApprovalError, ConsumeContext, ConsumedApproval, IssueRequest,
    IssuedApproval, ScopedIssueRequest,
};
pub use chat_store::{chat_store_dir, ChatStore, ChatStoreError};
pub use db::{DbHandle, MigrationError};
pub use dispatch::{
    AceAutoFeedPayload, AceBindSlotPayload, AceDryPayload, BedPayload, ControlTransport,
    DeviceControlAction, DeviceControlRequest, DevicePayload, DispatchError, DispatchGate,
    DispatchReceipt, LightBrightnessPayload, LightEnabledPayload, NozzlePayload, PartFanPayload,
    PartFanTarget, PayloadError, RequestContext, SpeedMode, SpeedPayload, TransportOutcome,
    UnavailableTransport, MAX_PAYLOAD_BYTES,
};
pub use job_dispatch::{
    is_cas_digest, is_opaque_ref, ArtifactCompatibility, JobAction, JobDispatchError,
    JobDispatchGate, JobReceipt, JobRequest, JobTransport, MaterialSlot, ObservedJob, PrintMode,
    ProviderSnapshot, QueueIntent, StartIntent, StopIntent, UnavailableJobTransport, UploadIntent,
    MAX_MATERIAL_SLOTS, MAX_SNAPSHOT_AGE_MS, MAX_UPLOAD_BYTES,
};
pub use keystore::{Keystore, KeystoreError, MemoryKeystore};

/// Broker version surfaced by the MCP-style capability catalog.
pub const BROKER_VERSION: &str = env!("CARGO_PKG_VERSION");
