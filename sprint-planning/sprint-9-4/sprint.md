# Sprint 9.4 — Plate, Auto-Arrange, Toolbar & View Presets

## Sprint Metadata

| Field                 | Value                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Slicer workbench: floating toolbar, camera presets, view cube, plate tabs, auto-arrange                                                                                      |
| **Sprint Goal**       | Turn the viewport into a slicer workbench: floating toolbar, camera presets, view cube, plate management and one-click auto-arrange wired to the existing `cad-arrange.mjs`. |
| **Duration Estimate** | ~2 weeks                                                                                                                                                                     |
| **Priority**          | P0                                                                                                                                                                           |
| **Sprint Type**       | Feature                                                                                                                                                                      |
| **Primary Owner**     | apps/editor (viewport + toolbar)                                                                                                                                             |
| **Source**            | Consultor report 2026-09-30 §2 (9.4) + audit G7/G12/G13/G15/G16/G36                                                                                                          |
| **Depends On**        | Sprint 9.3 (arrange targets need real transforms)                                                                                                                            |
| **Status**            | ✅ Done (6/6 tickets delivered, 2026-10-02)                                                                                                                                  |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.4-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

The viewport becomes a slicer workbench. A floating glass toolbar (top-center in-canvas)
hosts tool modes (Select/Move/Rotate/Scale), snap + grid toggles, arrange, fit-view and view
presets (iso/top/front/right + numpad keys). A view cube (DOM glass tile, bottom-right)
drives damped camera presets. Plate tabs at the bottom of the viewport add/switch/duplicate/
rename plates with per-plate object filters. Auto-arrange wires to the server `cad-arrange.mjs`
through the bridge and re-commits the new authoritative layout. Status bar extends with
selected-object coords, plate dims and dirty state.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.4-001 — Floating viewport toolbar

| Field                | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.4-001                                                                          |
| **Title**            | `viewport/Toolbar.tsx`: tool modes, snap/grid toggles, arrange, fit, view presets |
| **Priority**         | P0                                                                                |
| **Type**             | Feature                                                                           |
| **Estimated Effort** | M                                                                                 |
| **Status**           | ✅ Delivered (2026-10-02, commit `6c76647`)                                       |

#### Context

Glass fill-2/blur-2 floating row, 28px buttons, 2px gaps, tooltips (110ms). Active tool =
accent text + 2px accent underline (toolpath motif). Tool state lives in `state/toolbar.ts`;
consumes the 9.3 shortcut layer for `Q/W/E/R`. Mode describes the current gizmo interaction.

#### Acceptance criteria

- [x] Toolbar floats above the canvas with glass styling; tools drive gizmo mode + view.
- [x] Snap + grid toggles (state only in 9.4; snapping behavior lands 9.7).

#### Implementation notes

**What shipped (7 files, commit `6c76647`):**

- `apps/editor/src/state/toolbar-core.ts` (NEW, pure) — `ViewPreset`
  (iso/top/front/right), `VIEW_PRESETS` (direction + up per preset; front = -Z
  viewer side → approached from +Z), `VIEW_PRESET_KEYS` (numpad 1-4 + Home→iso),
  `isViewPreset`, `ToolbarFlags {snap, grid}` + `DEFAULT_TOOLBAR_FLAGS` +
  `toggleToolbarFlag` (immutable). Tool modes stay in `state/ui.ts` `ToolMode`
  (S9.3-001) — the toolbar consumes the S9.3-003 shortcut layer ids 1:1.
- `apps/editor/src/state/toolbar.ts` (NEW, zustand) — `useToolbar` store over
  the pure core (snap/grid toggleFlag). Re-exports the ViewPreset machinery.
- `apps/editor/src/viewport/Toolbar.tsx` (NEW) — glass fill-2/blur-2 floating
  row top-center OVER the canvas (mounted inside `.viewport-frame`, sibling of
  the R3F canvas so 3D input is untouched outside its bounds). Groups:
  Select/Move/Rotate/Scale (setTool → gizmo), snap/grid toggles (useToolbar,
  state-only), Arrange (S9.4-004 placeholder toast), Fit (F equivalent via
  FRAME_SELECTED_EVENT), view presets (dispatch `VIEW_PRESET_EVENT` custom
  event for the S9.4-002 camera listener). Tooltips use `shortcutFor`/
  `shortcutLabel` from the shared registry (110ms CSS transition delay).
- `apps/editor/src/components/icons.tsx` — added `move`, `rotate`, `scale`
  toolpath glyphs (matching the hand-rolled 16px mono set).
