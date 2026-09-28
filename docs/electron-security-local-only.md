# S4-003 — Local-Only Security Checklist (Electron)

> **Sprint**: 4 (docs-only)
> **Goal**: preserve every existing security invariant when the stack moves into an
> Electron shell. Companion to `docs/adr-electron-shell.md` + `docs/electron-packaging.md`.

## Invariant map (existing → Electron equivalent)

| #   | Existing invariant (server/browser today)                                                                                               | Electron equivalent required                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| I1  | CAD HTTP workspace binds **loopback only** (`127.0.0.1`, random port)                                                                   | Same — main process must not expose `0.0.0.0`; keep `127.0.0.1` hard-coded                   |
| I2  | **Per-session random token** gates `/api/*`, `/`, `/sync` (header `X-Cad-Token` or `?token=`)                                           | Same token model; renderer receives token via preload bridge, never via URL bar/log          |
| I3  | All tool/server errors go through `redact()` (**tokens/keys masked**)                                                                   | Same `redact()` used on every IPC error path and every console log                           |
| I4  | Cloud tokens stored DPAPI-encrypted locally (never in repo)                                                                             | Electron keeps the same store; renderer never gets cloud tokens — only the CAD session token |
| I5  | No credentials reach the browser (`contextIsolation` equivalent today = page is served with token in URL param but token not persisted) | Strict `contextIsolation: true`, `nodeIntegration: false`, sandbox on the renderer           |
| I6  | `/api/objects` returns mesh stats only (no secrets)                                                                                     | Same payloads over IPC bridge                                                                |
| I7  | MCP stdio transport: single client owns stdin/stdout                                                                                    | Main process owns the child's stdio; no socket listener for MCP                              |

## Electron main-process checklist

- [ ] `app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors')` — not needed;
      keep CORS behavior explicit in server (loopback + token already enforces it).
- [ ] Preload uses `contextBridge.exposeInMainWorld('cadToken', token)` and
      `'cad'` API (open/close/reload). No `process`, `require`, `Buffer` exposed.
- [ ] `BrowserWindow` webPreferences:
      `js
webPreferences: {
contextIsolation: true,
nodeIntegration: false,
sandbox: true,          // renderer has no Node.js at all
preload: path.join(__dirname, 'preload.cjs')
}
`
- [ ] Only `custom://app/*` is registered as privileged scheme; block everything else
      (`setWindowOpenHandler` deny, `will-navigate` allowlist to `custom://app/index.html`).
- [ ] Token lifecycle: generate once per server start, pass over IPC at load; **never**
      embed in `file://` URL, never write to disk, never log.
- [ ] Child server supervision: on crash, restart with a **new token**; old token
      invalidated immediately.
- [ ] `app.on('web-contents-created')`: force `session.setPermissionRequestHandler` deny
      for clipboard/notification/geolocation etc. (not needed by CAD UI).

## Renderer / UI checklist

- [ ] `ui/cad.html` keeps using `window.cadToken` when available
      (`const token = window.cadToken ?? urlToken`), preserving browser mode.
- [ ] No `eval`-able sinks added by Electron glue (existing parametric sandbox in the
      server remains authoritative; the renderer never evaluates generated code).
- [ ] AI `/api/ai_prompt` path: provider key stays in the **main process env only**;
      renderer never receives `CAD_AI_API_KEY`; on error the UI shows
      `AI provider not configured (set CAD_AI_API_KEY)` — no key leak.
- [ ] Import-map vendor assets are static and MIT; no remote fetch at runtime in
      offline mode (removes CDN as an attack surface).

## Logging & redaction checklist

- [ ] Every `console.*` in main/preload wraps strings with `redact()`.
- [ ] Child server stdout/stderr piped to log file; `redact()` filter applied
      before writing (or server already redacts — keep double gate).
- [ ] Never log `X-Cad-Token` or `window.cadToken` values; log only
      `token-present=true`.
- [ ] Debug dumps (`--trace`) must be opt-in and off by default.

## Release-time checklist

- [ ] Repackage without `.env`, `AnycubicSlicerNextControl/tokens/*`, `.probe-*`,
      `certs/*.pfx` (see `electron-packaging.md` §7).
- [ ] MSIX auto-update feed is HTTPS + signed (`latest.yml`); validate signature
      server-side.
- [ ] `THIRD_PARTY_NOTICES.md` present; license scan before each release (MIT/Apache-2 only).

## Verification (future)

When the Electron phase lands, verify with:

```bash
pnpm run test          # server suite unchanged
node scripts/smoke.mjs # MCP + CAD workspace exercises unchanged
# manual: launch packaged exe, confirm token in devtools is absent from window.cadToken logs,
# confirm CDN network requests = 0, confirm no loopback port opened on non-127.0.0.1.
```
