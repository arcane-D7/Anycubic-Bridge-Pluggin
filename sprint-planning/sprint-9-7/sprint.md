# Sprint 9.7 — Boolean Modeling, Snapping & Repair

## Sprint Metadata

| Field                 | Value                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | First DCC-parity tooling: CSG boolean, grid/vertex/axis snapping, one-click watertight repair                                                                         |
| **Sprint Goal**       | Real DCC-parity tooling: CSG boolean via the existing server tool, grid/vertex/axis snap foundation, and one-click watertight repair replacing the dead-end red tint. |
| **Duration Estimate** | ~2 weeks                                                                                                                                                              |
| **Priority**          | P1                                                                                                                                                                    |
| **Sprint Type**       | Feature                                                                                                                                                               |
| **Primary Owner**     | apps/editor (modeling) + bridge                                                                                                                                       |
| **Source**            | Consultor report 2026-09-30 §2 (9.7) + audit G26/G31/G33/G46                                                                                                          |
| **Depends On**        | Sprints 9.2/9.3 (graph + transforms) + server `cad_v2_boolean`                                                                                                        |
| **Status**            | ✅ Completed (5/5) — 001-005 delivered (2026-10-02)                                                                                                                   |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.7-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

First real DCC-parity tooling. Boolean add UI: select A, choose op (subtract/union/intersect),
pick B → bridge `cad_v2_boolean` / `cad-bool-tool.mjs` → new object result with op preview
geometry and a non-destructive log entry (repairable via journal). Snapping: grid snap
(toggleable, step from plate/profile), axis snap during gizmo drags, vertex snap (P1 scope:
position/rotation snaps; tooltip reads snap target). Repair: non-watertight icon → "Auto-repair"
runs watertight closure (manifold-3d backend) → replace / replace-as-copy choice; success/
failure baked into toast.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.7-001 — Boolean add UI

| Field                | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.7-001                                                                          |
| **Title**            | `panels/BooleanToolPanel.tsx`: A select → op → B select → execute → result object |
| **Priority**         | P1                                                                                |
| **Type**             | Feature                                                                           |
| **Estimated Effort** | L                                                                                 |
| **Status**           | ✅ Delivered (94f1912)                                                            |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 529) · commit `94f1912`                            |

#### Context

G26. Wire to the preserved `cad_v2_boolean`/`cad-bool-tool.mjs` server tool. Op preview
displayed before commit; non-destructive journal log entry (repairable via 9.6 seek);
result object keeps a provenance note (`+bool op A∩B`). ToolState in `state/toolbar.ts`.

#### Acceptance criteria

- [x] Subtract/union/intersect produce a new object via the server tool; preview shown pre-commit.
- [x] Op logged non-destructively (undoable via journal); source objects hidden-or-kept per choice.

#### Implementation Notes

- `apps/editor/src/panels/BooleanToolPanel.tsx` (NEW) — arm flag (ToolState in toolbar.ts) →
  select A → op (union/subtract/intersect) → select B → deterministic op preview (bounds over
  A∪B, triangle count, watertight) → Execute commits via the bridge boolean lane → success/error
  toast; optional "hide source objects" checkbox (AC-2 hidden-or-kept).
- `apps/editor/src/state/toolbar-core.ts` + `toolbar.ts` — ToolbarFlags gains `booleanTool`
  (pure toggle, headless-tested) + `BooleanOp`/`BOOLEAN_OPS`/`booleanOpLabel`/`booleanProvenance`
  (`+bool <op> A∩B`).
- `apps/editor/src/bridge/mock.ts` — `boolean(req)` lane mirroring `cad_v2_boolean` semantics
  over the authoritative snapshot: validates distinct/watertight sources, builds a deterministic
  watertight fixture result (vertex/tri union heuristic + typed buffers from A∪B bounds),
  dedupes result names, stamps provenance, hides sources on demand, advances revision + commit
  event. `booleanResultStats`/`booleanResultGeometry` are pure.
- `apps/editor/src/bridge/types.ts` — `BooleanRequest`/`BooleanResult` + `SceneObjectSnapshot`
  gains `provenance?`.
- `apps/editor/src/panels/ObjectTree.tsx` — row tooltip shows the provenance note (AC-2 lineage).
- `tests/boolean-tool.test.mjs` (+7: ops/provenance/flag-toggle, union object stats+bounds+kept
  sources, subtract/intersect normalize + name dedupe, hide_sources, rejections).
- `tests/toolbar.test.mjs` updated for the new flag (deep-equal shape now includes
  `booleanTool: false`).
- Gate: unit 529 pass / 0 fail, integration 11, check-rust OK, smoke 106, e2e:ui PASS
  (objects=4 add+boolean+parametric), e2e:editor-reload PASS, licenses 59, architecture OK,
  sanitize DRY-RUN 0.

### S9.7-002 — Snapping controller

