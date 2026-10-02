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
| **Status**            | ⏳ Planned                                                                                                                                                            |

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
| **Status**           | ⏳ Planned                                            |

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
| **Status**           | ⏳ Planned                                                 |

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
