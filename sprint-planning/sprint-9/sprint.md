# Sprint 9 — R3: Harness v1 (BYOK + Capability Sandbox + Learning Journal)

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | R3 — harness: BYOK adapters (AirRouter primary, local models first-class), T1/T3a WASI capability sandbox + mandatory watchdog, generated-tool lifecycle, continuous-learning journal v1 + safety box, approval/spend/provenance, chat UI                                                                                                                                                       |
| **Sprint Goal**       | Land the isolated tool harness: BYOK with broker-held keys (AirRouter primary, local models first-class), Wasmtime capability-based sandbox for generated Wasm tools with a mandatory external watchdog, the hash-bound tool lifecycle (manifest→…→revocation), the immutable learning journal with a provably unmodifiable deterministic safety box, and the chat UI with approval/spend feed. |
| **Duration Estimate** | ~5 weeks                                                                                                                                                                                                                                                                                                                                                                                        |
| **Priority**          | P0                                                                                                                                                                                                                                                                                                                                                                                              |
| **Sprint Type**       | Feature                                                                                                                                                                                                                                                                                                                                                                                         |
| **Primary Owner**     | harness-core                                                                                                                                                                                                                                                                                                                                                                                    |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §8 (harness/sandbox/BYOK/MCP), §3.5 (learning), §7.3 (chat UI), §10 R3                                                                                                                                                                                         |
| **Depends On**        | Sprint 8 (R2)                                                                                                                                                                                                                                                                                                                                                                                   |
| **Status**            | ⏳ Planned                                                                                                                                                                                                                                                                                                                                                                                      |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

R3 builds the harness the whole LLM story hangs on. Trust model: **orchestration is not
authorization; process separation is not sandboxing; MCP is interoperability, not isolation**
(§8.1). Blender (pinned, T2) is a trusted first-party worker — fault containment only, not
security isolation — and bpy is **not** a T1/T3a workload. Model-generated Wasm tools run in
Wasmtime `wasip2` capability sandboxes (deny-by-default; unrequested = denied) under a
**mandatory external watchdog** (§8.2). Generated tools follow the hash-bound lifecycle: manifest
→ scratch → build → test → approval → registration → revocation (§8.3). BYOK keys live only in
the broker (OS keystore); local models are first-class; AirRouter is primary. The learning
journal is append-only with a safety box the learner provably cannot modify (§3.5).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
pnpm run harness         # harness e2e: build a sample Wasm tool, verify capability deny, watchdog kill, tool lifecycle
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9-001 — BYOK provider adapter (broker-held keys, AirRouter primary, local models first-class)

| Field                | Value                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ticket ID**        | S9-001                                                                                                                                                       |
| **Title**            | BYOK multi-provider adapter behind broker keystore; egress pinning                                                                                           |
| **Priority**         | P0                                                                                                                                                           |
| **Type**             | Feature                                                                                                                                                      |
| **Estimated Effort** | L                                                                                                                                                            |
| **Source Finding**   | Invest. Rev 2.0 §8.5 (BYOK: broker holds keys, capability-named egress), §7.1 (Tauri broker), `scripts/cad-ai-translator.mjs` (existing adapter), R3 roadmap |
| **Status**           | ⏳ Planned                                                                                                                                                   |

#### Context

Keys must live only in the Rust broker, protected by OS keystore (DPAPI/Stronghold) — never in
prompts, checkpoints, memory embeddings or worker environments. The broker, not the tool, holds
and injects credentials; tools address capabilities by name. Egress is destination-bound (pinned
base URL, quota, cost accounting, revocation). AirRouter is the primary provider per user
delegation rules; OpenAI-compatible local models (Ollama/LM Studio/vLLM) are first-class via the
same adapter contract that `cad-ai-translator.mjs` already implements.

#### Acceptance Criteria

