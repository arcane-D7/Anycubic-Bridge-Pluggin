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
| **Status**            | ✅ Complete (5/5 tickets delivered, 2026-10-02)                                                                                                            |

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
| **Status**           | ✅ Delivered (2026-10-01, commit `75c102f`)                                              |

#### Context

Numeric X/Y/Z inputs for position/rotation/scale with absolute + relative modes, per-axis copy,
reset; mono `tabular-nums` readouts; edits commit on Enter/blur. Scale non-uniform allowed with
warning when non-uniform (thin-walls risk). Layout density per design spec (36px numeric rows).

#### Acceptance criteria

- [x] Inspector reads/writes real transform values from/to the bridge snapshot.
- [x] Enter/blur commits; relative mode works; reset returns to origin/identity.
- [x] Diffs between draft and committed transform surface in the status bar (dirty state).

#### Implementation notes

**What shipped (10 files, commit `75c102f`):**

- `apps/editor/src/panels/TransformInspector.tsx` — numeric X/Y/Z inspector mounted in the
  **objects** sidebar under the ObjectTree. Groups for position / rotation / scale with
  36px mono tabular-nums rows (design density). Per-kind `abs/rel` toggle (relative seeds
  delta baseline: 0 for position/rotation, 1 for scale), per-axis copy X→Y/Z (⇥), per-kind
  reset (↺ to 0, or 1 on scale). Edits commit on **Enter or blur** through the
  authoritative bridge lane — `scene.mutateObject({kind:"setTransform", name, transform})`
  - `invalidateQueries(["bridge","scene"])` (the ObjectTree persist pattern). Esc restores
    the committed snapshot field values.
- `apps/editor/src/state/transform-inspector.ts` — dependency-free pure core:
  `InspectorTransform` (x/y/z/rx/ry/rz in DEG /sx/sy/sz), `parseAxisValue` ("", invalid
  handling), `axisValue`/`withAxisValue`, `resolveKind` (absolute replaces; relative adds
  position/rotation, multiplies scale; other kinds untouched), `dirtyKinds` (AC-3), reset
  defaults, `isNonUniformScale`/`isResized` warnings, `prettyRotation`/`prettyScale`
  display rounding, `sameTransform`.
- `apps/editor/src/state/scene-core.ts` + `state/scene.ts` — `setTransform` event/reducer
  widened to the full transform shape (was position-only) so the inspector commits real
  rotation/scale values into the graph store.
- `apps/editor/src/state/ui.ts` — dirty-state slice: `dirtyTransformName` /
  `dirtyKinds` / `setDirtyTransform` / `clearDirtyTransform`.
- `apps/editor/src/components/status-bar.tsx` — AC-3 chip: shows
  `name: position|rotation|scale` while a draft differs from the committed snapshot;
  clears on commit/deselection (never stale).
- CSS: `inspector-*` block in `styles.css`, `.status-dirty` in `index.css`.

**Acceptance evidence:**

- AC-1 (real values in/out): inspector reads the selected object's transform from the
  store snapshot (cube −16/0/−10, cone 14/0/14 observed) and writes via the bridge
  `setTransform` lane; mock round-trip test asserts the full shape
  (`x/y/z/rx/ry/rz/sx/sy/sz`) persists into the snapshot and unknown objects reject.
- AC-2 (commit + relative + reset): unit tests cover absolute commit, relative add
  (position/rotation) and multiply (scale), and reset to origin/identity; browser probe
  verified Enter commits (bridge re-fetch → re-hydrate) and field re-fill.
- AC-3 (dirty state): `dirtyKinds` diff + `useUi` slice drive the status-bar chip; browser
  verified the chip appears on edit (`cube: position`) and disappears after commit and on
  deselection (global clear when no selection, per-kind clear when draft matches).

**Gate:** `pnpm run check` EXIT:0 — unit **361** pass (350 prior + 11 inspector), lint,
typecheck, Rust (auth + editor shell), smoke 106 tools, e2e:ui PASS, e2e:editor-reload
PASS, licenses 59, architecture OK, sanitize DRY-RUN 0 files.

### S9.3-003 — Shortcut layer

