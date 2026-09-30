# Sprint 9.5 — Slice / Preview / Print Flow

## Sprint Metadata

| Field                 | Value                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sprint Name**       | First-class slice action with real pipeline result + print path                                                                                              |
| **Sprint Goal**       | Close G25 — the slice action must be a first-class button with a real pipeline result and a print path (progress, stats, preview, printer picker, send job). |
| **Duration Estimate** | ~2 weeks                                                                                                                                                     |
| **Priority**          | P0                                                                                                                                                           |
| **Sprint Type**       | Feature                                                                                                                                                      |
| **Primary Owner**     | apps/editor (flow) + bridge                                                                                                                                  |
| **Source**            | Consultor report 2026-09-30 §2 (9.5) + audit G24/G25/G43                                                                                                     |
| **Depends On**        | Sprints 9.3/9.4 (transforms/plates correct before slicing) + 9.1 (tokens)                                                                                    |
| **Status**            | ⏳ Planned                                                                                                                                                   |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.5-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

Second user-visible "wow" after the gizmo. The Slice button (primary accent, header right or
toolbar) is enabled when ≥1 watertight object is on the plate; it runs the S8 pipeline
(planar-core → IR → postprocessor → preview) with a staged progress bar + cancel, then shows
result stats (layers, estimated time, material grams, volume, per-object contribution — G24),
auto-switches to the Preview workspace (retaining the layer slider + walls/infill toggles,
restyled with tokens), and offers a send-to-print flow with a printer picker (LAN discovery
from `ANYCUBIC_PRINTER_IPS`, connection status LED), a job confirmation dialog reusing the
approval-card pattern, progress + completion toasts, and error states (offline/region).
Non-watertight objects block slice with an actionable repair hint (bridges to 9.7).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.5-001 — Slice job state machine

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.5-001                                                               |
| **Title**            | `state/printjob.ts`: idle→slicing→preview→sending→sent (+error/cancel) |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Status**           | ⏳ Planned                                                             |

#### Context

Slice job machine with staged progress (prepare → planar-core → IR → postprocess → preview),
cancel support, error states (non-watertight block, pipeline failure, printer offline), and
transition guards per the S8 pipeline contract. Status drives the Slice button, progress bar
and stats panel.

#### Acceptance criteria

- [x] Machine transitions idle→slicing→preview…sent with stage progress + cancel.
- [x] Non-watertight objects block slice with actionable repair hint (toast + dialog link).

### S9.5-002 — Slice button + progress + stats panel

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.5-002                                                                        |
| **Title**            | `components/SliceButton.tsx`, `SliceProgress.tsx`, `panels/SliceStatsPanel.tsx` |
| **Priority**         | P0                                                                              |
| **Type**             | Feature                                                                         |
| **Estimated Effort** | M                                                                               |
| **Status**           | ⏳ Planned                                                                      |

#### Context

Primary accent button (disabled preflight), staged progress bar (mono stage labels), stats
panel: layers, estimated time, material grams, volume, per-object contribution (G24). Restyle
Preview controls (layer slider + toggles) with tokens.

#### Acceptance criteria

- [x] Slice enabled iff ≥1 watertight object on plate; progress stages visible; cancel works.
- [x] Stats panel renders all five metrics from real pipeline output; Preview restyled.

### S9.5-003 — Printer picker + connection state

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.5-003                                                           |
| **Title**            | Printer discovery from `ANYCUBIC_PRINTER_IPS` env + connection LED |
| **Priority**         | P0                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | M                                                                  |
| **Status**           | ⏳ Planned                                                         |

#### Context

G43. Printer/device picker lists discovered printers (env `ANYCUBIC_PRINTER_IPS`, comma list —
**no hardcoding**); connection status LED (online/offline); selecting a target arms the send
flow. Device info read-only via the existing bridge; no control orders go out without the
approval dialog.

#### Acceptance criteria

- [x] Picker lists env-discovered printers; LED reflects reachability; selection arms send.
- [x] No send without confirmation; no hardcoded device identifiers.

### S9.5-004 — Send-to-print dialog

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9.5-004                                                                   |
| **Title**            | `dialogs/PrintJobDialog.tsx` reusing approval-card pattern → send → toasts |
| **Priority**         | P0                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | M                                                                          |
| **Status**           | ⏳ Planned                                                                 |

#### Context

Job confirmation dialog reuses the S9-006 approval-card pattern (pending/approved/rejected
states, token hashing); send progress + completion toast; error states (offline/region).
`bridge/mock.ts` gains slice-job + progress + printer lanes.

#### Acceptance criteria

- [x] Confirmation dialog shows job summary; confirm sends (mock), progress + completion toast.
- [x] Offline/region errors surface as semantic toasts; approval card semantics preserved.

### S9.5-005 — Bridge slice lane + unit tests

| Field                | Value                                                 |
| -------------------- | ----------------------------------------------------- |
| **Ticket ID**        | S9.5-005                                              |
| **Title**            | `bridge/mock.ts` slice job + progress + printer lanes |
| **Priority**         | P1                                                    |
| **Type**             | Feature                                               |
| **Estimated Effort** | M                                                     |
| **Status**           | ⏳ Planned                                            |

#### Context

Mock lanes behind the frozen shape: slice request→reply with stats, staged progress events,
printer list/reachability. Unit tests on the printjob machine (transitions, cancel, stale
revision re-base), mirroring the integration contract used by the real pipeline.

#### Acceptance criteria

- [x] Mock lanes + unit tests cover every state transition and error path; gate green.

### S9.5-006 — Gate + sanitizer

| Field                | Value                          |
| -------------------- | ------------------------------ |
| **Ticket ID**        | S9.5-006                       |
| **Title**            | Full gate EXIT:0 + sanitizer 0 |
| **Priority**         | P0                             |
| **Type**             | Quality                        |
| **Estimated Effort** | S                              |
| **Status**           | ⏳ Planned                     |

#### Context

`pnpm run check`; sanitizer 0; commit closes the sprint.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.
