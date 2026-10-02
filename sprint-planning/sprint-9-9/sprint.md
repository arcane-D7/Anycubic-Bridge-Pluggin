# Sprint 9.9 — Printer Data Core & Device Panel (read side)

## Sprint Metadata

| Field                 | Value                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Printer data ingestion, polling, Device panel + status bar (read-only)                                                                               |
| **Sprint Goal**       | Bring ALL read-only printer data (identity, temps, cooling, ACE slots, print state, capabilities) into the editor UI, mirrored for the future Agent. |
| **Duration Estimate** | ~2 weeks                                                                                                                                             |
| **Priority**          | P0                                                                                                                                                   |
| **Sprint Type**       | Feature (integration)                                                                                                                                |
| **Primary Owner**     | apps/editor + bridge + MCP server bridge                                                                                                             |
| **Source**            | User request 2026-10-02 + Consultor report §A/§B for the read side (T.1–T.6)                                                                         |
| **Depends On**        | Sprints 9.1–9.8 (everything)                                                                                                                         |
| **Status**            | ⏳ Planned                                                                                                                                           |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.9-00x): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

Give the editor full read access to the printer. The server/MCP already holds 553 property
paths (identity, `tempature`, fans, ACE slots/material, print state, storage, capabilities —
see `docs/printer-property-map.md`). This sprint lands: the `PrinterSnapshot` schema +
agnostic path map (no hardcoded model/IDS), the polling store with adaptive frequency and
stale-while-revalidate, the Device panel (monitor + filaments/ACE read-only) and the
always-visible status bar with alert toasts. All read paths are also consumable by the
future Agent (same store; rights come in Sprint 9.11). No write actions this sprint — every
write (temp target, fans, speed, pause/stop, dryer, auto-feed) is Sprint 9.10.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.9-001 — PrinterSnapshot schema (agnostic, versioned)

| Field                | Value                                                     |
| -------------------- | --------------------------------------------------------- |
| **Ticket ID**        | S9.9-001                                                  |
| **Title**            | `bridge/types.ts`: `PrinterSnapshot`, `AceBox`, `AceSlot` |
| **Priority**         | P0                                                        |
| **Type**             | Feature (contract)                                        |
| **Estimated Effort** | S                                                         |
| **Status**           | ⏳ Planned                                                |

#### Context

Consultor §B.1. Declarative schema versioned (`schemaVersion: 1`), all telemetry fields
nullable (a bare Kobra 3 differs from Kobra S1 + 2×ACE — never assume). Units SI (°C,
%, seconds, mm), enums with names (`PrinterState`, `speedMode`, `editOrigin`) not raw
numbers. Capabilities kept raw (`Record<string, boolean>`).

#### Acceptance criteria

- [x] `PrinterSnapshot` covers identity, buildVolume, temps (nozzle/bed/chamber), cooling,
      print state, ACE boxes (slots, dryer, auto-feed, loaded slot, humidity), motion, AI,
      lights, peripherals, storage, capabilities + `raw` mirror.
- [x] `AceSlot` maps FILAMENT_STATES ⊂ {empty, unknown, identified, identifying}; `edit_status`
      0/1 → `editOrigin: 'rfid'|'manual'`; `-1` sentinel → `null`.
- [x] Unit tests: normalisation, sentinels, no real IDs/values in source.

### S9.9-002 — Agnostic printer path map (553 MCP paths → snapshot)

| Field                | Value                                              |
| -------------------- | -------------------------------------------------- |
| **Ticket ID**        | S9.9-002                                           |
| **Title**            | `printer-path-map.ts` + pure mapper + `raw` mirror |
| **Priority**         | P0                                                 |
| **Type**             | Feature (mapping)                                  |
| **Estimated Effort** | M                                                  |
| **Status**           | ⏳ Planned                                         |

#### Context

Consultor §B.2. Declarative (JSON-parseable) map `path → snapshot field + normalizer`
(°C, /100, layer+1, sentinel `-1→null`). Unmapped paths land in `raw: Record<string, unknown>`
(DevTools/Agent diagnostics). Model ids treated as opaque keys (visibility driven by
`capabilities`, never by interpreting `modelName`).

#### Acceptance criteria

- [x] Map covers groups 1–12 of the Consultor table (identity, temp, cooling, print, ACE,
      motion, AI, lights, peripherals, storage, capabilities, diagnostics).
- [x] Unknown paths → `raw`; no hardcoded model/firmware values (fixtures only in `tests/`).
- [x] Unit tests with redacted fixture payloads from `docs/evidence/`.

### S9.9-003 — Printer device store + polling engine

