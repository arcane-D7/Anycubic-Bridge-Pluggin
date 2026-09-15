# Expansion audit — MCP connectivity (2026-09-11)

Status: **all existing connections verified**; 54 tools live. This audit maps what
is already exposed versus the roadmap in `expansion-research.md`, and prioritises
the next expansion batch. The documentation here is deliberately **agnostic** to
any single printer; the unit used for live validation is cited only as
"the test unit".

## 1. Verification suite — result

| Check                                       | Tool count                    | Result                                                                          |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `verify-command-bus-mcp.mjs`                | 54 tools / 18 bus commands    | ✅ gates fire correctly (state/thermal/motion/job)                              |
| `verify-full-read-mcp.mjs`                  | 54 tools / 553 property paths | ✅ `read_all_validation` now passes (bug fixed: `transport:"wifi"` → `"cloud"`) |
| `verify-cloud-readonly-mcp.mjs`             | 54 tools                      | ✅ read-only diagnostics intact                                                 |
| Unit tests (`node --test tests/*.test.mjs`) | 62                            | ✅ 62/62 pass                                                                   |

**Bug fixed during this audit:** `scripts/verify-full-read-mcp.mjs` sent
`transport: "wifi"` (an obsolete value). The `printer_read_all` schema uses
`z.enum(["cloud","lan"])`. Corrected to `"cloud"`; re-validated live (full
cloud read with reconciliation returned device data).

The `.mcp.json` previously used `${PLUGIN_ROOT}` (a plugin-creator variable that
VS Code does not expand) → `MODULE_NOT_FOUND`. Replaced with the absolute path to
`dist/server.mjs`. Handshake `initialize` + live tool calls now succeed from the
VS Code MCP client.

## 2. Current surface (54 tools, live inventoried)

**Slicer/UIA (7):** inspect_slicer, list_slicer_profiles, open_slicer,
open_model_in_slicer, prepare_slice_job, run_slice_job, get_slice_job, uia_tree,
uia_read, uia_click, uia_type, uia_key, slice_via_app, slicer_component_inventory.

**LAN/Bambu-compatible (8):** discover_printers, printer_status,
printer_diagnostics, printer_capability_catalog, printer_lan_command_preview,
printer_monitor, send_to_printer, start_print, cancel_print, audit_gcode_recovery.

**Cloud account (8):** account_capture_token, account_token_status,
account_token_clear, account_login, account_devices, account_files,
account_cloud_diagnostics, account_cloud_live_diagnostics.

**Cloud print/read (10):** printer_read_all, printer_property_catalog,
printer_hidden_command_map, printer_property_reconcile, printer_command_catalog,
printer_command_send, printer_print_start, printer_gcode_resolve,
printer_connection_status, printer_http_readonly_diagnostics,
printer_connection_close.

**Files/print (3):** account_file_upload, account_print_local, printer_lan_camera.

**CAD (5):** cad_open_workspace, cad_close_workspace, cad_select_faces,
cad_edit_mesh, cad_texture, cad_image_to_3d.

**Materials:** printer_material_catalog.

(A few rows above pack multiple tools; total distinct = 54.)

## 3. Gap analysis vs roadmap (`expansion-research.md`)

