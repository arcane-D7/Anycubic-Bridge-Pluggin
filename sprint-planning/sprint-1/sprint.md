# Sprint 1 — Robust Boolean CSG (three-bvh-csg)

## Sprint Metadata

| Field                 | Value                                              |
| --------------------- | -------------------------------------------------- |
| **Sprint Name**       | Robust in-browser boolean CSG                       |
| **Sprint Goal**       | Replace the fragile half-space CSG kernel with the MIT `three-bvh-csg` engine, exposed as an MCP tool and usable from the CAD web UI. |
| **Duration Estimate** | ~1 day                                             |
| **Priority**          | P1                                                 |
| **Sprint Type**       | Feature + Test                                     |
| **Primary Owner**     | cad-engine                                          |
| **Source**            | [CAD research](../docs/cad-engine-research.md), [architecture](../docs/architecture.md) component 11 |
| **Depends On**        | None                                               |
| **Status**            | ✅ Complete · commit `892f39d`                      |
| **Health Gate**       | `pnpm run test` 132/132 · smoke 79 tools            |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

Today `ui/cad.html` performs booleans through a custom half-space kernel embedded
in `dist/server.mjs` (`/api/boolean`), which produces non-watertight or visually
wrong results on non-convex operands. This sprint swaps the boolean math for the
MIT `three-bvh-csg` library (same vector/mesh tooling family as the existing
Three.js viewer), running on Node as a pure CPU engine and exposed through a new
MCP tool `cad_v2_boolean`. The web UI gets a toggle to use the new engine and
re-fetch the watertight result. Out of scope: parametric engine (Sprint 2) and
AI text-to-cad (Sprint 3).

## Health Check Commands (must pass before commit)

```bash
pnpm install
pnpm run test
node scripts/smoke.mjs
```

Note: `pnpm run build` references a missing `src/` tree (legacy); the effective
gate for this checkout is `test` + `smoke` (see docs/architecture.md).

## Tickets

### S1-001 — Pure CSG engine module over three-bvh-csg

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S1-001                    |
| **Title**            | `scripts/cad-csg-engine.mjs` — pure boolean engine |
| **Priority**         | P0                        |
| **Type**             | Feature                   |
| **Estimated Effort** | M                         |
| **Source Finding**   | CAD research finalist #3 (three-bvh-csg, MIT) |
| **Status**           | ⏳ Planned                |

#### Context

The new engine must be a pure, side-effect-free module (SOLID: single
responsibility; DRY: shared helpers) that takes two triangle meshes + an
operation (add/subtract/intersect/difference) and returns a watertight mesh
(points + indexed triangles). It uses `three-bvh-csg` which already bundles the
robust BVH-based boolean math. Node-only; no DOM required.

#### Acceptance Criteria

- [ ] Exports a default function `booleanMesh(meshA, meshB, op)` and named `CSG_OPS`.
- [ ] Accepts `{ positions: number[], tris: {a,b,c}[] }` for both operands.
- [ ] Returns `{ positions: number[], tris: {a,b,c}[], watertight: boolean }`.
- [ ] Handles add/subtract/intersect/difference correctly (validated by unit tests).
- [ ] Pure (no I/O, no globals mutation); importable by tests directly.
- [ ] Run the health check command successfully.

### S1-002 — MCP adapter `cad_v2_boolean`

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S1-002                    |
| **Title**            | Register `cad_v2_boolean` MCP tool in the bundle |
| **Priority**         | P0                        |
| **Type**             | Feature                   |
| **Estimated Effort** | M                         |
| **Source Finding**   | Existing tool registration pattern in `dist/server.mjs` |
| **Status**           | ⏳ Planned                |

#### Context

The plugin exposes MCP tools via a bundle hook: modules in `scripts/` are
imported at the end of `dist/server.mjs` and register tools. `cad_v2_boolean`
reuses the CAD workspace state (objects by name) and applies
`booleanMesh` (S1-001) server-side, then writes the result back into the
workspace — mirroring `cad_select_faces`/`cad_edit_mesh` conventions
(annotations, `textAndStructured`, error redaction).

#### Acceptance Criteria

- [ ] New module `scripts/cad-bool-tool.mjs` exports `registerCadBoolTool(server, z)`.
- [ ] Tool exposed and listed by the bundle (smoke sees it) with proper annotations.
- [ ] Validates inputs via zod (name_a, name_b, op, result_name).
- [ ] Returns structured `{ ok, revision, vertices, triangles, watertight }`.
- [ ] Wire-in hook appended to `dist/server.mjs` before `server.connect(transport)`.
- [ ] Run the health check command successfully.

### S1-003 — Web UI toggle for robust boolean

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S1-003                    |
| **Title**            | `ui/cad.html` uses the v2 boolean engine |
| **Priority**         | P1                        |
| **Type**             | Feature                   |
| **Estimated Effort** | S                         |
| **Source Finding**   | `btnCsg` handler calls `/api/boolean` (half-space kernel) |
| **Status**           | ⏳ Planned                |

#### Context

The UI's existing `btnCsg` posts to `/api/boolean` (the legacy kernel). The
mutable CAD server does not know about `three-bvh-csg`; the clean path is to
call the new MCP-side path via a UI-triggered fetch to the new tool, or (simpler
and dependency-light) add a UI checkbox "Robust boolean" that invokes the server
endpoint wired by S1-002 and re-fetches the resulting mesh.

#### Acceptance Criteria

- [ ] A checkbox/toggle "Robust boolean" appears in the Boolean panel.
- [ ] When enabled, `btnCsg` uses the v2 engine and re-fetches the result mesh.
- [ ] Result appears live in the viewer (SSE refresh or explicit `buildMesh3D`).
- [ ] Falls back to legacy `/api/boolean` when disabled (backward compatible).
- [ ] Run the health check command successfully.

### S1-004 — Unit + integration tests for CSG engine

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S1-004                    |
| **Title**            | Tests: meshing prims, booleans, tool wiring |
| **Priority**         | P1                        |
| **Type**             | Test                      |
| **Estimated Effort** | M                         |
| **Source Finding**   | Project test convention `tests/*.test.mjs` |
| **Status**           | ⏳ Planned                |

#### Context

SOLID/DRY: engine (S1-001) should have high unit coverage; integration checks
that the bundle registers `cad_v2_boolean` and answers a smoke call; e2e checks
`cad.html` loads with the new toggle (Playwright/browser harness under
`tests/e2e/` where feasible). Existing suite runs with `node --test`.

#### Acceptance Criteria

- [ ] Unit tests: box-subtract, box-union, cylinder-intersect produce expected watertight meshes.
- [ ] Unit tests: invalid op / missing mesh throw clean errors.
- [ ] Integration test loads the bundle and asserts `cad_v2_boolean` is listed.
- [ ] E2E: `test/e2e` opens `cad.html` and verifies the toggle + a boolean flow.
- [ ] All tests pass via `pnpm run test`; smoke passes.
- [ ] Run the health check command successfully.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-1): robust boolean CSG via three-bvh-csg"

- S1-001: pure CSG engine `scripts/cad-csg-engine.mjs` (three-bvh-csg, MIT)
- S1-002: MCP tool `cad_v2_boolean` wired into the bundle
- S1-003: cad.html robust-boolean toggle + live refresh
- S1-004: unit/integration/e2e tests (all green)
```
