//! Named-capability broker proxy to pinned T2 workers — S9-004.
//!
//! Model-generated code that wants Blender/OCCT *results* requests a named
//! geometry capability (e.g. `geometry.boolean`). The broker proxies it to
//! the pinned worker — the model never obtains a Blender handle. Raw Blender
//! exec is denied (T3b-routed); unlisted geometry ops are denied.
//!
//! The pinned external worker (Blender/OCCT — user-installed prerequisite,
//! never bundled, GPL/LGPL external per the LICENSE POLICY) is represented
//! by the [`GeometryWorker`] trait. The in-crate [`StubGeometryWorker`] is
//! deterministic and headless so the proxy contract (hash equality,
//! disposable sessions, isolation) is provable in unit tests — the same
//! pattern as `StubTransport` in `http.rs`.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::capability::{Capability, GeometryOp};

/// Named geometry capabilities the broker can proxy (registry keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryCapabilityKind {
    GeometryBoolean,
    GeometryExtrude,
    MeshValidate,
    OcctConvert,
}

impl GeometryCapabilityKind {
    /// Registry name, e.g. `geometry.boolean`.
    pub fn name(self) -> &'static str {
        match self {
            Self::GeometryBoolean => "geometry.boolean",
            Self::GeometryExtrude => "geometry.extrude",
            Self::MeshValidate => "mesh.validate",
            Self::OcctConvert => "occt.convert",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "geometry.boolean" => Some(Self::GeometryBoolean),
            "geometry.extrude" => Some(Self::GeometryExtrude),
            "mesh.validate" => Some(Self::MeshValidate),
            "occt.convert" => Some(Self::OcctConvert),
            _ => None,
        }
    }

    /// Raw Blender exec names are NEVER proxyable — denied as T3b-routed.
    pub fn is_raw_blender_name(name: &str) -> bool {
        matches!(
            name,
            "blender.exec" | "bpy" | "raw.blender" | "blender.script"
        )
    }

    /// Maps to the existing (S9-002) capability surface.
    pub fn maps_to_capability(self) -> Capability {
        match self {
            Self::OcctConvert => Capability::OoctConvert,
            _ => Capability::BlenderGeometry,
        }
    }

    /// Maps to the existing (S9-002) geometry op enum.
    pub fn maps_to_op(self) -> GeometryOp {
        match self {
            Self::GeometryBoolean => GeometryOp::Boolean,
            Self::GeometryExtrude => GeometryOp::Extrude,
            Self::MeshValidate => GeometryOp::MeshValidate,
            Self::OcctConvert => GeometryOp::OcctConvert,
        }
    }
}

/// Which pinned external worker owns a capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerKind {
    Blender,
    Occt,
}

/// A declared capability entry: id + JSON input schema + bound worker kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CapabilitySchema {
    pub id: String,
    pub worker: WorkerKind,
    pub input_schema: serde_json::Value,
    pub description: String,
}

/// The capability registry: the declared, schematized named capabilities the
/// broker is willing to proxy. Everything else is denied.
#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityRegistry {
    schemas: Vec<CapabilitySchema>,
}

impl CapabilityRegistry {
    /// The built-in declarations (Invest. Rev 2.0 §8.2).
    pub fn declared() -> Self {
        Self {
            schemas: vec![
                CapabilitySchema {
                    id: GeometryCapabilityKind::GeometryBoolean.name().to_string(),
                    worker: WorkerKind::Blender,
                    input_schema: json!({
                        "type": "object",
                        "required": ["boolean"],
                        "properties": {
                            "boolean": { "enum": ["union", "subtract", "intersect"] },
                            "target": { "type": "string" }
                        }
                    }),
                    description: "Boolean combine two meshes on the pinned Blender worker"
                        .to_string(),
                },
                CapabilitySchema {
                    id: GeometryCapabilityKind::GeometryExtrude.name().to_string(),
                    worker: WorkerKind::Blender,
                    input_schema: json!({
                        "type": "object",
                        "required": ["height"],
                        "properties": {
                            "height": { "type": "number", "exclusiveMinimum": 0.0 },
                            "angle_deg": { "type": "number" }
                        }
                    }),
                    description: "Extrude a flat sketch on the pinned Blender worker".to_string(),
                },
                CapabilitySchema {
                    id: GeometryCapabilityKind::MeshValidate.name().to_string(),
                    worker: WorkerKind::Blender,
                    input_schema: json!({
                        "type": "object",
                        "properties": {
                            "watertight": { "type": "boolean" },
                            "min_area_mm2": { "type": "number" }
                        }
                    }),
                    description: "Validate a mesh (watertight / degenerate checks)".to_string(),
                },
                CapabilitySchema {
                    id: GeometryCapabilityKind::OcctConvert.name().to_string(),
                    worker: WorkerKind::Occt,
                    input_schema: json!({
                        "type": "object",
                        "required": ["format"],
                        "properties": {
                            "format": { "enum": ["step", "stl", "obj"] },
                            "tolerance_mm": { "type": "number" }
                        }
                    }),
                    description: "Conversion-only OCCT tier (STEP/STL/OBJ)".to_string(),
                },
            ],
        }
    }

