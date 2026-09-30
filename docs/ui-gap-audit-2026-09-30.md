# UI & Functionality Gap Audit — Anycubic Bridge Editor vs. Slicer/Modeling References

**Date:** 2026-09-30 · **Auditor:** GitHub Copilot (deep review, on-request) · **Status:** REVIEWED by Consultor (corrections incorporated — see §8 → §11)

> **Consultor review 2026-09-30:** audit validated as high-signal; three surgical corrections (G18 → P2, G31 → P1, NEW G41 model import → P0), six new gaps G41–G46, and a final 8-sprint roadmap (9.1–9.8). Full spec in `sprint-planning/` (9.1–9.8) + design system tokens in `docs/design-system-liquid-glass.md`.

## 1. Current Editor State (verified from source)

| Area                 | File(s)                                       | Current capability                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                | `apps/editor/src/App.tsx`                     | Header (brand, workspace tabs Prepare/Preview, Settings toggle, bridge state), left panel (sidebar-nav settings/objects/chat), resizable dividers, bottom timeline, R3F viewport. React 19 + zustand + TanStack Query. |
| Scene                | `state/scene.ts`                              | **Selection stub only**: `selected {name, watertight}` + `select`/`clear`. NO transform, NO visibility, NO delete, NO add. Read-only.                                                                                  |
| Object tree          | `panels/ObjectTree.tsx`                       | Lists objects with name + tri/vtx counts; click selects. No actions (rename/hide/delete/duplicate/move/etc).                                                                                                           |
| Viewport objects     | `viewport/SceneObjectModel.tsx`               | Each object = **unit box** scaled to bounds (`boxGeometry(1,1,1)` × scale)! Real triangle mesh NOT rendered. Click selects. Selection tint. Non-watertight tint.                                                       |
| Viewport interaction | `viewport/ModalInteraction.tsx`               | `.Gizmo` button + `.numeric-entry` input drive `runFlow(bridge, "gizmo"                                                                                                                                                | "numeric")`— a **conceptual modal flow** (begin→update→commit) BUT no 3D gizmo (no`TransformControls`), no real transform values, no geometric mutation. |
| Build plate          | `viewport/BuildPlate.tsx`                     | Profile-driven plate (250³), axes origin front-left, grid. Read-only.                                                                                                                                                  |
| Preview              | `viewport/LayerPreview.tsx` + `Viewport.tsx`  | Layer slider + Walls/Infill toggles (only when IR loaded). Preview is the ONLY real geometry rendering.                                                                                                                |
| Settings             | `panels/SettingsPanel.tsx`                    | Printer/Filament/Process tabs with numeric fields + export to `settings-draft.json`. Process tab functional; Supports/Brim checkboxes **disabled** ("Not connected to the editor pipeline yet").                       |
| Chat                 | `state/chat-core.ts` + `panels/ChatPanel.tsx` | Context sources + token budget + approval cards + model picker (S9-006). Prompt-injection gating.                                                                                                                      |
| Timeline             | `panels/Timeline.tsx`                         | Slicing mode selector (Standard/Non-planar) + eligibility hints. No real timeline/undo graph yet.                                                                                                                      |
| Bridge               | `bridge/mock.ts`                              | Read-only mock: ONE sample object `print-bed-block`; `begin/update/commit/cancel` contract simulates in-process. No mutation lanes.                                                                                    |

## 2. GAPS v1 — Object Control (the user's top concern: "não consigo controlar nenhum objeto na UI")

> The viewport renders **unit boxes** (not real meshes), and the only object action is _select_.

