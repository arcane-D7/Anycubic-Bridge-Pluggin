# Sprint 9.10 — Printer Actions (write side, gated)

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Write access: capability surface, control through `printer_command_send`, real print flow                                                                                                       |
| **Sprint Goal**       | Let the USER control the printer from the editor (temp targets, fans, speed mode, lights, pause/resume/stop, dryer, auto-feed) behind the existing safety gates; Agent writes require approval. |
| **Duration Estimate** | ~2 weeks                                                                                                                                                                                        |
| **Priority**          | P0                                                                                                                                                                                              |
| **Sprint Type**       | Feature (integration, gated writes)                                                                                                                                                             |
| **Primary Owner**     | apps/editor + MCP server (`printer_command_send`)                                                                                                                                               |
| **Source**            | User request 2026-10-02 + Consultor report §B.4/§C.1 (write side, T.7–T.8)                                                                                                                      |
| **Depends On**        | Sprint 9.9 (snapshot + panel)                                                                                                                                                                   |
| **Status**            | ✅ Complete (4/4)                                                                                                                                                                               |

#### Implementation Notes (S9.10-001)

`apps/editor/src/state/capability-surface.ts` — pure headless shared policy:

- `READ_ACTIONS` (11) — `snapshot.get`, `printer.identity/temps/fans/print/ace/motion/
ai/lights/peripherals/storage` — kind `"read"`, `requiresApproval: "never"`.
- `WRITE_ACTIONS` (14) — temp targets, fans, speed mode, lights, ACE (dry/autoFeed/
  bindSlot), print pause/resume/stop (kind `"write"`, `requiresApproval: "user"`),
  plus `raw.command` (kind `"raw"`, `agentBlocked: true` — DevTools + confirm only).
- Policies: `allowedFor(actor, entry)` — reads direct for both; writes direct for
  user, allowed for agent but always via approval card (`needsApproval(actor, entry)`
  true for agent writes); raw → user only, agent BLOCKED structurally.
- `buildSurface` indexes by action; `entryFor`; `surfaceIsValid` rejects duplicates.
- Same object imported by UI control surface and the Agent tool surface (S9.12) —
  no second copy of the rules.
- Tests: `tests/capability-surface.test.mjs` (8) — validity, duplicates, read
  direct, user direct / agent approval, raw blocked, lookup, classification.

Gate EXIT:0 (`$env:TEMP\s9-10-001-check1.log`): unit **628** pass/0 fail, integration
11, rust OK, build dist 254883 B, smoke 106, e2e ×2 PASS, licenses 59, arch OK,
sanitize DRY-RUN 0.

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.10-00x): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

Turn the read-only Device panel into a control surface. The MCP server already exposes
`printer_command_send` (light, fans, temperature, ACE dry/feed/auto-feed/slot, AI switch,
axis move/home, print pause/resume/stop, local-file start) with `confirm: true` gates and
`EXECUTE` word for motion/job. This sprint wires the UI steppers/toggles/buttons to those
commands (user direct; Agent only with approval card — the S9-006 pattern), and makes the
print approval card show REAL snapshot data instead of MOCK stats, blocking when the
selected filament is insufficient/absent. A declarative `capability-surface.ts` (user vs
Agent policy) lands here.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.10-001 — Capability surface: user vs Agent policy

| Field                | Value                                                |
| -------------------- | ---------------------------------------------------- |
| **Ticket ID**        | S9.10-001                                            |
| **Title**            | `capability-surface.ts` (pure, shared by UI + Agent) |
| **Priority**         | P0                                                   |
| **Type**             | Feature (contract/policy)                            |
| **Estimated Effort** | M                                                    |
| **Status**           | ✅ Done (`f1efc86`)                                  |

#### Context

Consultor §B.4. Declarative policy `{ action, capabilityKey, requiresApproval: 'never'|'user'|'agent' }`
and permission matrix: reads → user/Agent direct; writes (temp, fans, speed, lights, dryer,
auto-feed, pause/resume/stop) → user direct (safety gates), Agent requires approval card;
raw `printer_command_send` (hidden) → DevTools+confirm only, Agent blocked by policy.

