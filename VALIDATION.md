# Validation report

Date: 2026-08-27 (Europe/Lisbon) — updated 2026-09-11 (74 tools: 54 + 8 expansion
Batch 0 + 3 expansion Batch 2 + 9 Batch 1/2-edge, full property read surface,
persistent cloud command bus with 18 commands, LIVE-VALIDATED order-1 print
start — a real print of a recovery object reached `printing` and `finished` on
the physical test unit (task id per deployment), upload/print-local flows, 95
tests)

## Automated checks (2026-09-11, second+third audit)

- `node --test tests/*.test.mjs`: **95 tests passed** across 7 suites
  (cloud-readonly, printer-http-readonly, printer-full-read, printer-command-bus,
  audit-gap-tools, printer-expansion-tools, printer-edge-tools).
- `node scripts/verify-command-bus-mcp.mjs`: **74 tools**; bus = 18 commands
  (1 read, 7 state, 3 thermal, 3 motion, 4 job); all confirmation gates fire
  offline before any cloud access.
- `node scripts/verify-full-read-mcp.mjs`: 74 tools; catalog = 553 property paths.
- `node scripts/verify-cloud-readonly-mcp.mjs`: pre-existing diagnostics intact.
- `node scripts/smoke.mjs`: **74 tools**; inspect_slicer, account_login (clean
  fail), account_token_status, cad workspace responded.
- Live expansion Batch 0 (2026-09-11, `scripts/expansion-smoke.mjs` + `node
scripts/mcp-call.mjs`): all 8 new read-only tools answered against the real
  account — status snapshot (67 prints, 2.97 kg, 129h35min, ACE Pro slots),
  print history (latest task 0 success/finished), cloud store
  (73.96 MB / 2.00 GB), lifetime metrics, cloud files (10 shelf files, first
  gcode_id 120193034 `recovery-remainder-v3.gcode.3mf`), error catalog (5
  camera/AI categories + 29 failure reason codes), file preview (gcode
  120193034: 92 layers, 27.97 g, 1 color PLA 68.64 g), order registry
  (10 validated-live ids + 40 reference ids).
- Live expansion Batch 2 (2026-09-11, `node scripts/mcp-call.mjs`): 3 new
  read-only tools answered against the real account — cloud projects
  (`/work/project/getProjects`: 74 projects), print metrics
  (`/v2/project/printHistory`: total 65, finished 47, failed 18, clean
  failure_breakdown labels incl. "Print task already exists", "Abnormal slice
  file", "User initiated", "The printer cannot parse the file", "Feed timeout";
  failure_rate_pct 27.69, success_rate_pct 72.31), Prometheus expose
  (`printer_print_count_total 67`, material 2.97 kg, totaltime 129.58 h,
  nozzle 34 °C, hotbed 31 °C, consumables 13/89/0/0 %, ace_drying_status 0).
  Plus N2 upload quota preflight hardening added to
  `scripts/audit-gap-tools.mjs` (`getUserStore` before `lockStorageSpace`).

## Expansion Batch 0 (read-only, live-validated 2026-09-11)

The deep-investigation (P1–P5 → N1–N16, see
`docs/research/expansion-deep-investigation-2026-09-11.md`) delivered **8 new read-only
MCP tools** in `scripts/printer-expansion-tools.mjs`:

| Tool                       | Endpoint(s) used                                             | Purpose                                                    |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `printer_status_snapshot`  | `/work/printer/printersStatus` + `/work/printer/getPrinters` | lifetime + current temps + firmware + ACE slots + features |
| `account_print_history`    | `/v2/project/printHistory` (+ detail)                        | print history + failure-reason labels                      |
| `printer_lifetime_metrics` | aggregates printersStatus                                    | compact dashboard counters                                 |
| `account_cloud_store`      | `/work/index/getUserStore`                                   | upload quota preflight                                     |
| `account_cloud_files`      | `/work/index/userFiles`                                      | cloud shelf metadata (gcode_id, size, md5)                 |
| `printer_error_list`       | `/v3/work_project/getErrorList`                              | camera/AI defect catalog + incident codes                  |
| `printer_file_preview`     | `/work/gcode/infoFdm` / `/work/index/getModelFileInfo`       | slice metadata: layers, dims, per-color usage              |
| `printer_order_registry`   | offline                                                      | order-id vocabulary (validated + reference)                |

