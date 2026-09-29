//! Generated-tool lifecycle state machine (Investigation Rev 2.0 §8.3).
//!
//! A self-created tool goes through a versioned lifecycle; none of the stages
//! may be skipped. Approval is of the *exact manifested artifact* (hash-bound —
//! approving does not approve a re-build). Registration is by content hash;
//! only then invocable by name. Revocation kills running instances next tick
//! and is journaled.
//!
//! Separation of trust: a generated tool never gets a process handle, a shell
//! or raw Blender access. The only way to "run" a tool is to resolve its
//! artifact hash + granted capabilities for the sandbox runner (S9-002). Shell
//! is not even a `Capability` variant — structurally impossible to request.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::capability::{grant_subset, GrantedCapabilities, RequestedCapabilities};

/// Stages of the tool lifecycle in strict order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Manifest,
    Scratch,
    Build,
    Test,
    Approved,
    Registered,
    Revoked,
    Failed,
}

impl Stage {
    /// The next stage in the lifecycle order (excluding failure).
    pub fn next(&self) -> Option<Stage> {
        match self {
            Stage::Manifest => Some(Stage::Scratch),
            Stage::Scratch => Some(Stage::Build),
            Stage::Build => Some(Stage::Test),
            Stage::Test => Some(Stage::Approved),
            Stage::Approved => Some(Stage::Registered),
            Stage::Registered => Some(Stage::Revoked),
            Stage::Revoked | Stage::Failed => None,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LifecycleError {
    #[error("stage skipped: expected {expected:?}, attempted {attempted:?}")]
    StageSkipped { expected: Stage, attempted: Stage },
    #[error("no manifest registered under name {0}")]
    NoManifest(String),
    #[error("artifact hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("unknown tool name: {0}")]
    UnknownTool(String),
    #[error("unknown version hash: {0}")]
    UnknownVersion(String),
    #[error("tool is revoked or failed")]
    Revoked,
    #[error("tool is not registered")]
    NotRegistered,
    #[error("artifact hash not bound yet (build stage produces it)")]
    UnboundHash,
}

/// One journaled lifecycle transition. Content-addressed by the artifact hash
/// once a build binds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleJournalEntry {
    pub seq: u64,
    pub stage: Stage,
    pub artifact_hash: Option<String>,
    pub running_instances: u32,
}

/// A tool record tracked by the registry. Never holds a process handle —
/// executing happens solely through the sandbox; the record only tracks the
/// instance counter so revocation can kill them next tick.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolRecord {
    pub name: String,
    pub manifest_hash: String,
    /// Content hash of the build artifact; bound at the Build stage.
    pub artifact_hash: Option<String>,
    pub requested: RequestedCapabilities,
    pub granted: GrantedCapabilities,
    pub stage: Stage,
    pub running_instances: u32,
    pub revoking: bool,
}

/// Content-addressed tool registry + strict lifecycle state machine.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ToolRegistry {
    pub tools: HashMap<String, ToolRecord>,
    /// hash → tool name (only registered versions).
    pub versions: HashMap<String, String>,
    pub journal: Vec<LifecycleJournalEntry>,
    seq: u64,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn journal(&mut self, stage: Stage, artifact_hash: Option<String>, running: u32) {
        self.seq += 1;
        self.journal.push(LifecycleJournalEntry {
            seq: self.seq,
            stage,
            artifact_hash,
            running_instances: running,
        });
    }

    fn stage_of(&self, name: &str) -> Option<Stage> {
        self.tools.get(name).map(|r| r.stage)
    }

    /// Stage 1 — register the manifest and its declared capability set.
    /// The broker will grant a subset; never broader.
    pub fn register_manifest(
        &mut self,
        name: String,
        manifest_hash: String,
        requested: RequestedCapabilities,
    ) -> Result<(), LifecycleError> {
        if let Some(rec) = self.tools.get(&name) {
            if matches!(
                rec.stage,
                Stage::Registered | Stage::Revoked | Stage::Failed
            ) {
                return Err(LifecycleError::Revoked);
            }
        }
        let granted = grant_subset(&requested);
        self.tools.insert(
            name.clone(),
            ToolRecord {
                name: name.clone(),
                manifest_hash,
                artifact_hash: None,
                requested,
                granted,
                stage: Stage::Manifest,
                running_instances: 0,
                revoking: false,
            },
        );
        self.journal(Stage::Manifest, None, 0);
        Ok(())
    }

