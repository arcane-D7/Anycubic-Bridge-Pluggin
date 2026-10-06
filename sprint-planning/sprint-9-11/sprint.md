# Sprint 9.11 — Slicer-Style View, Live Overlay & BuildPlate Upgrades

## Sprint Metadata

| Field                 | Value                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | View modes (mesh / slicer-style / live), filament textures, plate realism                                                                                             |
| **Sprint Goal**       | Make the viewport show REAL filament colors (from ACE slots per extruder) and live printer state over a realistic plate — the visual core of the printer integration. |
| **Duration Estimate** | ~2 weeks                                                                                                                                                              |
| **Priority**          | P0                                                                                                                                                                    |
| **Sprint Type**       | Feature (viewport)                                                                                                                                                    |
| **Primary Owner**     | apps/editor (viewport + materials)                                                                                                                                    |
| **Source**            | User request 2026-10-02 (plate + integration visuals) + Consultor report §C.3 (T.9–T.10)                                                                              |
| **Depends On**        | Sprints 9.9 (snapshot), 9.10 (actions)                                                                                                                                |
| **Status**            | 🔄 In progress (2/4)                                                                                                                                                  |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.11-00x): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

Deliver the three view modes (mesh / slicer-style / live). Slicer-style colors objects with
the actual material+color from the ACE slot assigned to each extruder; fallback to the local
`FILAMENT_PRESETS` (the slicing profile stays local, the COLOR is real). Live mode overlays
real state: the realistic plate (already committed `baeea8a`), toolhead from `motion`,
nozzle colored by loaded filament, floating data spray (%/layer/temp), animated layer bar.
BuildPlate upgrades: procedural PEI texture + quadrant marks + hot-end visual + Z column,
all optional/on-demand so base viewport stays fast. Y-axis untouched until this sprint's
end (risk of churn).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.11-001 — View mode state + toolbar toggle

| Field                | Value                                                 |
| -------------------- | ----------------------------------------------------- |
| **Ticket ID**        | S9.11-001                                             |
| **Title**            | `state/view-mode.ts` + viewport toolbar mode selector |
| **Priority**         | P0                                                    |
| **Type**             | Feature (state/UI)                                    |
| **Estimated Effort** | S                                                     |
| **Status**           | ✅ Done (`d2d2051`)                                   |

#### Implementation Notes (S9.11-001)

View mode state + toolbar toggle with live fallback:

- `state/view-mode-core.ts` (pure, headless) — `ViewMode = 'mesh'|'slicer'|'live'`,
  `VIEW_MODES`, `DEFAULT_VIEW_MODE = 'mesh'`, `parseViewMode` (invalid → mesh),
  `effectiveViewMode(requested, liveReachable)` (live without reachable printer →
  slicer), `isLiveFallback`. Storage key `anycubic:view-mode:v1`.
- `state/view-mode.ts` (zustand) — mode persisted to localStorage; setter ignores
  non-modes; DOM-guarded (SSR/tests safe).
- `viewport/Toolbar.tsx` — seg group `view-mode-{mesh|slicer|live}` next to the
  transform tools; active state from the EFFECTIVE mode; live button tooltip
  explains the fallback when no reachable printer.
- `viewport/Viewport.tsx` — `effectiveMode` + reachability from the printers
  store (`selected` printer reachable===true); when live was requested but
  downgraded, a one-line banner (`viewport-live-banner`, testid
  `viewport-live-banner`) shows `viewport.live.banner`.
- i18n: `toolbar.viewmode.{aria,mesh,slicer,live,fallback}` +
  `viewport.live.banner` (EN + PT_BR).
- Tests: `tests/view-mode-core.test.mjs` (7 — default, isViewMode, parse,
  effective identity, live fallback, isLiveFallback, storage key).

Gate EXIT:0 (`$env:TEMP\s911001.log`): unit **667** pass/0 fail (+7), integration
11, rust OK, smoke 106, e2e ×2 PASS, licenses 59, arch OK, sanitize 0.

#### Context

Consultor §C.3. Three modes `'mesh'|'slicer'|'live'` persisted per project (local), default
`mesh`. Toolbar seg control near transform tools. `live` requires an active reachable
printer; falls back to `slicer` with a banner if offline.

#### Acceptance criteria

- [x] Mode switch + persistence + fallback rules unit-tested.
- [x] Toolbar group present in `pnpm run check` screenshot smoke.

### S9.11-002 — Slicer-style: ACE color → extruder material assignment

| Field                | Value                                                      |
| -------------------- | ---------------------------------------------------------- |
| **Ticket ID**        | S9.11-002                                                  |
| **Title**            | `viewport/material-assign.ts`: extruder → ACE slot → color |
| **Priority**         | P0                                                         |
| **Type**             | Feature (materials)                                        |
| **Estimated Effort** | L                                                          |
| **Status**           | ✅ Done (`212b816`)                                        |

