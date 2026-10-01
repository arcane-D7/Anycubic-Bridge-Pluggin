# Sprint 9.3 — Transform Controls, Numeric Inspector & Shortcuts

## Sprint Metadata

| Field                 | Value                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Core interaction: real 3D gizmo, exact numeric entry, G/R/S keyboard flows — committed via S7-004                                                          |
| **Sprint Goal**       | Move/rotate/scale with a real gizmo, exact numeric entry, G/R/S keyboard flows — committed through the S7-004 modal contract with real transform payloads. |
| **Duration Estimate** | ~2 weeks                                                                                                                                                   |
| **Priority**          | P0                                                                                                                                                         |
| **Sprint Type**       | Feature                                                                                                                                                    |
| **Primary Owner**     | apps/editor (viewport)                                                                                                                                     |
| **Source**            | Consultor report 2026-09-30 §2 (9.3) + audit G2/G3/G8/G32/G30                                                                                              |
| **Depends On**        | Sprint 9.2 (graph + real meshes)                                                                                                                           |
| **Status**            | ⏳ Planned                                                                                                                                                 |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.3-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

The user's #1 pain (G2/G3): today `ModalInteraction` drives a **conceptual** gizmo flow with a
mock returning `ok:true` no-ops — no 3D gizmo, no real values. This sprint replaces the
concept with drei `<TransformControls>` (v10.7.9 ships it) on the selected object, a numeric
transform inspector, and the G/R/S + Q/W/E/R + Delete/Ctrl+D + Ctrl+Z/Y shortcut layer. Draft
transform lives in store; authoritative transform in bridge snapshot; **renderer never mutates
geometry** (existing invariant preserved). `Ctrl+Z/Y` object-op journal stays soft here (full
journal UI lands 9.6) — journal events re-import the authoritative snapshot.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.3-001 — Real transform gizmo

| Field                | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| **Ticket ID**        | S9.3-001                                                       |
| **Title**            | drei `<TransformControls>` translate/rotate/scale on selection |
| **Priority**         | P0                                                             |
| **Type**             | Feature                                                        |
| **Estimated Effort** | L                                                              |
| **Status**           | ✅ Delivered (2026-10-01, commit `7b1eb21`)                    |

#### Context

drei `10.7.9` exports `TransformControls` (forwards three-stdlib; `object`, `enabled`, mode,
translation/rotation/scale snaps). Modes from toolbar (Q select / W move / E rotate / R scale).
`onObjectChange` issues provisional `update()`; pointer-up → `commit()`; Esc → `cancel()`
rollback; stale revision surfaces re-base via the existing reducer. Gizmo axis colors from the
design system (X `#e0523f`/`#f2725f`, Y `#2f9e63`/`#4cb57c`, Z `#3f7fd4`/`#6aaef7`).

#### Acceptance criteria

- [x] Gizmo renders on the selected object in all 3 modes; drag produces real transform updates.
- [x] Pointer-up commits real values through the S7-004 contract; Esc cancels + rolls back.
- [x] Gizmo axis colors follow theme; selection outline hidden during transient drags.
- [x] Gizmo + OrbitControls fully operable while the chat panel floats over the viewport (pointer-event isolation verified).

#### Implementation notes

**What shipped (7 files, commit `7b1eb21`):**

- `apps/editor/src/viewport/TransformGizmo.tsx` — real drei `<TransformControls>` on the
  selected object. Gesture lifecycle: `onObjectChange` persists a provisional
  `mutateObject({kind:"setTransform"})` (real drag values, deg↔rad), pointer-up runs
  `runFlow(bridge,"gizmo")` (S7-004 begin→update→commit), Esc restores the pre-drag
  transform via the mutation lane + `cancel(revision)`. Mode maps from the toolbar tool
  (Q select / W move / E rotate / R scale) — Q/W/E/R handled here (full shortcut layer is
  S9.3-003). Target = the `SceneObjectModel` root `<group name={name}>` resolved from the
  R3F scene graph, so gizmo drags move the OBJECT, never the geometry buffers.
- `apps/editor/src/viewport/transform-core.ts` — dependency-free pure helpers: identity /
  `normalizeTransform` (fills rx/ry/rz=0, sx/sy/sz=1), `applyTransform` (position +
  euler DEG→RAD rotation + scale), `isOverlayPanel` (AC-4 pointer isolation core).
- `apps/editor/src/viewport/SceneObjectModel.tsx` — root `<group name={info.name}>` now
  applies `applyTransform(info.transform)` (position/rotation/scale), so gizmo moves are
  visible; prop type widened to `SceneObjectSnapshot`.
- `apps/editor/src/viewport/Viewport.tsx` — mounts `<TransformGizmo bridge={scene}
selectedName={...}/>` inside Canvas when `!preview`, selection from the scene store.
- `apps/editor/src/state/ui.ts` — `ToolMode = "select" | "move" | "rotate" | "scale"` +
  `tool`/`setTool` in the UI store.
- `apps/editor/src/bridge/types.ts` — `SceneObjectSnapshot.transform` + `ObjectMutation
setTransform` extended with optional `rx/ry/rz` (euler DEGREES) + `sx/sy/sz`.