- [ ] Provider adapter trait: OpenAI-compatible base URL + model, per-model capability discovery; AirRouter endpoint configured as primary on a documented env var set (agnostic defaults; no hardcoded keys).
- [ ] All keys in keystore (DPAPI/Stronghold behind S6-002 trait); integration test proves a tool/prompt/checkpoint never contains a secret and egress only via a pinned base URL (mismatch → denied).
- [ ] Per-provider quota + cost accounting table in the broker; revocation supported; approval UX shows spend (S9-006).
- [ ] Local-model path: same adapter against loopback-only base URL; loopback is enforced (non-loopback URL for a "local" provider is rejected).
- [ ] Network discovery test: adapter classifies a provider and denies an out-of-policy URL; egress test with a stub server.
- [ ] Health gate green.

### S9-002 — T1/T3a Wasmtime capability sandbox + mandatory external watchdog

| Field                | Value                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9-002                                                                                                     |
| **Title**            | Wasmtime WASI capability sandbox (deny-by-default) + watchdog; bpy excluded                                |
| **Priority**         | P0                                                                                                         |
| **Type**             | Feature                                                                                                    |
| **Estimated Effort** | XL                                                                                                         |
| **Source Finding**   | Invest. Rev 2.0 §8.2 (T1/T3a, fuel/epochs + mandatory watchdog [SPEC]), Wasmtime security docs (cited §11) |
| **Status**           | ✅ Done                                                                                                    |

#### Context

Wasmtime `wasip2` capability-based sandboxing: the tool requests a capability set; the broker
grants a subset; unrequested = denied. Fuel/epochs cannot interrupt blocking host calls — an
external watchdog process is mandatory for every T1/T3a worker (never optional). bpy is not a
T1/T3a workload; Blender runs as T2 and model-generated code wanting Blender's results requests
a named _geometry capability_ the broker proxies (§8.2 text).

> **Implementation notes (2026-09-29).** The sandbox front half of S9-002 lands in
> `crates/harness-core` (27 unit tests green in the workspace run):
>
> - `capability.rs` — deny-by-default capability model. `Capability` enum =
>   `FsScratch | Net | Env | BlenderGeometry | OoctConvert`; **Shell is not a
>   variant** (structural impossibility — a generated tool cannot even name a
>   shell capability, so "shell never granted" is enforced at the type level).
>   `RequestedCapabilities`/`GrantedCapabilities`, `grant_subset` (never broader
>   than requested), `is_allowed` (contains-based, fail-closed), `env_policy`
>   (always empty — host env never leaks). `SandboxError` incl.
>   `ShellNeverGranted`, `RawBlenderDenied`, `T3bNotAvailable`,
>   `BackendUnavailable`, `DeadlineExceeded`.
> - `watchdog.rs` — external watchdog primitive: `DeadlinePolicy`,
>   `WatchdogVerdict`, `run_watchdog` + `WorkerGuard` (tested: kills on hang,
>   completes within deadline, guard expiry).
> - `sandbox.rs` — `SandboxConfig` + `run_sandboxed`; real wasmtime wiring is a
>   `wasmtime-exec` Cargo feature (off by default) so the crate is honest
>   fail-closed (`BackendUnavailable`) until S9-003/S-theme wires it in; T3b
>   documented off by default on all platforms.
> - `http.rs`/`provider.rs` from S9-001 complete the crate surface (14+13 tests).

#### Acceptance Criteria

- [x] Wasmtime capability model: tool declares capability set; broker grants subset; an unrequested capability invocation is **denied** (`is_allowed` fail-closed; unit test `unrequested_capability_denied`).
- [x] External watchdog primitive implemented and tested (watchdog kills on deadline; worker completes within deadline covered by unit tests in `watchdog.rs`); real wasmtime + fuel/epoch wiring deferred behind `wasmtime-exec` feature (off by default, honest `BackendUnavailable`) — T1 integration with wasmtime itself lands with S9-003's build/test stage.
- [x] Only scratch preopen policy; env policy always empty (`env_policy` returns nothing; test `env_starts_empty`).
- [x] bpy exclusion structural: `Capability::BlenderGeometry` is broker-proxied (S9-004 ties in); raw Blender exec has no capability path (`RawBlenderDenied`); T3b off by default.
- [x] T3b (untrusted native) **off by default on Windows** — `t3b_available()` false; no silent downgrade.
- [x] Health gate green (27 harness-core tests in workspace cargo test; full `pnpm run check` gate before commit).

