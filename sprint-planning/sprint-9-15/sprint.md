# Sprint 9.15 — Project Authority, Persistent Journal & Real Geometry Workers

## Sprint Metadata

| Field                 | Value                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Explicit providers, persistent project authority and validated geometry execution                                                           |
| **Sprint Goal**       | Establish one durable revision/journal authority and connect pinned geometry workers for real repair and boolean operations.                |
| **Duration Estimate** | ~4 weeks                                                                                                                                    |
| **Priority**          | P0                                                                                                                                          |
| **Sprint Type**       | Feature + Security                                                                                                                          |
| **Primary Owner**     | Project authority, geometry IPC and worker adapters                                                                                         |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-07/AUD-08/AUD-13; sections 6, 13, 18, 19 |
| **Depends On**        | Sprint 9.14                                                                                                                                 |
| **Status**            | 🔄 In progress (S9.15-001)                                                                                                                  |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Replace implicit mock selection and fragmented local revision state with explicitly selected providers and a persistent authority. Bind mutations to monotonic revisions and journal recovery, then execute repair/boolean through a pinned, capability-declared worker with independently checked geometry outputs. Preserve Demo as explicitly labeled Demo; unavailable real execution must fail honestly.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Run the relevant project/worker corpus or IPC integration test before the full gate. Tests use controlled transports and fixtures; no physical-device action is authorized.

## Tickets

### S9.15-001 — Explicit provider bootstrap and project authority

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.15-001                                                              |
| **Title**            | Select Demo/real providers explicitly and centralize project mutations |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | AUD-07/AUD-08; audit sections 6.1–6.3                                  |
| **Status**           | 🔄 In progress                                                         |

#### Context

UI imports of mock behavior can imply product execution, while snapshots/refetches fragment scene ownership. Select providers at bootstrap, expose origin/capabilities, and route domain changes through one authority with expected-revision semantics.

#### Acceptance Criteria

- [ ] Provider selection and origin/capabilities are explicit; Demo status is visible and never silently substitutes for unavailable real execution.
- [ ] All authoritative project mutations route through one owner and return structured revision/result/diagnostics.
- [ ] Unsupported provider operations return unavailable with a stable reason and cannot mutate mock state as a fallback.
- [ ] Migration/compatibility for existing project data is tested and rollback behavior documented.
- [ ] Run focused provider/contract checks, full gate and sanitizer dry-run successfully.

#### Implementation Notes (S9.15-001)

- Provider selection is resolved at bootstrap. Demo is explicitly identified as
  `demo-fixture`; real selection reports `tauri-project-store` as unavailable with
  `real-project-provider-not-connected` until a project authority is connected.
- Provider metadata is queried separately from `['bridge', 'scene']`. The scene
  query continues to return the canonical `BridgeHandle`, preserving context-menu,
  slice, print, and other existing consumers across refetch/invalidation.
- Demo bootstraps share one session handle so its mutation/revision closures remain
  authoritative across scene refetches. Provider selection is checked before the
  Demo handle cache; a prior Demo bootstrap cannot satisfy a later Real request.
  No production project backend,
  persistent revisions, migration, or real geometry operations are claimed here;
  those remain for S9.15-002/003. Existing project data is unchanged, so this
  ticket introduces no migration or rollback operation.
- Focused tests cover provider origin/capabilities, fixture mutation surviving a
  later handle bootstrap, real/unknown fail-closed selection, and no Demo fallback.
  The full gate and sanitizer result will be recorded after validation.

### S9.15-002 — Persistent monotonic revisions and recovery journal

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.15-002                                                          |
| **Title**            | Persist revisioned mutations, operation journal and crash recovery |
| **Priority**         | P0                                                                 |
| **Type**             | Feature + Recovery                                                 |
| **Estimated Effort** | XL                                                                 |
| **Source Finding**   | AUD-08; CAD-07; audit sections 6.3, 18.3                           |
| **Status**           | ⏳ Planned                                                         |

#### Context

Fixed snapshot revisions and recreated journals make stale artifacts, undo and concurrent tools unsafe. Persist each domain commit exactly once; distinguish no-op, conflict, rollback and recovered state.

#### Acceptance Criteria

- [ ] Two mutations and repeated refetch/reopen preserve monotonic revision and both journal entries.
- [ ] Add/remove/material/repair/boolean mutations are recoverable with undo/checkpoint where a safe inverse is not available.
- [ ] UI and tool mutation races reject stale `expectedRevision` without corrupting selection or state.
- [ ] Rename, duplicate, reset, no-op and crash-recovery behavior are covered; rollback does not masquerade as refetch.
- [ ] **CAD-07:** Recovery restores add/remove/repair/boolean/material changes, not transforms only.
- [ ] Run focused persistence/recovery checks, full gate and sanitizer dry-run successfully.

### S9.15-003 — Pinned real worker for repair and boolean geometry

| Field                | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Ticket ID**        | S9.15-003                                                                   |
| **Title**            | Execute repair/boolean through a pinned worker and validate output geometry |
| **Priority**         | P0                                                                          |
| **Type**             | Feature + Validation                                                        |
| **Estimated Effort** | XL                                                                          |
| **Source Finding**   | AUD-07; CAD-05–CAD-06; audit sections 6.2, 13.7–13.8                        |
| **Status**           | ⏳ Planned                                                                  |

#### Context

Changing `watertight` or returning fixture geometry is not repair/boolean. Connect only named operations to a discovered/pinned worker contract, enforce budgets/watchdog, and verify actual outputs independently. Respect the repository's direct-dependency/license policy.

#### Acceptance Criteria

- [ ] **CAD-05:** A defective mesh is measurably repaired or refused/partial with diagnostics; no flag-only success.
- [ ] **CAD-06:** Boolean output is new validated geometry with provenance, source handling and undo information.
- [ ] Worker identity/version/capability, limits, cancellation and unavailable state are explicit; no raw model-provided scripts/handles.
- [ ] Seeded worker failure, timeout, oversized input, source visibility and rollback are tested.
- [ ] Demo results remain labeled and cannot pass real-backend acceptance.
- [ ] Run worker corpus/integration checks, full gate and sanitizer dry-run successfully.

### S9.15-004 — Frame, unit and selection revision contracts

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.15-004                                                          |
| **Title**            | Define coordinate frames, units and remap-safe selection contracts |
| **Priority**         | P1                                                                 |
| **Type**             | Feature + Test                                                     |
| **Estimated Effort** | L                                                                  |
| **Source Finding**   | AUD-13; CAD-16; audit sections 6.3, 6.6, 13.3                      |
| **Status**           | ⏳ Planned                                                         |

#### Context

The editor, plate, machine and Preview must not apply placement inconsistently. Name each frame and unit at boundaries, use shared inverse helpers, and tie topology selection/remaps to the producing revision.

#### Acceptance Criteria

- [ ] **CAD-16:** Named-frame transforms round-trip landmarks and declared units with consistent constraints.
- [ ] Mesh/IR/telemetry positions share tested frame contracts; no global axis substitution or silent clamp.
- [ ] Selection IDs are revision-bound; topology worker returns remap/removed IDs, and stale selection is rejected.
- [ ] Rotations, negative/nonuniform scale, parenting, plate origins and future modes have fixtures.
- [ ] Run focused geometry/contract corpus, full gate and sanitizer dry-run successfully.

## Sprint Commit

Each ticket commit uses `feat(s9.15-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and the ticket's worker/recovery checks pass; no push.
