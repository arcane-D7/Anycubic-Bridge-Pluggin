# Sprint 7 — R1: Blender-Primary Editing Core

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | R1 — Blender required backend wiring, parity corpus, modal IPC, undo/recovery, import/export                                                                                                                                                                |
| **Sprint Goal**       | Wire the pinned, user-installed Blender as the required geometry authority behind modal begin/update/commit/cancel commands, prove parity on a versioned corpus (≥3 meshes, ≥20 ops) and land journal-based undo/recovery + STL/OBJ/3MF/glTF import-export. |
| **Duration Estimate** | ~4 weeks                                                                                                                                                                                                                                                    |
| **Priority**          | P0                                                                                                                                                                                                                                                          |
| **Sprint Type**       | Feature                                                                                                                                                                                                                                                     |
| **Primary Owner**     | geometry-core                                                                                                                                                                                                                                               |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §4 (decision + parity matrix + build options + IPC), §7.4, §10 R1; Sprint 5/6 gates                                        |
| **Depends On**        | Sprint 6 (R0)                                                                                                                                                                                                                                               |
| **Status**            | ⏳ Planned                                                                                                                                                                                                                                                  |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

Blender becomes the geometry authority: a pinned `BLENDER_VERSION`, user-installed/discovered
(never bundled — GPL), driven headless (`blender -b --python`) through a **framed stdio/framed
IPC command contract with a binary artifact channel** (MSIX-alias stdout limitation scoped to
the alias; JSON-over-file retained as PoC fallback per §4.6). The viewport renders the live
Blender scene as a _view_, never a twin. Modal ops (begin/update/commit/cancel), stale-revision
handling, selection invariants, and journal-based undo/recovery are the core deliverables, plus
the parity corpus that measures the R1 matrix rows (object mode, edit-mode selection, mesh
topology ops, merge/dissolve/normals, selection invariants, undo/redo).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
pnpm run corpus        # run the parity corpus assertions (new script; also wired into check:src set)
node scripts/sanitize-repo.mjs --dry-run
```

> The corpus runner requires the pinned Blender installed; on CI without Blender it must
> report SKIP (clearly), not false-green — the acceptance requires it run locally with the
> pinned version at least once in the sprint and the results journaled.

## Tickets

### S7-001 — Blender discovery + pinned version contract

| Field                | Value                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S7-001                                                                                                                                             |
| **Title**            | Blender discovery (MSIX alias + classic), version pinning, egress/limits for T2 worker                                                             |
| **Priority**         | P0                                                                                                                                                 |
| **Type**             | Feature                                                                                                                                            |
| **Estimated Effort** | M                                                                                                                                                  |
| **Source Finding**   | Invest. Rev 2.0 §4.1 (required dep), §4.3(a) baseline, `tools/HEADLESS-RENDER.md`, §8.2 T2 row (fault containment, firewall egress deny, watchdog) |
| **Status**           | ⏳ Planned                                                                                                                                         |

#### Context

The repo PoC (`tools/HEADLESS-RENDER.md`) already proves MSIX-alias discovery; this ticket
productizes it: resolve `BLENDER_VERSION` from env with an agnostic default, classify
alias-vs-classic install for transport choice, and enforce the T2 worker limits (wall clock,
output cap, killable, no secrets in env, scratch via junction, host firewall denies egress,
external watchdog — §8.2).

#### Acceptance Criteria

- [ ] `crates/blender-bridge` discovery: finds pinned Blender (MSIX alias path per HEADLESS-RENDER.md, then classic install); version check against `BLENDER_VERSION` fails hard (declared requirement, not optional) with a clear UI message.
- [ ] Transport selection: alias → JSON-over-file/binary-artifact channel fallback; classic → framed stdio preferred (`[?]` lifecycle validation pending per §4.6 — must be carried out here before the contract is declared).
- [ ] Spawn wrapper enforces: wall-clock cap, output-size cap, killable process group, no secrets in env, scratch dir via junction, egress blocked by host firewall (documented; no self-claimed sandbox).
- [ ] **External watchdog** process attached to every spawned Blender (mandatory §8.2) — kills on heartbeat loss; integration test kills the watchdog and asserts the child is reaped.
- [ ] Health gate green (+ watchdog and discovery unit tests).

### S7-002 — Framed stdio/IPC command contract (modal lifecycle + stale revisions)

| Field                | Value                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S7-002                                                                                                    |
| **Title**            | Versioned command contract: begin/update/commit/cancel, expected_revision, remapping table, binary deltas |
| **Priority**         | P0                                                                                                        |
| **Type**             | Feature                                                                                                   |
| **Estimated Effort** | XL                                                                                                        |
| **Source Finding**   | Invest. Rev 2.0 §4.6 (IPC contract), §4.2 selection invariants, §3.5 journal discipline                   |
| **Status**           | ⏳ Planned                                                                                                |

#### Context

Every interactive op is a modal lifecycle: begin (revision) → 0+ updates (provisional) →
commit (validate selection invariants, journal, advance revision) | cancel (roll to
begin-revision). Every command carries `expected_revision`; mismatch → rejected with the
actual revision (UI re-bases, never forces). Geometry payloads travel as binary deltas with a
versioned wire format and explicit backpressure.

#### Acceptance Criteria

- [ ] Wire format v1 documented and schema-tested: `{op, params, expected_revision, session}` → `{result, new_revision, remap_table, selection_state}`; length-framed records.
- [ ] Modal lifecycle enforced: a direct topology op outside a modal session is **rejected** (unit test).
- [ ] Stale-revision rejection: command with stale `expected_revision` → rejected with actual revision; UI re-base path tested (never force).
- [ ] Topology remapping: after a topology-changing op the response carries the remap table; stable editor element IDs map onto session-local Blender indices; selection invariants re-validated per round-trip.
- [ ] Binary delta channel: geometry payloads transferred as binary deltas (artifact channel), base64-of-binary in JSON envelope or file-backed; backpressure test (queue bound stalls issuing).
- [ ] Out-of-band BLEND modification → session invalidated with hash mismatch; re-import offered, never silent merge.
- [ ] Health gate green.

### S7-003 — Parity corpus v1 (≥3 meshes, ≥20 ops) + corpus runner

| Field                | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| **Ticket ID**        | S7-003                                                                                 |
| **Title**            | Versioned parity corpus + assertions (selection invariants, snapshots authoritative)   |
| **Priority**         | P0                                                                                     |
| **Type**             | Test                                                                                   |
| **Estimated Effort** | L                                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §4.2 (parity corpus [SPEC]), §7.4 (native snapshot wins over renderer) |
| **Status**           | ⏳ Planned                                                                             |

#### Context

Parity is _measured_, not asserted. The corpus: ≥3 small meshes + ≥20 recorded op sequences +
recorded expected outcomes (native BLEND snapshots, mesh hashes, selection snapshots). The
runner executes the R1-row matrix ops through the contract and compares against expectations.
Native snapshots are authoritative — a renderer mismatch is a renderer bug.

#### Acceptance Criteria

- [ ] Corpus v1 committed under `tests/corpus/` (or equivalent): ≥3 meshes; ≥20 recorded ops spanning object mode, edit-mode selection, extrude/inset/bevel/loop-cut/knife where supported, merge/dissolve/normal recalc, transforms.
- [ ] Each op has: native BLEND snapshot (or evaluated BMesh hash), mesh hash, selection snapshot; snapshots are the authority.
- [ ] Runner (`pnpm run corpus`) executes the sequence via contract, asserts hashes/selection invariants after every op; a stale-selection-from-deleted-element case is in the corpus and fails if the invariant breaks.
- [ ] In CI without Blender: runner reports SKIP-with-journal (never false-green); locally with pinned `BLENDER_VERSION` it must pass, and the run result (hash of corpus, pass/fail) is journaled in docs/evidence.
- [ ] Health gate green (corpus SKIP path) + local corpus run green (documented in the sprint notes).

### S7-004 — Viewport as a view of the live Blender scene (R3F)

| Field                | Value                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S7-004                                                                                            |
| **Title**            | R3F viewport rendering authoritative snapshots; gizmos/modes/numeric entry UI                     |
| **Priority**         | P1                                                                                                |
| **Type**             | Feature                                                                                           |
| **Estimated Effort** | XL                                                                                                |
| **Source Finding**   | Invest. Rev 2.0 §7.4 (viewport is view, not twin), §4.2 (UI owns interaction, Blender owns state) |
| **Status**           | ⏳ Planned                                                                                        |

#### Context

The viewport renders the native snapshot from the contract; there is NO independent in-broker
scene model. Gizmos, shortcuts, pivot, snap and proportional editing are UI-owned interaction
issuing modal commands; mesh state is Blender-owned. A renderer triangle disagreeing with the
native snapshot is a renderer bug (snapshot wins).

#### Acceptance Criteria

- [ ] Viewport subscribes to commit events and re-renders from authoritative mesh snapshots (no mutation of geometry in the UI).
- [ ] Gizmo transform issues `begin → update → commit`; numeric entry issues `begin → 0 updates → commit`; cancel rolls back to begin-revision (end-to-end test against a stub contract server).
- [ ] Selection highlights are derived from the last authoritative selection_state (never stale across ops).
- [ ] A deliberate renderer-vs-snapshot mismatch in a test fails with "renderer bug" semantics (snapshot wins).
- [ ] Health gate green.

### S7-005 — Undo/recovery = command-journal replay

| Field                | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Ticket ID**        | S7-005                                                                                    |
| **Title**            | Journal-based undo authority, autosave snapshots, crash recovery                          |
| **Priority**         | P0                                                                                        |
| **Type**             | Feature                                                                                   |
| **Estimated Effort** | L                                                                                         |
| **Source Finding**   | Invest. Rev 2.0 §4.6 (undo/recovery), §3.5 (journal discipline), Sprint 6 S6-004 skeleton |
| **Status**           | ⏳ Planned                                                                                |

#### Context

bpy has no UI undo stack; the command journal is the undo authority and must replay inverse
commands into bpy state, re-validating against the current mesh (an undo that would leave
stale selection is refused with a reason). Crash recovery = journal replay to last committed
revision against the last BLEND snapshot. R0 (S6-004) scaffolded the journal; here it binds to
the contract.

#### Acceptance Criteria

- [ ] Undo: replay inverse sequence to target revision re-validated; a would-leave-stale-selection undo is refused with a documented reason (unit test).
- [ ] Redo: replay forward to a committed revision only.
- [ ] Autosave: periodic BLEND snapshot + journal; crash recovery integration test kills the Blender worker and replays to the last committed revision with no stale selection.
- [ ] Undo/redo parity on the corpus (R1 matrix row "Undo/redo") — Blender-undo equivalence measured on corpus ops.
- [ ] Health gate green.

### S7-006 — Import/Export: STL/OBJ/3MF/glTF (+ STEP/IGES conversion-only note)

| Field                | Value                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S7-006                                                                                            |
| **Title**            | Import/export STL/OBJ/3MF/glTF; OCCT conversion tier read-only                                    |
| **Priority**         | P1                                                                                                |
| **Type**             | Feature                                                                                           |
| **Estimated Effort** | L                                                                                                 |
| **Source Finding**   | Invest. Rev 2.0 §10 R1 (import/export list), §4.4 (STEP/IGES conversion-only, degraded bbox path) |
| **Status**           | ⏳ Planned                                                                                        |

#### Context

R1 lands import/export for the four mesh formats. STEP/IGES are **conversion-only** via OCCT
(optional tier; no modeling kernel claim) — the current repo artifact is the degraded
bbox-cuboid path ([BUG] STEP bbox) and must not be presented as real mesh→STEP.

#### Acceptance Criteria

- [ ] Import: STL/OBJ/3MF/glTF → scene objects through the contract (round-trip volume/bbox preserved within declared tolerance).
- [ ] Export: STL/OBJ/3MF/glTF from the Blender scene; 3MF write support added (R0 read-only becomes read/write).
- [ ] STEP/IGES: OCCT conversion service behind the contract, clearly labeled conversion-only; mesh→STEP fidelity budget documented; the bbox-cuboid path is deprecated with a warning (no silent output).
- [ ] E2E: import fixture → transform → export → import again; geometric identity asserted.
- [ ] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-7): R1 — Blender-primary editing core + parity corpus"

- S7-001: Blender discovery + pinned-version contract (T2 limits, watchdog)
- S7-002: framed stdio/IPC command contract (modal lifecycle, stale revisions)
- S7-003: parity corpus v1 (>=3 meshes, >=20 ops) + runner
- S7-004: viewport as view of live Blender scene
- S7-005: journal-based undo/recovery
- S7-006: import/export STL/OBJ/3MF/glTF + OCCT conversion-only tier
```
