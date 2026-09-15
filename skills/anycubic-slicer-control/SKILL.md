---
name: anycubic-slicer-control
description: Safely inspect Anycubic Slicer Next, choose local profiles, prepare a slicing plan, export local G-code or G-code 3MF, and optionally upload/start a print on a LAN or cloud (account) Anycubic printer through the bundled MCP tools.
---

# Anycubic Slicer Next Control

Use the bundled MCP tools for local Anycubic Slicer Next workflows on Windows, including LAN remote print and cloud (account) remote print. The server **orchestrates the installed desktop app** — it never re-implements slicing.

## Required workflow (local slicing)

1. Call `inspect_slicer` before the first write action in a conversation.
2. Use `list_slicer_profiles` to find explicit machine, process, and filament profile paths. Never guess a printer profile.
3. Call `prepare_slice_job` with an absolute STL or 3MF path, explicit profiles, desired output format, and only the requested basic overrides.
4. Show the plan, output directory, and material settings to the user before execution.
5. Call `run_slice_job` only after the user has approved the plan; pass `confirmation: "RUN"`.
6. Report the returned artifact paths and exit code. Do not claim a printer received or started the job.

> **CLI slicing is for local G-code, not cloud print.** `run_slice_job` (CLI) produces a single-filament `.gcode.3mf` **without** thumbnails, `print_sequence`, or the app's `paint_info`/`bed_type` metadata. The printer firmware rejects such files with error **10115** ("printer cannot parse the file"). For anything you will print via the cloud, use `slice_via_app` so the app GUI writes the device-compatible structure.

## App-GUI slicing workflow (`slice_via_app`)

When the target file must be accepted by the printer (LAN upload or cloud print), orchestrate the app itself:

1. Call `slice_via_app({ input_path })` (optionally `slice_all`/`export_gcode`/`export_project`) — it starts the app, loads the model, clicks the app's own **Slice all** and **Export G-code** controls via UI Automation, then scans the allowed output roots for the newest exported file and verifies its structure.
2. The result includes `file_path` and a `compatibility` check (`has_thumbnail` / `print_sequence` markers). If `compatible: false`, the app did not produce the expected structure — do not send it to the printer.
3. Use the `file_path` in `send_to_printer` (LAN). Cloud print start is not currently validated; use the official Anycubic app.

> The app must be running on the same Windows session (it launches automatically). If the app is busy (a print is active), do **not** run `slice_via_app` — it would interrupt the user's workflow.

## Remote print workflow (LAN)

1. Ask the user for the printer's LAN IP and access code (or use `discover_printers` to find candidates; confirmed printers appear with open 8883/990).
2. Use `printer_status` with `dev_id` (uppercase serial, e.g. from the slicer device page) and `dev_ip` to confirm reachability and live temps.
3. After slicing, call `send_to_printer` with the local G-code/3MF path to upload to the printer's `sdcard/`.
4. Show the user the returned remote path and ask for explicit approval before calling `start_print`.
5. Call `start_print` with `task_name`, `file_remote_path` (e.g. `sdcard:model.gcode.3mf`), `dev_id`, `dev_ip` and `access_code` (or the env-provided `ANYCUBIC_ACCESS_CODE`).
6. Poll `printer_status` to confirm the job started; report `gcode_state` / `mc_percent`.

## Remote print workflow (cloud account)

The printer bound to the user's Anycubic account can be driven over the cloud workbench API without LAN access.

### Capturing the access_token automatically (recommended)

The app encrypts the JWT on disk (recent versions), so the recommended flow reads it from the app's memory while logged in and stores it encrypted (DPAPI, per-user).

1. Warn the user: running the capture will **not** log them out by itself, but if the token isn't currently in memory they may need to re-login in the Anycubic Slicer Next app so the token is re-created.
2. Call `account_capture_token` with `mode: "watch"` (default `max_seconds` 90). It polls the memory of `AnycubicSlicerNext` / `msedgewebview2` / `msedge`, scores JWT-like candidates (payload with `access_token` field, `iss` matching `anycubic`/`makeronline`/`casdoor`, `sub`, `exp`, `email`), picks the best hit and stores it encrypted.
3. If the user is logged in, the capture returns `stored: true` with `sub` / `email` / `expires_at` / `source` (no raw token). Otherwise it returns `found: false` — ask the user to re-login in the app and run it again.
4. Call `account_token_status` to confirm the stored token (safe metadata only; pass `include_token: true` only if the user explicitly asks for the raw JWT).
5. Call `account_login` (read-only, idempotent) to exchange the stored access_token for a working XX-Token and verify identity (user id/email).
6. Call `account_devices` to list printers bound to the account; note each device `key` (dev_id), `online`, and `deviceStatus`. Pass `device_status: true` to keep only online printers.
7. Call `account_files` only for read-only cloud-file discovery.
8. Do **not** call `account_print` for a cloud history reprint — it still uses the legacy broken contract (order 1 / filetype 1) and produced device error 10115. Use `printer_print_start` instead, which implements the LIVE-VALIDATED order 1 contract (START_PRINT=1 int; validated 2026-09-11 on the Anycubic FDM line — a real task reached `printing` then `finished`; the old 1240 hypothesis answered "Operation successful" yet never created a task).