| Field                | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| **Ticket ID**        | S9.9-003                                                        |
| **Title**            | `state/printer-device.ts` (pure) + adaptive polling + SWR cache |
| **Priority**         | P0                                                              |
| **Type**             | Feature (state)                                                 |
| **Estimated Effort** | M                                                               |
| **Status**           | ⏳ Planned                                                      |

#### Context

Consultor §B.3. Pure zustand store (headless-testable like printers-core/plates-core).
Adaptive polling: 1.5–2 s when printing/paused, 10–15 s idle, 30–60 s background
(document.hidden), ACE fixed 30 s. `capturedAt` + `staleThreshold` → `pollingStatus`
{idle|polling|stale|offline}; per-group diff so only changed fields propagate (fewer R3F
re-renders).

#### Acceptance criteria

- [x] Frequencies per the matrix; state flips to 1.5 s on `printing` automatically.
- [x] Selectors: `selectActivePrint`, `selectFilamentColors`, `selectLowestFilamentPct`,
      `selectTempsNeedingAttention` — all unit-tested.
- [x] Network failure → `pollingStatus: offline` + last good snapshot kept (SWR).

### S9.9-004 — Device panel: Monitor (temps, fans, peripherals, camera on-demand)

| Field                | Value                                              |
| -------------------- | -------------------------------------------------- |
| **Ticket ID**        | S9.9-004                                           |
| **Title**            | `panels/DevicePanel.tsx` — Monitor tab (read-only) |
| **Priority**         | P0                                                 |
| **Type**             | Feature (UI)                                       |
| **Estimated Effort** | L                                                  |
| **Status**           | ⏳ Planned                                         |

#### Context

Consultor §C.1 left column. Temp cards (current big, target small), fan sliders (read-only
during monitoring), peripheral chips (camera/ACE/USB), camera on-demand only (never preload —
firmware turns the chamber light on at capture start). Render sections only when the model
has them (`capabilities`-driven). New Device button in the editor header next to the picker.

#### Acceptance criteria

- [x] Sections gated by `capabilities`; empty/stale states well represented.
- [x] Camera starts on user action only; player chooses H.264/FLV by model feature.
- [x] i18n PT/EN keys added; no hardcoded unit strings shown raw.

### S9.9-005 — Device panel: Filaments / ACE slots (read-only)

| Field                | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| **Ticket ID**        | S9.9-005                                                         |
| **Title**            | `DevicePanel` — Filaments tab: ACE slot grid + dryer + auto-feed |
| **Priority**         | P0                                                               |
| **Type**             | Feature (UI)                                                     |
| **Estimated Effort** | M                                                                |
| **Status**           | ⏳ Planned                                                       |

#### Context

Consultor §C.1 right column. Grid of slots (4 per box, up to 2 boxes): real color swatch
(from `color_group`), material name, `remaining%` progress-ring (amber <50%, red <15% →
toast), RFID-vs-manual badge, box temp/humidity, dryer state + temp + remaining, auto-feed
toggle (read-only view here; write in 9.10), `loaded_slot` highlighted.

#### Acceptance criteria

- [x] 1–2 boxes supported; `editOrigin` badge; thresholds → toasts.
- [x] `loaded_slot` visual state; dryer state machine displayed from snapshot.
- [x] Unit tests for progress-ring thresholds + state mapping.

### S9.9-006 — Status bar + alert toasts

| Field                | Value                                                |
| -------------------- | ---------------------------------------------------- |
| **Ticket ID**        | S9.9-006                                             |
| **Title**            | `components/PrinterStatusBar.tsx` + threshold toasts |
| **Priority**         | P1                                                   |
| **Type**             | Feature (UI)                                         |
| **Estimated Effort** | M                                                    |
| **Status**           | ⏳ Planned                                           |

#### Context

Consultor §C.2/C.4. Slim strip over the viewport (or footer): `[Nozzle 210/220 °C] [Bed 60/60 °C]
[Layer 12/120] [42 %] [1:23] [❄34 %] [ACE slot 3]` + LED. Each chip opens the Device tab at its
section. Alerts: filament <15 % → toast+dot, <5 % persistent; temp outside the material window
(from `recommendedTempsC`) → preventive toast; ACE errors (feed/slot states 129–135) → red
toast + DevTools link; reachability loss → reconnect banner.

#### Acceptance criteria

- [x] Chips clickable to the right Device section; priority order (print > temps > filament > camera).
- [x] All thresholds testable + covered; i18n PT/EN.
- [x] `pnpm run check` EXIT:0 gate closing the sprint.
