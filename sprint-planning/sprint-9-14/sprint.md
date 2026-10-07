# Sprint 9.14 — Context Interaction, Canvas Layout & Scroll

## Sprint Metadata

| Field                 | Value                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Context interaction, responsive canvas controls and scroll accessibility                                                               |
| **Sprint Goal**       | Make contextual actions target-correct, accessible and usable at real pointer/keyboard inputs across supported viewport sizes.         |
| **Duration Estimate** | ~2 weeks                                                                                                                               |
| **Priority**          | P1                                                                                                                                     |
| **Sprint Type**       | Feature + Quality                                                                                                                      |
| **Primary Owner**     | apps/editor                                                                                                                            |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-01–03/AUD-15; sections 8, 9, 16, 19 |
| **Depends On**        | Sprint 9.13                                                                                                                            |
| **Status**            | ✅ Complete (4/4, 2026-10-07)                                                                                                          |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Correct click anchoring and target-aware menu behavior, remove toolbar/plate-control collisions, and apply a consistent accessible scroll policy. Preserve existing visual affordances while ensuring that controls perform their stated domain action rather than merely emitting a notification. No physical-device operation is in scope.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

For each ticket, run its focused unit/integration/browser-input check first, then both commands above. A hardware command is never part of this gate.

## Tickets

### S9.14-001 — Context-menu anchor, collision and keyboard focus

| Field                | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| **Ticket ID**        | S9.14-001                                                       |
| **Title**            | Preserve real pointer/keyboard anchor and accessible menu focus |
| **Priority**         | P1                                                              |
| **Type**             | Fix + Accessibility                                             |
| **Estimated Effort** | M                                                               |
| **Source Finding**   | AUD-01; CTX-01–CTX-04                                           |
| **Status**           | ✅ Delivered                                                    |

#### Context

Menu callers can omit viewport dimensions, causing the pure positioning helper to clamp the menu to a corner. Correct the caller/coordinate contract and collision handling without DPR compensation or machine-specific offsets.

#### Acceptance Criteria

- [x] **CTX-01:** Real central canvas click anchors the menu at the click when space permits.
- [x] **CTX-02:** Four corners/edges keep the menu visible through measured collision handling.
- [x] **CTX-03:** Resize, zoom and scroll preserve the declared CSS-pixel coordinate frame.
- [x] **CTX-04:** Keyboard anchor, Escape close and focus restoration work on a real rendered menu.
- [x] Run focused interaction tests, `pnpm run check`, and sanitizer dry-run successfully.

#### Implementation Progress

- The helper now uses document viewport dimensions in CSS pixels when callers omit bounds, and preserves the requested pointer coordinates when no DOM viewport exists.
- The rendered menu is measured after mount, clamped by its real rectangle, constrained to viewport height, and re-measured on element/viewport changes. Keyboard-origin context events anchor to the focused element; Escape returns focus to that owner.
- Focused validation: `node --test tests/context-menu.test.mjs` (11/11) and `node tests/e2e/editor-reload.e2e.mjs` (PASS). Browser E2E covers real central/edge right-clicks, viewport resize, DPR 2, Shift+F10, Escape, and focus restoration. Live browser verification at 90% zoom preserved the real click anchor within 1 CSS pixel; after real footer scrolling (scrollTop 0→119), a real canvas right-click remained client-coordinate anchored. Zoom and scroll were restored afterward.
- Full gate: `pnpm run check` EXIT 0 — unit 722/722, integration 11/11, Rust workspace/editor shell OK (176 tests), build 255608 bytes, smoke 115 tools, both E2E suites PASS, licenses 59, architecture OK, sanitizer 0 files/0 substitutions. Separate `node scripts/sanitize-repo.mjs --dry-run` also reported 0 files/0 substitutions.

### S9.14-002 — Shared contextual target and action resolution

| Field                | Value                                                               |
| -------------------- | ------------------------------------------------------------------- |
| **Ticket ID**        | S9.14-002                                                           |
| **Title**            | Resolve context actions consistently for tree, canvas and Edit Mode |
| **Priority**         | P1                                                                  |
| **Type**             | Feature                                                             |
| **Estimated Effort** | L                                                                   |
| **Source Finding**   | AUD-02; CTX-05–CTX-08                                               |
| **Status**           | ✅ Delivered                                                        |

#### Context

The tree and canvas currently expose divergent actions and target resolution. Route them through one typed context/action registry and revalidate target, selection, role and mesh revision at execution.

#### Acceptance Criteria

