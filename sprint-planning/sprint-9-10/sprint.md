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
| **Status**            | ⏳ Planned                                                                                                                                                                                      |

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
| **Status**           | ⏳ Planned                                           |

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
| **Status**           | ⏳ Planned                                                    |

#### Context

Consultor §C.1/§E. Nozzle/bed target steppers (hint: only applies to the active job — the
Anycubic protocol has no preheat order), fan sliders, `speed_mode` selector
(silent/standard/sport → 1/2/3), lights toggles+sliders. All go through
`printer_command_send` with `confirm: true`; replies (success/refused/timeout) surface as
toasts. Stop remains a modal-confirmed cancel (verified: Stop cancels, not pauses).

#### Acceptance criteria

- [x] Every control maps to a validated bus command; confirm gates enforced.
- [x] Refused/timeout states shown distinctly; no silent failures.
- [x] Unit tests for the command envelope construction (no network).

### S9.10-003 — ACE write: dryer, auto-feed, slot mapping

| Field                | Value                                             |
| -------------------- | ------------------------------------------------- |
| **Ticket ID**        | S9.10-003                                         |
| **Title**            | ACE dryer start/stop, auto-feed toggle, slot bind |
| **Priority**         | P1                                                |
| **Type**             | Feature                                           |
| **Estimated Effort** | M                                                 |
| **Status**           | ⏳ Planned                                        |

#### Context

ACE dryer (`ace_dry`), auto-feed (`ace_auto_feed`), slot mapping (`ace_set_slot`) from the
Device → Filaments tab. User direct with confirm; Agent gated. `use_ams` requires explicit
`ams_box_mapping`; painted slot is never assumed physical.

#### Acceptance criteria

- [x] Dryer start/stop + state feedback; auto-feed toggle persists visibly.
- [x] Slot bind uses the manual path (`edit_status:1`) — never forges an RFID tag.
- [x] Unit tests for payloads (box/slot mapping, confirm word).

### S9.10-004 — Real print flow: snapshot in approval card + filament guard

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.10-004                                                          |
| **Title**            | PrintJobDialog uses live snapshot; blocks on insufficient filament |
| **Priority**         | P1                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | M                                                                  |
| **Status**           | ⏳ Planned                                                         |

#### Context

The approval card currently shows MOCK `SliceStats`. Swap to live snapshot: real temps,
filament color/slot per extruder, remaining % per arranged filament. Validate the requested
filament exists in a loaded ACE slot with enough `remainingPct` before approving send; block
with a clear message otherwise. Keep the token-hash + approve/reject card.

#### Acceptance criteria

- [x] Card derives from live snapshot (temps, filament colors, remain %).
- [x] Insufficient/absent filament → send blocked with actionable message.
- [x] e2e smoke: approve → send → completion toast (mock lane seeds).
