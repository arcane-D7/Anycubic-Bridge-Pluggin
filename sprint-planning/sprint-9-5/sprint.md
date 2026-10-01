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
| **Status**            | 🚧 In progress (4/6 tickets delivered)                                                                                                                       |

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
| **Status**           | ✅ Delivered (9624d20)                                                 |

#### Context

Slice job machine with staged progress (prepare → planar-core → IR → postprocess → preview),
cancel support, error states (non-watertight block, pipeline failure, printer offline), and
transition guards per the S8 pipeline contract. Status drives the Slice button, progress bar
and stats panel.

#### Acceptance criteria

- [x] Machine transitions idle→slicing→preview…sent with stage progress + cancel.
- [x] Non-watertight objects block slice with actionable repair hint (toast + dialog link).

#### Implementation notes

- New dependency-free core `apps/editor/src/state/printjob-core.ts` (S9.5-001):
  - `SLICE_STAGES` ordered pipeline stages (prepare → planar-core → IR →
    postprocess → preview), `SliceStats` (layers, estimatedMinutes,
    materialGrams, volumeMm3, perObjectMm3), `PrintJobState`, guarded reducer
    `reducePrintJob` + `sliceEligible` / `blockingObjects` helpers.
  - Invariants: non-watertight objects block `start` with actionable
    `blockedBy` names; `cancel` only honoured while slicing (a ready slice is
    immutable); stale/out-of-order stage index dropped (re-base, never
    forced); `send-start` requires ready; `send-error` returns to ready
    (retryable, stats preserved); `error` not allowed from ready/sent.
- `apps/editor/src/state/printjob.ts` (zustand thin wrapper): preflight /
  start / advanceStage / finish / cancel / fail / reportSendStage /
  sendFinished / sendError / reset + type re-exports.
  GOTCHA TS: field/method collisions in the store interface — state fields
  `stage`/`error`/`sendStage` forced renames to advanceStage/fail/
  reportSendStage (zustand `create<Store>()` extends the state shape).
- Tests `tests/printjob-core.test.mjs` (10 cases, JS pure): eligibility,
  preflight block with actionable names, full happy path with staged progress
  and stats, cancel while slicing vs reject-after-finish, stale stage drop,
  slice failure → error, full send flow (negotiate→upload→sent), send failure
  retryable with stats preserved, send-start without ready rejected.
- Gate: unit 425 / fail 0, integration 11, smoke 106 tools, e2e:ui +
  e2e:editor-reload PASS, licenses + architecture OK, sanitize DRY-RUN 0
  files, GATE_EXIT=0. Commit `9624d20` — 3 files, +578.

### S9.5-002 — Slice button + progress + stats panel

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.5-002                                                                        |
| **Title**            | `components/SliceButton.tsx`, `SliceProgress.tsx`, `panels/SliceStatsPanel.tsx` |
| **Priority**         | P0                                                                              |
| **Type**             | Feature                                                                         |
| **Estimated Effort** | M                                                                               |
| **Status**           | ✅ Delivered (19de4f2)                                                          |

#### Context

Primary accent button (disabled preflight), staged progress bar (mono stage labels), stats
panel: layers, estimated time, material grams, volume, per-object contribution (G24). Restyle
Preview controls (layer slider + toggles) with tokens.

#### Acceptance criteria

- [x] Slice enabled iff ≥1 watertight object on plate; progress stages visible; cancel works.
- [x] Stats panel renders all five metrics from real pipeline output; Preview restyled.

#### Implementation notes

- `bridge/types.ts`: `SliceStats` (layers, estimatedMinutes, materialGrams,
  volumeMm3, perObjectMm3), `SliceRequest` (plateId, optional layerHeightMm /
  infillPercent), `SliceResult` (ok, revision, stats, blockedBy) — the frozen
  slice contract behind the provider swap.
- `bridge/mock.ts`: G24 stats estimator `computeSliceStats` (PLA density
  1.24 g/cm³, 0.2 mm layers, ~40 mm³/s throughput; layers = ceil(maxZ/layer),
  grams = volume·density, per-object share; AABB fallback when volumeMm3 is 0) + the real `slice()` lane on the handle: filters the authoritative
  snapshot by plate (`DEFAULT_PLATE_ID` from plates-core), rejects
  non-watertight objects with actionable `blockedBy` names, never advances
  the revision (slicing is read-only).
- `state/printjob-core.ts`: `SliceStats` now type-imported from
  `bridge/types.ts` (single source of truth — mock and machine share the
  shape; type-only import keeps the core headless).
