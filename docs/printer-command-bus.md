# Printer command bus — full control surface

Date: 2026-09-11. Implements **every** mechanism command over the cloud MQTT
path, a persistent connection manager, and the corrected cloud print start
(order 1 — live-validated). Companion to `printer-property-map.md` (read surface).

## Audit findings that drove this (2026-09-11)

1. **No cloud write path in the MCP.** The validated client methods existed in
   `scripts/anycubic-cloud.mjs` but no registered tool invoked them; the only
   write tools were LAN-only (`start_print`, `cancel_print`).
2. **`account_print` still used the broken contract** (`order_id: 1`,
   `filetype: 1`) from the 2026-09-07 incident — device error 10115.
3. **Every MQTT call created a fresh connection.** The broker requires a
   deterministic clientId; concurrent sessions with the same identity displace
   each other, so churn caused instability.

All three are fixed.

## New tools (5; 49 total on the server)

| Tool                        | Safety             | Purpose                                                                                                                                                                  |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `printer_command_catalog`   | read-only, offline | Lists the 14 commands with type, action, payload grammar, safety class and required confirmations                                                                        |
| `printer_connection_status` | read-only          | Persistent session health: connected, stats, buffered events                                                                                                             |
| `printer_gcode_resolve`     | read-only          | Resolves a gcode_id → cloud file id + slice metadata (`/work/gcode/infoFdm`)                                                                                             |
| `printer_command_send`      | write, gated       | Executes one command: light, fans, temperature, ACE dry/feed/auto-feed/slot, AI switch, axis move/home, print pause/resume/stop, local-file start                        |
| `printer_print_start`       | write, gated       | Cloud print start with the LIVE-VALIDATED order 1 contract and post-send task verification (2026-09-11: a real task reached `printing` then `finished` on the test unit) |

## Command set (14)

| Class       | Commands                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------- |
| read (1)    | `print_query`                                                                                   |
| state (5)   | `light_control` (live-validated), `fan_set`, `ace_auto_feed`, `ace_set_slot`, `ai_settings_set` |
| thermal (2) | `temperature_set`, `ace_dry`                                                                    |
| motion (2)  | `axis_move` (move/home — homing physically validated), `ace_feed`                               |
| job (4)     | `print_pause`, `print_resume`, `print_stop`, `print_start` (local file)                         |

Cloud print start (`printer_print_start`) is a separate tool because it needs
the full resolution + verification pipeline, not just an envelope publish.

## Safety gates (enforced before ANY network activity)

1. Every non-read command requires `confirm: true` — a schema default can never
   fire an action, and the gate runs before the cloud login.
2. `motion` and `job` commands additionally require `confirm_word: "EXECUTE"`.
3. `use_ams: true` requires an explicit `ams_box_mapping`; `paint_index` is
   never assumed to be a physical slot.
4. `printer_print_start` refuses while the printer reports a busy state
   (`printing`, `paused`, `pausing`, `resuming`, `preheating`, `busy`,
   `calibrating`, `leveling`, `vibrating`, `preheat`).
5. `filetype: 1` with an empty `filepath` (the 10115 malformed order) is
   unbuildable — the constructor rejects it.
6. No automatic retries. Ever. A rejected task must be inspected, not re-sent.

## Stable connection (CloudConnectionManager)

- One persistent, subscribed MQTT session per printer; `acquire()` reuses it
  while healthy and replaces it after an error/close (self-healing).
- Health snapshot (`printer_connection_status`): connected, last activity age,
  counters (connects / published / received), rolling event buffer (500).
- The session survives between tool calls; `release()` ends it gracefully.
- Reply correlation is honest: exact msgid match → `correlated_reply`; same
  type but device-generated msgid → `uncorrelated_report` (the device does use
  its own ids — never infer correlation from arrival order); nothing →
  `timeout`, which is reported as _neither success nor failure_.

## Cloud print start — the LIVE-VALIDATED order 1 contract

Implements every requirement from `cloud-history-reprint-incident-2026-09-07.md`
(updated 2026-09-11 — the 1240 hypothesis was disproven live; START_PRINT is
**order id 1 int**):

1. `assertIdle` busy-guard before anything is sent.
2. `resolveCloudGcode` → `/work/gcode/infoFdm?id=<gcode_id>` (the **G-code id**,
   not the task id). No resolved `file_id` → refuse (the cloud only regenerates
   slice info for slicer uploads).
3. `buildCloudStartPrintBody` → `order_id: 1` (int), `filetype: 0`,
   `file_id`, `file_name`, full `slice_param`, `project_type`, `task_settings`,
   `ams_info` with the explicit mapping, `settings` (no top-level
   msgid/timestamp).
4. HTTP `sendOrder` acceptance is recorded as `http_accepted`, never as success.
5. Post-send verification: the manager watches the live print/info reports and
   `verifyStartedTask` checks that the observed task preserves `model ==
file_id`, `gcode_id`, and has `slice_param`/`slice_result` present, with the
   device in an active preparation state (`print_status` in {1,2,3,4,5,13} or a
   matching `state`). `print_status: 3` (rejected) surfaces the incident note.
6. Result `ok: true` **only** when verified. Otherwise the tool returns
   `http_accepted`, the observed task snapshot, the problems found, and an
   explicit "never re-send automatically" note.

## Files

- `scripts/printer-command-bus-catalog.mjs` — command grammar + safety classes
- `scripts/printer-command-bus.mjs` — manager, gates, order-1 pipeline, executor
- `scripts/printer-command-tools.mjs` — MCP registration
- `tests/printer-command-bus.test.mjs` — 19 tests
- `scripts/verify-command-bus-mcp.mjs` — stdio end-to-end verifier

## Validation

```powershell
node --test tests/printer-command-bus.test.mjs   # 19 tests
node --test tests/*.test.mjs                     # 50 tests, all suites
node scripts/verify-command-bus-mcp.mjs          # 49 tools, gates fire offline
```

Live example (printer idle, token available):

```
printer_command_send { command: "light_control", on: true, confirm: true }
printer_print_start { gcode_id: <id>, confirm: true, confirm_word: "EXECUTE" }
printer_connection_status {}   // counters + buffered reports
```

Still unverified on hardware (never treat as safe defaults): `ai_settings_set`
action name, `print_start` local-file payload shape, absolute-coordinate moves.
See `printer_hidden_command_map` → `unverified` for the authoritative list.
