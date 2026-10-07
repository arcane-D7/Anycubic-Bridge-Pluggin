# Sprint 9.19 — CAD Object/Edit Capabilities & Honest Advanced-Geometry Scope

## Sprint Metadata

| Field                 | Value                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | CAD object operations, topology editing, fabrication volumes and capability truthfulness                                                                                     |
| **Sprint Goal**       | Deliver revision-safe CAD operations through real workers and define honest support boundaries for advanced geometry instead of equating UI affordances with Blender parity. |
| **Duration Estimate** | ~6 weeks                                                                                                                                                                     |
| **Priority**          | P1                                                                                                                                                                           |
| **Sprint Type**       | Feature + Test                                                                                                                                                               |
| **Primary Owner**     | Geometry worker adapters, project authority and Prepare                                                                                                                      |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-07/AUD-08; sections 8, 13, 19                                             |
| **Depends On**        | Sprint 9.18                                                                                                                                                                  |
| **Status**            | ⏳ Planned                                                                                                                                                                   |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Complete the defined initial CAD surface with distinct clone/instance and placement semantics, real revision-bound mesh editing with remap/corpus, and persistent parts/negative/print-modifier/geometric-modifier contracts. Sculpt, remesh, UV and painting are capability claims only when a real implementation, persistence, budgets and tests exist; otherwise they remain explicitly unavailable. This is progressive parity, not a promise to replicate all Blender features.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Run focused real-worker corpus, topology/recovery and preflight tests before the full gate. Do not execute external physical actions.

## Tickets

### S9.19-001 — Object identity, clone/instance and placement operations

| Field                | Value                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| **Ticket ID**        | S9.19-001                                                                |
| **Title**            | Implement distinct clone/instance and geometry-correct placement actions |
| **Priority**         | P1                                                                       |
| **Type**             | Feature                                                                  |
| **Estimated Effort** | L                                                                        |
| **Source Finding**   | AUD-02/AUD-13; CAD-01–CAD-04                                             |
| **Status**           | ⏳ Planned                                                               |

#### Context

Object organization must preserve stable identity and provenance; a linked instance is not an independent clone. Drop, Centre and Orient Face must remain separate operations and use evaluated world geometry, not local min-Y shortcuts.

#### Acceptance Criteria

- [ ] **CAD-01:** Clone receives unique identity and preserves appropriate metadata/provenance.
- [ ] **CAD-02:** Linked instance and independent clone have distinct, tested geometry-edit effects.
- [ ] **CAD-03:** Drop of rotated geometry touches the plate while preserving horizontal placement.
- [ ] **CAD-04:** Orient Face and Centre produce results distinct from Drop and are explicitly labeled.
- [ ] Undo/reopen and duplicate names do not redirect identity-based operations.
- [ ] Run focused geometry corpus/E2E, full gate and sanitizer dry-run successfully.

### S9.19-002 — Edit Mode selection, remap and parity corpus

| Field                | Value                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ |
| **Ticket ID**        | S9.19-002                                                                            |
| **Title**            | Bind topological Edit Mode operations to worker revisions and expected-result corpus |
| **Priority**         | P1                                                                                   |
| **Type**             | Feature + Test                                                                       |
| **Estimated Effort** | XL                                                                                   |
| **Source Finding**   | AUD-07/AUD-14; CAD-08, CAD-14                                                        |
| **Status**           | ⏳ Planned                                                                           |

#### Context

Triangle renderer indices cannot stand in for durable topology identities. Edit operations must run through trusted typed worker adapters, return remaps against an exact revision, and have per-operation invariants and expected results.

#### Acceptance Criteria

- [ ] **CAD-08:** Edit Mode selection survives supported topological operations through explicit remap or reports removed/stale IDs.
- [ ] **CAD-14:** Corpus records supported operations, fixtures, invariants and expected results; independent validation detects seeded incorrect output.
- [ ] Vertex/edge/face selection, provisional cancel and commit validate the producing revision.
- [ ] Unsupported operation or worker absence is a typed refusal; it cannot present a mock result as success.
- [ ] Run focused worker corpus and real-input checks, full gate and sanitizer dry-run successfully.

### S9.19-003 — Parts, negative volumes and ordered modifier stacks

| Field                | Value                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| **Ticket ID**        | S9.19-003                                                                    |
| **Title**            | Persist fabrication roles and evaluate supported modifier stacks fail-closed |
| **Priority**         | P0                                                                           |
| **Type**             | Feature                                                                      |
| **Estimated Effort** | XL                                                                           |
| **Source Finding**   | AUD-06/AUD-07; CAD-09–CAD-13                                                 |
| **Status**           | ⏳ Planned                                                                   |

#### Context

Parts, negative volumes, print modifiers and geometric modifiers have different semantics and authorities. Their roles, precedence, evaluated geometry and slice invalidation must be explicit and persist through undo/reopen.

#### Acceptance Criteria

- [ ] **CAD-09:** Adding parts preserves hierarchy, placement and material assignments.
- [ ] **CAD-10:** Negative volume changes real evaluated fabrication output, not appearance alone.
- [ ] **CAD-11:** Supported print modifier changes only its declared regional process parameters.
- [ ] **CAD-12:** Unsupported modifier/parameter fails preflight with an actionable reason.
- [ ] **CAD-13:** Stack ordering, enable/disable, apply and undo produce the correct evaluated result and provenance.
- [ ] Distinguish geometric modifiers from print modifiers in schema, UI, registry and tests; slice references evaluated hash/revision.
- [ ] Run focused slice/geometry/recovery tests, full gate and sanitizer dry-run successfully.

### S9.19-004 — Truthful advanced CAD capability matrix

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.19-004                                                                       |
| **Title**            | Define tested support boundaries for modifiers, sculpt, remesh, UV and painting |
| **Priority**         | P1                                                                              |
| **Type**             | Feature + Documentation                                                         |
| **Estimated Effort** | L                                                                               |
| **Source Finding**   | Audit sections 13.1, 13.4, 13.8 and 20; progressive Blender parity scope        |
| **Status**           | ⏳ Planned                                                                      |

#### Context

The requested broad CAD capability set includes geometric modifiers, sculpting, remesh, UV and painting. These cannot be implied by controls, Blender IPC stubs or print modifiers; each supported feature needs a real typed operation, persistence and measurable limits.

#### Acceptance Criteria

- [ ] Each capability is classified as implemented, experimental or unavailable based on executable provider evidence.
- [ ] Supported geometry modifiers have ordered stack semantics, evaluated output and undo/recovery tests.
- [ ] Sculpt/remesh/UV/painting are either backed by real bounded operations and persistence tests or explicitly unavailable with a reason and no success affordance.
- [ ] No claim of complete Blender parity is made; supported parity corpus and omissions are documented.
- [ ] Run focused capability/registry checks, full gate and sanitizer dry-run successfully.

## Sprint Commit

Each ticket commit uses `feat(s9.19-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and relevant real-worker/corpus checks pass; no push.