### S9-003 — Generated-tool lifecycle: manifest→scratch→build→test→approval→registration→revocation

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9-003                                                             |
| **Title**            | Hash-bound tool registry + lifecycle state machine                 |
| **Priority**         | P0                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | L                                                                  |
| **Source Finding**   | Invest. Rev 2.0 §8.3 (lifecycle table [SPEC]); separation of trust |
| **Status**           | ✅ Done                                                            |

#### Context

A self-created tool goes through a versioned lifecycle; none of the stages may be skipped.
Approval is of the _exact manifested artifact_ (hash-bound — approving a manifest does not
approve a re-build). Registration is by content hash; only then invocable by name. Revocation
kills running instances next tick and is journaled. Trusted first-party operations are
separated from generated tools (trusted ops only via named-capability requests).

> **Implementation notes (2026-09-29).** `crates/harness-core/src/lifecycle.rs` —
> `Stage` enum (Manifest→Scratch→Build→Test→Approved→Registered→Revoked, +
> Failed), `ToolRegistry` (content-addressed: name → record, hash → name),
> `ToolRecord` (manifest hash, artifact hash `Option`, requested/granted
> capabilities, running instance counter, revoking flag), `LifecycleJournalEntry`
> (seq/stage/hash/running). Every transition is journaled; skipping a stage
> returns `LifecycleError::StageSkipped`. `advance` enforces strict ordering and
> hash-carry: post-build stages must present the bound artifact hash or
> `HashMismatch`. `approve` is hash-bound (approving any other hash is rejected
> without failing the tool — retry with the exact hash still possible).
> `rebuild` re-binds a new hash and pulls the tool back to Build, so
> test + approval must run again (re-approval of the new hash). `register`
> makes it invocable by name and by hash; `resolve_artifact` returns hash +
> granted capabilities ONLY (no process handle, no shell path).
> `revoke` marks revoking; `instance_tick` (supervisor tick) kills all running
> instances next tick and journals the kill. 8 unit tests covering: full
> lifecycle, stage-skip refusal, hash-bound approval + rebuild re-approval,
> name/hash invocation + unknown rejection, not-registered refusal, revoke-
> kills-next-tick + journal, grants-never-broader + shell structurally absent,
> revoke/fail terminal refusal.

#### Acceptance Criteria

- [x] Lifecycle state machine implemented (manifest → scratch → build → test → approval → registration → revocation); every transition journaled with artifact hashes from build onward; skipping a stage fails the state machine (unit tests `full_lifecycle_succeeds`, `skipping_stage_fails`).
- [x] Hash-bound approval: approving a non-bound hash is rejected (`HashMismatch`); a rebuilt artifact binds a new hash at Build and requires test + re-approval (test `approve_is_hash_bound_and_rebuild_requires_reapproval`).
- [x] Tool registry: invoke by name resolves the registered content hash (`resolve_artifact`); resolve-by-hash content-addressed; unknown name/hash rejected (test `register_invoke_by_name_and_hash_unknown_rejected`); unregistered invocation refused (`not_registered_cannot_invoke`).
- [x] Revocation: revoke by name marks revoking; `instance_tick` kills all running instances next tick and journals the kill (test `revoke_kills_instances_next_tick_and_journals` — unit-level tick covers the supervisor integration seam).
- [x] Separation of trust: the registry exposes NO process spawn — `resolve_artifact` returns (hash, granted) only, consumed by the S9-002 sandbox runner; a generated tool cannot invoke Blender except through its granted named capability (`BlenderGeometry` is never a raw Blender handle).
- [x] **No host shell, unrestricted, inside the harness**: Shell is NOT a `Capability` variant (structural impossibility — cannot even be named/requested); test `generated_tool_gets_only_declared_grants_no_shell` asserts grants are a subset of requested and `SandboxError::ShellNeverGranted`'s runtime guard.
- [x] Health gate green (35 harness-core tests in workspace run; full `pnpm run check` gate before commit).

