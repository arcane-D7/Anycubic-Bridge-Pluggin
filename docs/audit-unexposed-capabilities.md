# Audit: unexposed capabilities — register and disposition

Date: 2026-09-11. Second full-system audit (after the command-bus expansion).
Goal: find EVERY function that exists in the codebase but is unreachable
through an MCP tool, expose what is safe and validated, and document the
disposition of everything else.

## Audit method

1. Full inventory of all 49 registered tools (direct + extension modules).
2. Per-module classification of every export as EXPOSED / UNEXPOSED.
3. Cross-check of MQTT type strings, HTTP endpoints and order ids against the
   catalogs.
4. Comparison of the documented validated-command table
   (`docs/research/expansion-research.md` §2) against the executable bus.

## Gaps found and EXPOSED (this iteration)

| Gap                                                       | Was reachable only via                                         | Now exposed as                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Cloud file upload (lock → presigned PUT → claim → unlock) | bridge `POST /cloud/print-local`, CLI `cloud-upload-print.mjs` | **`account_file_upload`** (confirm-gated; orphaned locks deleted on failure)                                            |
| Upload + start print locally sliced file                  | bridge `/cloud/print-local` only                               | **`account_print_local`** (upload → gcode resolve → order-1 start + verification; `confirm` + `confirm_word:"EXECUTE"`) |
| `print/update` — settings on the RUNNING job              | documented (`expansion-research.md`, COMMAND_MAP), not in bus  | **`print_update`** in `printer_command_send` (thermal; any subset of nozzle/bed/fan/speed mode)                         |
| `video/startCapture` / `stopCapture`                      | documented, not in bus                                         | **`video_start_capture` / `video_stop_capture`** (state)                                                                |
| `axis/turnOff` — release steppers                         | documented, not in bus                                         | **`axis_turn_off`** (motion; EXECUTE word required)                                                                     |
| `CloudConnectionManager.release()`                        | nothing                                                        | **`printer_connection_close`**                                                                                          |
| `ANYCUBIC_MATERIALS` (dead data)                          | nothing                                                        | **`printer_material_catalog`**                                                                                          |
| Camera FLV snapshot                                       | CLI-only probes                                                | **`printer_lan_camera`** (ffmpeg fixed argv, no shell, frames-limited)                                                  |

Tool count: 49 → **54**. Bus commands: 14 → **18**
(1 read, 7 state, 3 thermal, 3 motion, 4 job).

## Disposition of remaining UNEXPOSED items (deliberate)

| Item                                                                                                                                                                            | Where                                  | Why it stays unexposed                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy HTTP control wrappers (`setTemperature`, `setFanSpeed`, `setLight`, `setAiDetection`, `moveAxis`, `setAceSlot`, `aceDry`, `aceAutoFeed`, `aceGetInfo`, `listLocalFiles`) | `scripts/anycubic-cloud.mjs:200-249`   | Superseded by the MQTT bus (which carries reply correlation); HTTP `sendOrder` acceptance is not device execution (10115 / order-id history). Keep off the MCP surface.                   |
| Legacy ORDER ids without wrappers (1216 speed, 1227 motors-off, 1235-1237 file lists/deletes, 1254 feed, 1260 camera-open)                                                      | `scripts/anycubic-cloud.mjs:36-62`     | Unvalidated; 1236/1237 are **destructive**. The MQTT bus covers speed (print*update), motors-off (axis_turn_off), camera (video*\*), feed (ace_feed) with better evidence.                |
| `authHeadersPublic`                                                                                                                                                             | `scripts/anycubic-cloud.mjs:159`       | Credential-adjacent by design; ad-hoc CLI probes only.                                                                                                                                    |
| `file/deleteLocal` / `file/deleteUdisk`                                                                                                                                         | COMMAND_MAP (`reference`)              | Destructive and unvalidated — will not be exposed without live validation on sacrificial files.                                                                                           |
| LAN `print/start` payload                                                                                                                                                       | COMMAND_MAP (`reference`)              | Unverified on this firmware (LAN MQTT port 9883 closed, printer in cloud mode); the cloud order-1 path is the live-validated start.                                                       |
| `sourcesByTransport`, `commandByTypeAction`                                                                                                                                     | `scripts/printer-property-catalog.mjs` | Offline helpers; equivalent data is fully reachable via `printer_property_catalog` / `printer_hidden_command_map`.                                                                        |
| 3MF repair / binary STL writer (`dishrack-repair.mjs`, `position-dishrack.mjs`)                                                                                                 | `scripts/`                             | One-off task scripts (specific part repair), not printer control; candidate for a future `mesh_repair_3mf` tool but out of scope here.                                                    |
| `cad-dev.mjs`                                                                                                                                                                   | `scripts/`                             | BROKEN: imports missing `src/cad-server.js`. Dead file — delete or rewrite against the bundled server.                                                                                    |
| CLI probes (`cloud-sweep-readonly`, `monitor-print`, `check-print-state`, `probe-*`, `lan-*-probe`)                                                                             | `scripts/`                             | All read-only capabilities they exercise are already first-class MCP tools (`printer_read_all`, `printer_connection_status`, `account_cloud_live_diagnostics`); kept as engineering CLIs. |
| MQTT `video` READ source                                                                                                                                                        | —                                      | No query projection ever observed (camera is advertised via `info.urls.rtspUrl` and controlled via video actions); nothing to read yet.                                                   |
| `tempature/auto` publish                                                                                                                                                        | COMMAND_MAP (`reference`)              | Report-only action observed; publish semantics unverified.                                                                                                                                |

## Validation

```powershell
node --test tests/audit-gap-tools.test.mjs   # 12 tests
node --test tests/*.test.mjs                 # 62 tests, all suites
node scripts/verify-command-bus-mcp.mjs      # 54 tools; bus = 18 commands
node scripts/verify-full-read-mcp.mjs        # 54 tools; catalog unchanged (553 paths)
```

## Live-flow notes

- `account_file_upload` was validated live on 2026-09-05 (lock id 73911458, S3
  PUT 200, claim id 88637611, user_files listing). The gcode_id is generated
  asynchronously; the tool polls userFiles briefly and reports honestly when
  the cloud has not produced one yet.
- ⚠️ Raw G-code uploads do NOT automatically get full slice info — the cloud
  regenerates it only for slicer-pipeline uploads. `account_print_local`
  reports this explicitly instead of dispatching an order the device would
  reject with 10115.