> **API acceptance ≠ printer acceptance.** The workbench accepting an order is not proof the device started anything. `printer_print_start` verifies the created task preserves `model`, `gcode_id` and slice metadata and that the device entered an active state before reporting `ok: true`. Never report a cloud print as started from HTTP acceptance alone.

## Full printer control (cloud command bus)

The persistent cloud MQTT session gives the same control surface as the mobile app:

1. `printer_connection_status` — confirm the session health before acting.
2. `printer_command_catalog` — see every command with its safety class and required confirmations.
3. Read anything first with `printer_read_all` (all 12 MQTT sources + full HTTP catalog) — always the first diagnostic step.
4. Act with `printer_command_send`:
   - `light_control` (on/brightness), `fan_set` (part/aux/box), `temperature_set` (nozzle/bed), `ace_dry`, `ace_auto_feed`, `ace_set_slot` (manual filament path), `ai_settings_set` → require `confirm: true`.
   - `axis_move` (move/home), `ace_feed`, `print_pause`, `print_resume`, `print_stop`, `print_start` (local file) → additionally require `confirm_word: "EXECUTE"`.
5. Start a **cloud** print with `printer_print_start { gcode_id, confirm: true, confirm_word: "EXECUTE" }`:
   - resolves `gcode_id` → cloud file id via `/work/gcode/infoFdm` first;
   - refuses while the printer is busy (never start over an active job);
   - requires `ams_box_mapping` when `use_ams` is set;
   - verifies the created task before reporting success; on rejection it reports and never retries automatically.
6. Check results with `printer_read_all` or `printer_connection_status` (buffered device reports).

Safety rules that are enforced by the tools themselves (not negotiable by callers):

- No non-read command executes without `confirm: true`; motion/job also need `confirm_word: "EXECUTE"`.
- The busy-guard blocks any print start while the printer reports a busy lifecycle state.
- `filetype: 1` with an empty filepath (the 10115 malformed order) is unbuildable.
- No automatic retries — a rejected task must be inspected, not re-sent.

Use `account_token_clear` to wipe the stored token (e.g. account switch or security). The token is stored DPAPI-encrypted (current user scope) at `%LOCALAPPDATA%\AnycubicSlicerNextControl\tokens\cloud-token.json`.

### Alternative: explicit token

If automatic capture is unavailable, the account `access_token` (JWT) can be supplied via `ANYCUBIC_CLOUD_TOKEN` (mcp.json env) or the `access_token` parameter of `account_login`/`account_print`. The user obtains it from the Anycubic Slicer Next app while logged in; never request secrets in chat.

## 3D CAD modeling workflow (web workspace)

The MCP includes a lightweight web CAD workspace for designing or editing 3D printable objects without opening another application.

1. Call `cad_open_workspace({ input_path?, port?, idle_timeout_min?, open_browser? })` — it starts a local HTTP server bound **only to 127.0.0.1** with a random per-session token and opens the default browser. Pass `input_path` to preload an existing STL/OBJ into the scene, `open_browser: false` to suppress the browser (headless), and `idle_timeout_min: 0` to keep it running indefinitely.
2. The result returns `url` (contains the token) and `output_root`. The user can then model in the browser: add primitives (box/cylinder/cone/sphere/prism) with **millimeter numeric fields**, move/center/rotate/scale with precision inputs, boolean CSG (union/subtract/intersect), snap-to-grid, and a fit-view that also checks volumes/surfaces.
3. When the design is done, click **STL / OBJ / 3MF** in the browser to export. Files are written to `output_root` (the MCP default output folder). The export response shows the absolute `file_path`.
4. Use that exported `file_path` in the local slicing workflow (`prepare_slice_job`/`run_slice_job`) or `slice_via_app` to proceed to print. The CAD workspace itself never touches the printer or slicer.
5. Call `cad_close_workspace` when done (or rely on the idle timeout). Exports remain on disk.

> The CAD server uses a double-precision mesh kernel (`src/cad-mesh.ts`) for exact measurements; the web UI is served from the deployed `ui/` folder. It never listens on a non-local address and requires the session token for any mutation.

## Boundaries

- Local slicing: do not bypass input/output path allowlists; do not invent profile paths or silently substitute a different printer.
- Remote print: `start_print`, `cancel_print` and `account_print` require explicit user confirmation before calling; never store or echo the access code or access_token in conversation output.
- Cloud: never request or log the raw `access_token`/XX-Token; `account_login` only returns whether a token was resolved (and user id/email).
- Do not request arbitrary CLI flags, PowerShell, coordinates, or unbounded keystrokes. UI automation is limited to allowlisted safe actions (`uia_click`/`uia_key`/`uia_type`).
- A `.3mf` input can carry embedded settings. Explicit machine/process/filament profiles and requested overrides take precedence in the CLI workflow.
- Treat generated G-code as untrusted until the user verifies printer, nozzle, material, bed type, temperatures, and preview.
- **Active print safety**: if the user is currently printing (18h job etc.), never call `start_print`/`account_print`/`cancel_print` or run `slice_via_app`; keep all work to inspection, documentation, tests, and local file operations.