- `apps/editor/src/viewport/Viewport.tsx` — mounts `<Toolbar />` as the first
  child of `ViewportFrame` (z-index above canvas, `!preview`).
- `apps/editor/src/styles.css` — `.viewport-toolbar` (absolute top-center,
  fill-2/blur-2 glass, hairline + shadow-2, r-lg), `.toolbar-group` (2px gaps,
  separators), `.toolbar-btn` (28px min, transparent, hover raised, active =
  accent text + 2px accent underline below, 110ms transitions).
- `tests/toolbar.test.mjs` (NEW) — 5 unit tests: default flags, toggle flip +
  preserve, immutability, VIEW_PRESETS[keys] map, isViewPreset guard.

**Acceptance evidence:**

- AC-1 (floats + drives gizmo/view): mounted in ViewportFrame top-center; tool
  buttons write `useUi.tool` (the S9.3-001 gizmo switches mode); preset buttons
  dispatch the VIEW_PRESET_EVENT consumed by S9.4-002's camera tween. e2e:ui +
  editor-reload PASS.
- AC-2 (snap/grid state-only): toggles flip `useToolbar` flags with accent
  underline feedback; real snapping deliberately deferred to 9.7. Unit tests
  assert the toggle semantics headless.

**Gate:** `pnpm run check` EXIT:0 (log: `$env:TEMP\s9-4-001-check1.log`, `GATE_EXIT=0`) —
unit 384 pass, integration 11 pass, lint clean, typecheck clean, Rust (auth + editor
shell), smoke 106 tools, e2e:ui PASS, e2e:editor-reload PASS, licenses 59, architecture
OK, sanitize DRY-RUN 0 files.

### S9.4-002 — Camera presets + view cube

| Field                | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Ticket ID**        | S9.4-002                                                                |
| **Title**            | `viewport/ViewCube.tsx` + camera presets (iso/top/front/right + numpad) |
| **Priority**         | P1                                                                      |
| **Type**             | Feature                                                                 |
| **Estimated Effort** | M                                                                       |
| **Status**           | ✅ Delivered (2026-10-02, commit `a6e61e9`)                             |

#### Context

View cube bottom-right, 3×3 grid of faces/corners/edges from DOM (isometric "home" center),
84px glass tile, face hover `--sel-bg`, click = damped camera tween reusing existing
OrbitControls. Presets (iso/top/front/right + numpad keys) in `state/viewport.ts`
(+camera/preset state). Fit = F frames selection or whole plate.

#### Implementation notes

- `state/camera-core.ts` (pure): `ViewCubeCell` 26-cell union + `cellDirection()` — plate
  axes: front = -Z (viewer side) → approached from +Z; `homeDirection()` = top-front-right
  corner (isometric). Headless-testable, same pattern as toolbar-core.
- `viewport/ViewportCamera.tsx` (in-Canvas): listens `VIEW_PRESET_EVENT` (toolbar presets,
  from `viewport/Toolbar.tsx`) + `VIEW_CUBE_EVENT` (view cube); damped tween
  `TWEEN_MS=520`, ease-out cubic, rAF loop, orbit distance + Controls target preserved.
- `viewport/ViewCube.tsx` (DOM glass tile, bottom-right): 3×3 grid — 6 faces (F/R/B/L/T/D),
  4 top corners + home center; click dispatches `VIEW_CUBE_EVENT {cell|null}` (null = iso).
  Edges intentionally omitted (cell map extensible).
- Mounted in `Viewport.tsx`: `<ViewportCamera />` inside `<Canvas>` (when `!preview`),
  `<ViewCube />` as frame sibling (bottom-right). Styles `.view-cube` in `styles.css`
  (glass-fill-2/blur-2, r-lg, 22px cells).
- Unit tests `tests/camera-presets.test.mjs` (4): face axis convention, home = iso corner,
  all 26 cells resolve, unknown cell throws.

#### Acceptance criteria

- [x] View cube + numpad presets animate the camera; home = isometric.
- [x] Lighting/view orientations respect plate axes (front = front-left origin convention).
- [x] Verified: unit 388 pass (387 + 4 new), lint clean, typecheck clean, sanitize DRY-RUN 0.

### S9.4-003 — Plate tabs + per-plate filtering

| Field                | Value                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| **Ticket ID**        | S9.4-003                                                                       |
| **Title**            | `viewport/PlateTabs.tsx`: add/switch/duplicate/rename plates, per-plate filter |
| **Priority**         | P0                                                                             |
| **Type**             | Feature                                                                        |
| **Estimated Effort** | M                                                                              |
| **Status**           | ✅ Delivered (2026-10-02, commit `2e50c75`)                                    |