| #   | Gap                                                                      | Reference behavior                                           | Priority |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------ | -------- |
| G1  | Real mesh rendering (objects show as boxes; no wireframe/edges/vertices) | All slicers + Blender show real geometry                     | P0       |
| G2  | **Transform controls (move/rotate/scale gizmo) in the 3D viewport**      | Blender widget, Orca/Bambu plate tools, Anycubic slicer      | P0       |
| G3  | Numeric transform panel/inspector (position/rotation/scale X/Y/Z inputs) | Orca/Bambu/Anycubic scene object properties; Blender N-panel | P0       |
| G4  | Object actions: duplicate, delete, rename, hide/show, lock               | Blender outliner, all slicers                                | P0       |
| G5  | Scene graph: objects list as tree with hierarchy (groups/children)       | Blender outliner; Bambu/Orca object panels                   | P1       |
| G6  | Multi-select + selection box/rubber-band                                 | Blender, common DCC                                          | P1       |
| G7  | Snap to plate / auto-place / center                                      | Bambu auto-arrange, Orca auto-arrange, Anycubic              | P0       |
| G8  | Scale/rotate numeric entry per object                                    | Bambu/Orca; Anycubic                                         | P0       |
| G9  | Object origin/transform reference (local vs world)                       | Blender                                                      | P2       |
| G10 | Bounding/selection outline visible on selected (non-box)                 | All DCC                                                      | P1       |
| G11 | Plate/origin gizmo (move plate, plate split/cut, duplicate plate)        | Bambu/Orca multi-plate                                       | P2       |

## 3. GAPS v2 — Slicer-standard features (vs Bambu Studio / Orca Slicer / Anycubic Slicer Next)

| #   | Feature                                                                                                | Reference                                                           | Current                               | Priority         |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------- | ---------------- |
| G12 | **Plate management** (multiple plates, view toggle, plate move/split, copy plate)                      | Bambu plate tabs; Orca plate toolbar                                | ONE plate only, static                | P0               |
| G13 | **Auto-arrange** (place objects on build plate)                                                        | Bambu/Orca "Auto arrange"; our `cad-arrange.mjs` EXISTS server-side | UI missing                            | P0               |
| G14 | **Object placement info** (per-object position on plate + footprint)                                   | Bambu/Orca object list columns                                      | Missing                               | P1               |
| G15 | **Toolbar** (mode: select/move/rotate/scale, view presets: top/front/right/iso, zoom-fit, grid toggle) | All slicers                                                         | Only OrbitControls                    | P0               |
| G16 | **View cube / camera presets** (top/iso/front)                                                         | Bambu/Orca                                                          | Missing                               | P1               |
| G17 | **Cut tool** (splitting models, multi-part cut)                                                        | Bambu cut; Orca cut                                                 | Missing                               | P2               |
| G18 | **Support painting / support generation UI** (auto/normal/tree/touching buildplate)                    | Bambu/Orca/Anycubic                                                 | Settings only (disabled)              | P2 (post-engine) |
| G19 | **Flush/color painting** for multi-material                                                            | Bambu/Orca                                                          | Our `slicer_multimaterial` CLI exists | P2               |
| G20 | **Per-object print settings / filament assignment** (overrides per object)                             | Bambu/Orca                                                          | Missing (S8-005 partially)            | P1               |
| G21 | **Printer presets dropdown** (machine list, nozzle, temps, flow)                                       | All slicers                                                         | Only `kobra-s1` hardcoded in catalog  | P1               |
| G22 | **Filament presets + color swatches UI**                                                               | All slicers                                                         | Only numeric filament inputs          | P1               |
| G23 | **Print quality presets dropdown** (0.08/0.2/0.28, custom)                                             | All slicers                                                         | Missing (P: catalog has presets)      | P1               |
| G24 | **Slicing progress/estimated time/material stats in UI**                                               | All slicers (after slice)                                           | Missing                               | P1               |
| G25 | **Slice/Print button flow** (slice → preview → send to printer)                                        | All slicers                                                         | No slice action wired to printer      | P0               |

## 4. GAPS v3 — Blender-style modeling functions (DCC parity)

