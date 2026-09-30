# Sprint 9.2 — Real Geometry, Import & Scene Graph

## Sprint Metadata

| Field                 | Value                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Kill the unit boxes: real mesh rendering, model import, editable scene graph                                                |
| **Sprint Goal**       | Objects render from real triangle buffers; users can add/remove/rename/duplicate/hide/lock objects from a real object tree. |
| **Duration Estimate** | ~2 weeks                                                                                                                    |
| **Priority**          | P0                                                                                                                          |
| **Sprint Type**       | Feature                                                                                                                     |
| **Primary Owner**     | apps/editor (viewport + scene)                                                                                              |
| **Source**            | Consultor report 2026-09-30 §2 (9.2) + audit G1/G4/G5/G6/G10/G34/G41                                                        |
| **Depends On**        | Sprint 9.1 (tokens)                                                                                                         |
| **Status**            | 🔄 In Progress — 1/6 tickets done (S9.2-001), gate EXIT:0 per ticket                                                        |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.2-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

**This is the sprint that directly answers "não consigo controlar nenhum objeto na UI"** at
the graph level. Real triangle buffers come through the bridge (STL/3MF import; the preserved
server's per-triangle positions), so `SceneObjectModel` stops rendering `boxGeometry(1,1,1)`
scaled boxes and renders actual meshes with wireframe edges, watertight/non-watertight tint,
hover highlight and selection outline. The scene store becomes a real graph
(`{id, name, parents?, transform, visible, locked, watertight, mesh}`) with full CRUD
actions. `state/scene.ts` keeps its exported names frozen for its consumers. Also fold in the
`THREE.Clock` deprecation fix and the HMR 500 (`history`/`ChatPanel`) fix.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.2-001 — Bridge geometry + CRUD mutation lane

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.2-001                                                                        |
| **Title**            | `bridge/mock.ts` geometry buffers + object CRUD lane (snapshot shape preserved) |
| **Priority**         | P0                                                                              |
| **Type**             | Feature                                                                         |
| **Estimated Effort** | L                                                                               |
| **Status**           | ✅ Done                                                                         |

#### Context

The mock's snapshot response shape is **frozen** — 9.x extends it behind that shape (mutation
lanes), so the later real-bridge swap is a provider change, never a type change. Add per-object
triangle buffers (positions/normals/indices) + add/remove/rename/duplicate/hide/lock mutation
functions with the S7-002 framed modal contract (begin→update→commit) where appropriate.

#### Acceptance criteria

- [x] `GET /objects` shape unchanged; new geometry fields + CRUD lanes added behind it.
- [x] New `bridge/import.ts` parses STL (binary+ASCII) / 3MF into triangle buffers (units mm).
- [x] Existing tests referencing the frozen shape pass unchanged.

#### Implementation notes

- `import.ts` is a pure module (no three.js) so Node runs it headless. `parseStl` detects
  binary via declared–length match, falls back to ASCII when the header is printable.
  `parseThreemf` scans the zip central directory, raw-inflates the `.model` part with a
  hand-rolled fixed/dynamic Huffman decoder (verified byte-for-byte against `node:zlib`
  `deflateRawSync`), rejects non-mm units (`THREEMF_UNIT`), and captures the first object
  mesh (`THREEMF_NO_MESHES` / `THREEMF_EMPTY` otherwise). `isWatertight` is edge-based
  (every edge shared exactly 2×) so it works on per-triangle repacked buffers.
- Debug findings: the test zip builder wrote the compression method at the wrong central
  header offset, making the parser treat deflated data as stored — fixed in the fixture.
- `mock.ts` now serves real cone/cube/sphere geometry (mm) with `let sceneObjects` and the
  `mutateObject` CRUD lane (add/remove/rename/duplicate/toggleVisible/toggleLock/
  setTransform/commitObject) returning authoritative `objects` or `{ok:false}` error.
- 10/10 `tests/import-parser.test.mjs` green; full gate EXIT:0; commit `6e2be6f`.

### S9.2-002 — Scene graph store

| Field                | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.2-002                                                                          |
| **Title**            | `state/scene.ts` → graph store (id/name/transform/visible/locked/watertight/mesh) |
| **Priority**         | P0                                                                                |
| **Type**             | Refactor                                                                          |
| **Estimated Effort** | M                                                                                 |
| **Status**           | ⏳ Planned                                                                        |

