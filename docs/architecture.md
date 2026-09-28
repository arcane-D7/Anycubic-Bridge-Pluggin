# Architecture and safety model

## Decision

The robust integration boundary is a local, stdio-only MCP server bundled in a Codex plugin. The server exposes a small domain-specific tool surface and **orchestrates the installed Anycubic Slicer Next app** — it never re-implements slicing. Two execution paths:

1. **CLI adapter** (primary for local G-code): delegates slicing to Anycubic Slicer Next's own CLI with fixed flags (`--load-settings`, `--load-filaments`, `--slice`, `--export-3mf`).
2. **App-GUI path** (`slice_via_app`): drives the desktop app's own Slice/Export controls through Windows UI Automation so the app writes the device-compatible 3MF structure (thumbnails, `print_sequence`, `paint_info`) that the CLI alone cannot produce.

Windows UI Automation is both a diagnostic layer and a compatibility path. Remote printing is supported over the printer's LAN MQTT/FTP interface (the protocol family shared with Bambu Studio) and, as an opt-in second transport, over the Anycubic cloud workbench API using the user's account.

## Why orchestrate the app (CLI-only is insufficient for cloud print)

The official Anycubic source tree is an OrcaSlicer derivative. Its CLI parser accepts input models plus machine/process and filament JSON profiles, direct print-setting overrides, plate selection, arrangement/orientation, slicing, an output directory, and 3MF export. Slicing writes per-plate G-code to the output directory; `--export-3mf` additionally packages the result.

However, the CLI-generated single-filament `.gcode.3mf` is **rejected by the printer firmware** (error 10115, "printer cannot parse the file"). Static comparison of a working file (from the app GUI) vs. a CLI export showed the working file carries metadata the CLI does not write:

| Field                                            | CLI export (rejected) | App GUI export (accepted) |
| ------------------------------------------------ | --------------------- | ------------------------- |
| Thumbnails (`Metadata/*.png`, `THUMBNAIL_BLOCK`) | absent                | present                   |
| `print_sequence` / `is_seq_print`                | absent / `false`      | `by object` / `true`      |
| `bed_type`                                       | `textured_plate`      | `hot_plate`               |
| `filament_ids`                                   | `[0,1,2]`             | `[2,3]` (ACE slots)       |
| `first_extruder`                                 | `0`                   | `-1`                      |
| `paint_info` / `model_instances`                 | absent                | present                   |
| `project_settings` arrays                        | 1 slot                | 4 slots (ACE)             |

So the integration boundary is: **CLI for local G-code, app-GUI for anything that must be printed** (LAN or cloud). `slice_via_app` implements the app-GUI path and validates the exported structure (`src/export-scan.ts`).

The wxWidgets UI exposes many controls to Windows UI Automation, but the observed controls often report `ControlType.Pane`, have generated negative automation IDs, and use localized visible names. Coordinate or keyboard automation would therefore be more fragile across versions, languages, DPI, and window layouts — the UIA surface is deliberately small and allowlisted.

## Components

1. **Plugin package**: stable identity, bundled skill, and `.mcp.json` startup mapping.
2. **MCP server**: Zod-validated tools over stdio only. It does not open a TCP port.
3. **Policy layer**: canonical-path checks, input/output allowlists, extension and size limits, explicit profile selection, timeouts, unique output directories, and minimal audit records.
4. **CLI adapter**: uses `spawn(executable, args, { shell: false })`; callers cannot inject arbitrary flags or commands.
5. **Windows bridge**: reads UI Automation state, activates the known Anycubic window, and offers a small allowlisted set of safe UI actions (`uia_tree`, `uia_read`, `uia_click`, `uia_type`, `uia_key`). Click targets and key combinations are restricted to a fixed safe list; raw coordinates or arbitrary keystrokes are never exposed.
6. **App-export orchestration** (`slice_via_app` + `src/export-scan.ts`): starts the app, opens a validated model, clicks the app's own Slice/Export controls, then locates the newest exported file in the allowed output roots and verifies its firmware-compatible structure (thumbnail / `print_sequence` markers).
7. **Printer module** (`src/printer.ts`): LAN MQTT + FTP client for Anycubic/Bambu-compatible printers. Uses `mqtts://<printer-ip>:8883` with user `bblp` and the printer access code; uploads sliced output to `sdcard/` over FTPS (port 990, fallback 21). Exposes `discover_printers`, `printer_status`, `send_to_printer`, `start_print`, `cancel_print`.
8. **Cloud module** (`src/cloud.ts`): opt-in Anycubic cloud workbench client. Exchanges the Slicer Next `access_token` (JWT, normally stored in the app config) for a short-lived XX-Token and calls `getPrinters` / `getCloudFiles` against `cloud-universe.anycubic.com` (EN) or `cloud-platform.anycubicloud.com` (CN). Read operations are validated. `account_print` remains experimental and must not be used for history reprint until the cloud/local contract error in [the 2026-09-07 incident](cloud-history-reprint-incident-2026-09-07.md) is fixed. Requests are signed with the app's hard-coded `app_id`/`app_secret` MD5 scheme; the raw token is never logged.
9. **Token capture + DPAPI store**: `account_capture_token` reads the Slicer Next JWT from process memory (Win32 read) while logged in, and stores it DPAPI-encrypted (`token-store.ts` + `scripts/token-*`). `account_token_status` / `account_token_clear` manage it.
10. **Ephemeral job store**: `prepare_slice_job` creates a 15-minute plan. `run_slice_job` accepts only a known job ID and literal confirmation token. `start_print` requires an explicit `access_code` (or `ANYCUBIC_ACCESS_CODE`) and `dev_ip`/`dev_id`.
11. **CAD modeling workspace** (`src/cad-mesh.ts` + `src/cad-server.ts` + `ui/cad.html`): a precise, dependency-free mesh kernel (double precision, mm) for primitives, transforms, measurements and half-space CSG; a local HTTP server bound **only to 127.0.0.1** with a random per-session token (mutation-gated); and a Three.js web editor (CDN, import-map). `cad_open_workspace` starts the server and opens the browser; `cad_close_workspace` stops it. Exports (STL/OBJ/3MF) are written into the configured output root so the existing slicing/print pipelines can consume them. The CAD server keeps a singleton handle for the MCP session lifetime.