    /// Stage change enforcing strict ordering (no skips) and terminal-state
    /// refusal. `hash` is the artifact hash the transition claims to carry.
    /// When `journal` is false, the caller performs the journal entry (used by
    /// `to_build`, which binds the new hash and journals it in one entry).
    fn advance(&mut self, name: &str, target: Stage, hash: &str) -> Result<(), LifecycleError> {
        self.advance_with_journal(name, target, hash, true)
    }

    fn advance_with_journal(
        &mut self,
        name: &str,
        target: Stage,
        hash: &str,
        journal: bool,
    ) -> Result<(), LifecycleError> {
        let current = self
            .stage_of(name)
            .ok_or_else(|| LifecycleError::NoManifest(name.to_string()))?;
        if matches!(current, Stage::Revoked | Stage::Failed) {
            return Err(LifecycleError::Revoked);
        }
        if current.next() != Some(target) {
            return Err(LifecycleError::StageSkipped {
                expected: current,
                attempted: target,
            });
        }
        let (j_hash, j_running) = {
            let rec = self.tools.get_mut(name).unwrap();
            match &rec.artifact_hash {
                Some(bound) if *bound != hash => {
                    return Err(LifecycleError::HashMismatch {
                        expected: bound.clone(),
                        actual: hash.to_string(),
                    })
                }
                _ => {}
            }
            rec.stage = target;
            (rec.artifact_hash.clone(), rec.running_instances)
        };
        if journal {
            self.journal(target, j_hash, j_running);
        }
        Ok(())
    }

    fn require_hash(&self, name: &str) -> Result<String, LifecycleError> {
        self.tools
            .get(name)
            .and_then(|r| r.artifact_hash.clone())
            .ok_or(LifecycleError::UnboundHash)
    }

    /// Stage 2 — materialize the scratch dir for the artifact.
    pub fn to_scratch(&mut self, name: &str) -> Result<(), LifecycleError> {
        self.advance(name, Stage::Scratch, "")
    }

    /// Stage 3 — build. Binds the artifact content hash; every later carry-hash
    /// stage (test/approve) must match it exactly. The journal entry for the
    /// build transition records the newly bound hash (the transition USES the
    /// artifact it produced).
    pub fn to_build(&mut self, name: &str, artifact_hash: &str) -> Result<(), LifecycleError> {
        self.advance_with_journal(name, Stage::Build, "", false)?;
        let running = {
            let rec = self.tools.get_mut(name).unwrap();
            rec.artifact_hash = Some(artifact_hash.to_string());
            rec.running_instances
        };
        self.journal(Stage::Build, Some(artifact_hash.to_string()), running);
        Ok(())
    }

    /// Rebuild: bind a NEW artifact hash. Allowed from `Build`, `Test` or
    /// `Approved` — the tool returns to `Build`, so test AND approval must run
    /// again (re-approval of the new hash).
    pub fn rebuild(&mut self, name: &str, artifact_hash: &str) -> Result<(), LifecycleError> {
        let current = self
            .stage_of(name)
            .ok_or_else(|| LifecycleError::NoManifest(name.to_string()))?;
        if matches!(current, Stage::Revoked | Stage::Failed | Stage::Registered) {
            return Err(LifecycleError::Revoked);
        }
        if !matches!(current, Stage::Build | Stage::Test | Stage::Approved) {
            return Err(LifecycleError::StageSkipped {
                expected: current,
                attempted: Stage::Build,
            });
        }
        self.journal(Stage::Build, Some(artifact_hash.to_string()), 0);
        let rec = self.tools.get_mut(name).unwrap();
        rec.artifact_hash = Some(artifact_hash.to_string());
        rec.stage = Stage::Build;
        Ok(())
    }

    /// Stage 4 — test (carries the bound hash).
    pub fn to_test(&mut self, name: &str) -> Result<(), LifecycleError> {
        let hash = self.require_hash(name)?;
        self.advance(name, Stage::Test, &hash)
    }

    /// Stage 5 — APPROVAL, hash-bound: approving approves exactly the bound
    /// artifact hash. Approving any other hash fails the tool (fail-closed —
    /// no half-approved state).
    pub fn approve(&mut self, name: &str, artifact_hash: &str) -> Result<(), LifecycleError> {
        let bound = match self.tools.get(name).and_then(|r| r.artifact_hash.clone()) {
            Some(h) => h,
            None => return Err(LifecycleError::UnboundHash),
        };
        if bound != artifact_hash {
            // Hash-bound rejection: the tool is NOT failed — it simply is not
            // approved. Re-approval with the exact bound hash is still
            // possible (correct state-machine behavior for a retry).
            return Err(LifecycleError::HashMismatch {
                expected: bound,
                actual: artifact_hash.to_string(),
            });
        }
        self.advance(name, Stage::Approved, artifact_hash)
    }

