# Sprint 9.12 — Storage Browser, DevTools & Agent Parity (close printer integration)

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | File browser, DevTools panel, Agent tools parity, i18n + agnosticism audit                                                                                                                                                      |
| **Sprint Goal**       | Close the printer-integration loop: browse local/USB files, expose a DevTools pane for raw snapshot + hidden commands, and give the future Agent the SAME read/write surface as the UI (with policy) — then harden agnosticism. |
| **Duration Estimate** | ~2 weeks                                                                                                                                                                                                                        |
| **Priority**          | P1                                                                                                                                                                                                                              |
| **Sprint Type**       | Feature + Quality                                                                                                                                                                                                               |
| **Primary Owner**     | apps/editor + MCP server (storage + agent tools)                                                                                                                                                                                |
| **Source**            | User request 2026-10-02 + Consultor report §B/§C.4 (T.11–T.13)                                                                                                                                                                  |
| **Depends On**        | Sprints 9.9–9.11                                                                                                                                                                                                                |
| **Status**            | ⏳ Planned                                                                                                                                                                                                                      |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.12-00x): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

Finish the integration story: a Files tab (local/USB listings with thumbnails + send/print via
the real approval flow), a DevTools pane (raw snapshot mirror, property catalogs, hidden
command surface with confirm — the only place raw `printer_command_send` is allowed for user),
and Agent parity: `printer_get_snapshot` (read-only) + write tools all routed through the
policy from 9.10 — the Agent sees the same schema the UI draws. Then: full PT/EN i18n sweep
and a sanitize/agnosticism audit to ready the repo for the next release. No new external
runtime deps beyond what the camera player needs; licenses check stays green.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.12-001 — Files browser (local/USB) + send/print

| Field                | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| **Ticket ID**        | S9.12-001                                                     |
| **Title**            | `DevicePanel` — Files tab: listings + thumbnails + send/print |
| **Priority**         | P1                                                            |
| **Type**             | Feature                                                       |
| **Estimated Effort** | L                                                             |
| **Status**           | ✅ Done                                                       |

#### Context

Consultor §C.1 Tab "Ficheiros". List local + USB storage with metadata (name, size, date,
thumbnail), unified actions "Enviar / Imprimir" reusing the real approval card (9.10-004).
Cloud files listed read-only per burner caps (metadados only).

#### Acceptance criteria

- [x] Local + USB tabs; thumbnails when available; refresh + stale indication.
- [x] Send/Print goes through the live snapshot approval; storage preflight (`getUserStore`)
      shown before send.
- [x] Unit tests for listing normalisation (no real IDs outside fixtures).

### S9.12-002 — DevicePanel — DevTools pane (raw snapshot, catalogs, hidden commands)

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.12-002                                                          |
| **Title**            | DevTools: raw snapshot mirror + property catalog + command surface |
| **Priority**         | P1                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | M                                                                  |
| **Status**           | ✅ Done                                                            |

#### Context

Consultor §C.4/§B.4. The `raw` mirror from 9.9-002 becomes a collapsible JSON viewer;
`printer_property_catalog` + `printer_hidden_command_map` rendered as searchable tables;
raw `printer_command_send` form gated: DevTools visible + typed confirm only, Agent blocked
by policy from 9.10-001.

#### Acceptance criteria

- [x] Raw viewer + catalogs searchable; hidden command form requires typed confirm.
- [x] Every DevTools action logged to the session journal (auditable).
- [x] Agent policy rejects raw send (unit test).

### S9.12-003 — Agent parity: `printer_get_snapshot` + write tools (policy-routed)

| Field                | Value                                    |
| -------------------- | ---------------------------------------- |
| **Ticket ID**        | S9.12-003                                |
| **Title**            | MCP Agent tools mirroring the UI surface |
| **Priority**         | P0                                       |
| **Type**             | Feature (Agent)                          |
| **Estimated Effort** | L                                        |
| **Status**           | ⏳ Planned                               |

#### Context

The future Agent inside the app reads the SAME `PrinterSnapshot` the UI draws — no duplicate
pipeline. `printer_get_snapshot({printerId?})` read-only; write tools (`set_temperature`,
`set_speed_mode`, `pause/resume/stop`, `ace_dry`, `ace_auto_feed`, `slot_bind`) built on the
policy table with `requiresApproval` enforced via the S9-006 approval card. Storage exposure
to Agent limited to metadados (burner caps) — decide pre-implementation.

#### Acceptance criteria

- [x] Snapshot tool returns the exact schema from 9.9-001 (versioned).
- [x] Write tools blocked until approval card; policy imported from the same module.
- [x] Smoke test: Agent tool list includes snapshot; write tools gated.

### S9.12-004 — i18n PT/EN full sweep + agnosticism audit

| Field                | Value                                          |
| -------------------- | ---------------------------------------------- |
| **Ticket ID**        | S9.12-004                                      |
| **Title**            | i18n completeness + sanitize/agnosticism audit |
| **Priority**         | P1                                             |
| **Type**             | Quality                                        |
| **Estimated Effort** | M                                              |
| **Status**           | ⏳ Planned                                     |

#### Context

Consultor §C.4/§E. Machine states are normalized enums → translated; raw values (`0`, `-1`,
`20025`) never shown. Keys in `en.json` + `pt-PT.json`, no hardcoded UI strings left.
Final agnosticism audit: `node scripts/sanitize-repo.mjs --dry-run` → 0; docs redaction of
`docs/evidence` via `scripts/redact-evidence-json.mjs`; full `pnpm run check` green; licenses
check stays green (no new non-MIT/Apache deps).

#### Acceptance criteria

- [x] Zero hardcoded UI strings (grep gate); both locales complete + covered.
- [x] Sanitizer dry-run 0 files; evidence JSON parseable + redacted.
- [x] `pnpm run check` EXIT:0 closes the sprint (build + unit/integration/smoke/e2e +
      licenses + architecture).
