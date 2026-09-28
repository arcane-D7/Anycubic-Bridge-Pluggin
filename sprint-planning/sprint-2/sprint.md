# Sprint 2 — Parametric Engine (Manifold + Replicad)

## Sprint Metadata

| Field                 | Value                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sprint Name**       | Parametric code-CAD engine                                                                                                                       |
| **Sprint Goal**       | Add a Blender-like parametric modeling engine (manifold-3d WASM core; Replicad STEP export) exposed through a new MCP tool and reusable helpers. |
| **Duration Estimate** | ~2–3 days                                                                                                                                        |
| **Priority**          | P1                                                                                                                                               |
| **Sprint Type**       | Feature + Test                                                                                                                                   |
| **Primary Owner**     | cad-engine                                                                                                                                       |
| **Source**            | [CAD research](../docs/cad-engine-research.md) finalists #1 (Replicad) & manifold findings                                                       |
| **Depends On**        | Sprint 1                                                                                                                                         |
| **Status**            | ✅ Complete · commit `6739dfc`                                                                                                                   |
| **Health Gate**       | `pnpm run test` 144/144 · smoke 80 tools                                                                                                         |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

Sprint 1 gave robust booleans on meshes. This sprint adds a true parametric
engine: primitives (box/cylinder/sphere/cone/prism), transforms, booleans, and
extrusions built on `manifold-3d` (MIT, WASM — no external files, runs on Node
and browser), with `replicad`/`replicad-opencascadejs` (MIT) available for STEP
export. New MCP tool `cad_generate_parametric` executes a parametric script
(safe sandbox) and materializes the result as a mesh object + optional STL/STEP
file in the configured output root. The engine is a pure module (SOLID/DRY) so
tests can drive it directly, and the tool is a thin adapter.

## Health Check Commands (must pass before commit)

```bash
pnpm install
pnpm run test
node scripts/smoke.mjs
```

## Tickets

### S2-001 — Parametric engine module (Manifold core)

| Field                | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| **Ticket ID**        | S2-001                                                   |
| **Title**            | `scripts/cad-parametric-engine.mjs` — pure modeling core |
| **Priority**         | P0                                                       |
| **Type**             | Feature                                                  |
| **Estimated Effort** | L                                                        |
| **Source Finding**   | manifold-3d validated CSG + getMesh in Node (WASM, MIT)  |
| **Status**           | ⏳ Planned                                               |

#### Context

`manifold-3d` provides robust CSG and mesh generation entirely in WASM with no
external file dependencies. The engine exposes a small declarative API:
primitives (`box`, `cylinder`, `sphere`, `cone`, `prism`), transforms
(`translate`, `rotate`, `scale`, `mirror`), booleans (`add`, `subtract`,
`intersect`), and `extrude` (from polygon). Output is a shared
`{ positions, tris }` mesh plus optional STEP via Replicad when OCCT is
available. Pure module, no MCP dependency.

#### Acceptance Criteria

- [ ] `createParametricEngine()` initializes Manifold once (singleton, lazily).
- [ ] Primitives: box/cylinder/sphere/cone/prism produce valid watertight meshes.
- [ ] Booleans add/subtract/intersect produce correct results (validated by tests).
- [ ] `extrude` from 2D polygon list; `translate/rotate/scale/mirror` supported.
- [ ] Returns `{ positions, tris, watertight, volumeMm3 }`; STEP export delegated to Replicad helper.
- [ ] Pure module — no I/O; testable directly.
- [ ] Run the health check command successfully.

### S2-002 — Replicad STEP export helper

| Field                | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| **Ticket ID**        | S2-002                                                   |
| **Title**            | `scripts/cad-step-export.mjs` — STEP export via Replicad |
| **Priority**         | P1                                                       |
| **Type**             | Feature                                                  |
| **Estimated Effort** | M                                                        |
| **Source Finding**   | Replicad `blobSTEP()` API (MIT)                          |
| **Status**           | ⏳ Planned                                               |

#### Context

`replicad` needs OCCT WASM injected via `setOC` (heavy, ~30MB) and only works
when `replicad-opencascadejs` loads (Node 24 can throw `WebAssembly.Exception`).
The helper must attempt STEP export lazily, catch init failures gracefully, and
fall back to STL-only with a clear note — so Sprint 2 stays robust even when
OCCT is unavailable on the user's machine.

#### Acceptance Criteria