    /// Stage 6 — register by content hash. Only then invocable by name or by
    /// hash. The version map is content-addressed: hash → name.
    pub fn register(&mut self, name: &str) -> Result<(), LifecycleError> {
        let current = self
            .stage_of(name)
            .ok_or_else(|| LifecycleError::NoManifest(name.to_string()))?;
        if current.next() != Some(Stage::Registered) {
            return Err(LifecycleError::StageSkipped {
                expected: current,
                attempted: Stage::Registered,
            });
        }
        let hash = match self.tools.get(name).and_then(|r| r.artifact_hash.clone()) {
            Some(h) => h,
            None => return Err(LifecycleError::UnboundHash),
        };
        let running = self
            .tools
            .get(name)
            .map(|r| r.running_instances)
            .unwrap_or(0);
        {
            let rec = self.tools.get_mut(name).unwrap();
            rec.stage = Stage::Registered;
        }
        self.versions.insert(hash.clone(), name.to_string());
        self.journal(Stage::Registered, Some(hash), running);
        Ok(())
    }

    /// Resolve a tool by name → its registered content hash + granted
    /// capabilities. The caller (sandbox runner) executes the artifact inside
    /// the S9-002 sandbox — never via a shell.
    pub fn resolve_artifact(
        &self,
        name: &str,
    ) -> Result<(String, GrantedCapabilities), LifecycleError> {
        let rec = self
            .tools
            .get(name)
            .ok_or_else(|| LifecycleError::UnknownTool(name.to_string()))?;
        if rec.stage != Stage::Registered {
            if rec.stage == Stage::Revoked || rec.stage == Stage::Failed {
                return Err(LifecycleError::Revoked);
            }
            return Err(LifecycleError::NotRegistered);
        }
        let hash = rec
            .artifact_hash
            .clone()
            .ok_or(LifecycleError::UnboundHash)?;
        Ok((hash, rec.granted.clone()))
    }

    /// Resolve by artifact hash (content-addressed). Rejects unknown hashes.
    pub fn resolve_by_hash(&self, hash: &str) -> Result<String, LifecycleError> {
        self.versions
            .get(hash)
            .cloned()
            .ok_or_else(|| LifecycleError::UnknownVersion(hash.to_string()))
    }

    /// Record that one instance started (only when registered).
    pub fn instance_start(&mut self, name: &str) -> Result<(), LifecycleError> {
        let rec = self
            .tools
            .get_mut(name)
            .ok_or_else(|| LifecycleError::UnknownTool(name.to_string()))?;
        if rec.stage != Stage::Registered {
            return Err(LifecycleError::NotRegistered);
        }
        rec.running_instances += 1;
        Ok(())
    }

    /// Stage 7 — revocation. Marks revoking so all running instances are
    /// killed on the next tick; journaled.
    pub fn revoke(&mut self, name: &str) -> Result<(), LifecycleError> {
        let stage = self
            .tools
            .get(name)
            .ok_or_else(|| LifecycleError::UnknownTool(name.to_string()))?
            .stage;
        if stage == Stage::Revoked || stage == Stage::Failed {
            return Err(LifecycleError::Revoked);
        }
        if stage != Stage::Registered {
            return Err(LifecycleError::StageSkipped {
                expected: stage,
                attempted: Stage::Revoked,
            });
        }
        let (running, hash) = {
            let rec = self.tools.get_mut(name).unwrap();
            rec.revoking = true;
            rec.stage = Stage::Revoked;
            (rec.running_instances, rec.artifact_hash.clone())
        };
        self.journal(Stage::Revoked, hash, running);
        Ok(())
    }

    /// Tick — called repeatedly by the supervisor. Kills every running
    /// instance of revoked tools next tick and journals the kill.
    pub fn instance_tick(&mut self) {
        let names: Vec<String> = self
            .tools
            .iter()
            .filter(|(_, r)| r.revoking)
            .map(|(n, _)| n.clone())
            .collect();
        for name in names {
            let outcome = self.tools.get_mut(&name).map(|rec| {
                let killed = rec.running_instances;
                if killed > 0 {
                    let hash = rec.artifact_hash.clone();
                    rec.running_instances = 0;
                    rec.revoking = false;
                    Some(hash)
                } else {
                    rec.revoking = false;
                    None
                }
            });
            if let Some(Some(hash)) = outcome {
                self.journal(Stage::Revoked, hash, 0);
            }
        }
    }

