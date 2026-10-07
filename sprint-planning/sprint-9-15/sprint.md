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
| **Status**            | 🔄 In progress (2/4 delivered; S9.15-003 next)                                                                                              |

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
| **Status**           | ✅ Delivered                                                           |

#### Context

UI imports of mock behavior can imply product execution, while snapshots/refetches fragment scene ownership. Select providers at bootstrap, expose origin/capabilities, and route domain changes through one authority with expected-revision semantics.

#### Acceptance Criteria

- [x] Provider selection and origin/capabilities are explicit; Demo status is visible and never silently substitutes for unavailable real execution.
- [x] All authoritative project mutations route through one owner and return structured revision/result/diagnostics.
- [x] Unsupported provider operations return unavailable with a stable reason and cannot mutate mock state as a fallback.
- [x] Migration/compatibility for existing project data is tested and rollback behavior documented.
- [x] Focused provider/contract checks, full gate and sanitizer dry-run pass.

#### Implementation Notes (S9.15-001)

- Provider selection is resolved at bootstrap. Demo is explicitly identified as
  `demo-fixture`; at S9.15-001 delivery the real selection was unavailable until
  the project authority was connected by S9.15-002.
- Provider metadata is queried separately from `['bridge', 'scene']`. The scene
  query continues to return the canonical `BridgeHandle`, preserving context-menu,
  slice, print, and other existing consumers across refetch/invalidation. S9.15-002
  has since connected the Tauri project authority; only lanes backed by that authority
  are available in the real provider.
- Demo bootstraps share one session handle so its mutation/revision closures remain
  authoritative across scene refetches. Provider selection is checked before the
  Demo handle cache; a prior Demo bootstrap cannot satisfy a later Real request.
  S9.15-001 itself did not add persistent revisions or migration; those are
  implemented by S9.15-002 below. Real geometry execution remains for S9.15-003.
- Focused tests cover provider origin/capabilities, fixture mutation surviving a
  later handle bootstrap, real/unknown fail-closed selection, and no Demo fallback.
  Full health gate and sanitizer passed with S9.15-002; see its validation notes.

### S9.15-002 — Persistent monotonic revisions and recovery journal

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.15-002                                                          |
| **Title**            | Persist revisioned mutations, operation journal and crash recovery |
| **Priority**         | P0                                                                 |
| **Type**             | Feature + Recovery                                                 |
| **Estimated Effort** | XL                                                                 |
| **Source Finding**   | AUD-08; CAD-07; audit sections 6.3, 18.3                           |
| **Status**           | ✅ Delivered                                                       |

#### Context

Fixed snapshot revisions and recreated journals make stale artifacts, undo and concurrent tools unsafe. Persist each domain commit exactly once; distinguish no-op, conflict, rollback and recovered state.

#### Acceptance Criteria

- [x] Two mutations and repeated refetch/reopen preserve monotonic revision and both journal entries.
- [x] Add/remove/material/repair/boolean domain records persist actual before/after state; geometry outputs use content-addressed artifacts and artifact references commit with the state/event transaction.
- [x] UI mutations and modal transform commits send `expectedRevision`; stale writes return the authority revision/snapshot, preserve the committed state and remap selection by stable object ID.
- [x] Rename, duplicate, reset-to-global, no-op, operation retry/deduplication, changed-payload retry rejection and file-backed reopen recovery are covered; provisional transform rollback never masquerades as a refetch.
- [x] **CAD-07:** Recovery restores add/remove/repair/boolean/material domain changes, not transforms only.
- [x] Focused persistence/provider tests, full gate and sanitizer dry-run pass.

#### Implementation Notes (S9.15-002)

- Broker DB schema v3 adds `project_state`, typed `project_events`, and
  `project_operation_keys`. A single SQLite transaction compares the expected
  revision, writes the complete project document, appends one operation event,
  records its content-bound idempotency key, and registers artifact references.
  Stale writes do zero writes; identical state is a no-op; same-operation retry
  returns the current snapshot without appending another event; reusing that key
  with different content is rejected.
- `project-store::ProjectAuthority` provides stable project/object identities,
  state/revision read, named domain operation records with full before/after
  documents, typed journal read, legacy-ID metadata migration, and crash/reopen
  recovery. Mesh geometry is staged as content-addressed blobs, kept out of the
  SQLite JSON document and hydrated on reopen. Files are atomically staged before
  the DB transaction; a crash before commit can leave only an unreferenced blob,
  never a project reference to a partial file.
- Tauri registers `project_authority_read`, `project_authority_journal`, and
  `project_authority_commit`; workspace DB/blob roots derive from standard
  application-data environment variables. Backend startup failure leaves the
  shell available and Real is reported unavailable.
- The real bridge preserves the frozen `BridgeHandle` shape, stable IDs across
  rename, Demo isolation, and modal begin/update/commit/cancel behavior. Durable
  CRUD/material/placement operations use the authority. Real arrange, slice,
  printer operations, repair and boolean execution are explicitly unavailable;
  typed repair/boolean journal recovery is tested at the authority layer, but
  real geometry execution and independent validation remain S9.15-003.
- Legacy `objects` rows are retained in `legacy_objects` with their original ID,
  name and mesh hash plus `metadata-retained-geometry-not-hydrated`. No geometry
  is fabricated where the old DB has no recoverable mesh bytes. This migration
  is additive and keeps old rows intact; rollback means reopening the prior DB
  schema with the previous binary, not deleting migrated data.
- Validation: project-store **8/8**, provider **7/7**, editor typecheck passes,
  `pnpm run check:rust` passes, full `pnpm run check` exits 0 (unit 736, integration
  11, both E2E suites pass, 115-tool smoke, 59 licenses, architecture OK), and the
  standalone sanitizer dry-run touches 0 files/groups.

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