| #   | Feature                                                      | Reference                                         | Priority |
| --- | ------------------------------------------------------------ | ------------------------------------------------- | -------- |
| G26 | **Boolean add** (subtract/union/intersect on objects)        | Our `cad-bool-tool.mjs` / `cad_v2_boolean` EXISTS | P1       |
| G27 | Mesh selection modes (vert/edge/face) in the editor viewport | Blender edit mode                                 | P2       |
| G28 | Basic mesh ops exposed as tools (extrude/inset/bevel)        | Blender (bpy via our bridge)                      | P2       |
| G29 | Material / color assignment per object face                  | Blender                                           | P2       |
| G30 | Undo/redo via the S7-005 journal surfaced in UI              | Our `journal` crate exists                        | P1       |
| G31 | Snapping (grid/vertex/axis)                                  | Blender                                           | P1       |

## 5. GAPS v4 — Interaction/UX polish

| #   | Feature                                                                       | Priority          |
| --- | ----------------------------------------------------------------------------- | ----------------- |
| G32 | Keyboard shortcuts (G/R/S move/rotate/scale; Delete; Ctrl+D duplicate; F fit) | P0                |
| G33 | Grid + snapping UI                                                            | P2                |
| G34 | Selection color/gizmo styling + hover states                                  | P1                |
| G35 | Context menu on objects (right-click: duplicate/delete/hide)                  | P0                |
| G36 | Status bar (object count, units, coordinates, snapshot/revision)              | P1                |
| G37 | Toast/notification system (errors, actions, approvals)                        | P1                |
| G38 | I18n (PT/EN at least)                                                         | P2                |
| G39 | Theming: light/dark (currently only a light slicer theme)                     | P0 (user request) |
| G40 | Liquid-glass / Apple-inspired design system refresh                           | P0 (user request) |

## 6. Existing server-side capabilities that need UI wiring

- `cad_v2_boolean` (CSG boolean) — no UI.
- `cad_generate_parametric` / `cad_generate_from_prompt` (AI CAD) — no UI beyond chat.
- `slicer_multimaterial` (multi-material slices; marble) — CLI/chat only.
- `cad-arrange.mjs` (auto-arrange) — no UI.
- S7-002 framed modal contract + S7-005 undo journal — conceptual only (Gizmo button invokes flow with mock, no real geometry).
- S8 slice pipeline (planar-core, IR, postprocessor, preview) — the ONLY end-to-end rendered piece (IR JSON import only).

## 7. Screenshots (current UI)

Captured 2026-09-30 from http://127.0.0.1:1420/ (dev server):

1. **Main shell** — header + settings panel (Process tab) + viewport + timeline.
2. **Objects view** — object tree (single unit-box object) + viewport.
3. **Chat view** — ChatPanel with proposal/approval input.

> Visible issues on live page: 500 error on reload (`history`/`ChatPanel` HMR), THREE.Clock deprecation warning.
> The viewport renders the object as a **unit box** (blue box) — real geometry missing.

## 8. Consultor Review — Priority Corrections (2026-09-30)

The audit was cross-checked against the actual source. Three surgical corrections:

| Gap                  | Was         | Should be            | Why                                                                                                                                                                                                                                                      |
| -------------------- | ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G18 Support painting | P0          | **P2** (post-engine) | Fronts heavy work (paint texture map, face selection) before the planar core is solid.                                                                                                                                                                   |
| G31 Snapping         | P2          | **P1**               | Snap-to-grid/vertex is table stakes for object control — G7/G8 depend on it.                                                                                                                                                                             |
| **G41 Model import** | — (missing) | **P0**               | **The audit's biggest blind spot.** The app has a single sample object with NO geometry. Real mesh rendering (G1), object control, arrangement and slicing are all untestable until meshes enter the scene. Import is the enabler of the entire roadmap. |

## 9. New Gaps G41–G46 (added by Consultor)