- [x] **CTX-05:** Tree and canvas object menus share one typed opener/dispatcher and provider action lane.
- [x] **CTX-06:** Right-clicking a selected member preserves the selected target set; otherwise only the clicked object is targeted.
- [x] **CTX-07:** Role-specific actions are not advertised without role metadata; unsupported part/negative/modifier roles receive typed rejection.
- [x] **CTX-08:** Vertex/edge/face contexts without a mesh-edit contract receive typed `unsupported-edit-mode` rejection rather than executing against unknown topology.
- [x] No menu-only/mock handler reports success for an operation it did not execute.
- [x] Focused tests, browser input suite, full `pnpm run check`, and sanitizer dry-run pass.

#### Implementation Progress

- Added `state/context-action-core.ts`: typed context snapshot (surface, target kind/name, selection names, live project revision, edit mode) and execution-time resolver. It preserves an existing selection if the clicked object is a member; otherwise it narrows to that object. Resolution rechecks live viewport revision, current scene objects and lock flags and returns typed stale/missing/locked/unsupported-role/unsupported-edit-mode rejections.
- Added `hooks/use-object-context-menu.ts` as the shared owner for tree/canvas object menu construction and dispatch. The tree retains Rename and More info; canvas omits those because they have no canvas handler. Duplicate, visibility, place-on-plate, repair and delete use the same provider lanes for both surfaces. Provider refusal/error is surfaced and triggers authoritative scene rehydration; stale/unavailable targets never report success.
- `SceneObjectModel` forwards object hits to the shared opener. `Viewport` raycasts native canvas context-menu coordinates against the current R3F scene; mesh hits open the object menu and empty-space clicks retain the existing background menu.
- Backend boundary: `SceneObjectSnapshot` has no part/negative/modifier role metadata, mesh revision, or edit-element selection contract. No role-specific or Edit Mode operation is claimed or advertised. Those contexts fail closed until a provider contract exists; implementing that contract is out of scope for this ticket.
- Focused validation: `node --test tests/context-menu.test.mjs tests/object-tree-flow.test.mjs` passed 17/17; `pnpm exec tsc --noEmit` and touched-source ESLint passed; `node tests/e2e/editor-reload.e2e.mjs` passed. Browser E2E covers real mouse/Shift tree selection and context-menu opening; live browser verification confirmed native canvas mesh hits open object actions and background hits retain background actions.
- Full gate: `pnpm run check` EXIT 0 — unit 723/723, integration 11/11, Rust workspace/editor shell OK, build 255608 bytes, smoke 115 tools, both E2E suites PASS, licenses 59, architecture OK, sanitizer 0 files/0 substitutions. Separate sanitizer dry-run also EXIT 0 with 0 files/0 substitution groups.

### S9.14-003 — Right-drag discrimination and honest canvas actions

| Field                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| **Ticket ID**        | S9.14-003                                                   |
| **Title**            | Distinguish pan gestures and wire or refuse Arrange/Measure |
| **Priority**         | P1                                                          |
| **Type**             | Fix                                                         |
| **Estimated Effort** | M                                                           |
| **Source Finding**   | AUD-02; CTX-09–CTX-10                                       |
| **Status**           | ✅ Delivered                                                |

#### Context

Right-button panning must not open a menu after the pointer crosses the drag threshold. Frame menu actions must call the shared handler or explicitly report unavailable, not emit success-like notifications.

#### Acceptance Criteria

- [x] **CTX-09:** Real right-button drag beyond the threshold pans and does not open a context menu on release.
- [x] **CTX-10:** Arrange and Measure execute their real handler or return an honest unavailable result.
- [x] Click, short movement, cancel and pointer-capture-loss cases are covered.
- [x] Run focused real-input tests, full gate and sanitizer dry-run successfully.

#### Implementation Progress

- Added `viewport/context-gesture-core.ts` with a 6 CSS-pixel right-drag threshold, pointer identity checks, latched drag suppression and explicit cancel/lost-capture suppression. The R3F canvas picker applies the same discriminator before either mesh or background context menus; it does not capture the pointer, leaving OrbitControls' right-button pan intact. Keyboard context-menu invocation remains unaffected.
- Replaced the background Measure notification with the existing `useUi.setTool("measure")` mode. Background Arrange invokes the existing `scene.arrange` lane and refreshes the authoritative scene; it refuses with localized warning when the active plate is not the complete lane target because the current bridge contract cannot scope Arrange to one plate.
- Focused validation: `node --test tests/context-gesture.test.mjs tests/context-menu.test.mjs tests/object-tree-flow.test.mjs` passed 22/22; `pnpm exec tsc --noEmit` passed; `node tests/e2e/editor-reload.e2e.mjs` passed with real right-click/short-move, drag suppression, Arrange revision advance, Measure activation, and existing Shift+F10 coverage.
- Full gate: `pnpm run check` EXIT 0 — unit 728/728, integration 11/11, Rust workspace/editor shell OK (176 tests), build 255608 bytes, smoke 115 tools, both E2E suites PASS, licenses 59, architecture OK, integrated sanitizer 0 files/0 substitutions. Standalone `node scripts/sanitize-repo.mjs --dry-run` also reported 0 files/0 substitution groups.

