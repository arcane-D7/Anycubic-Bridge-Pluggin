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
| **Status**            | ⏳ Planned                                                                                                                                                                   |

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
| **Status**           | ⏳ Planned                                                                        |

#### Context

Glass fill-2/blur-2 floating row, 28px buttons, 2px gaps, tooltips (110ms). Active tool =
accent text + 2px accent underline (toolpath motif). Tool state lives in `state/toolbar.ts`;
consumes the 9.3 shortcut layer for `Q/W/E/R`. Mode describes the current gizmo interaction.

#### Acceptance criteria

- [x] Toolbar floats above the canvas with glass styling; tools drive gizmo mode + view.
- [x] Snap + grid toggles (state only in 9.4; snapping behavior lands 9.7).

### S9.4-002 — Camera presets + view cube

| Field                | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Ticket ID**        | S9.4-002                                                                |
| **Title**            | `viewport/ViewCube.tsx` + camera presets (iso/top/front/right + numpad) |
| **Priority**         | P1                                                                      |
| **Type**             | Feature                                                                 |
| **Estimated Effort** | M                                                                       |
| **Status**           | ⏳ Planned                                                              |

#### Context

View cube bottom-right, 3×3 grid of faces/corners/edges from DOM (isometric "home" center),
84px glass tile, face hover `--sel-bg`, click = damped camera tween reusing existing
OrbitControls. Presets (iso/top/front/right + numpad keys) in `state/viewport.ts`
(+camera/preset state). Fit = F frames selection or whole plate.

#### Acceptance criteria

- [x] View cube + numpad presets animate the camera; home = isometric.
- [x] Lighting/view orientations respect plate axes (front = front-left origin convention).

### S9.4-003 — Plate tabs + per-plate filtering

| Field                | Value                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| **Ticket ID**        | S9.4-003                                                                       |
| **Title**            | `viewport/PlateTabs.tsx`: add/switch/duplicate/rename plates, per-plate filter |
| **Priority**         | P0                                                                             |
| **Type**             | Feature                                                                        |
| **Estimated Effort** | M                                                                              |
| **Status**           | ⏳ Planned                                                                     |

#### Context

G12(θ). Plate tabs floating chips above the bottom edge: `Plate 1` active = accent-soft fill +
accent text; + Add; rename via context menu; unsaved indicator = 3px dot. Per-plate object
filter (objects belong to a plate; only current plate's objects render). Plate state in
`state/plates.ts`. Out of scope: plate split/cut (P2) and multi-plate slicing semantics.

#### Acceptance criteria

- [x] Multiple plates create/switch/duplicate/rename; per-plate object visibility correct.
- [x] Cross-plate object move (drag between tabs) works via context menu or drag-drop.

### S9.4-004 — Auto-arrange + place on plate

| Field                | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.4-004                                                                                  |
| **Title**            | Arrange button → bridge `cad-arrange.mjs` → re-commit layout; per-object "place on plate" |
| **Priority**         | P0                                                                                        |
| **Type**             | Feature                                                                                   |
| **Estimated Effort** | M                                                                                         |
| **Status**           | ⏳ Planned                                                                                |

#### Context

G7/G13. Arrange button (toolbar) → bridge calls the preserved `cad-arrange.mjs` → new
authoritative layout (objects re-committed through the S7-004 reducer). Per-object "place on
plate" centers + drops to z=0. Collision alert toast on overflow. Snap fields appear in the
transform inspector (behavior 9.7).

#### Acceptance criteria

- [x] Arrange produces a deterministic layout via the server tool; objects re-committed.
- [x] Overflow triggers a collision/overflow toast; per-object place-on-plate centers + z=0.

### S9.4-005 — Status bar extension

| Field                | Value                                                |
| -------------------- | ---------------------------------------------------- |
| **Ticket ID**        | S9.4-005                                             |
| **Title**            | Status bar: selected coords, plate dims, dirty state |
| **Priority**         | P1                                                   |
| **Type**             | Feature                                              |
| **Estimated Effort** | S                                                    |
| **Status**           | ⏳ Planned                                           |

#### Context

Extend the 9.1 status bar: left object count/units/build volume; selected-object coords (mono);
plate dims; right revision + dirty chip (`● 3 unsaved`). Pairs with G36/G44 scaffold.

#### Acceptance criteria

- [x] Status bar shows selected coords (mono), current plate dims, revision + dirty chip.

### S9.4-006 — Gate + sanitizer

| Field                | Value                          |
| -------------------- | ------------------------------ |
| **Ticket ID**        | S9.4-006                       |
| **Title**            | Full gate EXIT:0 + sanitizer 0 |
| **Priority**         | P0                             |
| **Type**             | Quality                        |
| **Estimated Effort** | S                              |
| **Status**           | ⏳ Planned                     |

#### Context

`pnpm run check` + unit tests for plates + arrange lane; sanitizer dry-run 0; commit closes
the sprint.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.
