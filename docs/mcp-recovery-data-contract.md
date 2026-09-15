# MCP recovery data contract and investigation log

Status: investigation open; no executable in-place recovery validated.
Date: 2026-09-10. Unidade de teste: Anycubic Kobra S1 (cloud id <PRINTER_ID>,
firmware <FW_VERSION>) — representativa da linha Anycubic FDM; o contrato abaixo é
genericamente aplicável (os IDs de máquina/ordem variam por modelo).

> Resolved 2026-09-11: in-place recovery validated end-to-end — a remainder
> object (layers after the failed boundary) was rebuilt, sliced, uploaded and
> printed fully on the test unit via the `printer_print_start` order-1 contract.
> See `live-validated-order1-2026-09-11.md`.

## User observations

The user confirms the part is still attached, the bed did not move after the
failure, the head parked, and layer 62 completed before the failure during
the layer transition. Measured printed height: 12.2–12.4 mm, approximately
0.1 mm measurement uncertainty. Do not keep asking for this same measurement.
Nominal completed layer Z is 12.4 mm; nominal next deposition Z is 12.6 mm.
This identifies the intended restart boundary, not the current coordinate offset.

## Implemented read surface

`account_cloud_live_diagnostics` is registered in this checkout's
`dist/server.mjs` through `scripts/cloud-readonly-diagnostics.mjs`.
The current checkout contains no src/ or tsconfig.json, despite package.json
referencing them. Do not claim that the TypeScript build passed. Keep this
extension when restoring/building the original source tree.

Inputs: explicit `printer_id`, `queries`, `read_orders`, `timeout_ms` (1–60 seconds),
optional `include_http`, `project_id`, `gcode_id`.

| MQTT type     | Action  | Live outcome                                               |
| ------------- | ------- | ---------------------------------------------------------- |
| axis          | query   | Coordinates, code 200                                      |
| info          | query   | Identity, features, current/last project, code 200         |
| tempature     | query   | Current and target temperatures, code 200                  |
| fan           | query   | Fan data, code 200                                         |
| light         | query   | Light data, code 200                                       |
| peripherie    | query   | Camera, ACE, USB presence, code 200                        |
| aiSettings    | query   | AI configuration, code 200                                 |
| multiColorBox | getInfo | ACE slots, material, remaining percentage, dryer, code 200 |
| print         | query   | No reply within 20 seconds on failed/idle printer          |
| extfilbox     | query   | No reply within 20 seconds                                 |

The new collector retains redacted raw fields and received timestamps rather
than only extracting a handful of known properties. Per-query states:
`correlated_reply`, `uncorrelated_report`, `timeout`, `publish_error`.
A device code is retained separately: receiving a report is not itself success.
Observed replies used device-generated msgids rather than the published IDs.
Do not assert request/response correlation solely by arrival order.

Optional HTTP reads: printer status/info/tool/functions, ACE information,
project info/monitor, history detail, FDM G-code metadata. Each failure remains
independent; HTTP errors must not discard MQTT data or other HTTP results.
The FDM metadata endpoint takes the **G-code ID**, not the print task ID.
HTTP status currently says is_printing=1 while MQTT reports project=null and
last_project.state=failed. Preserve both; do not infer that resume is available.

## Transport and command hazards

- Cloud command topic: `anycubic/anycubicCloud/v1/pc/printer/{model}/{key}/{type}`.
- Subscribe to account reports and printer public reports before publishing.
- MQTT connection now awaits SUBACK. Publish returns its request msgid.
- Broker requires the existing deterministic client identity. Randomized identity
  failed with `Connection refused: Not authorized` (CONNACK 5); change reverted.
  Concurrent clients with the same identity may disconnect one another. Run
  captures sequentially; a future persistent session broker is preferable.
- Legacy certificate compatibility is scoped to this MQTT connection;
  certificate and hostname verification remain enabled.
- `print/update` changes settings; it is NOT a refresh/status query.
- The old ORDER table conflicts with the checked-out anycubic-cloud-api enums.
  Example: old client labels 1214 as temperature and 1219 as axis; reference
  uses 1214 for axis, 1216 for temperature. Do not test mutation IDs to discover
  semantics. The direct typed MQTT read path avoids this ambiguity.
- Do not conclude HTTP orders are unsupported based on tests using wrong IDs.
- `resume_needs_unpack=false` describes file preparation, not resumability.
- `curr_layer`, integer material use, progress, and elapsed time do not prove
  the exact executed G-code byte offset. User confirmation supplies the layer
  completion observation in this case.