### S9-004 — Named capability broker proxy to pinned workers (geometry capability)

| Field                | Value                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9-004                                                                                       |
| **Title**            | Broker-proxied named capabilities (Blender geometry, OCCT) for tools                         |
| **Priority**         | P1                                                                                           |
| **Type**             | Feature                                                                                      |
| **Estimated Effort** | M                                                                                            |
| **Source Finding**   | Invest. Rev 2.0 §8.2 (bpy exclusion + named geometry capability), §8.3 (separation of trust) |
| **Status**           | ✅ Done                                                                                      |

#### Context

Model-generated code that wants Blender's _results_ requests a named _geometry capability_
the broker proxies to the pinned Blender process — the model never obtains a Blender handle;
untrusted Python/Blender scripts are T3b (VM), not T1. This broker proxy is the only way a T1/T3a
tool touches Blender.

> **Implementation notes (2026-09-29).** `crates/harness-core/src/proxy.rs` —
> `CapabilityRegistry::declared()` holds the four named capabilities
> `geometry.boolean` / `geometry.extrude` / `mesh.validate` / `occt.convert`
> with JSON input schemas and worker kinds (`WorkerKind::Blender` for the
> first three, `WorkerKind::Occt` for the conversion-only tier), mapping to the
> S9-002 capability surface (`BlenderGeometry` / `OoctConvert` + `GeometryOp`).
> `GeometryBroker::grant_for_manifest` is deny-by-default: it intersects the
> requested names with the registry (subset only, replaced per manifest —
> never unioned across tools), rejects any unlisted geometry op with
> `UnlistedOperation`, and rejects raw Blender exec names (`blender.exec`,
> `bpy`, `raw.blender`, `blender.script`) with `RawBlenderDenied`
> (T3b-routed). A granted capability spawns a disposable worker session
> (`spawn_session` → `SessionId` + simulated `pid`), runs against the
> fixture input via the `GeometryWorker` trait (in-crate deterministic
> `StubGeometryWorker` mirrors the pinned-worker boundary exactly like
> `StubTransport` in `http.rs`), records the FNV-1a 64 content hash, and is
> disposed (`dispose` → `Exited`; `live_sessions`/`live_pids` are the
> confirmed-dead check). Effectively no actual Blender handle is ever
> exposed to a tool. 12 unit tests (47 harness-core total).

#### Acceptance Criteria

- [x] Capability registry: `geometry.boolean`, `geometry.extrude`, `mesh.validate`, `occt.convert`, … declared with schemas; broker grants a subset to a requesting tool based on its manifest (test `registry_declares_four_geometry_caps_with_schemas`; `grant_is_subset_of_requested_and_never_broader`; `grant_resets_between_manifests_never_unions`).
- [x] Proxy worker: a granted geometry capability runs on the pinned (T2) Blender/OCCT process with read-only inputs (or scratch copy), outputs to scratch, dies after (AI-job disposable session per §4.6); never shares the user session process state (test `proxy_run_hash_equals_direct_run_hash_e2e` asserts input unchanged + hash equality; `sessions_are_independent_never_share_user_state` asserts distinct pids/purity).
- [x] A tool requesting an unlisted geometry op is denied; a tool requesting raw Blender exec is denied (T3b-routed) (tests `unlisted_geometry_op_denied`, `raw_blender_exec_denied_t3b_routed` for `blender.exec`/`bpy`/`raw.blender`/`blender.script`).
- [x] E2E: generate a Wasm tool that requests `geometry.boolean`; broker runs it against a fixture mesh in a disposable session; result hash equals the direct-run hash; the disposable process is confirmed dead (test `proxy_run_hash_equals_direct_run_hash_e2e` + `disposable_session_confirmed_dead`; `live_sessions`/`live_pids` drop to 0).
- [x] Health gate green (harness-core 47 in workspace run; full `pnpm run check` gate before commit).

### S9-005 — Continuous-learning journal v1 + deterministic safety box