- [ ] `exportStep(mesh, targetPath)` tries Replicad import→`blobSTEP` in a try/catch.
- [ ] On success writes `.step` file and returns `{ ok, file_path, bytes, engine: "replicad" }`.
- [ ] On failure returns `{ ok:false, error, engine, fallback:"stl" }` without throwing to the tool.
- [ ] Unit test uses a tiny mesh and asserts the graceful-failure path (no crash).
- [ ] Run the health check command successfully.

### S2-003 — Parametric tool `cad_generate_parametric`

| Field                | Value                                   |
| -------------------- | --------------------------------------- |
| **Ticket ID**        | S2-003                                  |
| **Title**            | MCP tool running parametric scripts     |
| **Priority**         | P0                                      |
| **Type**             | Feature                                 |
| **Estimated Effort** | L                                       |
| **Source Finding**   | MCP tool registration pattern in bundle |
| **Status**           | ⏳ Planned                              |

#### Context

Expose the engine to agents: a tool executes a parametric script (a safe,
device-less function over the declarative API above), materializes the mesh into
the CAD workspace (reusing `api("add")`/mesh import path), and optionally
exports STL/STEP into the allowed output root. Input: `{ script, params?,
export_format? ('stl'|'step'|'none'), object_name? }`. The sandbox only allows
the engine's declarative API (no `process`/`require`/network) — SOLID: the
engine is consumed but never mutated.

#### Acceptance Criteria

- [ ] Tool registered and listed by the bundle (smoke includes it).
- [ ] Runs a script using only the declarative engine API; rejects scripts with `process`/`require`/`import`/`fetch`.
- [ ] Materializes the result into the CAD workspace (object appears in `/api/objects`).
- [ ] Exports STL (always) and STEP (if available / requested) to the allowed output root.
- [ ] Returns structured `{ ok, object, revision, vertices, triangles, watertight, files[] }`.
- [ ] Invalid scripts → clean `isError` result, no crash.
- [ ] Run the health check command successfully.

### S2-004 — Parametric UI section (cad.html)

| Field                | Value                                    |
| -------------------- | ---------------------------------------- |
| **Ticket ID**        | S2-004                                   |
| **Title**            | cad.html parametric panel                |
| **Priority**         | P2                                       |
| **Type**             | Feature                                  |
| **Estimated Effort** | S                                        |
| **Source Finding**   | CAD workspace UI sections for primitives |
| **Status**           | ⏳ Planned                               |

#### Context

Surface the parametric engine in the browser: a small "Parametric" panel with a
script textarea and a Run button that calls the new tool (same token-gated
endpoint used by other tools) and refreshes the scene. Keeps UI consistent with
the existing dark theme.

#### Acceptance Criteria

- [ ] "Parametric" section with script textarea + Run button + status line.
- [ ] On run, calls the v2 engine path and refreshes `refreshList()` + `buildMesh3D()`.
- [ ] Errors shown in the status line (no unhandled rejections).
- [ ] Run the health check command successfully.

### S2-005 — Parametric tests (unit + integration + e2e)

| Field                | Value                                            |
| -------------------- | ------------------------------------------------ |
| **Ticket ID**        | S2-005                                           |
| **Title**            | Tests for engine, export, tool, UI               |
| **Priority**         | P1                                               |
| **Type**             | Test                                             |
| **Estimated Effort** | L                                                |
| **Source Finding**   | Project test convention + skill sprint-execution |
| **Status**           | ⏳ Planned                                       |

#### Context

Same discipline as S1-004: unit-test every primitive/boolean/transform/extrude;
integration-test tool registration and a full script run through the bundle;
e2e checks the parametric panel executes a script in the browser.

#### Acceptance Criteria

- [ ] Unit: each primitive watertight, correct bounds, volume > 0.
- [ ] Unit: boolean correctness (union/difference/intersect counts).
- [ ] Unit: script sandbox rejects forbidden globals.
- [ ] Integration: `cad_generate_parametric` listed + answers with a valid mesh.
- [ ] E2E: browser runs a parametric script and sees the object in the viewer.
- [ ] `pnpm run test` + smoke pass.
- [ ] Run the health check command successfully.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-2): parametric engine via manifold + replicad"

- S2-001: `scripts/cad-parametric-engine.mjs` (primitives/booleans/transforms/extrude)
- S2-002: `scripts/cad-step-export.mjs` (replicad STEP, graceful fallback)
- S2-003: MCP tool `cad_generate_parametric`
- S2-004: cad.html parametric panel
- S2-005: unit/integration/e2e tests
```