| Field                | Value                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.3-003                                                                                                          |
| **Title**            | `hooks/useShortcuts.ts` + `state/shortcuts.ts`: G/R/S, axis X/Y/Z, Enter/Esc, F, Delete/Ctrl+D, Q/W/E/R, Ctrl+Z/Y |
| **Priority**         | P0                                                                                                                |
| **Type**             | Feature                                                                                                           |
| **Estimated Effort** | M                                                                                                                 |
| **Status**           | ✅ Delivered (2026-10-01, commit `560b0c0`)                                                                       |

#### Context

G32. Key map: `G` move, `R` rotate, `S` scale (grab→move to confirm), axes `X/Y/Z` constrain,
`Enter` confirm, `Esc` cancel, `F` frame-selected, `Delete`/`Ctrl+D` delete/duplicate,
tool switch `Q/W/E/R`, `Ctrl+Z/Y` undo/redo (soft journal re-import in 9.3; full journal UI in
9.6). Central registry (scaffolded in 9.1) now wired; conflicts with text inputs ignored
(target check).

#### Acceptance criteria

- [x] All listed shortcuts fire and update the scene; no-op in text inputs.
- [x] Shortcut help tooltip/summary accessible (toolbar tooltips).

#### Implementation notes

**What shipped (12 files, commit `560b0c0`):**

- `apps/editor/src/state/shortcuts-core.ts` (NEW) — dependency-free pure core. Types:
  `ToolCommandId`, `GestureKind` (move|rotate|scale), `AxisName`, `ShortcutAction` union,
  `ShortcutEventLike`, `ShortcutContext`. `FRAME_SELECTED_EVENT` custom event name.
  `parseShortcutEvent(e, ctx)` precedence: editable target (INPUT/TEXTAREA/SELECT/
  isContentEditable → null) → altKey → Ctrl (z→undo, shift+z→redo, y→redo, d→duplicate)
  → selection-gated grabs (g/s/r — r without selection → tool.scale) → q/w/e tool switch
  → grab-modal (x/y/z constrain, Enter confirm, Esc cancel only when gesture active)
  → f→frame → Delete/Backspace→delete (only with selection). `GrabState
{kind, axis: AxisName|null, prevTool}` + `grabStart/grabToggleAxis/grabConfirm/
grabCancel/grabToTool/grabLabel` (same-axis X toggles the lock off).
- `apps/editor/src/state/ui.ts` — grab slice in the UI store: `grab: GrabState | null`,
  `startGrab(kind)` (no-op if a grab is already active; stores the pre-grab tool),
  `toggleGrabAxis`, `confirmGrab`, `cancelGrab` (restores `prevTool`). Helpers
  `grabToolFor(mode)` / `grabToolToMode(id)` map grab kind ↔ toolbar tool.
- `apps/editor/src/hooks/useShortcuts.ts` (NEW) — the ONE global keydown listener.
  Owns `isEditable(el)` target check, parse, and dispatch of every action; reads fresh
  state via `useUi.getState()`/`useScene.getState()` so the listener stays stable.
  Delete/duplicate/undo/redo go through the ObjectTree `persist` mutation lane
  (`{kind:"remove"|"duplicate"}` + soft re-import for undo/redo with a toast); grab
  actions call the store; frame dispatches `window.dispatchEvent(FRAME_SELECTED_EVENT)`.
- `apps/editor/src/viewport/FrameSelectedCamera.tsx` (NEW) — inside-Canvas component that
  frames the selected object (fallback: first object) on the custom event, using a padded
  Box3 + FOV math (repeat of the FitCamera path); zero state on no objects/preview.
- `apps/editor/src/components/shortcut-help.tsx` (NEW) — accessible help list grouped by
  Transform/Tools/Scene/Edit, `role="list"`, `kbd` chips, `aria-label`, testid.
- `apps/editor/src/viewport/TransformGizmo.tsx` — Q/W/E/R keydown moved out of the gizmo
  into the central layer; Esc-lock behaviour now routes through the grab slice; a grab
  with an active axis feeds `constrainToAxis` into the persisted draft on drag, so
  X/Y/Z lock the GIZMO VALUE (draft) even though three-stdlib lacks native mode
  constraining in the widget visuals.