- `components/SliceButton.tsx` (header, next to workspace tabs): primary
  accent action, enabled iff `sliceEligible(objectsOnPlate(active.id))` (≥1
  and all watertight on the ACTIVE plate); click preflights, starts the
  staged sequence (260 ms per stage) then calls the real lane and
  `finish(stats)` + success toast; disabled while slicing/sending.
- `components/SliceProgress.tsx` (footer): segmented 5-stage bar (prepare →
  planar-core → IR → postprocess → preview) with mono `stage/total · pct`
  meta + Cancel (honoured by the machine only between stages).
- `panels/SliceStatsPanel.tsx` (footer): 4-metric grid (layers, est. time,
  material, volume) + per-object breakdown, rendered only when the job
  reaches ready; hidden on cancel/reset. Preview controls were already
  restyled with tokens in S9.1-003 (glass-fill-2/blur-2 floating control).
- App.tsx mounts the button in the header and progress + stats in the
  footer. styles.css gains `.slice-btn` / `.slice-progress*` /
  `.slice-stats*` (accent fill, token track, mono numerals).
- Tests `tests/slice-lane.test.mjs` (7 cases, JS pure): layers from max
  stack height, volume/material/time derivation, AABB fallback for
  zero-volume, zero-bounds no-crash, active-plate filter, full lane through
  `fetchSceneSnapshot().slice()` (happy path), non-watertight block with
  actionable names. GOTCHA: block test runs BEFORE the happy path — the
  happy path mutates the module-level mock scene (removes the offender).
- Browser-verified: Slice disabled while sphere-non-watertight is on the
  plate → delete → enabled → click → "Slicing · prepare…" + staged progress
  - Cancel → stats panel (140 layers, 12 min, 35.2 g, 28,384 mm³; cone
    20,384 / cube 8,000 mm³) → reload restores the blocked state.
- Gate: unit 432 pass (was 425, +7) / fail 0, integration 11, smoke 106
  tools, e2e:ui + e2e:editor-reload PASS, licenses + architecture OK,
  sanitize DRY-RUN 0 files, GATE_EXIT=0. Commit `19de4f2` — 9 files, +686.

### S9.5-003 — Printer picker + connection state

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.5-003                                                           |
| **Title**            | Printer discovery from `ANYCUBIC_PRINTER_IPS` env + connection LED |
| **Priority**         | P0                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | M                                                                  |
| **Status**           | ✅ Delivered (aacadd6)                                             |

#### Context

G43. Printer/device picker lists discovered printers (env `ANYCUBIC_PRINTER_IPS`, comma list —
**no hardcoding**); connection status LED (online/offline); selecting a target arms the send
flow. Device info read-only via the existing bridge; no control orders go out without the
approval dialog.

#### Acceptance criteria

- [x] Picker lists env-discovered printers; LED reflects reachability; selection arms send.
- [x] No send without confirmation; no hardcoded device identifiers.

#### Implementation notes

- `bridge/types.ts`: frozen `PrinterInfo` (id, name, ip, machineType,
  reachable tri-state, lastSeenAt) + `PrinterListResult` (source `"env"`)
  — doc comment G43: identifiers come ONLY from `ANYCUBIC_PRINTER_IPS`,
  never hardcoded.
- `state/printers-core.ts` (dependency-free, headless-testable): strict
  `isValidIp` (IPv4 dotted-quad octets ≤255, IPv6 literal with `:`),
  `parsePrinterIps` (comma-split, trim, dedupe, invalid list),
  `printerId`/`printerName`, `PrintersState`, `reducePrinters` events
  (probe-start / probe-done / select) with guards: probe rejected while in
  flight, probe-done rejected when idle, unknown select rejected, select
  null clears.