    pub fn get(&self, id: &str) -> Option<&CapabilitySchema> {
        self.schemas.iter().find(|s| s.id == id)
    }

    pub fn declared_names(&self) -> Vec<&str> {
        self.schemas.iter().map(|s| s.id.as_str()).collect()
    }

    pub fn len(&self) -> usize {
        self.schemas.len()
    }

    pub fn is_empty(&self) -> bool {
        self.schemas.is_empty()
    }
}

/// The granted subset for one manifest. Never broader than requested.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantedGeometryCapabilities {
    pub capabilities: Vec<GeometryCapabilityKind>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProxyError {
    #[error("geometry operation not listed in the capability registry: {0}")]
    UnlistedOperation(String),
    #[error("raw Blender exec is denied for generated tools (T3b-routed)")]
    RawBlenderDenied,
    #[error("capability not granted to this tool: {0}")]
    NotGranted(String),
    #[error("no such disposable session: {0}")]
    SessionNotFound(u64),
    #[error("session already disposed")]
    SessionDisposed,
    #[error("worker failure: {0}")]
    WorkerFailed(String),
    #[error("io error: {0}")]
    Io(String),
}

/// Deterministic result of one worker invocation.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkerOutput {
    /// Content hash of the canonical result payload (FNV-1a 64, hex).
    pub result_hash: String,
    pub result: serde_json::Value,
}

/// The pinned (T2) worker boundary. Implementations: [`StubGeometryWorker`]
/// (in-crate, deterministic), later a real Blender/OCCT connector over the
/// S7 blender-bridge IPC — an external prerequisite, never bundled.
pub trait GeometryWorker: std::fmt::Debug {
    /// Pure: never mutates `input`, never shares user-session state.
    fn run(
        &self,
        cap: GeometryCapabilityKind,
        input: &serde_json::Value,
    ) -> Result<WorkerOutput, ProxyError>;
}

/// Deterministic in-process worker for tests/headless. The result payload is
/// `{capability, input}`; its content hash is identical for the broker path
/// and the direct-run path, so the proxy provably cannot alter the
/// computation.
#[derive(Debug, Default)]
pub struct StubGeometryWorker;

impl GeometryWorker for StubGeometryWorker {
    fn run(
        &self,
        cap: GeometryCapabilityKind,
        input: &serde_json::Value,
    ) -> Result<WorkerOutput, ProxyError> {
        let payload = json!({ "capability": cap.name(), "input": input });
        let canonical = serde_json::to_vec(&payload).map_err(|e| ProxyError::Io(e.to_string()))?;
        let result = json!({ "ok": true, "capability": cap.name(), "scoped": true });
        Ok(WorkerOutput {
            result_hash: content_hash(&canonical),
            result,
        })
    }
}

/// Lifecycle of one AI-job disposable worker session (§4.6). The session
/// runs and then dies; it never shares the user session process state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Spawned,
    Running,
    Exited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SessionId(pub u64);

#[derive(Clone, Debug, PartialEq)]
pub struct WorkerSession {
    pub id: SessionId,
    /// Simulated OS pid of the disposable worker process.
    pub pid: u64,
    pub capability: GeometryCapabilityKind,
    pub state: SessionState,
    pub result_hash: Option<String>,
}