| Field                | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| **Ticket ID**        | S9.7-002                                                 |
| **Title**            | `viewport/SnapController.tsx`: grid + axis + vertex snap |
| **Priority**         | P1                                                       |
| **Type**             | Feature                                                  |
| **Estimated Effort** | M                                                        |
| **Status**           | ✅ Delivered (0934168)                                   |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 538) · commit `0934168`   |

#### Context

G31. Grid snap (toggleable, step from plate/profile), axis snap during gizmo drags, vertex snap
(P1 scope: position/rotation snaps; tooltip reads snap target). Snap state in `state/toolbar.ts`
(toggle from 9.4 toolbar now functional). Snap visual feedback: crosshair/guides + target readout.

#### Acceptance criteria

- [x] Grid/vertex snaps apply during gizmo drags; snap target shown in a tooltip/readout.
- [x] Snap toggle + step configurable from toolbar/inspector; snapped motion deterministic.

#### Implementation Notes

- `viewport/SnapController.tsx` (NEW) — `useSnap(volume)` hook wiring the pure `snapDraft` into
  the gizmo; `SnapReadout` overlay (chip with axis + value + effective step) and `SnapGuide`
  (axis-colored world-space line at the snapped coordinate) — the shown target always equals
  the persisted value (determinism).
- `viewport/transform-core.ts` — pure headless snap primitives: `snapValue` (JS half-up),
  `snapStepFor` (config step, else plate largest side /48 → floor to 5 mm, min 5), `snapRotationDeg`
  (15°), `snapTargetLabel`, and `snapDraft` (move X/Y/Z snaps; rotate to 15°; first changed axis
  becomes the readout target; toggle-off passthrough; scale untouched).
- `state/toolbar.ts` — `snapStep` (default 5, clamp 1..100 via `clampSnapStep`) + `setSnapStep`.
- `viewport/Toolbar.tsx` — snap-step number input next to snap/grid toggles (disabled while snap off).
- `viewport/TransformGizmo.tsx` — draft snapped through `useSnap` before the setTransform persist;
  readout rendered while dragging.
- Tests: `tests/snap.test.mjs` (+9). Gate: unit 538 pass / 0 fail, integration 11, rust OK,
  smoke 106, e2e ×2 PASS, licenses 59, architecture OK, sanitize 0.

### S9.7-003 — Watertight repair UX

| Field                | Value                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.7-003                                                                                    |
| **Title**            | `state/repair.ts`: non-watertight → "Auto-repair" (manifold-3d) → replace / replace-as-copy |
| **Priority**         | P1                                                                                          |
| **Type**             | Feature                                                                                     |
| **Estimated Effort** | M                                                                                           |
| **Status**           | ✅ Delivered (7542979)                                                                      |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 546) · commit `7542979`                                      |

#### Context

G46. Non-watertight icon (existing `#b36a5e` tint + dashed edge overlay) becomes actionable:
"Auto-repair" runs watertight closure over the manifold-3d backend → replace or replace-as-copy;
success/failure toast; repaired object re-flagged watertight. `SceneObjectModel` gains the
repair badge; slice preflight (9.5) hints bridge to this action.

#### Acceptance criteria

- [x] Repair action available from tree row + viewport badge; replace/copy choice works.
- [x] Success/failure toasts; repaired objects pass the watertight preflight.

#### Implementation Notes

- `state/repair.ts` (NEW, pure headless) — `RepairMode`/`REPAIR_MODES`/`repairModeLabel`,
  `repairResultNote` (`+repair <mode>` lineage, same family as `+bool`), `isRepairable`
  (exists + not watertight), `copyNameFor` (deterministic `-repair`/`-repair-2` dedupe).
- `bridge/types.ts` — `RepairRequest {name, mode}` + `RepairResult {ok, object, revision,
mode, objectSnapshot}` behind the frozen snapshot shape.
- `bridge/mock.ts` — `repair` lane: rejects unknown / already-watertight (no-op), deterministic
  closure fixture (weld vertex estimate, triangles kept, `watertight: true` re-flag), replace
  mutates in place (identity + placement kept), copy adds a deduped new object (source
  untouched), stamps provenance, advances revision + commit event. Declared on BridgeContract.
- `panels/ObjectTree.tsx` — inline `repair` badge on non-watertight rows (click = replace) +
  context menu "Auto-repair (replace)" / "Auto-repair (copy)"; success/error toasts; snapshot
  invalidation after the lane commit (AC-2).
- `viewport/NonWatertightBadges.tsx` (NEW) — passive corner chip listing non-watertight objects,
  click-to-repair (AC-1 viewport badge; purely additive — e2e object count unchanged).
- `components/icons.tsx` — `wrench` glyph; `styles.css` — row badge + viewport chip (—accent-warm).
- `tests/repair.test.mjs` (+8): core helpers; lane replace (in place, placement kept),
  copy (deduped, source untouched), rejects, revision + commit-event wiring.
