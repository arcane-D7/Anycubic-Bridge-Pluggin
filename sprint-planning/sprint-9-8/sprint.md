# Sprint 9.8 — Interaction Polish, Labels, Measure, i18n

## Sprint Metadata

| Field                 | Value                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Closeout: context menus, labels, measure tool, dirty state, PT/EN, perf pass                                         |
| **Sprint Goal**       | Close the remaining local polish gaps; verify the licensing gate; hand a complete, stable local system to Sprint 10. |
| **Duration Estimate** | ~2 weeks                                                                                                             |
| **Priority**          | P1                                                                                                                   |
| **Sprint Type**       | Polish + Quality                                                                                                     |
| **Primary Owner**     | apps/editor (polish)                                                                                                 |
| **Source**            | Consultor report 2026-09-30 §2 (9.8) + audit G34/G35/G37/G38/G42/G44/G45/G46                                         |
| **Depends On**        | Sprints 9.1–9.7 (everything)                                                                                         |
| **Status**            | ✅ Complete (7/7) — 001–006 delivered, 007 final gate (2026-10-02)                                                   |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.8-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

Close out the local system. Context menus everywhere (tree, viewport, plate tabs, timeline —
G35). Viewport object labels (hover, toggleable always-on — G45). Measure tool (distance/
radius/angle probe without gizmo, mono readout bottom-left, cleared on mode exit — G42).
Dirty-state indicator in header (unsaved ops count, last-commit time) with save/restore to a
gitignored local file (G44). i18n PT/EN string table with no hardcoded UI strings left
(`state/i18n.ts` — G38). Perf pass: memoized scene graph, dpr cap, Clock audit, gl context-loss
guard. Final `pnpm run check` fully green including `check:licenses` + `check:architecture`;
hand the complete local system to Sprint 10 (auth/db).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.8-001 — Context menus everywhere

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.8-001                                                           |
| **Title**            | `components/ContextMenu.tsx`: tree, viewport, plate tabs, timeline |
| **Priority**         | P1                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | M                                                                  |
| **Status**           | ✅ Delivered @ `eea837a` (2026-10-02)                              |

#### Context

G35 completion. One reusable glass context menu (fill-3/blur-3, 1px hairline, keyboard
navigation, Esc closes, focus trap). Wired to object tree rows (duplicate/rename/hide/delete,
place-on-plate), viewport (background context: arrange/measure/import), plate tabs (rename/add/
duplicate/delete), timeline (seek/journal actions).

#### Acceptance criteria

- [x] All four surfaces open the same menu component with correct items; keyboard operable.

#### Implementation notes

- New files: `components/context-menu-core.ts` (pure headless: types, clamp, item builders),
  `components/context-menu-items.ts` (object/plate/journal builders), `components/ContextMenu.tsx`
  (portal + backdrop + keyboard nav), `state/context-menu.ts` (zustand store), `tests/context-menu.test.mjs` (9).
- Four surfaces wired: ObjectTree rows + "…" button, Viewport background (arrange/measure/import),
  PlateTabs chips, Timeline journal chips. Object meshes stop propagation (no scene menu over geometry).
- Gate 2026-10-02: prettier/lint/typecheck OK, unit 555 pass, integration 11, smoke 106,
  e2e:ui PASS (objects=4), e2e:editor-reload PASS, licenses 59, architecture OK, sanitize DRY-RUN 0.

### S9.8-002 — Viewport object labels

| Field                | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-002                                                             |
| **Title**            | `viewport/Labels.tsx`: hover + always-on label chips (name + status) |
| **Priority**         | P1                                                                   |
| **Type**             | Feature                                                              |
| **Estimated Effort** | M                                                                    |
| **Status**           | ✅ Delivered @ `c6f7e3e` (2026-10-02)                                |

#### Context

G45. HUD chips float above objects: name + status (watertight/non-watertight/locked). Toggle
always-on from toolbar; sizes mono secondary, contrast per spec. Implementation via
drei `Html` or manual projection to keep canvas clean.

#### Acceptance criteria

- [x] Chips on hover (or always-on per toggle); follow objects during transform; theme-correct.

#### Implementation notes

- Two thin pieces, zero canvas re-renders for labels: `LabelProjector` (in-canvas) projects
  each object's bounds top-center to NDC each frame from the LIVE group `matrixWorld`
  (anchor probe registered by SceneObjectModel) into a mutable bus (`state/labels.ts`);
  `ObjectLabels` (out-of-canvas sibling, like ViewCube) subscribes to the frame counter,
  converts NDC→CSS (`ndcToViewport`, y-flip), clamps (`clampChip`) and renders glass chips.
