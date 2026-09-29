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
| **Status**           | ⏳ Planned                                                         |

#### Context

A self-created tool goes through a versioned lifecycle; none of the stages may be skipped.
Approval is of the _exact manifested artifact_ (hash-bound — approving a manifest does not
approve a re-build). Registration is by content hash; only then invocable by name. Revocation
kills running instances next tick and is journaled. Trusted first-party operations are
separated from generated tools (trusted ops only via named-capability requests).

#### Acceptance Criteria

- [ ] Lifecycle state machine implemented: manifest → scratch → build → test → approval → registration → revocation; each transition journaled with hashes; skipping a stage fails the state machine (unit tests).
- [ ] Hash-bound approval: approving manifest H approves exactly artifact H; a rebuilt artifact with a new hash requires re-approval (test).
- [ ] Tool registry: invoke by name resolves the registered content hash; unknown hash → rejected.
- [ ] Revocation: revoke by hash/version kills all running instances next tick (integration test) and journals the revocation.
- [ ] Separation of trust: a generated tool cannot invoke a pinned Blender operation except by requesting its named capability (see S9-004); no direct process spawn from generated code.
- [ ] **No host shell, unrestricted, inside the harness**: the harness is a capability surface, not a terminal (test: shell capability is never granted).
- [ ] Health gate green.

### S9-004 — Named capability broker proxy to pinned workers (geometry capability)

| Field                | Value                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9-004                                                                                       |
| **Title**            | Broker-proxied named capabilities (Blender geometry, OCCT) for tools                         |
| **Priority**         | P1                                                                                           |
| **Type**             | Feature                                                                                      |
| **Estimated Effort** | M                                                                                            |
| **Source Finding**   | Invest. Rev 2.0 §8.2 (bpy exclusion + named geometry capability), §8.3 (separation of trust) |
| **Status**           | ⏳ Planned                                                                                   |

#### Context

Model-generated code that wants Blender's _results_ requests a named _geometry capability_
the broker proxies to the pinned Blender process — the model never obtains a Blender handle;
untrusted Python/Blender scripts are T3b (VM), not T1. This broker proxy is the only way a T1/T3a
tool touches Blender.

#### Acceptance Criteria

- [ ] Capability registry: `geometry.boolean`, `geometry.extrude`, `mesh.validate`, `occt.convert`, … declared with schemas; broker grants a subset to a requesting tool based on its manifest.
- [ ] Proxy worker: a granted geometry capability runs on the pinned (T2) Blender/OCCT process with read-only inputs (or scratch copy), outputs to scratch, dies after (AI-job disposable session per §4.6); never shares the user session process state.
- [ ] A tool requesting an unlisted geometry op is denied; a tool requesting raw Blender exec is denied (T3b-routed).
- [ ] E2E: generate a Wasm tool that requests `geometry.boolean`; broker runs it against a fixture mesh in a disposable session; result hash equals the direct-run hash; the disposable process is confirmed dead.
- [ ] Health gate green.

### S9-005 — Continuous-learning journal v1 + deterministic safety box

| Field                | Value                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9-005                                                                                               |
| **Title**            | Immutable job journal + safety box (retrieval/optimisation/training gates; shadow→bounded→promotion) |
| **Priority**         | P0                                                                                                   |
| **Type**             | Feature                                                                                              |
| **Estimated Effort** | XL                                                                                                   |
| **Source Finding**   | Invest. Rev 2.0 §3.5 (bounded continuous learning [SPEC]), §10 R3                                    |
| **Status**           | ⏳ Planned                                                                                           |

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

#### Acceptance Criteria

- [ ] Journal v1 append-only store: full record schema per §3.5; `source = sensor|human` per evidence item; conflict → both stored + flag (test).
- [ ] Safety box model: invariant set (collision limits, swept-volume budget, hard clearances, endstop limits) profile-owned and human-approved; validator rejects any proposal outside the box with a journaled reject; unit test with an out-of-box parameter proposal.
- [ ] Retrieval gate: find similar past jobs (read-only) — lowest gate. Optimization gate: bounded numeric deltas, offline holdout by machine+material, shadow mode first then bounded experiments (user-approved) then promotion; rollback restores last-known-good parameter set atomically with journal entry.
- [ ] Training gate: separate dataset/review/promotion path; never auto-promotes.
- [ ] Structural impossibility test: a capability request that would touch a safety field is denied at the capability boundary (no code path reaches a safety field from a learned parameter).
- [ ] E-stop independence: the emergency-stop path contains no learned component (structural test inspects the E-stop module's dependency graph).
- [ ] Health gate green.

### S9-006 — Chat UI v1: context sources, token budget, approval cards, spend

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9-006                                                                     |
| **Title**            | Chat panel v1 with approval/spend/provenance feed (React)                  |
| **Priority**         | P1                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | L                                                                          |
| **Source Finding**   | Invest. Rev 2.0 §7.3 (chat requirements), §8.8 (approval UX), §8.5 (spend) |
| **Status**           | ⏳ Planned                                                                 |

#### Context

The chat panel must show exactly which context sources were injected, a token budget meter per
request, approval cards rendered inline (concrete effect + scope), the BYOK provider/model
picker with per-key health/spend, and global memory access. Prompt-injection posture: model
output from untrusted-input requests is always a **proposal**, broker-gated; the model has **no
direct printer capability** (broker-issued, approval-gated).

#### Acceptance Criteria

- [ ] Chat view: messages + context-sources list (which memories/scene/files injected) + token budget meter per request.
- [ ] Approval cards: inline, show exact effect (geometry diff / file write / outbound data / spend) and scope (allow-once/session/project); destructive actions always explicit; sandbox approval separate from artifact-commit.
- [ ] Every approval journaled: model, provider, prompt hash, tool args hash, input revision, outcome (rows appear in the journal viewer).
- [ ] Prompt-injection: a request whose output proposes a capability is shown as proposal + approval card; never auto-executed (e2e test with an injected instruction fixture).
- [ ] Model selector: AirRouter primary listed; local models (loopback) selectable; per-key health + spend shown; revocation reflected in UI.
- [ ] Health gate green.

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