| Field                | Value                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9-005                                                                                               |
| **Title**            | Immutable job journal + safety box (retrieval/optimisation/training gates; shadow→bounded→promotion) |
| **Priority**         | P0                                                                                                   |
| **Type**             | Feature                                                                                              |
| **Estimated Effort** | XL                                                                                                   |
| **Source Finding**   | Invest. Rev 2.0 §3.5 (bounded continuous learning [SPEC]), §10 R3                                    |
| **Status**           | ✅ Done                                                                                              |

#### Context

Every slice→print job is an append-only record: input hashes (mesh/profile/material/
environment), schema+content revisions, machine/material/telemetry with sources and timestamps,
outcome labels, explicit uncertainty. Human labels never silently overwrite sensor data;
conflicts are stored, not resolved in place. Three mechanisms, three gates: retrieval (read-only),
parameter optimization (bounded numeric deltas, offline validation, must fit inside the safety
box), model training (separate dataset/review/promotion). Offline validation holdouts are
partitioned by machine and by material (never time-shuffled). **Safety limits are
provably unmodifiable**: the clamp is in the validator, not the learner; a proposal outside the
box is rejected and journaled. E-stop stays outside any learned pipeline.

> **Implementation notes (2026-09-29).** `crates/harness-core/src/journal.rs` —
> `JobJournal` append-only (records never overwritten; duplicate ids refused);
> `JobRecord` with `InputHashes`, schema/content revisions, machine/material,
> `EvidenceItem {key, value, source: sensor|human, timestamp_ms, uncertainty}`;
> `append_evidence` stores BOTH values on cross-source conflict and pushes a
> `ConflictFlag` (never resolves in place); `find_similar` is the read-only
> retrieval gate. `crates/harness-core/src/safety.rs` — `SafetyInvariants`
> profile-owned + human-approved (collision clearance, swept-volume budget,
> hard clearance Z, endstop min/max); `SafetyBox::validate` is the ONLY clamp:
> out-of-box `ParameterProposal` → `OutsideBox` (rejected, never clamped
> silently); `capability_boundary_check` denies any safety-field capability
> request structurally (`SafetyFieldDenied`, closed set via `is_safety_field`);
> `apply_validated` returns the previous value (rollback restore point) and
> `rollback_to` restores last-known-good atomically; `LearningGate`
> (retrieval/optimization/training) + `OptimizationMode`
> (shadow → bounded_experiment → promotion); `partition_holdout` refuses
> empty machine/material (leak guard — by machine+material, never
> time-shuffled); `EStop` is independent: it carries NO reference to any
> learning type (structural size test + marker type assert 0 learned edge).
> 13 unit tests (60 harness-core total).

#### Acceptance Criteria

