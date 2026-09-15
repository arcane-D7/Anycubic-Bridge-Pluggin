# Research notes — 2026-08-27

## OpenAI plugin architecture

The current official OpenAI architecture treats a plugin as a package containing skills, an optional MCP server, and optional UI resources. ChatGPT and Codex share a universal plugin directory, while local and repository marketplaces are authoring and private-distribution sources.

For this project:

- `.codex-plugin/plugin.json` provides package identity and points to the bundled skill and MCP configuration.
- `.mcp.json` starts the local stdio server in Codex.
- Tool contracts use explicit inputs, structured results, and MCP safety annotations.
- Filesystem writes are local and bounded; LAN remote print (MQTT/FTP) is supported via explicit `dev_ip`/`dev_id`/`access_code` parameters.
- Cloud (account) remote print is exposed through `account_login` / `account_devices` / `account_print`, using the Slicer Next workbench API and an account `access_token` (JWT) supplied by the user via `ANYCUBIC_CLOUD_TOKEN` or per-call `access_token`. The token is never logged or echoed.

Official sources:

- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Define tools](https://developers.openai.com/plugins/plan/tools)
- [Security and privacy](https://developers.openai.com/plugins/guides/security-privacy)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)

The connection model is surface-specific. Codex can start a bundled local stdio MCP server. ChatGPT Developer Mode requires a public HTTPS endpoint or Secure MCP Tunnel; the official guide explicitly says a tunnel can reach a configured stdio or HTTP server. Therefore, this PoC keeps the local server private and leaves tunnel registration and the resulting `plugin_asdk_app...` mapping as a deployment step.

## Anycubic automation surface

The official [AnycubicSlicerNext repository](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext) states that the application is open source and based on OrcaSlicer. The inspected commit was `6103ed8b511609658d00d0538cc7f0609cdb57da` dated 2026-02-02.

Source evidence at that commit:

- [`--export-3mf` action](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext/blob/6103ed8b511609658d00d0538cc7f0609cdb57da/src/libslic3r/PrintConfig.cpp#L7628)
- [`--slice` plate selection](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext/blob/6103ed8b511609658d00d0538cc7f0609cdb57da/src/libslic3r/PrintConfig.cpp#L7674)
- [`--arrange` and `--orient`](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext/blob/6103ed8b511609658d00d0538cc7f0609cdb57da/src/libslic3r/PrintConfig.cpp#L7803)
- [`--load-settings`, `--load-filaments`, and `--outputdir`](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext/blob/6103ed8b511609658d00d0538cc7f0609cdb57da/src/libslic3r/PrintConfig.cpp#L7913)
- [Per-plate G-code written during slicing](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext/blob/6103ed8b511609658d00d0538cc7f0609cdb57da/src/OrcaSlicer.cpp#L5064)
- [3MF project/package export](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext/blob/6103ed8b511609658d00d0538cc7f0609cdb57da/src/OrcaSlicer.cpp#L5880)

The direct `export_gcode` CLI action is commented out in this branch, but the `slice` action itself writes `plate_N.gcode` to `outputdir`. Adding `--export-3mf` creates a packaged G-code 3MF as well.

## Local verification

The machine had Anycubic Slicer Next at `C:\Program Files\AnycubicSlicerNext\AnycubicSlicerNext.exe`; the executable reported product version `1.4.1.2`. Windows UI Automation exposed localized wxWidgets controls including `Altura da camada`, `Fatiar Disco Único`, and `Salvar Projeto`. These controls had generated negative automation IDs and often reported `ControlType.Pane`, confirming that UIA is useful for inspection but a fragile primary execution API.

The PoC performed a local slice of `tests/fixtures/cube-20mm.stl` using installed Kobra S1 0.4 mm, 0.20 mm High Quality, and Anycubic PLA profiles. The generated G-code reported:

- `printer_model = Anycubic Kobra S1`
- `layer_height = 0.2`
- `sparse_infill_density = 15%`
- `wall_loops = 3`
- `enable_support = 0`
- `filament_type = PLA`

The job returned exit code 0 and produced both `plate_1.gcode` and `output.gcode.3mf`. This is a software integration check only, not a physical-print validation.

## Remote print protocol (LAN MQTT + FTP)

Investigated the upstream repositories at commit `6103ed8` (`ANYCUBIC-3D/AnycubicSlicerNext`) and BambuStudio `master`. The Anycubic firmware and the slicer use the Bambu-compatible networking stack:

- **MQTT**: `mqtts://<printer-ip>:8883`, username `bblp`, password = printer access code, TLS with self-signed certificate accepted.
  - Publish request topic: `device/<DEV_ID>/request`
  - Subscribe report topic: `device/<DEV_ID>/report`
  - Status pull: `{"print":{"command":"pushall"},"system":{"sequence_id":...}}`
  - Start print: `{"print":{"command":"project_file","task_id":...,"subttask_name":...,"url":"sdcard:file.3mf","bed_type":"auto",...}}`
  - Control: `task_cancel`, `task_pause`, `task_resume`, `print_stop`.
- **FTP**: port 990 (TLS) or 21, user `bblp`, password = access code, upload folder `sdcard/` (the printer JSONs all define `ftp_folder: "sdcard/"`).
- Error codes (bambu_networking.hpp): `-4010` file > 1 GB, `-4020` FTP failure, `-4030` MQTT failure, `-5010` G-code FTP failure, `-6010`/`-6020` connection failure.
- Verified machine capability JSONs (C11/C12/C13/N1/N2S/BL-P001/BL-P002); N1/N2S report `support_cloud_print_only: true`, so LAN print start works on the current Kobra class hardware (C11/C12/C13).

The implementation in `src/printer.ts` mirrors this protocol and keeps credentials in memory only. No cloud account is required; the access code and `dev_ip`/`dev_id` come from the user or `ANYCUBIC_ACCESS_CODE` / `ANYCUBIC_PRINTER_IPS`. Live LAN validation requires the printer powered on and on the same Wi-Fi network.