- Pure core `viewport/labels-core.ts` (`statusOf`/`chipLabel`/`ndcToViewport`/`clampChip`);
  6 headless tests `tests/labels.test.mjs`. Toolbar toggle `toggle-labels` (eye icon) sets
  `ui.objectLabelsAlwaysOn`. Chips follow gizmo drags (read live matrices).
- Gate 2026-10-02: unit 561 pass, integration 11, smoke 106, e2e:ui PASS, e2e:editor-reload
  PASS, licenses 59, architecture OK, sanitize DRY-RUN 0.

### S9.8-003 — Measure tool

| Field                | Value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-003                                                              |
| **Title**            | `viewport/MeasureTool.tsx`: distance/radius/angle probe, mono readout |
| **Priority**         | P1                                                                    |
| **Type**             | Feature                                                               |
| **Estimated Effort** | M                                                                     |
| **Status**           | ✅ Delivered @ `f7d2aad` (2026-10-02)                                 |

#### Context

G42. Measure mode (toolbar toggle): gizmo-less probe on click (vertex/edge/face snapping from
9.7). Distance between two points, radius of circular edge, angle between edges — readout
bottom-left in mono, cleared on mode exit. Works on imported meshes (raycast against real
geometry).

#### Acceptance criteria

- [x] Distance/radius/angle measurements correct on real geometry; readout mono; cleared on exit.

#### Implementation notes

- `measure-core.ts` pure headless (distance3 / circumRadius degenerate-safe / angleDeg / pushProbe
  residual reducer / formatMeasure); `state/measure.ts` zustand bus; `MeasureTool.tsx` in-canvas
  (THREE.Raycaster against real S9.2 meshes via `scene.getObjectByName(name).traverse`);
  `MeasureReadout.tsx` out-of-canvas mono bottom-left + Dist/R/∠ switcher + clear.
- Toolbar toggle (icon `measure`), M key via `shortcuts-core`, ToolMode `measure` (ui.ts),
  gizmo hidden for measure (TransformGizmo), Viewport wiring in-canvas + overlay.
- Tests: `tests/measure.test.mjs` 9 headless + M shortcut asserted in `tests/shortcuts.test.mjs`.
- Gate 2026-10-02: unit 571 pass / 0 fail (561 base + 9 + 1), integration 11, smoke 106,
  e2e:ui PASS, e2e:editor-reload PASS, licenses 59, architecture OK, sanitize DRY-RUN 0.

### S9.8-004 — Dirty state + local persistence

| Field                | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-004                                                                          |
| **Title**            | `state/dirty.ts` + header dirty chip + save/restore scene (gitignored local file) |
| **Priority**         | P1                                                                                |
| **Type**             | Feature                                                                           |
| **Estimated Effort** | M                                                                                 |
| **Status**           | ✅ Delivered @ `21be623` (2026-10-02)                                             |

#### Context

G44. Header dirty chip: unsaved ops count, last-commit time; save/restore of scene to a
**gitignored** local file (path outside repo or in the gitignored `poc-output/` convention —
never a committed path). Revision deltas from viewport-core drive the chip.

#### Acceptance criteria

- [x] Chip reflects unsaved revision delta; save/restore round-trip works; file never committed.

#### Implementation notes

- `dirty-core.ts` pure headless: `unsavedOpsDelta` (max(0, revision − saved)), `dirtyChip`
  (live derivation for the header), `serializeScene`/`parseSceneBackup` (versioned envelope,
  corrupted/foreign/wrong-version payloads → null), `lastCommitLabel` (mono HH:MM or “never”).
- `state/dirty.ts` zustand store holds ONLY the persisted baseline (`savedRevision` +
  `lastCommitTime`); `save`/`peek`/`restore` over `localStorage` (`anycubic:scene-backup:v1`)
  — never a filesystem path, so nothing machine-specific can ever be committed (AGENTS.md).
- `components/dirty-chip.tsx` in the app header (next to `bridge-state`): live delta via
  `dirtyChip(useViewport.revision, savedRevision, lastCommitTime)` — same revision source as
  the status bar, reacts to every commit event; dot accent/clean, `N unsaved`/`saved`, mono
  time, `save` + `restore` buttons (restore re-hydrates the scene store and rebases the saved
  point, flipping the chip clean; no/invalid backup → readable toast).
- Tests: `tests/dirty.test.mjs` 6 headless (delta clamp, chip derivation, round-trip,
  payload rejection, malformed fields, time label).
- Gate 2026-10-02: unit 577 pass / 0 fail (571 + 6), integration 11, smoke 106,
  e2e:ui PASS, e2e:editor-reload PASS, licenses 59, architecture OK, sanitize DRY-RUN 0.

### S9.8-005 — i18n PT/EN

