# ADR-001 — Electron Shell over Node MCP Server

> **Status**: Accepted (plan-only — no runnable Electron code in this sprint)
> **Date**: 2026-09-11
> **Sprint**: 4 (docs-only)
> **Related**: `docs/electron-packaging.md`, `docs/electron-security-local-only.md`

## Context

`anycubic-slicer-next-control` v0.1.0 is an MIT-licensed MCP server (Node ≥22) exposing
an MCP stdio transport, a loopback HTTP CAD workspace (`http://127.0.0.1:{port}/?token=...`),
and a browser-based Three.js UI (`ui/cad.html`) that talks to the workspace REST API
(`/api/objects`, `/api/add`, `/api/import`, `/api/parametric`, `/api/ai_prompt`, …).

The user constraint is **"future Electron"**: eventually the whole stack should ship as
a desktop application. Sprint 4 is **plan-only**: it documents the packaging blueprint,
it does not write Electron code.

This ADR records the recommended architecture and the considered alternatives.

## Decision

**Wrap the existing Node server unchanged inside an Electron main process, reuse the
existing `ui/cad.html` renderer, and keep loopback HTTP + per-session token as the only
transport between renderer and server.** No framework rewrite. No new runtime.

## Recommended Architecture

```mermaid
flowchart LR
  subgraph Main Process (Node, bundled)
    M[MCP stdio server<br/>dist/server.mjs components]
    CAD[CAD HTTP workspace<br/>127.0.0.1:loopback + token]
    SPAWN[Child: node server.mjs<br/>or in-process import]
    OUTLETS[Outlets: IPC bridge<br/>contextBridge + ipcMain]
  end
  subgraph Renderer (Chromium sandboxed)
    UI[ui/cad.html<br/>Three.js + BVH CSG + import-map CDN]
    FETCH[cadFetch → http://127.0.0.1:port]
    IPC[window.cadToken + window.cad api]
  end
  SPAWN --> CAD
  UI --> FETCH --> CAD
  UI --> IPC --> OUTLETS --> CAD
```

### Process model (Option A — recommended: child process)

- Electron main process is a thin launcher.
- It **spawns the existing Node stdio MCP server** (`dist/server.mjs`) as a child process
  (same Node ≥22 runtime embedded / executable chosen at install time), exactly like the
  MCP client does today over stdio.
- `server.mjs`'s `createCadServer().start()` binds the CAD workspace on `127.0.0.1`
  (loopback only) with a **per-session random token** (existing behavior — unchanged).
- If the child crashes, Electron restarts it (Six-it-style supervision) and the renderer
  reconnects; no code change in the server is required.

**Why child process over in-process import:**

1. `dist/server.mjs` is an **ESM bundle**. Electron main is CommonJS by default; importing
   an ESM bundle with dynamic `import()` inside the main lifecycle adds interop risk
   (top-level await, stdio ownership, graceful shutdown).
2. Stdio ownership: the server owns `process.stdin`/`stdout` for MCP framing. Running it
   in-process would fight Electron's event loop and logging.
3. Isolation: crash of CAD engine (WASM) cannot take the shell down; supervision loop can
   restart just the server.
4. Zero server changes: any improvements to the server ship in the same package.

### Process model (Option B — in-process import, rejected)

`await import("../dist/server.mjs")` inside Electron main and instantiate the stdio
transport against a synthetic duplex stream. Higher wiring complexity, ESM/CJS interop
in Electron main, and no crash isolation. Only revisit if spawning Node becomes
impractical (embedded runtime distribution).

### UI loading

- The renderer must reach the **same `ui/cad.html`** the browser uses.
- Recommended: `custom://app/ui/cad.html` protocol (`protocol.registerFileProtocol` /
  `registerSchemesAsPrivileged` with `stream: true, supportFetchAPI: true`).
- The HTML is already CDN-independent in _logic_: `three@0.186.0`, `three-mesh-bvh`,
  `three-bvh-csg` are loaded via import-map from jsdelivr / esm.sh. For offline-first
  desktop use, vendoring these three packages **locally** is the recommended change
  (see `electron-packaging.md`). The UI JS (`cadFetch`, import-map, params) is unchanged.

### IPC channels

- Keep HTTP as the _data_ transport (renderer ↔ CAD workspace).
- Use IPC only for:
  - Token handoff: preload `contextBridge.exposeInMainWorld('cadToken', token)` — the
    renderer reads `window.cadToken` instead of `?token=` in the URL.
  - Lifecycle: `window.cad.openWorkspace()`, `window.cad.closeWorkspace()`,
    `window.cad.reloadServer()`.
  - Optional desktop extras later: export-dialog, open-file (STL) via native file picker.

## Alternatives considered

| Option                              | Pros                               | Cons                                                                                                                              | Verdict                                         |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Tauri (Rust)**                    | Small binary, memory-light, native | Requires rewriting server connectivity (Rust sidecar), UI must run in WebView2; no ESM Node bundle reuse; Rust toolchain in build | Rejected — Node server reuse is the whole point |
| **Plain WebView2 / WebView2Loader** | No Electron dependency             | Manual host/background process management, no npm ecosystem, more glue code, harder auto-update                                   | Rejected — too much custom glue                 |
| **PWA / browser-only**              | Zero packaging                     | No native file dialogs, no install, user already runs MCP where a desktop app adds value                                          | Not chosen for the "future Electron" constraint |

**Why Electron wins here**: the server is Node; the UI is a plain HTML/JS single page
with an import-map; Electron gives identical Chromium behavior, npm packaging via
`electron-builder`, and the simplest main-process supervision story. Tauri would require
maintaining a Rust sidecar just to bridge to `dist/server.mjs`, duplicating what Electron
gives for free.

## Consequences

- **Positive**: server and UI ship unchanged; token/loopback security invariant is
  preserved; path to NSIS/MSIX/auto-update is standard Electron ecosystem.
- **Negative**: larger binary footprint than Tauri; Electron runtime must be licensed
  (Electron/MIT — compatible with project's MIT constraint); renderer still trusts
  `window.cadToken` which must be constrained by `contextIsolation` (see security doc).
- **Migration cost**: none for the server; the UI needs the import-map to become
  locally-vendored if offline support is required.

## References

- `docs/electron-packaging.md` — S4-002 installer/distribution blueprint
- `docs/electron-security-local-only.md` — S4-003 security invariant mapping
- Project `architecture.md` — existing loopback/token architecture