/// Broker-proxied geometry capability execution.
#[derive(Debug)]
pub struct GeometryBroker<W: GeometryWorker> {
    registry: CapabilityRegistry,
    worker: W,
    /// Last grant from `grant_for_manifest`. Replaced on every manifest
    /// (fail-closed: never unioned).
    granted: GrantedGeometryCapabilities,
    sessions: Vec<WorkerSession>,
    next_session_id: u64,
    next_pid: u64,
}

impl<W: GeometryWorker> GeometryBroker<W> {
    pub fn new(worker: W) -> Self {
        Self {
            registry: CapabilityRegistry::declared(),
            worker,
            granted: GrantedGeometryCapabilities::default(),
            sessions: Vec::new(),
            next_session_id: 0,
            next_pid: 0,
        }
    }

    pub fn registry(&self) -> &CapabilityRegistry {
        &self.registry
    }

    /// Manifest grant — deny-by-default: unlisted geometry ops are denied,
    /// raw Blender exec names are denied (T3b-routed); the granted set is a
    /// subset of the requested names intersected with the registry.
    pub fn grant_for_manifest(
        &mut self,
        requested_names: &[impl AsRef<str>],
    ) -> Result<GrantedGeometryCapabilities, ProxyError> {
        let mut granted = Vec::new();
        for name in requested_names {
            let name = name.as_ref();
            match GeometryCapabilityKind::from_name(name) {
                Some(kind) => granted.push(kind),
                None if GeometryCapabilityKind::is_raw_blender_name(name) => {
                    return Err(ProxyError::RawBlenderDenied);
                }
                None => return Err(ProxyError::UnlistedOperation(name.to_string())),
            }
        }
        let g = GrantedGeometryCapabilities {
            capabilities: granted,
        };
        self.granted = g.clone();
        Ok(g)
    }

    /// Spawn a disposable session for a granted capability.
    pub fn spawn_session(&mut self, cap: GeometryCapabilityKind) -> Result<SessionId, ProxyError> {
        if !self.granted.capabilities.contains(&cap) {
            return Err(ProxyError::NotGranted(cap.name().to_string()));
        }
        self.next_session_id += 1;
        self.next_pid += 1;
        let id = SessionId(self.next_session_id);
        self.sessions.push(WorkerSession {
            id,
            pid: self.next_pid,
            capability: cap,
            state: SessionState::Spawned,
            result_hash: None,
        });
        Ok(id)
    }

    /// Run the granted capability against a fixture input on the disposable
    /// worker. The result hash is written to the session record.
    pub fn run(
        &mut self,
        session: SessionId,
        input: &serde_json::Value,
    ) -> Result<WorkerOutput, ProxyError> {
        let idx = self
            .sessions
            .iter()
            .position(|s| s.id == session)
            .ok_or(ProxyError::SessionNotFound(session.0))?;
        if self.sessions[idx].state == SessionState::Exited {
            return Err(ProxyError::SessionDisposed);
        }
        let cap = self.sessions[idx].capability;
        let output = self.worker.run(cap, input)?;
        let hash = output.result_hash.clone();
        self.sessions[idx].state = SessionState::Running;
        self.sessions[idx].result_hash = Some(hash);
        Ok(output)
    }

    /// Dispose the disposable session: the process is killed. Read-only
    /// record (with pid) is retained for audit; it is no longer live.
    pub fn dispose(&mut self, session: SessionId) -> Result<(), ProxyError> {
        let idx = self
            .sessions
            .iter()
            .position(|s| s.id == session)
            .ok_or(ProxyError::SessionNotFound(session.0))?;
        if self.sessions[idx].state == SessionState::Exited {
            return Err(ProxyError::SessionDisposed);
        }
        self.sessions[idx].state = SessionState::Exited;
        Ok(())
    }

    /// Live (not-yet-disposed) worker processes — the "confirmed dead" check
    /// is `live` dropping to 0 once every session is disposed.
    pub fn live_sessions(&self) -> usize {
        self.sessions
            .iter()
            .filter(|s| s.state != SessionState::Exited)
            .count()
    }

    pub fn live_pids(&self) -> Vec<u64> {
        self.sessions
            .iter()
            .filter(|s| s.state != SessionState::Exited)
            .map(|s| s.pid)
            .collect()
    }

    pub fn session(&self, id: SessionId) -> Option<&WorkerSession> {
        self.sessions.iter().find(|s| s.id == id)
    }
}

