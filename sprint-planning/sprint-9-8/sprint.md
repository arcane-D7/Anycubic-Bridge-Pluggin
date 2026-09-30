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
| **Status**            | ⏳ Planned                                                                                                           |

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
| **Status**           | ⏳ Planned                                                         |

#### Context

G35 completion. One reusable glass context menu (fill-3/blur-3, 1px hairline, keyboard
navigation, Esc closes, focus trap). Wired to object tree rows (duplicate/rename/hide/delete,
place-on-plate), viewport (background context: arrange/measure/import), plate tabs (rename/add/
duplicate/delete), timeline (seek/journal actions).

#### Acceptance criteria

- [x] All four surfaces open the same menu component with correct items; keyboard operable.

### S9.8-002 — Viewport object labels

| Field                | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-002                                                             |
| **Title**            | `viewport/Labels.tsx`: hover + always-on label chips (name + status) |
| **Priority**         | P1                                                                   |
| **Type**             | Feature                                                              |
| **Estimated Effort** | M                                                                    |
| **Status**           | ⏳ Planned                                                           |

#### Context

G45. HUD chips float above objects: name + status (watertight/non-watertight/locked). Toggle
always-on from toolbar; sizes mono secondary, contrast per spec. Implementation via
drei `Html` or manual projection to keep canvas clean.

#### Acceptance criteria

- [x] Chips on hover (or always-on per toggle); follow objects during transform; theme-correct.

### S9.8-003 — Measure tool

| Field                | Value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-003                                                              |
| **Title**            | `viewport/MeasureTool.tsx`: distance/radius/angle probe, mono readout |
| **Priority**         | P1                                                                    |
| **Type**             | Feature                                                               |
| **Estimated Effort** | M                                                                     |
| **Status**           | ⏳ Planned                                                            |

#### Context

G42. Measure mode (toolbar toggle): gizmo-less probe on click (vertex/edge/face snapping from
9.7). Distance between two points, radius of circular edge, angle between edges — readout
bottom-left in mono, cleared on mode exit. Works on imported meshes (raycast against real
geometry).

#### Acceptance criteria

- [x] Distance/radius/angle measurements correct on real geometry; readout mono; cleared on exit.

### S9.8-004 — Dirty state + local persistence

| Field                | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-004                                                                          |
| **Title**            | `state/dirty.ts` + header dirty chip + save/restore scene (gitignored local file) |
| **Priority**         | P1                                                                                |
| **Type**             | Feature                                                                           |
| **Estimated Effort** | M                                                                                 |
| **Status**           | ⏳ Planned                                                                        |

#### Context

G44. Header dirty chip: unsaved ops count, last-commit time; save/restore of scene to a
**gitignored** local file (path outside repo or in the gitignored `poc-output/` convention —
never a committed path). Revision deltas from viewport-core drive the chip.

#### Acceptance criteria

- [x] Chip reflects unsaved revision delta; save/restore round-trip works; file never committed.

### S9.8-005 — i18n PT/EN

| Field                | Value                                                               |
| -------------------- | ------------------------------------------------------------------- |
| **Ticket ID**        | S9.8-005                                                            |
| **Title**            | `state/i18n.ts`: PT/EN string table; no hardcoded UI strings remain |
| **Priority**         | P2                                                                  |
| **Type**             | Feature                                                             |
| **Estimated Effort** | L                                                                   |
| **Status**           | ⏳ Planned                                                          |

#### Context

G38. Extract every UI string into the table; language toggle in settings; default = system
locale (PT-BR or EN). Extracted keys used via a `t()` helper; no hardcoded literals left in
tsx. Keep the font stack identical (spec §3.5 — both glyph sets covered). **Coverage now includes
the conversation list + dock affordances (Detach/Dock/Collapse/Pill) — PT/EN for the chat panel
and floating-panel chrome.**

#### Acceptance criteria

- [x] Full PT/EN coverage; toggle switches live; no hardcoded UI strings in source.

### S9.8-006 — Perf + stability pass

| Field                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| **Ticket ID**        | S9.8-006                                                          |
| **Title**            | Memoized scene graph, dpr cap, Clock audit, gl context-loss guard |
| **Priority**         | P1                                                                |
| **Type**             | Quality                                                           |
| **Estimated Effort** | M                                                                 |
| **Status**           | ⏳ Planned                                                        |

#### Context

Perf pass per spec: memoized scene graph (React.memo + stable selectors), dpr cap (devicePixel
ratio ≤2 for canvas), `THREE.Clock` audit in R3F (no per-frame alloc), gl context-loss guard
(restore renderer on context loss). Validate in both themes + dense plates (≥20 objects).
**Floating-panel overlay budget**: backdrop-filter/glass blur over the animating WebGL canvas
must stay within perf acceptance — idle static cache handled by WebView2, `prefers-reduced-transparency`
drops the blur, no `will-change` outside drag, dpr cap ≤2. **Chat lazy-load**: panel + AI SDK
loaded via `React.lazy` chunk (keeps the main scene bundle lean).

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
| **Status**           | ⏳ Planned                                                                   |

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