| #       | Gap                                                                                                  | Ref                  | Priority | Rationale                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| **G41** | **Model import** (file picker + drag-drop STL/3MF/STEP, import dialog with scale/center/auto-orient) | All slicers          | **P0**   | Enabler of the whole roadmap — no geometry, no object control.                                         |
| G42     | Measurement tool (distance/radius/angle readout, measure mode)                                       | Bambu, Orca, Blender | P1       | Standard CAD-printer expectation; cheap once snapping exists (9.7).                                    |
| G43     | Printer/device picker + connection state (for G25's "send to printer")                               | All slicers          | **P0**   | G25 is incomplete without a device target. Discovery reads `ANYCUBIC_PRINTER_IPS` env — no hardcoding. |
| G44     | Dirty-state / save indicator (unsaved ops, revision delta)                                           | All slicers          | P1       | Users must know plate state vs. last commit; pairs with G30.                                           |
| G45     | Object name labels in viewport (hover + toggleable always-on)                                        | Bambu                | P1       | Orientation in dense plates; cheap HUD chip.                                                           |
| G46     | Non-watertight repair UX (actionable "auto-repair", not just red tint)                               | Bambu                | P1       | Red tint without an action is a dead end; manifold-3d already a dependency.                            |

## 10. Final prioritized roadmap (Sprints 9.1 → 9.8)

Eight intermediate sprints deliver the **complete local system before Sprint 10 (auth/db)**:

| Sprint  | Title                                             | Gap coverage                                          | One-line goal                                                                                  |
| ------- | ------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **9.1** | Design System Foundation + Shell Refresh          | G39, G40                                              | Tokens, light/dark themes, glass shell, toast + shortcut scaffolding.                          |
| **9.2** | Real Geometry, Import & Scene Graph               | G1, G4, G5, G6(θ), G10, G41, G34(θ), +Clock/HMR fixes | Real meshes; add/remove/rename/duplicate/hide/lock from a real object tree.                    |
| **9.3** | Transform Controls, Numeric Inspector & Shortcuts | G2, G3, G8, G32, G30(θ)                               | Move/rotate/scale real gizmo, exact numeric entry, G/R/S keyboard flow — committed via S7-004. |
| **9.4** | Plate, Auto-Arrange, Toolbar & View Presets       | G7, G12(θ), G13, G15, G16, G36(θ)                     | Plate tabs + toolbar + view cube + arrange wired to `cad-arrange.mjs`.                         |
| **9.5** | Slice / Preview / Print Flow                      | G24, G25, G43                                         | Real slice button → progress → stats → preview → printer picker → send job.                    |
| **9.6** | Presets, Object Properties & Undo Surface         | G14, G20, G21, G22, G23, G30, G36                     | Printer/filament/quality presets, per-object overrides, journal-backed undo/redo UI.           |
| **9.7** | Boolean Modeling, Snapping & Repair               | G26, G31, G33, G46                                    | CSG boolean UI (server tool exists), grid/vertex snap, one-click watertight repair.            |
| **9.8** | Interaction Polish, Labels, Measure, i18n         | G34, G35, G37, G38, G42, G44, G45, G46(θ)             | Context menus everywhere, measure tool, labels, PT/EN, perf pass, licensing gate green.        |

**Permanent out-of-scope for 9.x:** support/color painting (G18/G19, post-engine), mesh edit modes vert/edge/face (G27–G29), cut tool (G17), plate split (G11), object origins (G9), multi-material flush UI, all of Sprint 10 (auth/db/cloud), WebGPU/R3F v10, any non-APACHE/MIT dependency.

## 11. Sources

- Consultor report 2026-09-30 (validates G1–G40, adds G41–G46, roadmap 9.1–9.8, full design-system spec → `docs/design-system-liquid-glass.md`)
- R3F 9.8.0 "compatible with React 19.3.0" (PR #3916); drei 10.7.9 ships `TransformControls`; three 0.186.0; zustand 5.0.15 — confirmed stack, no upgrade needed.
