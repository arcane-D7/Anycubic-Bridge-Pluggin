# Sprint 4 — Electron Packaging (Plan-Only)

## Sprint Metadata

| Field                 | Value                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Electron packaging strategy                                                                                                                                   |
| **Sprint Goal**       | Document the packaging path for a future Electron desktop app wrapping the CAD workspace + MCP server (plan-only; no runnable Electron shell in this sprint). |
| **Duration Estimate** | ~1 day (docs + checklist)                                                                                                                                     |
| **Priority**          | P2                                                                                                                                                            |
| **Sprint Type**       | Docs                                                                                                                                                          |
| **Primary Owner**     | cad-engine                                                                                                                                                    |
| **Source**            | User constraint: "future Electron"; architecture docs                                                                                                         |
| **Depends On**        | Sprint 3                                                                                                                                                      |
| **Status**            | ✅ Complete (docs) · commit (este sprint)                                                                                                                     |
| **Health Gate**       | `git diff --stat` docs-only                                                                                                                                   |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

The CAD engine, MCP server, and web UI are all MIT-clean and portable. This
sprint produces a documented packaging blueprint: how an Electron shell would
bundle the Node server, the MANIFEST/token-gated HTTP loopback, six-It style
process management, and installer distribution (electron-builder + NSIS/MSI),
plus a checklist for local-only behavior (no cloud secrets). No runnable
Electron code is written — this is the "plan-only" phase the user requested.

## Health Check Commands (docs-only gate)

```bash
git diff --stat        # only docs/ changes expected
```

## Tickets

### S4-001 — Electron architecture decision record

| Field                | Value                                    |
| -------------------- | ---------------------------------------- |
| **Ticket ID**        | S4-001                                   |
| **Title**            | ADR: Electron shell over Node MCP server |
| **Priority**         | P1                                       |
| **Type**             | Docs                                     |
| **Estimated Effort** | M                                        |
| **Source Finding**   | future-Electron user constraint          |
| **Status**           | ✅ Done · docs/adr-electron-shell.md     |

#### Context

Document the recommended architecture: Electron main process spawns the bundled
`dist/server.mjs` (stdio MCP) or imports it directly; CAD HTTP workspace stays
on loopback with per-session token; renderer loads the same `ui/cad.html` via a
`custom://` protocol or file; IPC channels for tool results. Include alternatives
(Tauri, plain WebView) and why Electron wins for the current UI (Three.js +
import-map CDN).

#### Acceptance Criteria

- [x] ADR written under `docs/` (`docs/adr-electron-shell.md`).
- [x] Covers process model, token/loopback security, UI loading, IPC.
- [x] Lists alternatives (Tauri, WebView2) with trade-offs.
- [x] Run the health check command successfully (docs-only diff).

### S4-002 — Installer & distribution checklist

| Field                | Value                                         |
| -------------------- | --------------------------------------------- |
| **Ticket ID**        | S4-002                                        |
| **Title**            | Packaging blueprint (electron-builder)        |
| **Priority**         | P1                                            |
| **Type**             | Docs                                          |
| **Estimated Effort** | S                                             |
| **Source Finding**   | WinApp CLI packaging skill + plugin awareness |
| **Status**           | ✅ Done · docs/electron-packaging.md          |

#### Context

The desktop distribution needs MSIX/NSIS installers, code signing, and
auto-update. Document: electron-builder config sketch, app icon assets, signing
certificate workflow, output paths, and the runtime requirement note (Node ≥22
embedded). Keep all paths/plugins MIT-compatible.

#### Acceptance Criteria

- [x] Packaging blueprint with electron-builder targets, signing, auto-update.
- [x] App icon/manifest asset checklist (WinApp CLI compatible).
- [x] Clean-room note: no Anycubic proprietary assets bundled.
- [x] Run the health check command successfully (docs-only diff).

### S4-003 — Security & local-only checklist

| Field                | Value                                          |
| -------------------- | ---------------------------------------------- |
| **Ticket ID**        | S4-003                                         |
| **Title**            | Local-only hardening checklist                 |
| **Priority**         | P1                                             |
| **Type**             | Docs                                           |
| **Estimated Effort** | S                                              |
| **Source Finding**   | redaction/token-gating invariants in this repo |
| **Status**           | ✅ Done · docs/electron-security-local-only.md |

#### Context

The desktop app must preserve the current security invariants: loopback-only CAD
server, per-session token, no cloud secrets in renderer, DPAPI-encrypted token
store, redaction of tokens/keys in all logs. Document how Electron preserves
these (contextIsolation, no nodeIntegration in renderer, token passed via
`window.cadToken` bridged over IPC only).

#### Acceptance Criteria

- [x] Security checklist documenting redaction, token flow, contextIsolation.
- [x] Confirms no secrets reach the renderer or logs.
- [x] Maps each existing invariant to its Electron equivalent.
- [x] Run the health check command successfully (docs-only diff).

## Sprint Commit

```bash
git add -A
git commit -m "docs(sprint-4): electron packaging blueprint"

- S4-001: Electron architecture ADR
- S4-002: installer + distribution checklist
- S4-003: local-only security checklist
```