#### Context

G12(θ). Plate tabs floating chips above the bottom edge: `Plate 1` active = accent-soft fill +
accent text; + Add; rename via context menu; unsaved indicator = 3px dot. Per-plate object
filter (objects belong to a plate; only current plate's objects render). Plate state in
`state/plates.ts`. Out of scope: plate split/cut (P2) and multi-plate slicing semantics.

#### Implementation notes

- `state/plates-core.ts` pure model: add / switch / duplicate / rename / dirty + membership
  filter + orphan guard; `state/plates.ts` zustand store (`usePlates`, `useActivePlate()`) +
  const re-exports (TS requires explicit import before re-export).
- `viewport/PlateTabs.tsx` floating glass chips (mirror toolbar: fill-2 / blur-2 /
  `--shadow-inset-hi`); tab active = accent-soft + accent-primary + accent-ring; 3px dot on
  dirty; `+` adds next non-colliding label ("Plate N"); double-click or context menu opens
  inline rename (Enter/blur commit, Esc cancel).
- Context menu per tab: Duplicate plate / Rename... / "Move objects to..." (other plates,
  disabled when source has no objects) → persisted via `scene.mutateObject({kind:
"setPlate", name, plateId})` + `invalidateQueries(["bridge","scene"])`.
- Bridge/scene: `SceneObjectSnapshot.plateId?` (absent = default plate), `setPlate` event +
  reducer case, `mock.mutateObject` lane, store action.
- `Viewport.tsx` filters `visibleObjects = objectsOnPlate(objects, activePlateId)` — only
  the active plate's objects render; deleted dead `count` variable.
- `App.tsx` replaces static "Plate 01" heading with live plate name
  (`data-testid="plate-heading-name"`) and mounts the tab strip in `.viewport-host`.
- Styles in `styles.css`: `.plate-tabs/.plate-tab/.is-active/.plate-tab-dot/`
  `.plate-tab-add/.plate-tabs-rename/.plate-menu-caption` — note `--bg-inset` does not exist
  in index.css, rename input uses `--bg-panel`.
- Tests: `tests/plates.test.mjs` (13 cases, headless). Gate: unit 400 pass / fail 0, lint
  clean, tsc EXIT:0, e2e:ui + e2e:editor-reload PASS, sanitize DRY-RUN 0 files, GATE_EXIT=0.

### S9.4-004 — Auto-arrange + place on plate

| Field                | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.4-004                                                                                  |
| **Title**            | Arrange button → bridge `cad-arrange.mjs` → re-commit layout; per-object "place on plate" |
| **Priority**         | P0                                                                                        |
| **Type**             | Feature                                                                                   |
| **Estimated Effort** | M                                                                                         |
| **Status**           | ✅ Delivered (2026-10-02, commit `3e6e06c`)                                               |

#### Context

G7/G13. Arrange button (toolbar) → bridge calls the preserved `cad-arrange.mjs` → new
authoritative layout (objects re-committed through the S7-004 reducer). Per-object "place on
plate" centers + drops to z=0. Collision alert toast on overflow. Snap fields appear in the
transform inspector (behavior 9.7).

#### Implementation notes

- `state/arrange-core.ts` (pure, headless): `centerOnPlateTransform(obj)` centers X/Y on the
  plate origin + drops minZ to 0 (bounds × scale, `-0` normalized via `|| 0`); `arrangeTransforms`
  is a snapshot-level port of `scripts/cad-arrange.mjs` shelf packing (footprint = bounds size
  × scale, largest-first rows, block centered, overflow warnings). No runtime transform-core
  import so Node 24 runs it directly.
- Bridge lane `arrange(opts)` (mock): runs the layout, re-commits transforms (revision + 1,
  journal diff events emitted, commit event fired), returns `{ placed, warnings }`. New
  `ArrangePlacement` / `ArrangeResult` types in `bridge/types.ts`; `BridgeContract.arrange`.
- `Toolbar.tsx` now receives `scene`; the Arrange button gathers the ACTIVE plate's objects
  (`objectsOnPlate`), calls the lane with the machine-profile dimensions (never a hardcoded
  220×220), invalidates the scene query and pushes a success / overflow-warning / error toast.
- `ObjectTree.tsx`: context menu gains "Place on plate" → `setTransform(centerOnPlateTransform)`
  persisted via the bridge; the footer Arrange button wires the same lane.
- Tests `tests/arrange-core.test.mjs` (8 cases): place-on-plate (incl. scale), deterministic
  layout inside the plate, mesh-offset semantics (X = grid − center), oversized overflow
  warning, degenerate footprint skip, block centering, empty list. Gate: unit 408 pass / fail 0,
  e2e:ui + e2e:editor-reload PASS, sanitize DRY-RUN 0 files, GATE_EXIT=0.

### S9.4-005 — Status bar extension

| Field                | Value                                                |
| -------------------- | ---------------------------------------------------- |
| **Ticket ID**        | S9.4-005                                             |
| **Title**            | Status bar: selected coords, plate dims, dirty state |
| **Priority**         | P1                                                   |
| **Type**             | Feature                                              |
| **Estimated Effort** | S                                                    |
| **Status**           | ✅ Delivered (afa5dec)                               |

#### Context

Extend the 9.1 status bar: left object count/units/build volume; selected-object coords (mono);
plate dims; right revision + dirty chip (`● 3 unsaved`). Pairs with G36/G44 scaffold.

#### Acceptance criteria

- [x] Status bar shows selected coords (mono), current plate dims, revision + dirty chip.

#### Implementation notes

- New dependency-free core `apps/editor/src/state/statusbar-core.ts` (S9.4-005):
  - `formatCoords(transform)` → mono string `x 12.3  y -4.1  z 0.6` (1 decimal, d1 helper);
  - `positionOf(o)` → identity 0 when transform absent;
  - `plateBounds(objects)` → scene-space AABB (bounds min/max offset by transform
    position, rotation read as identity, scale as 1 — same convention as arrange
    core); null on empty set;
  - `formatPlateDims(b)` → `40 × 10 × 40 mm` label;
  - `unsavedCount(plateDirty, objectsOnPlate, dirtyTransformName, objects)` →
    draft wins (1 if the draft belongs to any object), else plate-dirty = count.
- `components/status-bar.tsx` subscribes to scene selection + plate membership:
  after the build-volume segment, a selected anchor shows `status-coords` (mono,
  tooltip `cone position (mm)`, e.g. `x 0 y -13 z 14`); when the ACTIVE plate has
  objects, `status-plate-dims` renders the scene AABB label (tooltip
  `Plate 1 scene bounds (mm)`). Keeps the S9.3-002 draft kinds chip
  (`cone: position` on uncommitted inspector edit) and adds `● N unsaved`
  (`status-dirty-chip`, draft closed + plate dirty) counting active-plate objects.
- Verified in browser (snapshot): `3 objects · mm · 250×250×250 · x 0 y -13 z 14 ·
53 × 26 × 28 mm · rev 8`; typing x=10 into the inspector surfaced the draft chip
  `cone: position` without mutating the committed coords.
- Tests `tests/statusbar-core.test.mjs` (7 cases — JS only, prettier-safe): mono
  rounding, identity transform, AABB aggregation over two placed objects, null on
  empty set, dims label, draft vs plate-dirty counting. Gate: unit 415 pass / fail
  0, integration 11 pass, smoke 106 tools, e2e:ui + e2e:editor-reload PASS,
  licenses + architecture OK, sanitize DRY-RUN 0 files, GATE_EXIT=0.
- Commit `afa5dec` — 3 files, +255 (prettier + sanitize hook clean).

### S9.4-006 — Gate + sanitizer

| Field                | Value                                        |
| -------------------- | -------------------------------------------- |
| **Ticket ID**        | S9.4-006                                     |
| **Title**            | Full gate EXIT:0 + sanitizer 0               |
| **Priority**         | P0                                           |
| **Type**             | Quality                                      |
| **Estimated Effort** | S                                            |
| **Status**           | ✅ Delivered (2026-10-02, closes sprint 9.4) |

#### Context

`pnpm run check` + unit tests for plates + arrange lane; sanitizer dry-run 0; commit closes
the sprint.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.

#### Implementation notes

- Full gate run (S9.4-005 check): `pnpm run check` EXIT:0 — format:check, lint,
  typecheck, unit **415 pass / 0 fail** (plates + arrange + statusbar cores),
  integration 11 pass, check:rust, build, smoke (106 tools), e2e:ui PASS,
  e2e:editor-reload PASS, check:licenses OK, check:architecture OK,
  **sanitize DRY-RUN 0 files / 0 substitution groups (usr=mafsc)**.
- Every sprint commit passed the pre-commit hook (prettier + sanitize dry-run):
  `6c76647` (001), `a6e61e9` (002), `2e50c75` (003), `3e6e06c` (004),
  `afa5dec` (005), docs `0bf8fdf` / `49ee6e3` / `b1abbe5`.
- Sprint 9.4 is **COMPLETE 6/6** — all acceptance criteria met; no ticket left
  behind (mandatory completion requirement satisfied).
