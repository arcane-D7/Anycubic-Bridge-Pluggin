# Sprint 9.1a — Dock / Panel-Layout Foundation (deteachable floating panels)

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Floating-panel host: drag/snap/resize/collapse dock, R3F pointer isolation, a11y                                                                                                                                                |
| **Sprint Goal**       | Make panels (starting with Chat) **dockable ↔ floating** inside the UI while the user keeps navigating other tabs and doing viewport actions; with snap, resize, collapse-to-pill, persistence and R3F pointer-event isolation. |
| **Duration Estimate** | ~1 week                                                                                                                                                                                                                         |
| **Priority**          | P1                                                                                                                                                                                                                              |
| **Sprint Type**       | Feature                                                                                                                                                                                                                         |
| **Primary Owner**     | apps/editor (UI)                                                                                                                                                                                                                |
| **Source**            | Consultor report 2026-09-30 ronda 2 §3 (dock verdict: purpose-built minimal dock + motion; NOT react-rnd/grid-layout) + user Mandate B                                                                                          |
| **Depends On**        | Sprint 9.1 (shadcn + tokens + overlay root readiness)                                                                                                                                                                           |
| **Status**            | ⏳ Planned                                                                                                                                                                                                                      |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.1a-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

**User Mandate B (2026-09-30): a tab do Chat tem de ser destacável — flutua dentro da UI
enquanto o utilizador navega noutras tabs ou faz outras ações.**

The dock is a **purpose-built minimal system** (~300 lines, `components/dock/`) — not
react-rnd, not react-grid-layout (Consultor verdict: grid-layout is dashboard-semantics with
no overlay docking; react-rnd solves 80% but has no snap animation, stale maintenance). It
uses **motion** for springs and drag. The floating panel portals into a top-level
`#overlay-root` so it is **never a sibling captured by the viewport's stacking context** —
with a global `pointer-events:none` wrapper + `auto` only on the panel rect, the R3F canvas
(gizmo, OrbitControls) keeps receiving events under the floating panel. A11y via **Radix
Dialog `modal={false}`** (Esc, focus, `role="dialog"`, no scroll-lock). Dock state persists
to localStorage (`anycubic:dock-state:v1`, machine-agnostic). **Hard architecture rule
(Consultor §5): in-app floating only — NEVER build OS floating windows** (breaks the
single-webview coordinate model, drag math across displays, z-order vs canvas, focus).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.1a-001 — Overlay root + z-ladder + R3F isolation

| Field                | Value                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.1a-001                                                                                               |
| **Title**            | `dock/overlay-root.tsx`: `#overlay-root` portal, `pointer-events:none` discipline, z-index scale tokens |
| **Priority**         | P0                                                                                                      |
| **Type**             | Feature                                                                                                 |
| **Estimated Effort** | M                                                                                                       |
| **Status**           | ⏳ Planned                                                                                              |

#### Context

Mount `#overlay-root` once in `App.tsx`. Global `pointer-events:none` on the root; only the
floating panel's own rect sets `auto`. Viewport frame gets `position:relative; isolation:isolate`;
Canvas `z-0` + `touch-action:none`; `ViewportHud` absolute `z-10`; floating panels `z-40`;
Radix Dialog/Dropdown portals `z-50`; toasts `z-60`. Any floating chrome renders via
`createPortal` into the overlay root so the viewport stacking context never captures it.

#### Acceptance criteria

- [x] `#overlay-root` + portal exists; z-index scale tokens defined; canvas event-fallthrough verified with OrbitControls.
- [x] When a panel is docked/collapsed/unmounted, everything falls through to the gizmo.

### S9.1a-002 — Dock store + drag/snap/resize host

| Field                | Value                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ticket ID**        | S9.1a-002                                                                                                                                        |
| **Title**            | `state/dock.ts` + `use-dock` (ref-based, rAF-throttled) + `FloatingPanelHost` (motion drag, 8-way resize, snap zones, collapse-to-pill, persist) |
| **Priority**         | P0                                                                                                                                               |
| **Type**             | Feature                                                                                                                                          |
| **Estimated Effort** | L                                                                                                                                                |
| **Status**           | ⏳ Planned                                                                                                                                       |