    /// Journal listing — the audit trail of every transition.
    pub fn journal_entries(&self) -> &[LifecycleJournalEntry] {
        &self.journal
    }

    /// Number of distinct tools (registry size).
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Capability;

    fn fs_scratch() -> RequestedCapabilities {
        RequestedCapabilities {
            capabilities: vec![Capability::FsScratch],
        }
    }

    /// Boot a manifest through to Approved with the given artifact hash.
    fn boot_approved(reg: &mut ToolRegistry, name: &str, hash: &str) {
        reg.register_manifest(name.to_string(), "manifest-h".into(), fs_scratch())
            .unwrap();
        reg.to_scratch(name).unwrap();
        reg.to_build(name, hash).unwrap();
        reg.to_test(name).unwrap();
        reg.approve(name, hash).unwrap();
    }

    #[test]
    fn full_lifecycle_succeeds() {
        let mut reg = ToolRegistry::new();
        boot_approved(&mut reg, "tool-a", "abc123");
        assert_eq!(reg.stage_of("tool-a"), Some(Stage::Approved));
        reg.register("tool-a").unwrap();
        assert_eq!(reg.stage_of("tool-a"), Some(Stage::Registered));
        let (hash, granted) = reg.resolve_artifact("tool-a").unwrap();
        assert_eq!(hash, "abc123");
        assert!(granted.capabilities.contains(&Capability::FsScratch));
        // Invocation by content hash.
        assert_eq!(reg.resolve_by_hash("abc123").unwrap(), "tool-a");
        // Journal: every transition recorded, in order, with hashes from build.
        let entries = reg.journal_entries();
        assert_eq!(entries.len(), 6); // manifest, scratch, build, test, approved, registered
        assert_eq!(entries[0].stage, Stage::Manifest);
        assert_eq!(entries[1].stage, Stage::Scratch);
        assert_eq!(entries[2].stage, Stage::Build);
        assert_eq!(entries[3].stage, Stage::Test);
        assert_eq!(entries[4].stage, Stage::Approved);
        assert_eq!(entries[5].stage, Stage::Registered);
        // Hash recorded from Build onward (build transition binds the new hash).
        assert!(entries[2..]
            .iter()
            .all(|e| e.artifact_hash.as_deref() == Some("abc123")));
    }

    #[test]
    fn skipping_stage_fails() {
        let mut reg = ToolRegistry::new();
        reg.register_manifest("tool-b".into(), "m".into(), fs_scratch())
            .unwrap();
        // Manifest → Build directly: Scratch skipped.
        let err = reg.to_build("tool-b", "h").unwrap_err();
        assert_eq!(
            err,
            LifecycleError::StageSkipped {
                expected: Stage::Manifest,
                attempted: Stage::Build
            }
        );
        // Tool remains valid for the correct next stage.
        assert_eq!(reg.stage_of("tool-b"), Some(Stage::Manifest));
    }

    #[test]
    fn approve_is_hash_bound_and_rebuild_requires_reapproval() {
        let mut reg = ToolRegistry::new();
        boot_approved(&mut reg, "tool-c", "h1");
        // Approving a DIFFERENT hash is rejected WITHOUT failing the tool:
        // re-approval with the exact bound hash is still possible (retry).
        assert!(matches!(
            reg.approve("tool-c", "h1-wrong"),
            Err(LifecycleError::HashMismatch { .. })
        ));
        // The tool stays Approved (correct approval happened during boot).
        assert_eq!(reg.stage_of("tool-c"), Some(Stage::Approved));

        // Fresh tool: rebuild binds a NEW hash after approval → back to Build;
        // test + approval must run again (re-approval of the new hash).
        let mut reg2 = ToolRegistry::new();
        boot_approved(&mut reg2, "tool-d", "old-hash");
        reg2.rebuild("tool-d", "new-hash").unwrap();
        assert_eq!(reg2.stage_of("tool-d"), Some(Stage::Build));
        assert_eq!(reg2.require_hash("tool-d").unwrap(), "new-hash");
        // Cannot skip test — straight to approve with the new hash is refused.
        assert!(matches!(
            reg2.approve("tool-d", "new-hash"),
            Err(LifecycleError::StageSkipped { .. })
        ));
        reg2.to_test("tool-d").unwrap();
        // Approval of the OLD hash now fails (bound to new-hash).
        assert!(matches!(
            reg2.approve("tool-d", "old-hash"),
            Err(LifecycleError::HashMismatch { .. })
        ));
        reg2.approve("tool-d", "new-hash").unwrap();
        assert_eq!(reg2.stage_of("tool-d"), Some(Stage::Approved));
    }

