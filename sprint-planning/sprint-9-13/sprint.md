# Sprint 9.13 — Editor ↔ Anycubic Cloud Printer Integration

> **Roadmap gap (2026-10-07, user request)**: the editor today discovers printers
> **only via LAN** (`ANYCUBIC_PRINTER_IPS` + port probe). The preserved MCP server
> already owns the full cloud stack (`account_login`, `account_devices`,
> `account_cloud_diagnostics`, cloud MQTT, JWT DPAPI-encrypted). The user asked
> for the **complete package**: cloud-account printers in the picker + live
> cloud snapshot in the Device panel, routed through the local loopback —
> never exposing the JWT to the webview.

## Status

| #   | Ticket    | Title                                                  | Status             |
| --- | --------- | ------------------------------------------------------ | ------------------ |
| 1   | S9.13-001 | cloud-bridge loopback (Node → MCP stdio)               | ✅ Done + verified |
| 2   | S9.13-002 | editor cloud provider + picker cloud badge             | ✅ Done            |
| 3   | S9.13-003 | Device panel cloud snapshot + adaptive polling         | ✅ Done            |
| 4   | S9.13-004 | i18n keys (EN/PT) + agnosticism audit + gate + commits | ✅ Done            |

## Context (verified)

- **MCP server is stdio-only** — no listening socket. Its cloud tools are the
  authority: `account_devices` (vendor/server.mjs:6553), `account_cloud_diagnostics`
  (:6606), `TokenStore` DPAPI (:2433), `getPrinters()` → `{id, key, machineType,
deviceStatus, name?, model?, online}` (:2380).
- **HTTP gateways already exist as separate processes**:
  - `scripts/rest-bridge.mjs` — POST /tools/{name}, Bearer token, port 8766.
  - `scripts/loopback-bridge.mjs` — GET-only CAD read bridge, ephemeral port + token
    (spawns `scripts/mcp-entry.mjs` over StdioClientTransport — the exact precedent
    to copy for the broker cloud lane).
- **Rust broker-server** (crates/broker-server) is the pattern to extend: axum,
  loopback `127.0.0.1:18181`, CORS allow-origin `http://127.0.0.1:1420` +
  `tauri://localhost`, env-only config via `config_from_env()`, sexpandable Router.
- **Editor swap points**: `usePrinterDevice.setFetcher()` (printer-device.ts:54-91)
  is the documented provider-swap; `PrinterListResult.source` is `"env"` literal
  today; `discoverPrinters` in mock.ts is the mock provider.
- **Vite exposes only `ANYCUBIC_PRINTER_IPS`** to the webview
  (vite.config.ts `envPrefix: ["VITE_", "ANYCUBIC_PRINTER_IPS"]`) — a new
  `ANYCUBIC_CLOUD_LOOPBACK_URL` must be added to that allow-list.

## Execution

> **Decision (2026-10-07)**: the cloud lane landed as a **Node loopback**
> (`scripts/cloud-bridge.mjs`), NOT a Rust broker-server extension — the Rust
> axum service has no MCP SDK dependency and isn't spawned by Tauri today,
> while `scripts/loopback-bridge.mjs` is the exact HTTP→stdio precedent with
> the SDK already in the tree. Same posture: loopback-only, CORS allow-list,
> env-only config, JWT never leaves the MCP child.

1. **S9.13-001** — `scripts/cloud-bridge.mjs` (✅ smoke-tested):
   - `GET  /health` → `{ok, state}`
   - `POST /printer/cloud/login` → `account_login` delegation (JWT stripped)
   - `GET  /printer/cloud/devices?region=` → `account_devices` → normalized
     `{id, key, machineType, name, model, online}` (real account device at
     runtime; NEVER committed)
   - `GET  /printer/cloud/snapshot?printerId=&kind=&region=` →
     `account_cloud_diagnostics` (read-only)
   - Spawns the MCP child via `StdioClientTransport` + `scripts/mcp-entry.mjs`
   - CORS/Origin allow-list: DEV `http://127.0.0.1:1420`, PROD `tauri://localhost`
2. **S9.13-002** — `apps/editor/src/bridge/cloud.ts` (mirror `chat-transport.ts`):
   env gate `ANYCUBIC_CLOUD_LOOPBACK_URL`/`ANYCUBIC_CLOUD_REGION` →
   `cloudDiscoverPrinters` (source `"cloud"`, id `cloud-<id>`) +
   `cloudPayloadToMcp` adapter (cloud keys → MCP-flat grammar) + shared
   `mapPrinterPayload`. `printers-core.ts` `source` union "env"|"cloud";
   `usePrinters.refreshCloud` merges into the list; `PrinterPicker` shows a
   "Cloud" badge + `cloud·<region>` footer. `vite.config.ts` envPrefix
   allow-list extended (env-only).
3. **S9.13-003** — DevicePanelMonitor swaps `usePrinterDevice.setFetcher` to
   `cloudFetchSnapshot` when the selected id starts with `cloud-` (LAN keeps
   the mock fetcher); same `PrinterSnapshot` schema via the shared mapper.
4. **S9.13-004** — i18n keys `printer.badge.cloud` EN/PT; AGENTS.md §4 env table
   (+`ANYCUBIC_CLOUD_LOOPBACK_URL`); sanitizer dry-run 0; gate `pnpm run check`
   EXIT=0; conventional commits, **no push**.

## Health gate (per ticket)

```sh
pnpm run check                  # unit+type+lint+rust+build+smoke+e2e+licenses+arch+sanitize
# + curl loopback smoke for the cloud lane
```

## Canonical refs

- `docs/architecture.md`, `sprint-planning/sprint-overview.md` (sprints 9.9–9.12
  are LAN/preserved-MCP; 9.13 is the cloud gap).
- `scripts/rest-bridge.mjs`, `scripts/loopback-bridge.mjs` (HTTP→stdio pattern).
- `crates/broker-server/src/lib.rs` (loopback + CORS + env-config pattern).
- `apps/editor/src/bridge/{mock,types,chat-transport}.ts`, `state/{printers,printer-device}.ts`.