#### Context

Replace the selection-only stub. Keep exported names (`selected`, `select`, `clear`) frozen
for consumers; add `add/remove/rename/duplicate/toggleVisible/toggleLock`, multi-select
(shift-click), and per-object `transform`/`visible`/`locked`/`watertight`/`mesh` fields.
All destructive ops route through the viewport-core reducer pattern already in
`state/viewport-core.ts` (begin→update→commit|cancel) so a stale revision is always
rebase-able.

#### Acceptance criteria

- [x] Graph store with full CRUD + multi-select; old consumer API intact.
- [x] Delete/hide/duplicate route through the framed modal reducer (no undo-less destructive ops).

### S9.2-003 — Real mesh rendering

| Field                | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| **Ticket ID**        | S9.2-003                                                      |
| **Title**            | `viewport/SceneObjectModel.tsx` renders real triangle buffers |
| **Priority**         | P0                                                            |
| **Type**             | Feature                                                       |
| **Estimated Effort** | M                                                             |
| **Status**           | ⏳ Planned                                                    |

#### Context

Render from real buffers; fallback keeps a bounds box for mesh-info-only objects. Wireframe
edges + watertight/non-watertight tint (existing `#b36a5e` non-watertight convention kept) +
hover highlight + selection outline (2px `--sel-outline-3d` + 6px glow halo, per design spec
§3.6). Selection outline hidden while transient transform in progress.

#### Acceptance criteria

- [x] Imported objects render real geometry, not unit boxes (visual check + snapshot test).
- [x] Watertight tint, non-watertight tint, hover, selection outline all correct.
- [x] Wireframe edges toggleable (per object / global view mode).

### S9.2-004 — Object tree full rework

| Field                | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Ticket ID**        | S9.2-004                                                                    |
| **Title**            | `panels/ObjectTree.tsx`: rename/visibility/lock/context menu/footer actions |
| **Priority**         | P0                                                                          |
| **Type**             | Feature                                                                     |
| **Estimated Effort** | M                                                                           |
| **Status**           | ⏳ Planned                                                                  |

#### Context

Rows ≤32px: visibility eye, lock, name (ellipsis), right-aligned mono meta (`2.4k tri · 1.8k
vtx`). Inline rename on double-click; hover `--sel-hover`; selected `--sel-bg` + 2px left
accent rail; right-click context menu (duplicate/rename/hide/delete — G35 scaffold); footer
Add (import)/Duplicate/Delete/Arrange buttons.

#### Acceptance criteria

- [x] All tree actions work against the graph store; row density ≤32px; meta uses mono tabular.
- [x] Inline rename via double-click; context menu (right-click) wired.

### S9.2-005 — Import dialog + drag-drop

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9.2-005                                                                   |
| **Title**            | ImportDialog (STL/3MF, scale/center/auto-orient) + drag-drop onto viewport |
| **Priority**         | P0                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | M                                                                          |
| **Status**           | ⏳ Planned                                                                 |

#### Context

G41. Entry points: Add button in object panel footer, drag-drop onto viewport, file dialog.
Import dialog: units mm, auto-center, scale, orient-flat. On import, objects enter the graph
store placed above the plate (z=0).

#### Acceptance criteria

- [x] STL (binary/ASCII) + 3MF import via three entry points; dialog honors scale/center/orient.
- [x] Imported object appears in tree + viewport immediately, watertight status computed.

### S9.2-006 — Hygiene: Clock deprecation + HMR 500 + gate

| Field                | Value                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| **Ticket ID**        | S9.2-006                                                                       |
| **Title**            | Fix `THREE.Clock` deprecation, HMR 500 (`history`/`ChatPanel`), then full gate |
| **Priority**         | P1                                                                             |
| **Type**             | Chore                                                                          |
| **Estimated Effort** | S                                                                              |
| **Status**           | ⏳ Planned                                                                     |

#### Context

From audit §7: live page 500 on reload (HMR ChatPanel) + THREE.Clock deprecation warning.
Eliminate both with **zero mystery** (audit the actual R3F usage and swap the deprecation).
Re-verify with the 9.1a overlay root + AI SDK hooks mounted — HMR 500 regression check is now
exercised with a real portal transport on page reload.

#### Acceptance criteria

- [x] No Clock deprecation warning in dev console; reload no longer 500s (incl. with overlay root + AI SDK hooks mounted).
- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.