/// FNV-1a 64 content hash (lowercase hex) — deterministic content addressing
/// without a crypto dependency; same pattern as planar-core §3.3.
pub fn content_hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker() -> GeometryBroker<StubGeometryWorker> {
        GeometryBroker::new(StubGeometryWorker)
    }

    #[test]
    fn registry_declares_four_geometry_caps_with_schemas() {
        let reg = CapabilityRegistry::declared();
        assert_eq!(reg.len(), 4);
        assert_eq!(
            reg.declared_names(),
            vec![
                "geometry.boolean",
                "geometry.extrude",
                "mesh.validate",
                "occt.convert"
            ]
        );
        let boolean = reg.get("geometry.boolean").unwrap();
        assert_eq!(boolean.worker, WorkerKind::Blender);
        assert_eq!(boolean.input_schema["required"][0], "boolean");
        let occt = reg.get("occt.convert").unwrap();
        assert_eq!(occt.worker, WorkerKind::Occt);
        assert!(reg.get("geometry.subdivide").is_none());
    }

    #[test]
    fn capability_mapping_is_consistent_with_s9_002_surface() {
        assert_eq!(
            GeometryCapabilityKind::GeometryBoolean.maps_to_capability(),
            Capability::BlenderGeometry
        );
        assert_eq!(
            GeometryCapabilityKind::OcctConvert.maps_to_capability(),
            Capability::OoctConvert
        );
        assert_eq!(
            GeometryCapabilityKind::MeshValidate.maps_to_op(),
            GeometryOp::MeshValidate
        );
        assert_eq!(
            GeometryCapabilityKind::OcctConvert.maps_to_op(),
            GeometryOp::OcctConvert
        );
    }

    #[test]
    fn grant_is_subset_of_requested_and_never_broader() {
        let mut b = broker();
        let g = b
            .grant_for_manifest(&["geometry.boolean", "mesh.validate"])
            .unwrap();
        assert_eq!(
            g.capabilities,
            vec![
                GeometryCapabilityKind::GeometryBoolean,
                GeometryCapabilityKind::MeshValidate
            ]
        );
        // subset only: requesting more than granted never materializes extras
        let g2 = b.grant_for_manifest(&["geometry.boolean"]).unwrap();
        assert_eq!(
            g2.capabilities,
            vec![GeometryCapabilityKind::GeometryBoolean]
        );
    }

    #[test]
    fn unlisted_geometry_op_denied() {
        let mut b = broker();
        let err = b.grant_for_manifest(&["geometry.subdivide"]).unwrap_err();
        assert_eq!(
            err,
            ProxyError::UnlistedOperation("geometry.subdivide".to_string())
        );
    }

    #[test]
    fn raw_blender_exec_denied_t3b_routed() {
        for raw in ["blender.exec", "bpy", "raw.blender", "blender.script"] {
            let mut b = broker();
            let err = b.grant_for_manifest(&[raw]).unwrap_err();
            assert_eq!(err, ProxyError::RawBlenderDenied, "denied: {raw}");
        }
    }

    #[test]
    fn spawn_requires_grant_fail_closed() {
        let mut b = broker();
        b.grant_for_manifest(&["mesh.validate"]).unwrap();
        let err = b
            .spawn_session(GeometryCapabilityKind::GeometryBoolean)
            .unwrap_err();
        assert_eq!(err, ProxyError::NotGranted("geometry.boolean".to_string()));
    }

    #[test]
    fn grant_resets_between_manifests_never_unions() {
        let mut b = broker();
        b.grant_for_manifest(&["geometry.boolean"]).unwrap();
        b.grant_for_manifest(&["mesh.validate"]).unwrap();
        let err = b
            .spawn_session(GeometryCapabilityKind::GeometryBoolean)
            .unwrap_err();
        assert_eq!(err, ProxyError::NotGranted("geometry.boolean".to_string()));
    }

    #[test]
    fn proxy_run_hash_equals_direct_run_hash_e2e() {
        let mut b = broker();
        let g = b.grant_for_manifest(&["geometry.boolean"]).unwrap();
        assert_eq!(
            g.capabilities,
            vec![GeometryCapabilityKind::GeometryBoolean]
        );
        let session = b
            .spawn_session(GeometryCapabilityKind::GeometryBoolean)
            .unwrap();

        // Fixture mesh operation — the same input for broker and direct path.
        let input = json!({ "boolean": "subtract", "target": "cube-20mm" });
        let input_before = input.clone();

        let out = b.run(session, &input).unwrap();
        let direct = StubGeometryWorker
            .run(GeometryCapabilityKind::GeometryBoolean, &input)
            .unwrap();

        // The proxy cannot alter the computation.
        assert_eq!(out.result_hash, direct.result_hash);
        assert_eq!(out.result, direct.result);
        // Read-only inputs: the fixture was never mutated.
        assert_eq!(input, input_before);
        assert_eq!(
            b.session(session).unwrap().result_hash.as_deref(),
            Some(out.result_hash.as_str())
        );
    }

    #[test]
    fn disposable_session_confirmed_dead() {
        let mut b = broker();
        b.grant_for_manifest(&["geometry.boolean"]).unwrap();
        let s1 = b
            .spawn_session(GeometryCapabilityKind::GeometryBoolean)
            .unwrap();
        let s2 = b
            .spawn_session(GeometryCapabilityKind::GeometryBoolean)
            .unwrap();
        assert_eq!(b.live_sessions(), 2);

        let input = json!({ "boolean": "union", "target": "cube-20mm" });
        b.run(s1, &input).unwrap();
        b.dispose(s1).unwrap();

        // s1 process is confirmed dead; s2 still live.
        assert_eq!(b.live_sessions(), 1);
        let pid1 = b.session(s1).unwrap().pid;
        assert!(!b.live_pids().contains(&pid1));
        assert_eq!(b.session(s1).unwrap().state, SessionState::Exited);
        assert_eq!(b.session(s2).unwrap().state, SessionState::Spawned);

        b.dispose(s2).unwrap();
        assert_eq!(b.live_sessions(), 0);
        assert!(b.live_pids().is_empty());
    }

    #[test]
    fn sessions_are_independent_never_share_user_state() {
        let mut b = broker();
        b.grant_for_manifest(&["mesh.validate"]).unwrap();
        let s1 = b
            .spawn_session(GeometryCapabilityKind::MeshValidate)
            .unwrap();
        let s2 = b
            .spawn_session(GeometryCapabilityKind::MeshValidate)
            .unwrap();
        // distinct process identities
        assert_ne!(b.session(s1).unwrap().pid, b.session(s2).unwrap().pid);

        let in1 = json!({ "watertight": true });
        let in2 = json!({ "watertight": false });
        let out1 = b.run(s1, &in1).unwrap();
        let out2 = b.run(s2, &in2).unwrap();
        // worker is pure: results only depend on (cap, input), never on which
        // session ran — yet each session holds its own record.
        assert_ne!(out1.result_hash, out2.result_hash);
        assert_eq!(
            out1.result_hash,
            StubGeometryWorker
                .run(GeometryCapabilityKind::MeshValidate, &in1)
                .unwrap()
                .result_hash
        );

        b.dispose(s1).unwrap();
        assert_eq!(b.live_sessions(), 1);
        // disposing one session never touches the other's state
        assert_eq!(b.session(s2).unwrap().state, SessionState::Running);
        assert!(b.session(s2).unwrap().result_hash.is_some());
    }

    #[test]
    fn session_not_found_and_double_dispose_errors() {
        let mut b = broker();
        b.grant_for_manifest(&["geometry.boolean"]).unwrap();
        let missing = SessionId(99);
        assert_eq!(
            b.run(missing, &json!({})).unwrap_err(),
            ProxyError::SessionNotFound(99)
        );
        assert_eq!(
            b.dispose(missing).unwrap_err(),
            ProxyError::SessionNotFound(99)
        );

        let s = b
            .spawn_session(GeometryCapabilityKind::GeometryBoolean)
            .unwrap();
        b.dispose(s).unwrap();
        assert_eq!(b.dispose(s).unwrap_err(), ProxyError::SessionDisposed);
        assert_eq!(
            b.run(s, &json!({})).unwrap_err(),
            ProxyError::SessionDisposed
        );
    }

    #[test]
    fn content_hash_is_deterministic_and_content_sensitive() {
        assert_eq!(content_hash(b"abc"), content_hash(b"abc"));
        assert_ne!(content_hash(b"abc"), content_hash(b"abd"));
        assert_eq!(content_hash(b""), "cbf29ce484222325");
    }
}