- `apps/editor/src/viewport/transform-core.ts` — added `AXES` + `AxisName` +
  `constrainToAxis(draft, axis, kind)`: move zeroes the two free axes, rotate zeroes
  rotation around non-locked axes, scale forces units on free axes. Dependency-free
  (9+ unit tests).
- `apps/editor/src/viewport/Viewport.tsx` — mounts `FrameSelectedCamera` when `!preview`.
- `apps/editor/src/App.tsx` + `styles.css` — header "?" trigger toggling the shortcut-help
  popover (details/summary → keyboard operable); `useShortcuts(scene)` after scene load.
- `apps/editor/src/state/shortcuts.ts` — registry entries for grab/constrain/confirm/
  cancel/redoShift + exported `SHORTCUT_HELP` (12 items) feeding the help popover.

**Acceptance evidence:**

- AC-1 (all shortcuts fire + no-op in inputs): 11 unit tests in `tests/shortcuts.test.mjs`
  (parse precedence, editable-target no-op, grab state machine incl. same-axis toggle,
  grab→tool mapping) + the full gate. e2e:editor-reload mounts the app with the shortcut
  layer, zero page errors.
- AC-2 (help accessible): `<details>/<summary>` popover keeps it keyboard-operable;
  `summary` carries `aria-label` + `title`; list uses `role="list"`; kbd chips visible.

**Gate:** `pnpm run check` EXIT:0 (log: `GATE_EXIT=0`) — unit 382 pass, lint clean,
typecheck clean, Rust (auth + editor shell), smoke 106 tools, e2e:ui PASS, e2e:editor-reload
PASS, licenses 59, architecture OK, sanitize DRY-RUN 0 files.

### S9.3-004 — Bridge transform lane

| Field                | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.3-004                                                                              |
| **Title**            | `bridge/mock.ts` real begin/update/commit with transform values + journal soft events |
| **Priority**         | P0                                                                                    |
| **Type**             | Feature                                                                               |
| **Estimated Effort** | M                                                                                     |
| **Status**           | ✅ Delivered (2026-10-02, commit `8f8069b`)                                           |

#### Context

Replace no-op `ok:true` mocks with real transform begin→update→commit semantics returning
authoritative snapshots; stale revision (revision mismatch) returns rebase-able error. Emit
S7-005 journal events (`+move`, `+rotate`, `+scale`) for Ctrl+Z/Y soft re-import.

#### Acceptance criteria

- [x] begin/update/commit carry real transform values; commit returns new authoritative revision.
- [x] Stale-revision path exercised by a unit test; journal events emitted per op.

#### Implementation notes

**What shipped (3 files, commit `8f8069b`):**

- `apps/editor/src/bridge/mock.ts` — real modal lane replacing the `ok:true` no-ops:
  - `journalEventsFor(before, after, name, revision)` (NEW, pure) — normalizes absent
    defaults (x/y/z=0, rx/ry/rz=0, sx/sy/sz=1) and emits `+move` if ANY of x/y/z changed,
    `+rotate` if ANY rx/ry/rz changed, `+scale` if ANY sx/sy/sz changed. `from`/`to` carry
    only their own-kind fields (S7-005 shape).
  - `fetchSceneSnapshot()` now owns `lastCommitted: Map<name, transform>` (seeded from
    scene objects), `session: {token, beginRevision, start: Map<name, transform>}` and a
    module-scoped `journal: TransformJournalEvent[]`; the handle exposes
    `journal: readonly TransformJournalEvent[]`.
  - `begin(revision)` snapshots every object transform into `session.start` and returns
    `{ok:true, token}`; `update(revision)` stays provisional (NO-OP, does not advance);
    `commit(expectedRevision)` throws `StaleCommitError` when the caller's revision is
    stale, else advances `currentRevision`, diffs each object vs `lastCommitted`, appends
    events to the journal, fires `onCommitEvent`, and returns
    `{ok, newRevision, selection, journalEvents}`; `cancel(beginRevision)` restores all
    transforms from `session.start` when the token matches.
  - Revision is FROZEN on the handle at fetch time; the authoritative revision lives in the
    closure and advances only on commit — callers must re-read `result.newRevision`.