- Older documents asserting Bambu-compatible access-code support are historical
  hypotheses, not validation for this Kobra S1.

## Evidence and outstanding recovery reference

### HTTP order correction verified

`http-read-orders-1789077058851.json` contains live reports after these orders:
axis=1214, peripherie=1231, light=1232, multiColorBox=1206, local_files=103.
All five returned device reports. The file/listLocal report echoed the HTTP
ack msgid and contains 54 saved print files, including the failed shelf and
both previous successful shelf packages. It did not expose recovery state or
firmware logs. These five reads are now available via `read_orders` and their
legacy read constants have been corrected. Other legacy control constants
have NOT been validated and must not be trusted based on their names.

HTTP endpoint validation also found:

- `/v2/printer/tool` needs a positive `type_function_id`; collector now supplies
  13 (the XYZ tool) and the actual printer model ID.
- ACE endpoint is `/v2/printer/getMultiColorBoxInfo`; corrected the initial
  failed `/v2/printer/multiColorBoxInfo` request.
- `/v2/printer/functions` returned Photon S metadata for Kobra S1 inputs;
  do not use this result as a reliable capability list.

Live axis reports repeatedly return X=47, Y=276, Z=4.034207620182453.
No homed flag, G-code origin, base position, mesh transform or crash byte offset
was returned. Do not issue G92 based only on 12.4 minus this value.

Task 0, G-code 0, file 0:
`0910-2020-OpenSCAD Model_plate(01)_PLA_0.2_2h32m25s.gcode`.
Error 10116, 150 total layers. Cloud metadata package MD5:
`aee4356d99920f3355b9b3d957e9dc27`.

The exact G-code includes full-circle G3 Z hops near the bed edge; one checked
sequence starts X169.748 Y1.681 and uses I-0.388 J-1.154, producing a theoretical
minimum Y of approximately -0.6905. This is a concrete candidate for a motion
range failure, NOT a proven firmware error cause without the execution log.
Inspect arc extents, not just G1 endpoints, when validating a repair.

MQTT/HTTP snapshots during this investigation reported bed target 0 and bed
cooling (45 C in the MCP validation). Do not claim heating remained enabled;
no heater setting was changed by this investigation.

## Additional route checked

Rinkhals documents a limited Klipper API on `/tmp/unix_uds1` and a gkapi
TCP proxy on 18086. A read-only connection check against <LAN_IP> returned
ECONNREFUSED for ports 18086, 7125, 2883 and 22. No internal request was sent.
This is current reachability, not proof those processes do not exist internally.
Installing firmware, enabling debug access or rebooting is NOT part of these
read-only probes and may destroy the state needed for this recovery.

Sources:

- https://rinkhals-community.github.io/Rinkhals/firmware/ipc-commands/
- https://rinkhals-community.github.io/Rinkhals/firmware/mqtt/
- Local anycubic-cloud-api: const/enums.py, api/functions.py,
  data_models/printer_properties.py, lan/commands.py.

## Reproduce and validate

```powershell
node --test tests/cloud-readonly.test.mjs
node scripts/verify-cloud-readonly-mcp.mjs
node scripts/verify-cloud-readonly-mcp.mjs --live
node scripts/capture-cloud-readonly.mjs <PRINTER_ID> 0 0
node scripts/probe-cloud-http-read-orders.mjs
```

Tests: five passed; stdio tool discovery and an actual tool call succeeded.
These verify the checkout's server, not hot-loading into an already-running
Codex MCP process. Captures are saved under docs/evidence without credentials
or signed URLs. Full byte-level recovery and safe startup remain unvalidated.

## Official log export: next data source (no reboot)

Official guide retrieved directly as HTML:
https://wiki.anycubic.com/en/fdm-3d-printer/kobra-s1-combo/fault-log-export

Official archive downloaded to `docs/evidence/anycubic-s1-official-log-export.zip`
from https://wiki.anycubic.com/kobra-s1/zxhwb3j0x2rpcgo=(2).zip .
Static ZIP inspection found only a directory and a 12-byte marker:
`ZXhwb3J0X2Rpcgo=/ZXhwb3J0LnR4dAo=` containing `log:1` and `cfg:1`.
There is no firmware payload or executable in this archive.
Archive SHA256: `4E14904F0DDCC89F10A9194AD145324676C3C252C4E7CDD129AF46850BFD3FB3`.