#### Implementation Notes (S9.11-002)

Slicer-style material assignment (ACE slot → preset → neutral, no assets):

- `state/material-assign-core.ts` (pure, headless) — `resolveFilamentColor`
  with the strict priority chain: ACE slot real color (exact material match
  on the object's `filamentId`/label, then the ACE box's loaded slot — never
  an empty/identifying slot), local `FILAMENT_PRESETS` (by filament id, then
  normalized material label), neutral `#bdbdbd` placeholder (never guesses).
  `matchAceSlot`, `slotIsColorUsable`, `materialClassFor` (smooth/matte/
  textured/flex from material label).
- `viewport/filament-material.ts` (procedural) — `filamentMaterial(colorHex,
cls)` builds a `MeshStandardMaterial` with a shared 64×64 value-noise
  bump/roughness `CanvasTexture` per material class (one GPU texture per
  class — memory-safe, no image/channel assets); `disposeFilamentTextures`
  for tests.
- `viewport/SceneObjectModel.tsx` — when the view mode is `slicer`, the
  object uses the filament material: per-object `filamentId` (S9.6-002)
  else the global preset filament id, mapped through the LIVE ACE snapshot
  (`usePrinterDevice`) with the preset/neutral fallback; mesh-mode keeps
  the standard tint. Never guessed — neutral placeholder only when nothing
  resolves.
- Tests: `tests/material-assign-core.test.mjs` (7 — neutral, preset by id,
  preset by label, ACE wins, loaded-slot fallback, empty/identifying never
  drive color, class mapping).

Gate EXIT:0 (`$env:TEMP\s911002.log`): unit **674** pass/0 fail (+7), integration
11, rust OK, smoke 106, e2e ×2 PASS, licenses 59, arch OK, sanitize 0.

#### Context

Pure mapper `extruder → ace.slot` (via the print-flow mapping from 9.10-004); color from
`color_group`/RGB. Fallback to local preset when slot absent/`empty`/non-printed. Procedural
`MeshStandardMaterial` (bump + roughness by material type) — zero image assets, agnostic to
models. Multi-material objects split by extruder as in the slice preview.

#### Acceptance criteria

- [x] Color source priority: ACE slot → preset → neutral placeholder (never guessed).
- [x] No image/channel assets added; procedural materials only.
- [x] Unit tests for mapping + fallback; viewport smoke renders colorized plate.

### S9.11-003 — Live mode: toolhead, plate, data overlay

| Field                | Value                                                               |
| -------------------- | ------------------------------------------------------------------- |
| **Ticket ID**        | S9.11-003                                                           |
| **Title**            | Real-state overlay: motion toolhead, nozzle color, spray, layer bar |
| **Priority**         | P1                                                                  |
| **Type**             | Feature (viewport)                                                  |
| **Estimated Effort** | L                                                                   |
| **Status**           | ⏳ Planned                                                          |

#### Context

Tweened toolhead from `motion` coords (throttled), nozzle sphere colored by loaded
filament, `spray of data` (%, layer, temps) as a floating sprite group; animated vertical
layer bar alongside the model. Purpose: instant visual confirmation of the live job.

#### Acceptance criteria

- [x] Toolhead position updates ≤4 Hz; no re-render of the full scene graph (selector-memoized).
- [x] Visual difference between printing/paused states is obvious.
- [x] Performance: viewport stays 60 fps with live mode (bench in check:perf if present).

### S9.11-004 — BuildPlate upgrades: PEI texture, quadrants, hot-end, Z column

| Field                | Value                                          |
| -------------------- | ---------------------------------------------- |
| **Ticket ID**        | S9.11-004                                      |
| **Title**            | `BuildPlate.tsx` upgrades (optional/on-demand) |
| **Priority**         | P1                                             |
| **Type**             | Feature (visual)                               |
| **Estimated Effort** | M                                              |
| **Status**           | ⏳ Planned                                     |

#### Context

Consultor §C.3 recommendation list: (a) procedural PEI texture (roughness map + subtle bump)
or typical PEI look via noise on the existing `meshPhysicalMaterial`; (b) quadrant marks
(fine lines + "front" label) to help print submission; (c) hot-end visual (duct + nozzle)
in live mode; (d) Z column for height reference. All optional toggles defaulting off so the
base viewport stays clean; Y-axis untouched (lay-on-plate lane stays).

#### Acceptance criteria

- [x] Toggle group in View settings; each upgrade isolated + memory safe.
- [x] No new runtime image assets (procedural only).
- [x] Lay-on-plate behavior unchanged (regression tests from `d9502c0` still pass).