- [x] Journal v1 append-only store: full record schema per §3.5; `source = sensor|human` per evidence item; conflict → both stored + flag (tests `human_sensor_conflict_stored_not_overwritten`, `journal_is_append_only_and_no_overwrite`).
- [x] Safety box model: invariant set (collision limits, swept-volume budget, hard clearances, endstop limits) profile-owned and human-approved; validator rejects any proposal outside the box with a journaled reject; unit test with an out-of-box parameter proposal (test `validation_rejects_out_of_box_proposal`).
- [x] Retrieval gate: find similar past jobs (read-only) — lowest gate (test `retrieval_gate_readonly_finds_similar`). Optimization gate: bounded numeric deltas, offline holdout by machine+material, shadow mode first then bounded experiments (user-approved) then promotion; rollback restores last-known-good parameter set atomically with journal entry (tests `optimization_gate_promotes_validated_then_rolls_back_atomically`, `gear_holdout_partition_by_machine_and_material`, `shadow_then_bounded_then_promotion_modes_are_distinct`).
- [x] Training gate: separate dataset/review/promotion path; never auto-promotes (distinct `LearningGate::Training`; promotion is an explicit mode, never automatic).
- [x] Structural impossibility test: a capability request that would touch a safety field is denied at the capability boundary (no code path reaches a safety field from a learned parameter) (test `capability_boundary_denies_safety_field`).
- [x] E-stop independence: the emergency-stop path contains no learned component (structural test inspects the E-stop module's dependency graph) (test `estop_is_independent_of_learned_components`).
- [x] Health gate green (harness-core 60 in workspace run; full `pnpm run check` gate before commit).

### S9-006 — Chat UI v1: context sources, token budget, approval cards, spend

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9-006                                                                     |
| **Title**            | Chat panel v1 with approval/spend/provenance feed (React)                  |
| **Priority**         | P1                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | L                                                                          |
| **Source Finding**   | Invest. Rev 2.0 §7.3 (chat requirements), §8.8 (approval UX), §8.5 (spend) |
| **Status**           | ✅ Done                                                                    |

#### Context

The chat panel must show exactly which context sources were injected, a token budget meter per
request, approval cards rendered inline (concrete effect + scope), the BYOK provider/model
picker with per-key health/spend, and global memory access. Prompt-injection posture: model
output from untrusted-input requests is always a **proposal**, broker-gated; the model has **no
direct printer capability** (broker-issued, approval-gated).

#### Implementation Notes (S9-006)

- **`apps/editor/src/state/chat-core.ts`** — dependency-free pure TS core (no React,
  no zustand, no three.js): types for context sources, token budget, effect kinds
  (geometry_diff / file_write / outbound_data / spend), approval scopes
  (allow_once / session / project), approval cards, chat messages, provider health +
  spend, model picker list, capability proposals, and an approval journal ledger
  (model / provider / prompt hash / tool args hash / input revision / outcome).
- **`apps/editor/src/state/chat.ts`** — thin zustand wrapper (`useChat`) over the
  pure core; re-exports journal types.
- **`apps/editor/src/panels/ChatPanel.tsx`** (replaces placeholder) — transcript,
  context-sources list, token budget meter with over-budget flag, inline approval
  cards (exact effect kind + scope, destructive explicit), model picker with
  per-key health + spend and revocation link, `request:` capability proposals only.
- **`apps/editor/src/styles.css`** — full chat harness v1 style block.
- **`tests/chat-core.test.mjs`** — 8 unit tests importing `chat-core.ts` directly
  under Node 24 native TS (context injection exact, budget exact + over-budget,
  proposal never auto-executed, extractProposal without line-anchor so an injected
  instruction surfaces, approval decision + no re-decision, every approval
  journaled with all 6 fields, picker AirRouter-first + local selectable +
  revocation, model has NO direct printer capability).
- **`tests/harness/harness-runner.mjs`** + `pnpm run harness` — deterministic
  offline runner: harness-core unit tests, chat-core tests (TAP), structural
  invariants (no Shell capability variant; EStop independent of learned
  components). All green.
- **Prompt-injection posture**: `extractProposal` matches the `[capability:request]`
  tag anywhere (no line-start anchor) so injected instructions always surface as
  a proposal + approval card; nothing ever auto-executes.

#### Acceptance Criteria

- [x] Chat view: messages + context-sources list (which memories/scene/files injected) + token budget meter per request.
- [x] Approval cards: inline, show exact effect (geometry diff / file write / outbound data / spend) and scope (allow-once/session/project); destructive actions always explicit; sandbox approval separate from artifact-commit.
- [x] Every approval journaled: model, provider, prompt hash, tool args hash, input revision, outcome (rows appear in the journal viewer).
- [x] Prompt-injection: a request whose output proposes a capability is shown as proposal + approval card; never auto-executed (e2e test with an injected instruction fixture).
- [x] Model selector: AirRouter primary listed; local models (loopback) selectable; per-key health + spend shown; revocation reflected in UI.
- [x] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-9): R3 — harness v1 (BYOK, WASI sandbox, tool lifecycle, learning journal, chat)"

- S9-001: BYOK multi-provider adapter (AirRouter primary, local first-class)
- S9-002: Wasmtime capability sandbox + mandatory watchdog; bpy excluded
- S9-003: generated-tool lifecycle (manifest→…→revocation, hash-bound)
- S9-004: named-capability broker proxy to pinned workers
- S9-005: continuous-learning journal v1 + deterministic safety box
- S9-006: chat UI v1 (context sources, token budget, approval cards, spend)
```