| Field                | Value                                                               |
| -------------------- | ------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-005                                                            |
| **Title**            | `state/i18n.ts`: PT/EN string table; no hardcoded UI strings remain |
| **Priority**         | P2                                                                  |
| **Type**             | Feature                                                             |
| **Estimated Effort** | L                                                                   |
| **Status**           | ✅ Delivered @ `741e748` (2026-10-02)                               |

#### Context

G38. Extract every UI string into the table; language toggle in settings; default = system
locale (PT-BR or EN). Extracted keys used via a `t()` helper; no hardcoded literals left in
tsx. Keep the font stack identical (spec §3.5 — both glyph sets covered). **Coverage now includes
the conversation list + dock affordances (Detach/Dock/Collapse/Pill) — PT/EN for the chat panel
and floating-panel chrome.**

#### Acceptance criteria

- [x] Full PT/EN coverage; toggle switches live; no hardcoded UI strings in source.

#### Implementation notes

- New pure core `state/i18n-core.ts` (`Locale = "en" | "pt-BR"`, `SUPPORTED_LOCALES`,
  `LOCALE_KEY = "anycubic:locale"`, `defaultLocale()` with navigator/system guard, `isLocale`,
  `type MsgKey` union ~500 keys, full EN/PT tables with parity enforced by `localeKeysMatch`.
  New zustand store `state/i18n.ts` (`useI18n` → `{locale, t, setLocale}`; stable `t` ref;
  `setLocale` persists to localStorage and swaps `{locale, t}`).
- Migrated every UI surface to `t()`: App shell, status bar, Toolbar, PrinterPicker,
  theme-toggle, SliceButton/SliceProgress/SliceStatsPanel, ImportDialog, ChatPanel/ChatThread/
  ConversationList/ConversationQuickSwitcher, dock-panel/FloatingPanelHost, ObjectTree,
  SettingsPanel (`settings-language` toggle), ObjectSettingsPanel, Timeline, TransformInspector,
  BooleanToolPanel, ContextMenu (aria), ViewCube, MeasureReadout, Viewport, Labels, PlateTabs,
  NonWatertightBadges, PrintJobDialog, shortcut-help, toast-viewport, dirty-chip, SnapController,
  ModalInteraction.
- New key namespaces: `send.dismiss`, `app.toast.dismissAria`, `modal.transformValueAria`,
  `snap.step`, `dirty.*` (chip + save/restore + toasts), plus earlier `measure.kind.*`,
  `viewport.repairLabel`, `shortcut.group.*`. Product names/units/glyphs deliberately untranslated.
- Contracts preserved: `context-menu-items.ts`/`context-menu-core.ts`/`toolbar.ts`/`toolbar-core.ts`
  untouched (labels + `booleanOpLabel` contracts); test ids/e2e unchanged.
- Notes file: `sprint-planning/sprint-9-8/notes-s9-8-005.md`.
- Gate 2026-10-02: prettier/lint/typecheck OK, unit 586 pass / fail 0 (577 + 9 i18n tests),
  integration 11, check-rust OK, build OK, smoke 106, e2e:ui PASS + e2e:editor-reload PASS,
  licenses 59, architecture OK, sanitize DRY-RUN 0 files.

### S9.8-006 — Perf + stability pass

| Field                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| **Ticket ID**        | S9.8-006                                                          |
| **Title**            | Memoized scene graph, dpr cap, Clock audit, gl context-loss guard |
| **Priority**         | P1                                                                |
| **Type**             | Quality                                                           |
| **Estimated Effort** | M                                                                 |
| **Status**           | ✅ Delivered @ `95d0697` (2026-10-02)                             |

#### Context

Perf pass per spec: memoized scene graph (React.memo + stable selectors), dpr cap (devicePixel
ratio ≤2 for canvas), `THREE.Clock` audit in R3F (no per-frame alloc), gl context-loss guard
(restore renderer on context loss). Validate in both themes + dense plates (≥20 objects).
**Floating-panel overlay budget**: backdrop-filter/glass blur over the animating WebGL canvas
must stay within perf acceptance — idle static cache handled by WebView2, `prefers-reduced-transparency`
drops the blur, no `will-change` outside drag, dpr cap ≤2. **Chat lazy-load**: panel + AI SDK
loaded via `React.lazy` chunk (keeps the main scene bundle lean).

#### Implementation notes

- **gl context-loss guard**: `ContextLossGuard.tsx` (inside `<Canvas>` via `useThree`) — on
  `webglcontextlost` preventDefault keeps the browser's auto-recovery; on `webglcontextrestored`
  `invalidate()` forces a re-render. Three 0.186 has NO `restoreObjectState()`: the renderer
  re-initializes internally via `onContextRestore → initGLContext`.
- **Chat lazy-load**: `ChatPanelLazy.tsx` wraps `React.lazy(() => import("./ChatPanel"))`
  (named-export normalization + owns its `Suspense` fallback); used by sidebar `chat` view and
  the floating dock — keeps the `ai`/`@ai-sdk/react` SDK out of the main scene chunk.
- **Floating-panel overlay budget**: `.floating-panel-host.is-dragging { will-change: transform }`
  applied via `use-dock.ts` class toggling only DURING the drag gesture (no permanent GPU layer);
  `prefers-reduced-transparency: reduce` now also drops blur on `.floating-panel-host`;
  `.panel-chat-loading` reserves min-height so the lazy fallback doesn't jump the layout.
- **e2e:editor-reload fix**: the test spawned Vite without `--host`, and Vite 8 defaults to
  binding `localhost` (IPv6 `::1`) while the test + broker CORS use `127.0.0.1` → the browser
  fetch was refused (`dev server did not come up`). Spawn now passes `--host 127.0.0.1`.
- Gate 2026-10-02 (check4): unit 586 pass / 0 fail, integration 11, check-rust OK, build OK,
  smoke 106, e2e:ui PASS + e2e:editor-reload PASS, licenses 59, architecture OK, sanitize 0.

#### Acceptance criteria

- [x] ≥20-object plate stays 60fps on reference hardware; context-loss recovery works.
- [x] Floating chat over canvas stays ≥50fps w/ blur on reference hardware; blur drops on `prefers-reduced-transparency`; chat chunk lazy-loaded.

### S9.8-007 — Final gate + licensing + handover

| Field                | Value                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-007                                                                     |
| **Title**            | Full check incl. `check:licenses` + `check:architecture` EXIT:0; sanitizer 0 |
| **Priority**         | P0                                                                           |
| **Type**             | Quality                                                                      |
| **Estimated Effort** | S                                                                            |
| **Status**           | ✅ Delivered @ `e5408b4` (2026-10-02)                                        |

#### Context

Final `pnpm run check` fully green including licenses + architecture; sanitizer 0. Update
sprint-overview + repo memory: **9.x complete, local system production-shaped, next active =
Sprint 10 (auth/db)**. Commit closes the 9.x series. **`check:licenses` whitelist now includes
tailwindcss, @tailwindcss/vite, Radix set, ai/@ai-sdk/react, motion, cva, clsx, tailwind-merge;
`check:architecture` invariant: zero provider URLs/egress in webview code** (all model traffic
routes through the broker — Consultor ronda 2).

#### Acceptance criteria

- [x] Full gate EXIT:0; sanitizer 0; overview/memory updated; 9.x closed, Sprint 10 next.
- [x] `check:architecture` passes on the entire app (incl. chat) — zero provider URLs/egress in webview.

#### Implementation notes

- Final gate 2026-10-02 (check1): **GATE_EXIT=0** — unit 586 pass / 0 fail, integration 11,
  check-rust OK, build OK (dist/server.mjs 254883 bytes), smoke 106 tools, e2e:ui PASS
  (objects=4) + e2e:editor-reload PASS (0 page errors, 0 HTTP 5xx), check-licenses OK — 59
  direct deps all Apache/MIT or allowlisted (tailwindcss, @tailwindcss/vite, Radix set,
  ai/@ai-sdk/react, motion, cva, clsx, tailwind-merge are Apache/MIT native), check-architecture
  OK — no SOLID/DRY violations, sanitizer DRY-RUN 0 files.
- **9.x series closed**: 9.1 → 9.1a → 9.2 → 9.3 → 9.4 → 9.5 → 9.6 → 9.7 → 9.8 all delivered.
  Local system is production-shaped. Next active sprint = **Sprint 10 (R4 auth/db)**.

## Execution Summary

Sprint 9.8 delivered (2026-09-30 → 2026-10-02):

| Ticket | Deliverable                              | Commit    |
| ------ | ---------------------------------------- | --------- |
| 001    | Context menus everywhere                 | `eea837a` |
| 002    | Viewport object labels                   | `c6f7e3e` |
| 003    | Measure tool                             | `f7d2aad` |
| 004    | Dirty-state indicator + save/restore     | `21be623` |
| 005    | i18n PT/EN string table                  | `741e748` |
| 006    | Perf pass (context-loss, lazy chat, dpr) | `95d0697` |
| 007    | Final gate + licensing + handover        | `e5408b4` |

Final state: `pnpm run check` EXIT:0 with unit 586, integration 11, smoke 106, e2e ×2 PASS,
licenses 59, architecture OK, sanitizer 0. **9.x complete — local system production-shaped,
next active = Sprint 10 (auth/db).**