#### Context

`state/dock.ts`: `panels: Record<PanelId, { mode:'docked'|'floating'|'collapsed', rect, z }>`;
snap-zones computed from viewport bounds (edges/corners/center); persistence
`localStorage['anycubic:dock-state:v1']`, machine-agnostic (no repo literal), clamped on boot.
Drag position lives in a ref (no re-render storm), rAF-throttled during drag, committed to
zustand on drag-stop. Snap on drag-end (motion spring animate to edge/corner/free),
8-direction resize handles, collapse to a pill (click to reopen). Floating content renders
the existing single-conversation `ChatPanel` (glass fill-2/blur-2) for now.

#### Acceptance criteria

- [x] Drag + 8-way resize + edge/corner snap + free-floating all work; state persists and clamps on boot.
- [x] Collapse-to-pill works; pill reopen restores rect; no re-render storm (ref-based drag, rAF).

### S9.1a-003 — Chat panel detach affordances

| Field                | Value                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| **Ticket ID**        | S9.1a-003                                                                    |
| **Title**            | "⇱ Detach" from sidebar Chat nav + "⇲ Dock" in floating header + pill reopen |
| **Priority**         | P0                                                                           |
| **Type**             | Feature                                                                      |
| **Estimated Effort** | M                                                                            |
| **Status**           | ⏳ Planned                                                                   |

#### Context

Sidebar Chat nav item gets a split action: click switches (docked); "⇱ Detach" (or drag-off
the icon) flips `mode:'floating'`. Floating header has "⇲ Dock" (re-dock; double-click header
also re-docks). Collapse → pill at the docked edge; click pill reopens. The floating panel
shows the existing chat (single conversation for now; multi-conversation lands 9.6).

#### Acceptance criteria

- [x] Detach/Dock/Collapse/reopen all wired end-to-end; docked tab still functional.
- [x] Floating panel visibly overlays the viewport HUD chrome (glass fill-2/blur-2) without breaking it.

### S9.1a-004 — A11y for floating panels

| Field                | Value                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.1a-004                                                                                                              |
| **Title**            | Radix Dialog `modal={false}` wrapper (Esc, focus, role=dialog, no scroll-lock), soft focus trap, Alt+Shift+arrows move |
| **Priority**         | P1                                                                                                                     |
| **Type**             | Feature                                                                                                                |
| **Estimated Effort** | S                                                                                                                      |
| **Status**           | ⏳ Planned                                                                                                             |

#### Context

Consultor §3.1: build on **Radix Dialog `modal={false}`** — gives Esc, focus management,
`role="dialog"`, **no body scroll-lock**; DO NOT use `modal:true` (locks scroll + `aria-modal`
and fights the 3D viewport). Soft focus trap only while focus is inside; Alt+Shift+arrows
move the panel; visible focus ring on the floating chrome. Esc = collapse to pill when floating.

#### Acceptance criteria

- [x] Floating panel is a non-modal dialog: Esc collapses, focus contained, no scroll-lock.
- [x] Alt+Shift+arrows move the panel; focus ring visible; verified in both themes.

### S9.1a-005 — Gate + sanitizer + license check

| Field                | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| **Ticket ID**        | S9.1a-005                                                        |
| **Title**            | Full gate EXIT:0 + sanitizer 0 + new-deps license check (motion) |
| **Priority**         | P0                                                               |
| **Type**             | Quality                                                          |
| **Estimated Effort** | S                                                                |
| **Status**           | ⏳ Planned                                                       |

#### Context

`pnpm run check` (format/lint/typecheck/unit/integration/rust/build/smoke/e2e/licenses/architecture)

- sanitizer dry-run 0. `check:licenses` admits **motion (MIT)**; verify no ISC sneaks in.
  Explicit Tauri-webview verification: floating drag/snap over the R3F canvas works in the
  actual webview (not just browser dev) — the Consultor's #1 integration risk.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; motion admitted by licenses; webview drag/snap verified; commit closes the sprint.