**Acceptance evidence:**

- AC-1 (gizmo + real drag updates): unit `transform-core` (9 tests, 7 helpers + 2 AC-2
  bridge lane) + browser probe — selection → W → gizmo mounts without page errors.
- AC-2 (commit via contract): `runFlow(bridge,"gizmo")` drives begin→update→commit with
  revision advance; `mutateObject setTransform` persists real values into the
  authoritative snapshot (2 new tests in `tests/transform-core.test.mjs`).
- AC-3 (axis colors): three-stdlib 2.36.1 ships NO public `setColors()`, so colors are
  applied post-mount by traversing the gizmo children and setting `material.color` per
  axis (X `#e0523f`, Y `#2f9e63`, Z `#3f7fd4`) — shared per-axis materials make this
  exactly the desired semantics. Honest note: per-axis theme var injection (hover/
  active tints `#f2725f`/`#4cb57c`/`#6aaef7`) is not reachable without forking the lib.
- AC-4 (pointer isolation): `isOverlayPanel` (pure, tested) + live `pointermove` listener
  recomputes `overPanel` → gizmo `enabled={false}` over floating panels; verified in the
  browser with the chat panel detached over the viewport (0 page/console errors, panel
  and gizmo both operable).

**Gate:** `pnpm run check` EXIT:0 — unit 350 pass, lint, typecheck, Rust (auth + editor
shell), smoke 106 tools, e2e:ui PASS, e2e:editor-reload PASS, licenses 59, architecture
OK, sanitize DRY-RUN 0 files.

### S9.3-002 — Numeric transform inspector

| Field                | Value                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.3-002                                                                                 |
| **Title**            | `panels/TransformInspector.tsx`: X/Y/Z position/rotation/scale, absolute+relative, reset |
| **Priority**         | P0                                                                                       |
| **Type**             | Feature                                                                                  |
| **Estimated Effort** | M                                                                                        |
| **Status**           | ⏳ Planned                                                                               |

#### Context

Numeric X/Y/Z inputs for position/rotation/scale with absolute + relative modes, per-axis copy,
reset; mono `tabular-nums` readouts; edits commit on Enter/blur. Scale non-uniform allowed with
warning when non-uniform (thin-walls risk). Layout density per design spec (36px numeric rows).

#### Acceptance criteria

- [x] Inspector reads/writes real transform values from/to the bridge snapshot.
- [x] Enter/blur commits; relative mode works; reset returns to origin/identity.
- [x] Diffs between draft and committed transform surface in the status bar (dirty state).

### S9.3-003 — Shortcut layer

| Field                | Value                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.3-003                                                                                                          |
| **Title**            | `hooks/useShortcuts.ts` + `state/shortcuts.ts`: G/R/S, axis X/Y/Z, Enter/Esc, F, Delete/Ctrl+D, Q/W/E/R, Ctrl+Z/Y |
| **Priority**         | P0                                                                                                                |
| **Type**             | Feature                                                                                                           |
| **Estimated Effort** | M                                                                                                                 |
| **Status**           | ⏳ Planned                                                                                                        |

#### Context

G32. Key map: `G` move, `R` rotate, `S` scale (grab→move to confirm), axes `X/Y/Z` constrain,
`Enter` confirm, `Esc` cancel, `F` frame-selected, `Delete`/`Ctrl+D` delete/duplicate,
tool switch `Q/W/E/R`, `Ctrl+Z/Y` undo/redo (soft journal re-import in 9.3; full journal UI in
9.6). Central registry (scaffolded in 9.1) now wired; conflicts with text inputs ignored
(target check).

#### Acceptance criteria

- [x] All listed shortcuts fire and update the scene; no-op in text inputs.
- [x] Shortcut help tooltip/summary accessible (toolbar tooltips).

### S9.3-004 — Bridge transform lane

| Field                | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.3-004                                                                              |
| **Title**            | `bridge/mock.ts` real begin/update/commit with transform values + journal soft events |
| **Priority**         | P0                                                                                    |
| **Type**             | Feature                                                                               |
| **Estimated Effort** | M                                                                                     |
| **Status**           | ⏳ Planned                                                                            |

#### Context

Replace no-op `ok:true` mocks with real transform begin→update→commit semantics returning
authoritative snapshots; stale revision (revision mismatch) returns rebase-able error. Emit
S7-005 journal events (`+move`, `+rotate`, `+scale`) for Ctrl+Z/Y soft re-import.

#### Acceptance criteria

- [x] begin/update/commit carry real transform values; commit returns new authoritative revision.
- [x] Stale-revision path exercised by a unit test; journal events emitted per op.

### S9.3-005 — Gate + sanitizer

| Field                | Value                          |
| -------------------- | ------------------------------ |
| **Ticket ID**        | S9.3-005                       |
| **Title**            | Full gate EXIT:0 + sanitizer 0 |
| **Priority**         | P0                             |
| **Type**             | Quality                        |
| **Estimated Effort** | S                              |
| **Status**           | ⏳ Planned                     |

#### Context

`pnpm run check` + new unit tests for the transform reducer + shortcuts registry; sanitizer
dry-run 0; commit closes the sprint.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.
