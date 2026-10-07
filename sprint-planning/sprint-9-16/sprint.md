# Sprint 9.16 — Project Materials, Real Slice Artifacts & Technical Preview

## Sprint Metadata

| Field                 | Value                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Project material authority, real slicing and artifact-backed Preview                                                                |
| **Sprint Goal**       | Bind project intent to validated slice outputs and provide a technically faithful, performant Preview of those artifacts.           |
| **Duration Estimate** | ~5 weeks                                                                                                                            |
| **Priority**          | P0                                                                                                                                  |
| **Sprint Type**       | Feature + Performance                                                                                                               |
| **Primary Owner**     | Editor project, slice engine and Preview                                                                                            |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-04–06/AUD-13; sections 10–12, 19 |
| **Depends On**        | Sprint 9.15                                                                                                                         |
| **Status**            | ⏳ Planned                                                                                                                          |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Separate durable project materials from physical spool bindings, execute the selected real slice provider against an immutable current scene snapshot, and publish Preview only for independently validated artifacts. Preserve IR provenance and implement playback from actual segment ordering; estimates, Demo outputs and unsupported capabilities must never imply a real printable result.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Run the focused slice/IR/render/performance suites before the full gate. No upload or print action is authorized.

## Tickets

### S9.16-001 — Project materials and explicit physical bindings

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-001                                                                  |
| **Title**            | Persist project material assignments separately from device spool bindings |
| **Priority**         | P1                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | L                                                                          |
| **Source Finding**   | AUD-04–05; MAT-01–MAT-08                                                   |
| **Status**           | ⏳ Planned                                                                 |

#### Context

Current slot matching can override an explicit project choice and confuse render appearance with physical availability. Keep stable project material identity/assignment and versioned printer/tool/slot binding separate; presentation mode must not mutate geometry.

#### Acceptance Criteria

- [ ] **MAT-01–MAT-02:** Mesh/Slicer presentation differs as intended; Slicer is solid/opaque by default with optional diagnostic edges and no geometry/revision mutation.
- [ ] **MAT-03–MAT-05:** Explicit assignment survives mismatched loaded slots; same polymer may bind distinct colors; offline/unassigned/stale state is diagnostic, not arbitrary recoloring.
- [ ] **MAT-06–MAT-07:** Selective snapshot updates refresh appearance; valid UV/triplanar texture and GPU resource lifecycle are verified.
- [ ] **MAT-08:** Tree, Prepare, Preview and send-preflight resolve the same assignment/binding revision.
- [ ] Run focused material/render/resource checks, full gate and sanitizer dry-run successfully.

### S9.16-002 — Immutable real slice jobs and validated artifacts

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-002                                                                        |
| **Title**            | Slice the captured project snapshot and publish only current validated artifacts |
| **Priority**         | P0                                                                               |
| **Type**             | Feature + Security                                                               |
| **Estimated Effort** | XL                                                                               |
| **Source Finding**   | AUD-06; SLC-01–SLC-08                                                            |
| **Status**           | ⏳ Planned                                                                       |

#### Context

The simulated UI stages are not a slice result. A job must capture project revision, targets, evaluated geometry, resolved settings/materials and provider identity, then validate IR/program and freshness before enabling Preview/export/send.

#### Acceptance Criteria

- [ ] **SLC-01–SLC-03:** Current placed model produces actual IR/program; Slice opens that output without manual JSON; Ready follows independent validation and compatibility checks.
- [ ] **SLC-04–SLC-06:** Cancellation prevents late success; input edits mark captured output stale; target plates remain those captured at job start.
- [ ] **SLC-07–SLC-08:** Cache covers every output-affecting input/provider version; missing/stale/incompatible artifact blocks send.
- [ ] Unsupported modifiers/material/tool features fail preflight with named reasons; no silent engine fallback or invented statistics.
- [ ] Run focused slice pipeline and concurrency tests, full gate and sanitizer dry-run successfully.

### S9.16-003 — IR fidelity, preview mapping and declared units

| Field                | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-003                                                                   |
| **Title**            | Preserve artifact attributes and map paths/metadata faithfully into Preview |
| **Priority**         | P1                                                                          |
| **Type**             | Feature + Test                                                              |
| **Estimated Effort** | L                                                                           |
| **Source Finding**   | AUD-04/AUD-06; PRV-01–PRV-04, PRV-06–PRV-07, PRV-09                         |
| **Status**           | ⏳ Planned                                                                  |

#### Context

The parser and renderer must preserve supported engine facts and artifact placement rather than substituting zeros, generic path classes or current-scene transforms. Validate schema/version, bounds and references before render.

#### Acceptance Criteria

- [ ] **PRV-01–PRV-04:** Supported attributes survive parse/model; manufacturing kinds are classified correctly; noncontiguous layer IDs and deterministic segment/G-code mapping work.
- [ ] **PRV-06–PRV-07:** Units/origin are correct; absent values display unavailable rather than fabricated zero.
- [ ] **PRV-09:** Preview placement matches the immutable captured scene revision.
- [ ] Invalid, oversized and mismatched artifact inputs fail safely with structured diagnostics.
- [ ] Run focused parser/contract/render checks, full gate and sanitizer dry-run successfully.

### S9.16-004 — Artifact playback, filters and performance budgets

| Field                | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-004                                                                 |
| **Title**            | Implement ordered artifact playback and measured Preview resource budgets |
| **Priority**         | P1                                                                        |
| **Type**             | Feature + Performance                                                     |
| **Estimated Effort** | L                                                                         |
| **Source Finding**   | AUD-06; PRV-05, PRV-08, PRV-10; audit section 12.3–12.4                   |
| **Status**           | ⏳ Planned                                                                |

#### Context

Playback must track actual execution order and segment IDs without reparsing the full artifact on every pointer move. Establish representative corpus budgets before tuning and release GPU/buffer resources when artifacts change.

#### Acceptance Criteria

- [ ] **PRV-05:** Play/pause/step/scrub tracks known artifact segments and their instruction mapping.
- [ ] **PRV-08:** Single-layer and cumulative filters affect visualization only, not slice output.
- [ ] **PRV-10:** Representative corpus meets documented load/scrub/memory budgets with repeatable measurements.
- [ ] Old artifact preparation is cancelled and removed GPU resources are released.
- [ ] Run focused playback/performance checks, full gate and sanitizer dry-run successfully.

## Sprint Commit

Each ticket commit uses `feat(s9.16-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and applicable artifact checks pass; no push.