## Trust boundaries

| Boundary             | Controls                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model -> MCP         | Strict schemas (Zod v4, `.strict()`), focused descriptions, no generic command tool.                                                                                                                                                                        |
| MCP -> filesystem    | Absolute paths, canonicalization, allowlists, extension/size checks.                                                                                                                                                                                        |
| MCP -> slicer        | Fixed executable, fixed flag vocabulary, `shell: false`, timeout.                                                                                                                                                                                           |
| Slicer -> artifacts  | New UUID directory, no overwrite, allowlisted root, artifact enumeration.                                                                                                                                                                                   |
| UI automation        | Read-only inspection plus a fixed allowlist of safe clicks/keys; no model-selected coordinates or arbitrary selectors.                                                                                                                                      |
| App-GUI export       | Only the app's own Slice all / Export G-code / Save Project controls; structure validation before the file is used.                                                                                                                                         |
| MCP -> printer       | Access code never logged; `dev_ip`/`dev_id` from user or `ANYCUBIC_PRINTER_IPS`; TLS with self-signed certs accepted for the LAN peer; publish-only control messages, no cloud account required.                                                            |
| MCP -> cloud         | `ANYCUBIC_CLOUD_TOKEN` (or per-call `access_token`) is never logged or echoed; session memoized per region. Printer/file reads are supported; START_PRINT is experimental and currently blocked by the documented cloud/local request mismatch.             |
| MCP -> CAD workspace | Binds only to 127.0.0.1; per-session random token for all mutations (`X-Cad-Token` header or `?token=`); view-only `/api/objects`; exports constrained to the configured output root; idle timeout auto-stops the server; never touches the printer/slicer. |

## Optional environment

| Variable                | Meaning                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANYCUBIC_ACCESS_CODE`  | Printer access code (8-char alphanumeric on modern Anycubic/Bambu firmware). Used when a tool does not receive `access_code`.                                        |
| `ANYCUBIC_PRINTER_IPS`  | Comma-separated fixed printer IPs to skip subnet discovery.                                                                                                          |
| `ANYCUBIC_CLOUD_TOKEN`  | Anycubic account access_token (JWT, from AnycubicSlicerNext conf). Used by `account_login`/`account_devices`/`account_print` when no `access_token` param is passed. |
| `ANYCUBIC_CLOUD_REGION` | `en` (default) or `cn` endpoint selection for the workbench API.                                                                                                     |

## Failure model

- Missing executable or profile: fail before creating a job.
- Invalid or out-of-root path: reject without touching the slicer.
- Expired or reused job: reject.
- Timeout: terminate the child process and mark the job failed.
- Non-zero slicer exit or no artifacts: mark failed and return a bounded diagnostic.
- App-GUI export: if the app is not running / the Slice or Export control is not found, `slice_via_app` returns a structured error; it never guesses coordinates.
- Export structure invalid (`compatible: false`): the tool reports it so the caller does not send an unparseable file to the printer (prevents 10115).
- Printer unreachable on LAN (ports 8883/990 closed or wrong access code): each remote-print tool returns a structured `error` and does not claim success.
- Cloud login or order failure (bad/expired `access_token`, printer offline, region mismatch): each `account_*` tool returns `ok:false` with a bounded `error`; the raw token is never included.
- **Order accepted by API but rejected by the device (10115)**: the API may return code 1 while the printer later rejects the file. Mitigation = produce the file via the app GUI (`slice_via_app`) and validate its structure before dispatch.
- **CAD workspace**: if the workspace is already running, `cad_open_workspace` returns the existing URL (idempotent). If the port is taken, startup fails with a structured error (use port 0 for ephemeral). If the UI file is missing in the deployed `ui/` folder, the server serves a JSON error instead of a page. Partially designed scenes are lost on close/restart (in-memory by design; exports persist on disk).
- Partially written files remain in the unique job folder for manual inspection; nothing existing is overwritten.

## Future hardening

- Verify artifact contents and G-code metadata against the selected profile before returning success.
- Add a signed local companion executable if reliable progress/cancellation requires Windows Job Objects.
- Add versioned UIA adapters per slicer release only when CLI coverage is insufficient.
- Add an optional review UI showing printer, nozzle, material, temperatures, bed type, and output hash before slicing.
- Cloud-transport hardening: token rotation helper, region auto-detection, and an explicit file upload path (workbench lock/claim/PUT/unlock) so `account_print` can accept a local sliced G-code without a pre-existing cloud file.