## Expansion Batch 2 (read-only infra, live-validated 2026-09-11)

Delivered **3 new read-only MCP tools** plus one hardening to existing flows,
all in `scripts/printer-expansion-tools.mjs` / `scripts/audit-gap-tools.mjs`:

| Tool                     | Endpoint(s) used                                  | Purpose                                                      |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------ |
| `account_cloud_projects` | `/work/project/getProjects`                       | cloud project index (id, name, model, size, timestamps)      |
| `account_print_metrics`  | aggregates `account_print_history` (printHistory) | outcome counters + failure breakdown + success/failure rates |
| `printer_metrics_expose` | aggregates printersStatus                         | Prometheus/OpenMetrics text (counters, gauges, ACE drying)   |
| `account_file_upload`    | hardening: `getUserStore` preflight               | aborts upload when the remaining quota < file size           |

All are `readOnlyHint:true` (the upload hardening is inside an existing tool),
never mutate account or device, pass every output through `redact()`, and share
the session from `printer-command-tools` (JWT from `args.access_token` →
`ANYCUBIC_CLOUD_TOKEN` → Slicer Next debug log). Evidence captured in
`docs/evidence/expansion-probe-*.json`.

Delivered **9 new MCP tools** — Batch 1 (mutating, gated) + Batch 2 infra
(N12/N13/N14) — in a new module `scripts/printer-edge-tools.mjs`, injected
into `dist/server.mjs` after `registerExpansionTools`:

| Tool                    | Kind        | Safety    | Notes                                                                                                |
| ----------------------- | ----------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `printer_edge_stop`     | Batch 1     | job       | STOP_PRINT_FORCE (44) / SET_PRINT_STATUS_FREE (901); needs `confirm:true` + `confirm_word:"EXECUTE"` |
| `ace_feed_finish`       | Batch 1     | state     | FEED_FILAMENT_FINISH (1209); needs `confirm:true`                                                    |
| `ace_refresh_slot`      | Batch 1     | state     | MULTI_COLOR_BOX_REFRESH_SLOT (1210); needs `confirm:true`                                            |
| `printer_rename`        | Batch 1     | write     | `/work/printer/edit` (N10); idempotent, `confirm:true`                                               |
| `firmware_update_check` | Batch 1     | read-only | `/work/printer/getPrinterUpdateVersion`; never triggers OTA                                          |
| `printer_event_watch`   | Batch 2/N14 | read-only | diff of printersStatus vs previous sample → events                                                   |
| `nfc_tag_decode`        | Batch 2/N13 | read-only | offline decoder (Anycubic/Bambu/Creality); never writes tags                                         |
| `spool_resolve`         | Batch 2/N13 | read-only | offline spool registry lookup                                                                        |
| `camera_cloud_info`     | Batch 2/N12 | read-only | RTC support, `video_taskid`, timelapse; never opens camera                                           |

All Batch 1 handlers verify the confirmation **before any cloud/network call**;
`printer_edge_stop` (safety job) additionally requires the literal word
`"EXECUTE"` in `confirm_word`. Mutations are flagged `destructiveHint:true`
(`printer_rename` is idempotent → `destructiveHint:false`), and every output
passes through `redact()`. Read-only probes (`firmware_update_check`,
`printer_event_watch`, `nfc_tag_decode`, `spool_resolve`, `camera_cloud_info`)
were deliberately kept in the same module to avoid altering the exact tool-name
lists asserted by the earlier registration tests.

NFC tag writes are **never** exposed — ACE is reader-only. OTA downloads are
never triggered. `printer_edge_stop` in `mode:"force"` only for a genuinely
stuck state on the sacrificial test unit.

## LIVE integration (2026-09-11, printer <PRINTER_ID> free) — Batch 1 + Batch 2 edge

Run directly against the physical Kobra S1 (fw <FW_VERSION>) via `node scripts/mcp-call.mjs`:

| Probe                                                                   | Result                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firmware_update_check` `{}`                                            | read_only ok; firmware <FW_VERSION>, `need_update:0`; ota `state:"unavailable"` (endpoint best-effort, degrade limpo)                                            |
| `camera_cloud_info` `{}`                                                | rtc_supported:false, video_taskid:null, timelapse:false                                                                                                          |
| `printer_event_watch` `{reset:true}` → `{}`                             | since "first" com `state:"free"` (baseline módulo-level só diffs dentro do mesmo processo — cada `mcp-call` é novo processo)                                     |
| `nfc_tag_decode` / `spool_resolve`                                      | offline, sem device (unit-tested)                                                                                                                                |
| `printer_edge_stop` sem confirm / sem EXECUTE                           | **gate offline**: "requires confirm: true" / "requires confirm_word: EXECUTE" — nada publicado                                                                   |
| `printer_edge_stop` `{mode:"free",confirm:true,confirm_word:"EXECUTE"}` | publish OK (topic print, order_id 901); reply timeout (estado livre — esperado); impressora continuou `free`, task_id null                                       |
| `ace_refresh_slot` `{box_id:0,confirm:true}`                            | publish OK (topic multiColorBox, refresh); reply timeout; printersStatus sem multi_color_box nesta view                                                          |
| `ace_feed_finish` `{box_id:0,confirm:true}`                             | publish OK (feedFilamentFinish); reply timeout (sem feed em curso)                                                                                               |
| `printer_rename` `{new_name,confirm:true}`                              | reporta `state:"failed"` transport ("request error") de forma estruturada — endpoint `/work/printer/edit` é best-effort e NÃO live-confirmado; nada foi aplicado |

Conclusão honesta: os canais **MQTT (publicação + envelope + gates) e REST
(read) estão funcionais e validados live**. As 3 edge writes receberam
"device reply: none" — transport OK, mas o device não replicou (payloads de
refresh/feed acabam por ser específicos do app e unit-semantically idempotentes
nestes estados). Nenhum dano à impressora: `state:"free"`, `task_id:null` após
todos os testes. `printer_edge_stop mode:"force"` NÃO foi executado (só em
estado genuinamente preso).

- Second-audit gap register: `docs/audit-unexposed-capabilities.md`
  (cloud upload, upload+print, print_update, video capture, axis turnOff,
  session close, material catalog — exposed; legacy HTTP wrappers and
  destructive file deletes — deliberately unexposed, reasons documented).
- ⚠️ `pnpm run build` CANNOT be claimed: this checkout has no `src/` or
  `tsconfig.json`; `dist/server.mjs` is extended via the standalone modules in
  `scripts/` (documented in `docs/mcp-recovery-data-contract.md`).

## 2026-09-10/11 expansion audit — findings and fixes

| Finding                                                                       | Fix                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No cloud write path in the MCP (client methods existed but no tool used them) | `printer_command_send` + `printer_print_start` over a persistent cloud MQTT session                                                                                                                                                                                                                                                     |
| `account_print` still used order 1 / filetype 1 (10115 incident contract)     | New `printer_print_start` implements order 1 (int) / filetype 0 with full resolution + post-send verification; `account_print` demoted to legacy in docs. 2026-09-11 LIVE: order 1 + full slice_param + ams mapping created task 0 which reached `printing` — the old 1240 hypothesis was disproven (accepts but never creates a task). |
| Fresh MQTT connection per call (identity displacement risk)                   | `CloudConnectionManager` keeps one self-healing persistent session per printer                                                                                                                                                                                                                                                          |
| No stable-reconnect guarantee                                                 | Manager replaces a dead session on the next acquire; `printer_connection_status` exposes health                                                                                                                                                                                                                                         |

- `pnpm install`: passed with lockfile supply-chain policy checks.
- `pnpm peers check`: no peer dependency issues.
- `pnpm run build`: TypeScript build and autonomous ESM bundle passed (packages externalized; `node_modules` of the deployment folder provides runtime deps).
- `pnpm run test`: **10 test files, 66 tests passed** (schemas incl. `account_devices` device_status filter + `account_print` gcode_id/filepath, security, CLI args, printer helpers + printer tool schemas, cloud client, token store, export-scan compatibility, **cad-mesh math/CSG/exporters, cad-server HTTP API**).
- `pnpm run smoke`: MCP server started, **advertised 27 tools** with input/output schemas and annotations, answered `inspect_slicer`; `account_login` responds (fails cleanly when no token is stored, succeeds when one is), `account_token_status` reports `ok:true` regardless of stored state, and the **CAD workspace starts on 127.0.0.1, returns a token-gated URL and stops cleanly**.
- Official `plugin-creator` validator: passed (for the pre-remote-print surface; UIA actions remain allowlisted).

## Post-PoC additions (remote print + full UIA)

- `src/printer.ts` implements the LAN MQTT/FTP protocol (bblp/access-code, `sdcard/`, `device/<id>/request|report`).
- Five remote-print tools (`discover_printers`, `printer_status`, `send_to_printer`, `start_print`, `cancel_print`).
- Five full-access UIA tools (`uia_tree`, `uia_read`, `uia_click`, `uia_type`, `uia_key`) with safe allowlists and ASCII folding for accented control names.
- `list_slicer_profiles` now marks `source: "user"` for profiles under `%APPDATA%\AnycubicSlicerNext\user\` and raises the limit to 1000.

## Post-PoC additions (cloud remote print by account)

- `src/cloud.ts` implements the Anycubic cloud workbench API (XX-Token from the Slicer Next `access_token`, signed headers, `getPrinters`, `getCloudFiles`, `sendOrder`).
- Four account tools (`account_login`, `account_devices`, `account_files`, `account_print`) using `ANYCUBIC_CLOUD_TOKEN` (env) or a per-call `access_token`; region `en`/`cn` via `ANYCUBIC_CLOUD_REGION`.
- `account_devices` supports `device_status` (true = online only, false = offline only, omitted = all).
- `account_print` accepts the validated body grammar: `file_key`/`file_id` plus optional `gcode_id`/`filepath` and `file_name`; the exact sendOrder JSON was empirically validated against the real API (code 1 on accepted orders).
- Raw tokens are never logged or echoed; the session is memoized per region.

## Post-PoC additions (automatic token capture + DPAPI store)

- `scripts/token-watcher.ps1` scans/watches process memory (`AnycubicSlicerNext`, `msedgewebview2`, `msedge`) with Win32 API (OpenProcess/VirtualQueryEx/ReadProcessMemory), extracts JWT-like candidates, scores them (payload `access_token` field, `iss` matching anycubic/makeronline/casdoor, `sub`, `exp`, `email`), and returns the best hit with metadata (sub/email/expires_at/source/bytes_scanned).
- `scripts/token-crypt.ps1` encrypts/decrypts the JWT with DPAPI (`ProtectedData`, `CurrentUser` scope) — key material never leaves the user's account.
- `src/token-store.ts` persists the encrypted token to `%LOCALAPPDATA%\AnycubicSlicerNextControl\tokens\cloud-token.json` (atomic write, mode 0o600); `src/token-watcher.ts` drives the script and parses the last JSON line (watch mode reports progress every 5s).
- Tools: `account_capture_token` (mode scan|watch), `account_token_status` (metadata; opt-in raw token), `account_token_clear`.
- **Live cloud validation passed (2026-08-27)**: captured the real Slicer Next JWT from memory (source `AnycubicSlicerNext`, sub `1d58194e-…`, v1.4.1.2), exchanged it via `account_login` (XX-Token OK), and `account_devices` returned the bound printer: **Anycubic Kobra S1** (device `key` `<DEVICE_KEY>…`, online). `account_print` orders were accepted by the API, but the device rejected them (see 10115 below).
- Live LAN printer validation is pending: no printer was reachable on the local subnet at implementation time (printer off network). Provide `ANYCUBIC_PRINTER_IPS` / `ANYCUBIC_ACCESS_CODE` or per-call `dev_ip`/`access_code` to validate.

## Post-PoC additions (app-GUI orchestration: `slice_via_app` + `export-scan`)

- **`slice_via_app`** starts the installed Anycubic Slicer Next, loads a validated model, clicks the app's own **Slice all** / **Export G-code** / **Save Project** controls (UI Automation safe allowlist, ASCII-folded names), then scans the allowed output roots for the newest exported file.
- **`src/export-scan.ts`** (`scanExportedFiles` + `inspectExportedCompatibility`) reports firmware-compatible structure: 3MF thumbnail PNG detection via ZIP central-directory, G-code via `THUMBNAIL_BLOCK` / `print_sequence` / `by object` / `model_instances` markers. Tool result includes `compatibility: true|false`.
- Unit tests cover a CLI export (incompatible → `compatible:false`) and an app-GUI export (`compatible:true`).

## Post-PoC additions (web CAD modeling workspace)

- **`src/cad-mesh.ts`** — precise double-precision mesh kernel: primitives (box/cylinder/cone/sphere/prism), transforms, bounding box / volume / surface area, half-space-clipping CSG (`union`/`subtract`/`intersect`), and exporters **STL (binary/ascii), OBJ and 3MF** (self-contained minimal ZIP writer — no external deps).
- **`src/cad-server.ts`** — local HTTP workspace bound **only to 127.0.0.1** with a random 16-byte hex token per session; serves the web UI (`ui/cad.html`) and a JSON API: add/remove/transform/boolean/export/import/clear/objects/mesh/health. Mutations require the token; reads (`/api/objects`) are view-only; idle timeout stops the server; exports are written into the configured output root. Supports binary+ASCII STL import (`parseStl`).
- **`ui/cad.html`** — Three.js (CDN, import-map) web editor: primitives with mm numeric fields, numeric move/center/rotate/scale, CSG booleans, snap, ortho/persp toggle, transform gizmo (G/R/S) with server persistence, import STL, export STL/OBJ/3MF with toast + path display, stats panel (size/volume/surface/watertight).
- Tools: **`cad_open_workspace`** (input_path preload, port, idle_timeout_min, open_browser) and **`cad_close_workspace`**; a shared singleton handle keeps the server alive across tool calls.
- **Live browser validation passed (2026-08-28)**: served page rendered a box with correct 20×10×20 mm stats (4 cm³, watertight); CSG union produced a manifold result; exports wrote `box_2.stl` and `uniao.3mf` into the default output root; re-import round-trip preserved 20×10×20 mm/4000 mm³. No page errors (three.js import-map fixed).

## Root cause: printer error 10115 (confirmed, static)

All four API-accepted `sendOrder` dispatches were rejected by the device with reason **10115** ("printer cannot parse the file"). Static comparison of a working file (from the app GUI) vs. a CLI export shows the CLI single-filament 3MF lacks the structure the firmware requires:

| Field                                            | CLI export (rejected) | App GUI export (accepted) |
| ------------------------------------------------ | --------------------- | ------------------------- |
| Thumbnails (`Metadata/*.png`, `THUMBNAIL_BLOCK`) | absent                | present                   |
| `print_sequence` / `is_seq_print`                | absent / `false`      | `by object` / `true`      |
| `bed_type`                                       | `textured_plate`      | `hot_plate`               |
| filament ids                                     | `[0,1,2]`             | `[2,3]` (ACE slots)       |
| `first_extruder`                                 | `0`                   | `-1`                      |
| `paint_info` / `model_instances`                 | absent                | present                   |
| `project_settings` arrays                        | 1 slot                | 4 slots (ACE)             |

Mitigation: for anything to be printed via cloud (or LAN), produce the file with the app GUI (`slice_via_app`) and validate with `inspectExportedCompatibility` before dispatch. Never dispatch a CLI-produced single-filament 3MF to the printer.

## Local PoC slice

Input: `tests/fixtures/cube-20mm.stl`

Profiles:

- Machine: Anycubic Kobra S1 0.4 nozzle
- Process: 0.20mm High Quality @Anycubic Kobra S1 0.4 nozzle
- Filament: Anycubic PLA @Anycubic Kobra S1 0.4 nozzle

Overrides verified in the generated G-code:

- layer height: 0.2 mm
- sparse infill density: 15%
- infill pattern: gyroid
- wall loops: 3
- supports: disabled

Result: exit code 0. Generated `plate_1.gcode` (304,433 bytes) and `output.gcode.3mf` (58,545 bytes). The 3MF archive contained `Metadata/plate_1.gcode`, its MD5, slice metadata, model settings, project settings, and slice information.

SHA-256:

- `plate_1.gcode`: `77D2524C7A9EF320CE378A08A92362EB6EA1F44150030361D0279F75F510054C`
- `output.gcode.3mf`: `EB9AE9913479B2C6CBFF0B3583DE1531EED720E53ED212929763EFDC7966095A`

This validates software integration only. It does not validate a physical printer, filament condition, bed adhesion, collision clearance, or safe print execution.