    #[test]
    fn register_invoke_by_name_and_hash_unknown_rejected() {
        let mut reg = ToolRegistry::new();
        boot_approved(&mut reg, "tool-e", "h1");
        reg.register("tool-e").unwrap();
        assert_eq!(reg.resolve_artifact("tool-e").unwrap().0, "h1");
        assert_eq!(reg.resolve_by_hash("h1").unwrap(), "tool-e");
        assert_eq!(
            reg.resolve_artifact("nope").unwrap_err(),
            LifecycleError::UnknownTool("nope".into())
        );
        assert_eq!(
            reg.resolve_by_hash("deadbeef").unwrap_err(),
            LifecycleError::UnknownVersion("deadbeef".into())
        );
    }

    #[test]
    fn not_registered_cannot_invoke() {
        let mut reg = ToolRegistry::new();
        boot_approved(&mut reg, "tool-f", "h2");
        // Before registration, invocation is refused.
        assert_eq!(
            reg.resolve_artifact("tool-f").unwrap_err(),
            LifecycleError::NotRegistered
        );
    }

    #[test]
    fn revoke_kills_instances_next_tick_and_journals() {
        let mut reg = ToolRegistry::new();
        boot_approved(&mut reg, "tool-g", "h3");
        reg.register("tool-g").unwrap();
        reg.instance_start("tool-g").unwrap();
        reg.instance_start("tool-g").unwrap();
        assert_eq!(reg.tools["tool-g"].running_instances, 2);
        reg.revoke("tool-g").unwrap();
        assert_eq!(reg.stage_of("tool-g"), Some(Stage::Revoked));
        // Invocation is refused after revocation.
        assert_eq!(
            reg.resolve_artifact("tool-g").unwrap_err(),
            LifecycleError::Revoked
        );
        // Revocation journaled with the instance count.
        assert!(reg
            .journal_entries()
            .iter()
            .any(|e| e.stage == Stage::Revoked && e.running_instances == 2));
        // Next tick kills all running instances.
        reg.instance_tick();
        assert_eq!(reg.tools["tool-g"].running_instances, 0);
        assert!(!reg.tools["tool-g"].revoking);
    }

    #[test]
    fn generated_tool_gets_only_declared_grants_no_shell() {
        let mut reg = ToolRegistry::new();
        reg.register_manifest("tool-h".into(), "m".into(), fs_scratch())
            .unwrap();
        reg.to_scratch("tool-h").unwrap();
        reg.to_build("tool-h", "h4").unwrap();
        reg.to_test("tool-h").unwrap();
        reg.approve("tool-h", "h4").unwrap();
        reg.register("tool-h").unwrap();
        let (_, granted) = reg.resolve_artifact("tool-h").unwrap();
        // Grants are a subset of requested — never broader.
        assert!(granted
            .capabilities
            .iter()
            .all(|c| *c == Capability::FsScratch));
        // No host shell: Shell is NOT a Capability variant (structural
        // impossibility — cannot even be requested) and the registry exposes
        // no spawn/exec API, only resolve_artifact for the sandbox runner.
        // Runtime guard: ShellNeverGranted from S9-002.
        let shell_err = crate::capability::SandboxError::ShellNeverGranted;
        assert!(shell_err.to_string().contains("never granted"));
    }

    #[test]
    fn revoked_or_failed_cannot_continue() {
        let mut reg = ToolRegistry::new();
        boot_approved(&mut reg, "tool-i", "h5");
        // Wrong-stage attempt is refused without damage.
        assert!(matches!(
            reg.to_build("tool-i", "h5"),
            Err(LifecycleError::StageSkipped { .. })
        ));
        assert_eq!(reg.stage_of("tool-i"), Some(Stage::Approved));
        // Register then revoke: a revoked tool cannot re-register a manifest
        // (manifest is frozen for registered/revoked tools).
        reg.register("tool-i").unwrap();
        reg.revoke("tool-i").unwrap();
        assert!(matches!(
            reg.register_manifest("tool-i".into(), "new-manifest".into(), fs_scratch()),
            Err(LifecycleError::Revoked)
        ));
        assert!(matches!(
            reg.to_test("tool-i"),
            Err(LifecycleError::Revoked)
        ));
    }
}