#### Acceptance criteria

- [x] Same policy object imported by UI and Agent tool surface (parity of rules).
- [x] Agent write path forces the S9-006 approval card; no bypass.
- [x] Unit tests: policy table coverage, blocked actions for Agent.

### S9.10-002 — Control wiring: temps, fans, speed mode, lights

| Field                | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| **Ticket ID**        | S9.10-002                                                     |
| **Title**            | Wire Device Monitor steppers/sliders → `printer_command_send` |
| **Priority**         | P0                                                            |
| **Type**             | Feature                                                       |
| **Estimated Effort** | L                                                             |
| **Status**           | ✅ Done (`100fde0`)                                           |

#### Implementation Notes (S9.10-002)

Wiring Device Monitor → `printer_command_send`:

- `apps/editor/src/state/printer-control-core.ts` (pure, headless) — the envelope
  grammar: `buildCommandEnvelope(action, payload)` maps each write to the bus
  command with the schema windows (nozzle 0–320 °C, bed 0–120 °C, fan 0–100 %,
  brightness 0–100) — `temperature_set`, `fan_set` (fan: `"part"`),
  `print_update` (speed mode silent/standard/sport → 1/2/3 via `SPEED_MODE_NUM`),
  `light_control` (on / on+brightness). Every envelope is `confirm: true`;
  motion/job would add `confirm_word: "EXECUTE"` (not emitted by Monitor here).
- `apps/editor/src/bridge/mock.ts` — `printerControl(req)` lane: TRANSPORT only,
  refuses envelopes without `confirm:true` (kind `invalid`), deterministic seams
  (`setMockControlResults` / `setMockControlRefused` / `setMockControlTimeout`)
  for refused/timeout paths; results are semantic
  (`accepted | refused | timeout | invalid`).
- `apps/editor/src/bridge/types.ts` — `PrinterControlRequest` + `PrinterControlResult`.
- `apps/editor/src/state/printer-control.ts` — thin zustand store `sendControl()`
  → builds envelope → lane → DISTINCT toasts (accepted success / refused warning /
  timeout warning / invalid error); lane never called on invalid envelope.
- `DevicePanel.tsx` — steppers on temp targets (+/− 5°C), fan part (+/− 5 %),
  speed select (silent/standard/sport), lights toggle + brightness steppers;
  all capability-gated (`tempature`/`fans`/`print`/`light`), `busy` locks the
  controls while a command is in flight.
- i18n: `control.*` keys (accepted/refused/timeout/invalid/failed + step arias).
- Tests: `printer-control.test.mjs` (10 — envelope grammar + bounds + agent raw
  block), `printer-control-lane.test.mjs` (4 — lane accepted/invalid/refused/timeout
  seams), `printer-control-store.test.mjs` (4 — outcome→toast mapping headless).

Gate EXIT:0 (`$env:TEMP\s910002.log`): unit **646** pass/0 fail, integration 11,
rust OK, build OK, smoke 106, e2e ×2 PASS, licenses 59, arch OK, sanitize 0.

### S9.10-003 — ACE write: dryer, auto-feed, slot mapping

| Field                | Value                                             |
| -------------------- | ------------------------------------------------- |
| **Ticket ID**        | S9.10-003                                         |
| **Title**            | ACE dryer start/stop, auto-feed toggle, slot bind |
| **Priority**         | P1                                                |
| **Type**             | Feature                                           |
| **Estimated Effort** | M                                                 |
| **Status**           | ✅ Done (`751e65d`)                               |

#### Implementation Notes (S9.10-003)

ACE writes (dryer, auto-feed, manual slot bind):

- `printer-control-core.ts` — three new grammar actions: `ace.dry`
  (`ace_dry` flat args `stop` / `target_temp` 0–80 / `duration_min` 0–1440 /
  `remain_time:0`), `ace.autoFeed` (`ace_auto_feed` `disabled`→`enabled`),
  `ace.bindSlot` (`ace_set_slot` `box_id`/`slot_index` 0–9, `material_type`,
  `color` [R,G,B]) — all `confirm: true`. Bounds per the schema; optional
  dryer fields only validated when provided (defaults 45°C / 240 min).
