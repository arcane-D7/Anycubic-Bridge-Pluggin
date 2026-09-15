# Printer property map — exhaustive read surface & hidden command map

Date: 2026-09-10. Unidade de teste: Anycubic Kobra S1 (cloud id <PRINTER_ID>, model_id
20025, ACE Pro model_id 40002, firmware <FW_VERSION>) — **representativa da linha
Anycubic FDM, não exclusiva dela**. Every "live" entry in this document comes
from captured traffic against that real printer (`docs/evidence/cloud-*.json`,
`.sweep-events.json`), not from vendor documentation. Property paths, sources and
groups are generic across the family; per-model capability gating is exposed via
`printer_capability_catalog` / `printer_read_all` (`features[]`).

## What was added to the MCP

Four new tools (44 total on the server — later expanded to 49 with the command
bus, see `docs/printer-command-bus.md`):

| Tool                         | Purpose                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `printer_read_all`           | Queries **every** discovered MQTT read source over cloud or native LAN, optionally the full cloud HTTP catalog and account reads; reconciles each source against the catalog and reports unmatched `extra` fields |
| `printer_property_catalog`   | Offline catalog of every known property, unit, group, evidence level and the exact publish topic                                                                                                                  |
| `printer_hidden_command_map` | Offline map of every writable channel: topics, envelope, commands with payload fields and safety class, HTTP endpoints, legacy order ids, unverified operations                                                   |
| `printer_property_reconcile` | Offline: compare a captured payload (MQTT source or HTTP kind) against the catalog to find undocumented fields                                                                                                    |

Implementation: `scripts/printer-property-catalog.mjs` (declarative MQTT
catalog + command map), `scripts/printer-http-property-catalog.mjs` (generated
HTTP property catalog), `scripts/printer-full-read.mjs` (transports + tools),
`scripts/gen-http-property-catalog.mjs` (regenerator), wired into
`dist/server.mjs`.

## Read surface totals

| Surface                                     | Entries                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| MQTT read sources                           | 12 (`info`, `tempature`, `fan`, `light`, `peripherie`, `aiSettings`, `multiColorBox`, `axis`, `extfilbox`, `print`, `file`, `status`) |
| MQTT property paths                         | 119 (110 live + 9 reference)                                                                                                          |
| Cloud HTTP endpoints with generated catalog | 9 (434 property paths, all live)                                                                                                      |
| Grand total property paths                  | 553                                                                                                                                   |
| Command map                                 | 34 commands (13 live / 14 mapping / 7 reference)                                                                                      |

HTTP endpoints with full catalogs: `printer_info` (128 fields — the single
richest source), `project_info` (126), `gcode_info_fdm` (63), `history_detail`
(50), `ace` (33), `printer_tool` (15), `printer_status` (8), `printer_functions`
(6), `project_monitor` (5).

## Property groups captured live

- **Identity** — `printerName`, `model`, `ip`, `version`, firmware version
  objects, machine dimensions (`machine_data.size_x/y/z`, `pixel`, `res_x/y`),
  nozzle diameter, MAC.
- **Temperature** — current and target for nozzle, bed and chamber (the topic is
  intentionally spelled `tempature`).
- **Cooling** — `fan_speed_pct`, `aux_fan_speed_pct`, `box_fan_level` (also
  duplicated inside `info`).
- **Print state** — lifecycle `state`, `print_status`, `progress`, `curr_layer`,
  `total_layers`, `remain_time`, `print_time`, `pause` (authoritative 0–4),
  task ids, filename, print speed mode.
- **Material** — ACE slots with `type`, `sku`, `color`, `color_group`,
  `consumables_percent`, `edit_status` (0 = RFID tag, 1 = manual), `status`,
  `icon_type`; external filament box; `supplies_usage`.
- **ACE hardware** — `model_id`, `status`, `temp`, `humidity`, `loaded_slot`,
  `feed_status.*`, `drying_status.*`, `auto_feed`, `multi_color_box_version[]`.
- **Motion** — `coordinates.x/y/z` (NOT a homing reference; no offset proof).
- **AI** — `ai_settings.status/type/count/sensitivity_level/notice_type`.
- **Lighting** — `lights[].type/status/brightness`.
- **Peripherals** — `camera`, `multiColorBox`, `udisk` presence flags.
- **Storage** — local and USB file listings (`records[].filename/is_dir/
timestamp/size/plate_number`), thumbnail/video keys.
- **Camera** — `urls.rtspUrl` (redacted), timelapse `saveVideoThumbnail` keys.
- **Capabilities** — `features.*` (12 booleans incl. `fod_support`,
  `shengwang_rtc_support`).

## Hidden command/connection points (mapped, read-only)

Transport topics (templates, never concrete printers in the tool output):