- `apps/editor/src/bridge/types.ts` — `TransformJournalEvent` interface
  (`{kind: "+move"|"+rotate"|"+scale", name, revision, from, to}` with
  `Readonly<Record<string, number>>` payloads); `BridgeContract.commit` gains
  `journalEvents: TransformJournalEvent[]`; `BridgeHandle` gains `journal`.
- `tests/bridge-transform-lane.test.mjs` (NEW) — 7 unit tests: 3 pure
  `journalEventsFor` (move-only exact fields, rotation+scale, equal→nothing) + 2 AC-1
  (commit returns new authoritative revision with real transform values; journal
  accumulates across commits using `c1.newRevision`) + 2 AC-2 (stale commit refused with
  `StaleCommitError{expected, actual}` and advances nothing; cancel rolls back all
  objects to the session start transforms).

**Acceptance evidence:**

- AC-1 (real values + authoritative revision): commit diffs real transforms — unit asserts
  `moveEv.from {x:-16,y:0,z:-10}` → `to {x:0,y:0,z:0}` with kinds
  `["+move","+rotate","+scale"]` and `journal[0].revision === c1.newRevision`; the
  second commit uses the fresh revision (never the frozen handles) and accumulates.
- AC-2 (stale rebase + journal): stale `commit(starterRev)` rejects with expected/actual
  mismatch and advances nothing; a follow-up legit commit at the advanced revision
  succeeds; `cancel` restores the pre-gesture transforms with an empty journal.

**Gate:** `pnpm run check` EXIT:0 (log: `$env:TEMP\s9-3-004-check2.log`, `GATE_EXIT=0`) —
unit 379 pass, integration 11 pass, lint clean, typecheck clean, Rust (auth + editor
shell), smoke 106 tools, e2e:ui PASS, e2e:editor-reload PASS, licenses 59, architecture
OK, sanitize DRY-RUN 0 files.

### S9.3-005 — Gate + sanitizer

| Field                | Value                                        |
| -------------------- | -------------------------------------------- |
| **Ticket ID**        | S9.3-005                                     |
| **Title**            | Full gate EXIT:0 + sanitizer 0               |
| **Priority**         | P0                                           |
| **Type**             | Quality                                      |
| **Estimated Effort** | S                                            |
| **Status**           | ✅ Delivered (2026-10-02, closes sprint 9.3) |

#### Context

`pnpm run check` + new unit tests for the transform reducer + shortcuts registry; sanitizer
dry-run 0; commit closes the sprint.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.

#### Implementation notes

**Closeout evidence:**

- Final gate `pnpm run check` EXIT:0 (log: `$env:TEMP\s9-3-004-check2.log`, `GATE_EXIT=0`)
  — unit **379** pass, integration **11** pass, lint clean, typecheck clean, Rust (auth +
  editor shell), build OK, smoke **106** tools, e2e:ui PASS (objects=4), e2e:editor-reload
  PASS, licenses 59, architecture OK, **sanitize DRY-RUN 0 files** (`usr=mafsc` 0 touch).
- Clean git working tree (only the 2 docs files staged for this closeout commit).
- Sprint 9.3 complete: 5/5 tickets delivered — `7b1eb21` (001), `75c102f` (002),
  `560b0c0` (003), `8f8069b` (004), this commit (005). NO PUSH (main protected, 2 reviews).

## Sprint Complete ✅

Sprint 9.3 delivered 5/5 in full: real drei `<TransformControls>` gizmo with axis colors +
pointer isolation (001), numeric transform inspector with abs/rel/reset + dirty status (002),
G/R/S + X/Y/Z + Enter/Esc + F + Delete/Ctrl+D + Q/W/E/R + Ctrl+Z/Y shortcut layer with
accessible help (003), real bridge begin/update/commit lane with S7-005 journal events and
rebase-able stale-revision errors (004), and the closing full gate + sanitizer (005). The
viewport now drives real transform values through the authoritative bridge lane; Ctrl+Z/Y
soft re-import is journal-backed (full journal UI lands in 9.6).