- **Manual path only** — the bind form sends the manual `ace_set_slot`
  (edit_status stays 1): we NEVER forge an RFID tag. Consumables stay in
  the local spool registry (spool_bind contract, P1).
- `DevicePanel.tsx` — Filament tab gained per-box dryer toggle
  (`device-dryer-toggle`), auto-feed toggle (`device-autofeed-toggle`), and a
  `BindSlotModal` for empty slots (`device-bind-modal`); all gated by
  capability `multiColorBox` and locked while a command is in flight (`busy`).
- i18n: `device.fil.bindSlot/material/color/cancel/bind` (EN + PT_BR).
- Tests: +8 envelope ACE tests (dryer start/stop/bounds, auto-feed on/off,
  bind color triple + refusals, box window) + 1 lane test (ACE over lane).

Gate EXIT:0 (`$env:TEMP\s910003.log`): unit **654** pass/0 fail (+8), integration
11, rust OK, smoke 106, e2e ×2 PASS, licenses 59, arch OK, sanitize 0.

### S9.10-004 — Real print flow: snapshot in approval card + filament guard

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.10-004                                                          |
| **Title**            | PrintJobDialog uses live snapshot; blocks on insufficient filament |
| **Priority**         | P1                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | M                                                                  |
| **Status**           | ✅ Done (`7f2e090`)                                                |

#### Implementation Notes (S9.10-004)

Real print flow — live snapshot in the approval card + filament guard:

- `apps/editor/src/state/printer-print-guard-core.ts` (pure, headless) —
  `printReady(boxes)` decides sendability from the LIVE ACE snapshot:
  no ACE → ready (local spool unknown, honest pass-through); ACE present →
  needs ≥1 identified/manual slot with `remainingPct >= PRINT_MIN_REMAIN_PCT`
  (10%) — hard-block below that, warn below 50%. `identifying` slots are never
  counted. Agnostic — never real printer values.
- `PrintJobDialog.tsx` — three gates on send:
  1. `openCard` refuses to open the approval card when the guard fails with an
     actionable toast;
  2. the card shows a LIVE block (real temps + per-slot ACE swatches + remain
     %, from `usePrinterDevice` snapshot — not MOCK stats);
  3. the Approve button is disabled while blocked AND `runSend` re-checks the
     guard at send time (snapshot may have emptied after the card was shown).
     The token-hash approve/reject card is untouched.
- i18n: `send.blockedTitle` / `send.filamentBlocked` / `send.live.temps` /
  `send.live.ace` (EN + PT_BR).
- Tests: `printer-print-guard.test.mjs` (6 — no-ACE pass, ≥min pass, all-empty
  block, low block, identifying block, warn-only) — the approve→send→completion
  toast flow is already covered by `printjob-core.test.mjs` (send machine) +
  `send-job.test.mjs` (mock lane seeds: success/offline/region).

Gate EXIT:0 (`$env:TEMP\s910004.log`): unit **660** pass/0 fail (+6), integration
11, rust OK, smoke 106, e2e ×2 PASS, licenses 59, arch OK, sanitize 0.

## Sprint Closed — 2026-10-06

All 4/4 tickets delivered; gates green across the whole sprint.

| Ticket    | Commit    |
| --------- | --------- |
| S9.10-001 | `f1efc86` |
| S9.10-002 | `100fde0` |
| S9.10-003 | `751e65d` |
| S9.10-004 | `7f2e090` |

| Gate metric       | Value           |
| ----------------- | --------------- |
| unit tests        | 660 pass/0 fail |
| integration       | 11 pass         |
| rust              | OK              |
| smoke (MCP tools) | 106             |
| e2e ×2            | PASS            |
| licenses          | 59              |
| architecture      | OK              |
| sanitizer dry-run | 0 files         |