- Cloud command: `anycubic/anycubicCloud/v1/pc/printer/{model_id}/{printer_key}/{type}`
- Cloud reports: `.../printer/app/{model_id}/{printer_key}/#` and `.../printer/public/...`
- LAN command: `anycubic/anycubicCloud/v1/web/printer/{model_id}/{mqtt_device_id}/{type}`
- LAN handshake: `http://{ip}:18910/info` → signed `/ctrl` → AES-128-CBC
  credentials → local MQTT 9883 (rotating credentials, never persisted)
- Camera: `http://{ip}:18088/flv`; gkapi facade: `http://{ip}:80/api/version`

Envelope: `{type, action, timestamp, msgid, data}`. Parsers must key on the
**topic type**, not on `action`.

Command safety classes (34 commands): `read` ×14, `state` ×9, `thermal` ×4,
`motion` ×3, `job` ×4. Notables:

- `light/control` — **executed live** and confirmed via `light/report`.
- `print/homexy` — executed physically during earlier validation (motion!).
- `print/update` — changes the RUNNING job; it is not a refresh query.
- `multiColorBox/setInfo` — the legitimate manual-filament path (mirrors
  `edit_status=1`); no tag forging required.
- `video/startCapture|stopCapture` — camera stream control.

Legacy HTTP `sendOrder` ids are documented as **descriptive only** — the vendor
client and the reference enum disagree (e.g. 1214 appears as both
SET_TEMPERATURE and QUERY_AXIS_POSITION). Only six ids are validated reads:
axis 1214, peripherie 1231, light 1232, multiColorBox 1206, local_files 103,
usb_files 101.

Explicitly unverified (never use to act): LAN start-print payload, LAN
aiSettings switch action name, auto-leveler/self-test/release-film/
residue-clean, move-to-absolute-coordinates, local/USB file delete, and every
legacy order id whose name was not re-measured.

## Quirks that cost time (do not relearn them)

- `tempature` (sic) is the real topic name; `tempature/auto` exists as a
  report action with unverified publish semantics.
- `multiColorBox` reads need `action: "getInfo"`, not `query`, and are
  activity-gated (poll).
- `status` is push-only (`workReport`); there is no known query projection.
- `print/query` and `extfilbox/query` timed out on an idle/failed printer —
  a timeout is not proof the capability is absent.
- Device replies often use device-generated msgids; never assert correlation
  from arrival order.
- MQTT clientId must be deterministic (`md5(email + "pcf")`); randomized ids
  get CONNACK 5 (Not authorized). Concurrent clients with the same identity
  displace each other — serialize captures.
- The CA is SHA-1: Node needs `NODE_OPTIONS=--tls-cipher-list=DEFAULT:@SECLEVEL=0`.
- `info` MQTT also carries fan percentages and `urls.rtspUrl` — don't fan out to
  the fan source just for those.
- Cloud control must be published on MQTT (`pc/...`); HTTP `sendOrder`
  acceptance is NOT device execution (10115 incident).
- `file/listLocal` REQUIRES a `path` in the payload (`{path:'/',page:1,page_size:N}`);
  an empty data object is rejected by the device with code 10112 "path is empty".
- 10116 ("Abnormal slice file") can affect a cloud gcode that HAS slice info
  (status 2). Early 2026-09-11 probes used order 1240 (accepted over HTTP, no
  task created, device stayed `free`). The root cause was the WRONG order id,
  not the slice: with `order_id=1` + full `slice_param` the same gcode started
  (task 0 reached `printing`). Keep `slice_param` complete on every
  start; a previously-failed slice still needs a fresh reslice via the app
  (`slice_via_app`) if the device reports 10116 at print time.

## Safety model

`printer_read_all` publishes only `query` / `getInfo` / `listLocal` (all in
`READ_ONLY_ACTIONS`); the push-only `status` source is never published to. The
LAN transport refuses non-IPv4 targets. Every tool is annotated
`readOnlyHint: true`; the command map is descriptive (`executable: false`).
Credentials are redacted recursively (`token`, `password`, `secret`, `email`,
JWT shapes, signed URLs); `printer_key` is only ever returned as a 6-char
suffix in `printer_read_all` results. Tests assert that no non-read action is
ever published and that the offline tools cannot touch the network.

## Validation

```powershell
node --test tests/printer-full-read.test.mjs   # 23 tests
node --test tests/*.test.mjs                   # 31 tests (all suites)
node scripts/verify-full-read-mcp.mjs          # 44 tools over stdio
node scripts/gen-http-property-catalog.mjs     # regenerate HTTP catalog from evidence
```

Live cloud run: `printer_read_all` with `transport: "cloud"`, `printer_id:
<PRINTER_ID>`, `include_http: true` — requires `ANYCUBIC_CLOUD_TOKEN` or a logged-in
slicer. Live LAN run requires LAN Mode enabled on the printer (port 18910).

## Regenerating the HTTP catalog

After a new capture adds or changes HTTP fields:

```powershell
node scripts/gen-http-property-catalog.mjs
node --test tests/printer-full-read.test.mjs
```

The tests fail on any live field not present in the catalog, so a new firmware
field surfaces as a test failure instead of silently disappearing.