- `bridge/mock.ts`: `discoverPrinters(rawEnv)` lane on the handle — pure
  map over parsed IPs, no fetch (probe is the React layer's job);
  `BridgeContract.discoverPrinters` added.
- `state/printers.ts` (zustand store): owns `import.meta.env` +
  `fetch`; `probeReachability` tries ports 990 / 6000 / 8080 with
  `mode: "no-cors"` + AbortController timeout (990/6000 are browser
  unsafe ports → degrade to offline; 8080 is the probe fallback).
- `components/PrinterPicker.tsx` (header popover `details/summary`, G43):
  LED tri-state `.printer-led` probing/online/offline; auto-probe on
  mount; refresh re-probes; empty state + hint for missing/invalid env;
  rows with `title="Arm send target {ip}"`, selection arms send.
- `vite.config.ts`: `envPrefix: ["VITE_", "ANYCUBIC_PRINTER_IPS"]` —
  deliberately NOT generic `ANYCUBIC_` (tokens stay server-side).
- Tests `tests/printers-lane.test.mjs` (9 cases, JS pure): parse
  dedupe/trim/invalid, empty env hint, invalid-only hint, initial
  tri-state, probe-done fold, probe-in-flight guard + unknown select,
  idle probe-done rejection, lane discover (2 printers, sanitized id),
  lane with invalid-only env. NOTE: `not-an-ip` was once accepted by a
  loose regex — hardened with `isValidIp`.
- Browser-verified (dev server with `ANYCUBIC_PRINTER_IPS=127.0.0.1`):
  empty env → "No printer" + hint; with env → "Pick printer" list
  "Printer @ 127.0.0.1"; LED offline → online when a probe server
  answered on 8080 (no-cors); selection arms send (trigger shows IP,
  row `data-selected` + check, popover closes); footer "refreshed · env".
- Gate: unit 441 pass (was 432, +9) / fail 0, integration 11, smoke 106
  tools, e2e:ui + e2e:editor-reload PASS, licenses + architecture OK,
  sanitize DRY-RUN 0 files, GATE_EXIT=0. Commit `aacadd6` — 10 files,
  +920.

### S9.5-004 — Send-to-print dialog

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9.5-004                                                                   |
| **Title**            | `dialogs/PrintJobDialog.tsx` reusing approval-card pattern → send → toasts |
| **Priority**         | P0                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | M                                                                          |
| **Status**           | ✅ Delivered (5556d00)                                                     |

#### Context

Job confirmation dialog reuses the S9-006 approval-card pattern (pending/approved/rejected
states, token hashing); send progress + completion toast; error states (offline/region).
`bridge/mock.ts` gains slice-job + progress + printer lanes.

#### Acceptance criteria

- [x] Confirmation dialog shows job summary; confirm sends (mock), progress + completion toast.
- [x] Offline/region errors surface as semantic toasts; approval card semantics preserved.

#### Implementation notes

- Bridge contract (G25): `SendRequest` (printerId, ip, stats, summary — the
  card shows a human summary, never a raw control order) + `SendResult`
  (`ok:true` taskId | `ok:false` with semantic `offline`/`region`/`unknown`).
- Mock lane `sendJob` (headless-deterministic): offline printers / region
  block via module-level test seams (`setMockOfflinePrinters`,
  `setMockRegionBlocked`) — the React layer never sets them (reachability
  lives in the LAN probe); success mints `mock-task-{revision}`.
- `printjob-core.ts`: `tokenHash` (FNV-1a **32-bit**, integer-exact —
  the 64-bit literal exceeded `Number.MAX_SAFE_INTEGER` and failed the
  `no-loss-of-precision` lint, so it was swapped for the 32-bit variant
  that still pins the exact approved payload), `sendTokenFor` (serialises
  `ip|layers|minutes|volume`), `reduceSendJob` (open → pending card with
  `tokenHashHex`; decide → approved/rejected + `lastApprovedHash` recorded
  only on approval; close → clear). Never auto-executes.
- `printjob.ts` store: `openSendApproval` / `decideSendApproval` /
  `closeSendApproval`; store initializer carries `approval: null` +
  `lastApprovedHash: undefined` (typed on `PrintJobStore`); `reset` clears
  the card.
- `dialogs/PrintJobDialog.tsx`: pending card shows summary + target + token
  hash; a payload mismatch after approval is surfaced as a re-approve
  requirement (hash gate in `runSend`); approve drives `send-job` lane with
  staged progress (negotiate → upload → queue); offline → warning toast,
  region → error toast, success → taskId toast. Mounted in the App footer
  next to `SliceStatsPanel`.
- `styles.css`: `.print-job-*`, `.send-progress*`,
  `.approval-target/-token/-mismatch/-task` reusing existing tokens
  (no `:root` redefinition).
- Tests (`tests/send-job.test.mjs`, 10 cases): tokenHash deterministic +
  payload-sensitive, `sendTokenFor` stable, `reduceSendJob`
  open/approve/reject/re-decide(unknown id)/close, lane happy/offline/region
  via test seams — all headless, no network.
- Gate: format + lint + typecheck + unit 451 + integration 11 + rust +
  build + smoke 106 + e2e ×2 + licenses + architecture + sanitize
  DRY-RUN 0 files — EXIT:0.

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