The guide instructs: extract to an empty USB drive, insert into the still-powered
printer, wait more than ten seconds for two beeps and a few additional seconds,
then return the USB drive to the computer. Expected outputs are `ACCONF.pack`
and `AC LoG.pack`. It explicitly warns that restarting clears the log.
This was NOT executed on the printer. The user was asked to connect a USB drive
to the PC so it can be prepared without formatting or deleting any data.
Inspect the returned configuration/logs for homing, offsets, motion bounds,
error details, last executed commands and recovery state before any restart.
The export may supply the needed evidence; its contents are not yet available
and must not be assumed to contain an exact resume position.

PC inventory found removable E: labelled with the user's name, exFAT. No writes or
formatting were performed; user confirmation of the target drive is still required.

Subsequent update: user reconnected and authorized preparation of the USB drive.
Verified E: is the removable Lexar USB Flash Drive labelled with the user's name,
exFAT, with only System Volume Information visible at its root. Verified the official
archive SHA256 above, then extracted it without overwrite. The resulting
`E:\ZXhwb3J0X2Rpcgo=\ZXhwb3J0LnR4dAo=` is 12 bytes and contains `log:1` and
`cfg:1`. No formatting, deletion, firmware installation or printer command was
performed. Awaiting the physical USB export and returned ACCONF.pack/AC LoG.pack.

Further USB investigation: the original exFAT drive returned no exported files.
The user then manually exported to a second FAT32 drive and observed 100%
progress. Read-only PC inspection of D: (ASolid USB, 31,438,405,632-byte FAT32
volume) found only System Volume Information, including a recursive hidden-file
check; no log packages existed. This rules out exFAT as the sole explanation.
After explicit user approval, extracted the hash-verified official marker onto
D: without formatting or deletion. Verified the 12-byte file at
`D:\ZXhwb3J0X2Rpcgo=\ZXhwb3J0LnR4dAo=` contains `log:1` and `cfg:1`.
The automatic export attempt on this second drive remains pending.

## Follow-up: USB export failed again; alternative read interfaces

The user subsequently attempted automatic and manual export on FAT32 D:.
No log was produced. A fresh recursive PC inspection confirmed only Windows
system files and the 12-byte export marker. Do not repeat the same USB procedure
as if it had not been tried, and do not blame exFAT for the FAT32 failure.

New MCP support:

- `account_cloud_live_diagnostics.read_orders` now accepts `usb_files` (101).
  This is a read operation documented by the existing API reference.
  Live response: file/listUdisk, code 200, echoed request ID, empty records.
  The pen was connected to the PC at query time; this does NOT establish its
  mount state during the earlier export on the printer.
- Local and USB file reports are separated by action (`listLocal`/`listUdisk`)
  so one response cannot incorrectly satisfy the other query.
- `printer_http_readonly_diagnostics` is registered in the checkout's MCP.
  It uses bounded curl GET requests to a private IPv4 address and fixed paths.
  No shell interpolation, redirects, credentials, POST or G-code execution.
  Response size is limited to 1 MiB, each request to five seconds.

Network results against <LAN_IP>: ports 80 and 18088 accept TCP;
22, 443, 2222, 2883, 7125, 9883, 18086, 18910 return ECONNREFUSED.
Only connections were tested; the camera stream was not started or captured.

Important compatibility finding: Node fetch fails on port 80 with
`Response does not match the HTTP/1.1 protocol (Missing expected CR after response line)`.
Curl tolerates this response formatting. Therefore a previous generic
`fetch failed` was not sufficient to establish that the service was unavailable.

Verified HTTP results:

- `/api/version`: 200, self-identifies as OctoPrint 1.8.7, API 0.1.
- `/api/printer`, `/api/job`, `/api/connection`, `/api/files`, `/api/settings`,
  `/api/logs`, `/server/info`, `/printer/objects/list`, `/info`: 404 Not Found.
  This is a partial compatibility facade, not evidence of a full OctoPrint or
  Moonraker installation. No offsets, internal logs or recovery byte position
  were obtained through these endpoints.

Evidence:

- `docs/evidence/recovery-alternatives-1789078492227.json`
- `docs/evidence/printer-http-1789078613859.json`

Validation: eight unit tests passed after updating the file-report fixture to
include the actual protocol action. Run:
`node --test tests/printer-http-readonly.test.mjs tests/cloud-readonly.test.mjs`
and `node scripts/verify-cloud-readonly-mcp.mjs --http-live`.

Remaining boundary: the user-confirmed complete layer defines the cut, but
none of the read interfaces tested supplies the firmware coordinate origin or
last executed motion. Firmware modification, reboot, installing a root/debug
package, and unsolicited movement remain outside this read-only investigation.
The print recovery is still unvalidated, not complete.