### S9.14-004 — Responsive toolbar/plate ownership and scroll policy

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.14-004                                                              |
| **Title**            | Recompose canvas controls, plate information and accessible scrollbars |
| **Priority**         | P1                                                                     |
| **Type**             | Feature + Accessibility                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | AUD-03/AUD-15; UI-01–UI-10; SCR-01–SCR-05                              |
| **Status**           | ✅ Delivered                                                           |

#### Context

Toolbar and plate rail compete for the same canvas space, Fit semantics are ambiguous, and scrollable containers use inconsistent native styling. Give each control one visible owner and use existing scroll primitives/tokens where appropriate.

#### Acceptance Criteria

- [x] **UI-01–UI-04:** No priority-control overlap at 1743/1280/1024 widths; sidebar resize, zoom and Portuguese labels retain hit access.
- [x] **UI-05–UI-07:** Fit plate, Fit selection, Grid and Top have distinct truthful semantics and no redundant permanent owner.
- [x] **UI-08:** Plate controls sit above plate tabs without covering the repair trigger or other overlays.
- [x] **UI-09–UI-10:** The plate `(i)` popup reports correct profile/origin and supports keyboard, outside/Escape close and focus restoration.
- [x] **SCR-01–SCR-05:** Scroll containers inventoried and themed; light/dark/forced-colors, wheel/keyboard/touch, gutter and shared policy verified. Native scrollbar-thumb drag was verified in the live browser; headless Chromium uses an overlay scrollbar, so its E2E checks thumb styling and exercises the other input modes.
- [x] Focused browser geometry/accessibility checks, full gate and standalone sanitizer dry-run pass.

#### Implementation Progress

- Root cause of the interrupted E2E failure: the context-menu viewport test left the browser at 640px, where the responsive sidebar intentionally overlays the canvas, then later assertions attempted to click viewport controls underneath it. At the supported 1024px layout, the 1026px toolbar content also overflowed the narrower canvas and the plate-info trigger covered the transform button. The test now restores 1024px before control checks; compact toolbars wrap below the top-left repair trigger and the plate rail occupies its own row. Wide canvases retain a centered toolbar.
- The toolbar no longer owns Grid. The plate rail owns Fit plate, Top, Grid, optional plate upgrades, identity and an information popover. Fit plate uses a dedicated camera event and the profile-derived build-volume radius. Fit selection is disabled without selected objects and frames the union of all selected object bounds.
- Plate information now reports active plate name, profile, provenance, build volume and object count. Its Radix popover is keyboard-operable, closes on outside click/Escape, and restores trigger focus.
- The shared scroll policy covers shell panels/footer, object/chat/journal lists, repair and other popovers, printer/device/DevTools lists and tables, floating panel bodies, viewport toolbar/plate rail, status strip and context menu. Scrollbar colors follow theme tokens; forced colors use system colors; overflow owners retain native wheel/keyboard/touch behavior, contained overscroll and stable vertical gutters. The formerly hidden printer status scrollbar is visible.
- Focused checks: `node --test tests/camera-presets.test.mjs tests/i18n.test.mjs` passed 14/14; `node tests/e2e/editor-reload.e2e.mjs` passed with 1024/1280/1743 geometry and center hit tests, sidebar resize, 90% CSS zoom, Portuguese labels, profile/origin, Fit/Top/Grid, popover focus, wheel/PageDown/touch and forced-colors. Live browser pointer drag moved the settings scrollbar from `scrollTop 0` to `342` at 1024×480. `pnpm exec tsc --noEmit`, touched-source ESLint and Prettier passed.
- Full gate: `pnpm run check` EXIT 0 — unit 729/729, integration 11/11, Rust workspace/editor shell passed, build 255608 bytes, smoke 115 tools, both E2E suites passed, licenses 59, architecture clean, integrated sanitizer 0 files/0 substitutions. Standalone `node scripts/sanitize-repo.mjs --dry-run` EXIT 0 with 0 files/0 substitutions.

## Sprint Execution Summary

| Ticket    | Status       | Evidence                                                                         |
| --------- | ------------ | -------------------------------------------------------------------------------- |
| S9.14-001 | ✅ Delivered | Context-menu anchor/focus E2E + full gate                                        |
| S9.14-002 | ✅ Delivered | Shared target/action resolution E2E + full gate                                  |
| S9.14-003 | ✅ Delivered | Right-drag/action E2E + full gate                                                |
| S9.14-004 | ✅ Delivered | Responsive geometry, fit semantics, plate info, scroll inputs/themes + full gate |

## Sprint Commit

Each ticket commit uses `feat(s9.14-00x): <imperative summary>` (or the suitable Conventional Commits type), only after both health commands pass; no push.
