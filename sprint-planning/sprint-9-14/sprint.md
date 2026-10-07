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
| **Status**            | 🔄 In Progress (1/4)                                                                                                                   |

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
| **Status**           | ⏳ Planned                                                          |

#### Context

The tree and canvas currently expose divergent actions and target resolution. Route them through one typed context/action registry and revalidate target, selection, role and mesh revision at execution.

#### Acceptance Criteria

- [ ] **CTX-05:** Tree and canvas invoke the same action handler and produce the same domain result for an object.
- [ ] **CTX-06:** Right-clicking a member of multi-selection preserves the correct target set.
- [ ] **CTX-07:** Part, negative-volume and modifier actions follow each target's role.
- [ ] **CTX-08:** Edit Mode resolves vertex/edge/face targets against a valid mesh revision or returns a typed rejection.
- [ ] No menu-only/mock handler reports success for an operation it did not execute.
- [ ] Run focused tests, full `pnpm run check`, and sanitizer dry-run successfully.

### S9.14-003 — Right-drag discrimination and honest canvas actions

| Field                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| **Ticket ID**        | S9.14-003                                                   |
| **Title**            | Distinguish pan gestures and wire or refuse Arrange/Measure |
| **Priority**         | P1                                                          |
| **Type**             | Fix                                                         |
| **Estimated Effort** | M                                                           |
| **Source Finding**   | AUD-02; CTX-09–CTX-10                                       |
| **Status**           | ⏳ Planned                                                  |

#### Context

Right-button panning must not open a menu after the pointer crosses the drag threshold. Frame menu actions must call the shared handler or explicitly report unavailable, not emit success-like notifications.

#### Acceptance Criteria

- [ ] **CTX-09:** Real right-button drag beyond the threshold pans and does not open a context menu on release.
- [ ] **CTX-10:** Arrange and Measure execute their real handler or return an honest unavailable result.
- [ ] Click, short movement, cancel and pointer-capture-loss cases are covered.
- [ ] Run focused real-input tests, full gate and sanitizer dry-run successfully.

### S9.14-004 — Responsive toolbar/plate ownership and scroll policy

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.14-004                                                              |
| **Title**            | Recompose canvas controls, plate information and accessible scrollbars |
| **Priority**         | P1                                                                     |
| **Type**             | Feature + Accessibility                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | AUD-03/AUD-15; UI-01–UI-10; SCR-01–SCR-05                              |
| **Status**           | ⏳ Planned                                                             |

#### Context

Toolbar and plate rail compete for the same canvas space, Fit semantics are ambiguous, and scrollable containers use inconsistent native styling. Give each control one visible owner and use existing scroll primitives/tokens where appropriate.

#### Acceptance Criteria

- [ ] **UI-01–UI-04:** No priority-control overlap at 1743/1280/1024 widths; sidebar resize, zoom and long locale labels retain hit access.
- [ ] **UI-05–UI-07:** Fit plate, Fit selection, Grid and Top have distinct truthful semantics and no redundant permanent owner.
- [ ] **UI-08:** Plate controls sit above plate tabs without covering other overlays.
- [ ] **UI-09–UI-10:** The plate `(i)` popup reports correct profile/origin and supports keyboard, outside/Escape close and focus restoration.
- [ ] **SCR-01–SCR-05:** Inventory and theme all relevant scroll containers; light/dark/forced-colors, wheel/keyboard/touch/thumb, gutter and shared policy are verified.
- [ ] Run focused browser geometry/accessibility checks, full gate and sanitizer dry-run successfully.

## Sprint Commit

Each ticket commit uses `feat(s9.14-00x): <imperative summary>` (or the suitable Conventional Commits type), only after both health commands pass; no push.