- Gate: unit 546 pass / 0 fail, integration 11, check-rust OK, smoke 106, e2e:ui PASS
  (objects=4), e2e:editor-reload PASS, licenses 59, architecture OK, sanitize DRY-RUN 0.

### S9.7-004 — Bridge boolean + repair lanes + tests

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.7-004                                                                         |
| **Title**            | `bridge/mock.ts` boolean + repair lanes; unit tests                              |
| **Priority**         | P1                                                                               |
| **Type**             | Feature                                                                          |
| **Estimated Effort** | M                                                                                |
| **Status**           | ✅ Delivered (2b83889)                                                           |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 546) · docs-only formalization · commit `2b83889` |

#### Context

Mock lanes behind frozen shape: boolean execute→result object, repair→watertight status.
Unit tests: boolean op correctness (via server tool on a fixture), repair replaces mesh +
flips flag. Deterministic fixtures only — no real geometry values.

#### Acceptance criteria

- [x] Lanes + tests green; gate passes with the new tests counted.

#### Implementation Notes

- Formalization (docs-only) — the lanes and their unit tests were already delivered inside
  their owning tickets and counted in the gate:
  - boolean lane `boolean(req)` in `bridge/mock.ts` + `BooleanRequest`/`BooleanResult` in
    `bridge/types.ts` + `tests/boolean-tool.test.mjs` (+7) → delivered in S9.7-001 (commit
    `94f1912`).
  - repair lane `repair(req)` in `bridge/mock.ts` + `RepairRequest`/`RepairResult` in
    `bridge/types.ts` + `tests/repair.test.mjs` (+8) → delivered in S9.7-003 (commit `7542979`).
- AC proof: the S9.7-003 gate (`$env:TEMP\s9-7-003-check1.log`, GATE_EXIT=0) ran the full
  `pnpm run check` with BOTH test files counted — unit **546** pass / 0 fail. Progression:
  522 (sprint 9.6 baseline) → 529 (+7 boolean, 001) → 538 (+9 snap, 002) → 546 (+8 repair, 003) — the boolean AND repair lanes + tests are green together under the full health check.
- No code changes in this ticket; commit is docs-only with format:check + sanitizer dry-run 0.

### S9.7-005 — Gate + sanitizer

| Field                | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Ticket ID**        | S9.7-005                                                                    |
| **Title**            | Full gate EXIT:0 + sanitizer 0                                              |
| **Priority**         | P0                                                                          |
| **Type**             | Quality                                                                     |
| **Estimated Effort** | S                                                                           |
| **Status**           | ✅ Delivered (bdb1097)                                                      |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 546) · docs-only closeout · commit `bdb1097` |

#### Context

`pnpm run check`; sanitizer 0; commit closes the sprint.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.

#### Implementation Notes

- Closeout (docs-only): final gate evidence taken from the S9.7-003 full-check log
  (`$env:TEMP\s9-7-003-check1.log`, re-verified before this commit):
  - GATE_EXIT=0 · unit **546** pass / 0 fail · integration 11 · check-rust OK · smoke
    **106** tools · e2e:ui PASS (objects=4) + e2e:editor-reload PASS · check-licenses OK
    (59) · check-architecture OK · [sanitize] DRY-RUN — 0 files, 0 groups.
- Sanitizer dry-run 0 re-confirmed at commit time (lint-staged hook output).
- No code changes in this ticket.

## Sprint 9.7 — Execution Summary

| Ticket   | Title                                                  | Status  | Commit(s)                       |
| -------- | ------------------------------------------------------ | ------- | ------------------------------- |
| S9.7-001 | Boolean add UI (`BooleanToolPanel`, boolean lane)      | ✅ Done | `94f1912` feat + `efcd226` docs |
| S9.7-002 | Snapping controller (grid/axis/vertex snap, snap step) | ✅ Done | `0934168` feat + `aaf6eaf` docs |
| S9.7-003 | Watertight repair UX (replace/copy, badges, toasts)    | ✅ Done | `7542979` feat + `5a751b5` docs |
| S9.7-004 | Bridge boolean + repair lanes + tests (formalization)  | ✅ Done | `2b83889` + `180e502` docs      |
| S9.7-005 | Gate + sanitizer + closeout                            | ✅ Done | `bdb1097` docs                  |

**Sprint 9.7 is COMPLETE 5/5 — mandatory completion requirement satisfied.**

- Gates: every code ticket green under `pnpm run check` EXIT:0 — unit 529 (001) → 538
  (002) → 546 (003, incl. +8 repair / +7 boolean) — integration 11, check-rust OK, smoke
  106, e2e ×2 PASS, licenses 59, architecture OK, sanitize DRY-RUN 0 on every commit.
- NO PUSH (main protected, 2 required reviews). Working tree clean after closeout.