| Roadmap phase                                          | Status      | Assessment                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. LAN Mode native client (handshake+AES+MQTT 9883)    | Partial     | `printer-http-readonly.mjs` probes HTTP facade (gkapi: /api/v1/_, /printer/_). Firmware on the test unit runs **cloud mode** (18910 closed) — LAN Mode client stays documented, not exercised.                                                                                                                                                                                                                         |
| 2. Full control commands                               | ✅ Mostly   | 18 commands via cloud MQTT bus: light, fan, temp, ace dry/feed/auto-feed/slot, aiSettings, axis move/turnOff, print pause/resume/stop/update, video start/stop, print query. Missing vs roadmap: `tempature/auto` publish (unverified semantics), ACE `getInfo` polling as a first-class read.                                                                                                                         |
| 3. Camera + AI watchdog                                | Partial     | Cloud MQTT `video/startCapture`/`stopCapture` exposed; LAN camera snapshot via `printer_lan_camera` (FLV 18088, fixed argv). No Obico/LLM-vision watchdog yet.                                                                                                                                                                                                                                                         |
| 4. NFC daemon / Spoolman                               | Partial     | Client-side spool registry implemented (`spool-registry.mjs`: upsert/evento/dedup/consumo; tools `spool_register`, `spool_usage`, `spool_status`, `spool_bind`, `spool_consume_from_slice`) + plano de escrita NFC pronto (`nfc-tag-writer.mjs`/`nfc_tag_plan`, NTAG213 formato Anycubic a validar com ReSpool no hardware). Falta: leitor/escritor físico (PC/SC, Android NDEF, PN532/ACR122U) e integração Spoolman. |
| 5. REST/OpenAPI + MQTT bridge + webhooks + anyctrl CLI | Partial     | Local REST exists for the CAD workspace (token-gated). No generic REST surface, MQTT republish, webhooks, or `anyctrl` binary.                                                                                                                                                                                                                                                                                         |
| 6. Timelapse / job queue / cost metrics                | Not started | Roadmap only.                                                                                                                                                                                                                                                                                                                                                                                                          |

## 4. Prioritised expansion proposals

### P1 — NFC/spool registry (highest value; owner decision already made)

**Implementado (2026-09-14, aprovado pelo owner, client-side primeiro):**

- **Opção A — tracking client-side** (`scripts/spool-registry.mjs`):
  - Registry persistente em JSON local (`%LOCALAPPDATA%\AnycubicSlicerNextControl\spool-registry.json`).
  - Tools: `spool_register` (novo spool), `spool_usage` (registra consumo por impressão,
    dedup por task_id + used_g), `spool_status` (saldo restante/gasto/pct),
    `spool_bind` (plano de binding no slot — delega para `ace_set_slot`, `edit_status:1`),
    `spool_consume_from_slice` (lê `filament_used_g` do preview de fatiamento e aplica).
- **Opção B — prep NFC sem hardware** (`scripts/nfc-tag-writer.mjs`):
  - `nfc_tag_plan` gera o plano de blocos NTAG213 formato Anycubic (magic `A1N0` +
    SKU + material + RGB) e o `registry_record` correspondente.
  - **Pendente hardware**: até chegarem tags brancas NFC, nada é escrito. O layout de
    bytes é premissa a validar com ReSpool numa tag real (formato proprietário).
- Serviu de base para cost tracking e multi-filament awareness.

### P2 — Camera watchdog (AI failure detection)

- Keep `printer_lan_camera`; add `camera_watch` (poll snapshots every Ns, run a
  local classifier — Obico ML or a configurable vision API — and
  alert/pause/stop per policy). Must be opt-in and gated by `confirm:`.
- Requires the LAN-mode camera path available (`info.urls.rtspUrl` exposure first).

### P3 — Generic REST/OpenAPI + webhooks

- The MCP surface is complete; add a token-gated HTTP server (127.0.0.1) that
  mirrors every tool, plus webhook events (`job.started|finished|failed`,
  `spool.low`, `ai.alert`). This makes the bridge consumable by Home Assistant,
  n8n/Node-RED, and any language.
- Reuse the CAD workspace server patterns already in place.

### P4 — LAN Mode native client (feature-gated)

- Implement handshake + AES + MQTT 9883 behind a capability gate; do not activate
  unless the device reports LAN Mode on. Documents the re-pairing risk.

### P5 — `tempature/auto` + ACE `getInfo` read source

- Clarify publish semantics of `tempature/auto` (report-only today).
- Add an `ace_read`/read-source for `multiColorBox getInfo` polling so properties
  like remaining %, dryer state, and slot SKU are first-class reads (they are
  currently only part of `printer_read_all`).

## 5. Concrete next step (recommended)

Ship **P1 (spool registry, read-only)** + **P5 (ace_read)** together: both are
read-heavy, zero-risk, directly extend the verified read surface, and the NFC
report schema is already captured in evidence with known keys. Validate live with
`printer_read_all`'s `multiColorBox` source, then register the two tools.

See also: `docs/mcp-recovery-data-contract.md` (read surface),
`docs/audit-unexposed-capabilities.md` (deliberately unexposed items),
`docs/expansion-research.md` (long-term roadmap).
