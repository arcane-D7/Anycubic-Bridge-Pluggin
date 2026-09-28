# Sprint 6 — R0 Foundation: Desktop Shell + Domain Model + Contracts

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sprint Name**       | R0 Foundation — Tauri+React scaffold, broker skeleton, machine capability contract, versioned project schema, loopback bridge                                                                                                                                |
| **Sprint Goal**       | Deliver a runnable desktop shell with the new workspace, the machine capability contract v1 (fail-closed, 3 ingestion paths), a versioned project schema with content-addressed artifacts, and a read-only loopback bridge to the preserved Node MCP server. |
| **Duration Estimate** | ~3 weeks                                                                                                                                                                                                                                                     |
| **Priority**          | P0                                                                                                                                                                                                                                                           |
| **Sprint Type**       | Feature                                                                                                                                                                                                                                                      |
| **Primary Owner**     | platform-core                                                                                                                                                                                                                                                |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §5, §6 (auth-separable), §7 (UI), §10 R0, §3.0a (dual slicing modes — persisted per project); Sprint 5 gates                |
| **Depends On**        | Sprint 5 (architecture + quality gates)                                                                                                                                                                                                                      |
| **Status**            | ⏳ Planned                                                                                                                                                                                                                                                   |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

R0 builds the shell everything else hangs on. The new `apps/editor` (Tauri 2 + React 19 + R3F 9) starts up, talks to a Rust broker (rusqlite workspace DB, no auth dependency), ingests
machine profiles through the three read-only paths into the §5.1 capability schema with
fail-closed pre-flight rejection, and reads the legacy scene **read-only** through a loopback
bridge during migration. The legacy editor is **not** deleted yet (cutover is at R5+); it is
frozen and bridged. Auth service is scaffolded as a separable loopback service but the editor
core runs with it off.

## Health Check Commands (must pass before commit)

```bash
pnpm run check   # format → lint → typecheck → unit → integration → build → smoke → e2e → licenses → sanitize (Sprint 5 gate)
pnpm run e2e     # new desktop-app e2e (Tauri) plus legacy cad-ui e2e read-only
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S6-001 — Tauri 2 + React 19 scaffold (apps/editor)

| Field                | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| **Ticket ID**        | S6-001                                                           |
| **Title**            | Desktop shell scaffold (Tauri 2, React 19, R3F 9, layout panels) |
| **Priority**         | P0                                                               |
| **Type**             | Feature                                                          |
| **Estimated Effort** | XL                                                               |
| **Source Finding**   | Invest. Rev 2.0 §7.1/§7.2; Sprint 5 architecture (S5-001/002)    |
| **Status**           | ⏳ Planned                                                       |

#### Context

No React/Tauri code exists. This ticket creates the app: Tauri 2 Rust core, Vite + React 19 +
TS strict, Zustand/Jotai state, TanStack Query, R3F 9 viewport shell with the panel layout
(object tree / 3D viewport / chat / bottom timeline) from §7.2. No geometry authority yet (that
is R1) — the viewport renders empty-state + profile-driven build plate placeholder. Must pass
all Sprint 5 quality gates from day one.

#### Acceptance Criteria

- [ ] `apps/editor` workspace member boots `pnpm tauri dev` with the §7.2 panel layout; window title/branding independent of Blender.
- [ ] React 19 + TS strict; `pnpm run typecheck` green for the workspace; no `any` in new code (lint enforces).
- [ ] State via Zustand/Jotai (scene/selection stubs), TanStack Query wired to a mocked bridge endpoint.
- [ ] Build plate placeholder is **profile-driven** (reads a stub machine profile), never a hardcoded 220x220 default.
- [ ] R3F 9 (stable) used; R3F 10 alpha explicitly not installed (license/pinning note in `docs/licenses.md` if applicable).
- [ ] Health gate `pnpm run check` green.

### S6-002 — Rust broker skeleton + workspace DB

| Field                | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Ticket ID**        | S6-002                                                                      |
| **Title**            | Broker skeleton, rusqlite workspace.db, keystore boundary (no auth dep)     |
| **Priority**         | P0                                                                          |
| **Type**             | Feature                                                                     |
| **Estimated Effort** | L                                                                           |
| **Source Finding**   | Invest. Rev 2.0 §8.1/§8.5 (T2 broker, keys in keystore), §6.1 storage table |
| **Status**           | ⏳ Planned                                                                  |

#### Context

The Rust broker is the trusted orchestrator: process supervision, keystore (DPAPI/Stronghold),
DB ownership. This ticket creates the crate skeleton + SQLite schema (projects, ops, undo
journal, revisions) **without** auth — the editor core has zero auth dependency per §8.1. BYOK
keys never touch the DB (keystore only). A `schema_version` pragma is enforced from the start
(versioned project schema).

#### Acceptance Criteria

- [ ] `crates/broker` crate compiles with `cargo check`; exposes Tauri command façade (typed commands, no panic surface).
- [ ] rusqlite migrations (embedded, versioned): projects, objects, ops/journal, revisions, artifacts (content-addressed references, blobs outside DB). `PRAGMA user_version` enforced; migration test adds v2 schema and asserts data survives.
- [ ] Keystore trait (DPAPI/Stronghold behind an interface) stubbed with a file-based fake for tests; **proves** BYOK keys are never written to SQLite.
- [ ] Editor core starts and works with the auth service **absent** (auth not running → no crash, `service_scope = local-project` only).
- [ ] Unit + integration tests for migrations and keystore fake pass; health gate green.

### S6-003 — Machine capability contract v1 (schema + ingestion)

| Field                | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| **Ticket ID**        | S6-003                                                                                 |
| **Title**            | §5.1 machine capability contract v1 — schema, 3 ingestion paths, fail-closed rejection |
| **Priority**         | P0                                                                                     |
| **Type**             | Feature                                                                                |
| **Estimated Effort** | XL                                                                                     |
| **Source Finding**   | Invest. Rev 2.0 §5.1/§5.2/§5.3 (fail-closed, src/measured, qualification)              |
| **Status**           | ⏳ Planned                                                                             |

#### Context

The machine capability contract is the single source of truth for what a machine can do —
NOT the env vars or cloud catalog (those populate it). Unknowns are null/"unknown", never a
default that hides ignorance. Unsupported feature → pre-flight rejection with the named
capability and profile id. Implementation must include: JSONC schema v1, three read-only
ingestion paths (manual form / API from `scripts/printer-http-property-catalog.mjs` with
confidence marking / online catalog hash-checked), profile store, qualification lifecycle
(unqualified → shadow → qualified), event-driven revocation (nozzle/firmware/toolhead swap).

#### Acceptance Criteria

- [ ] `schemas/machine-profile.schema.json` (JSONC v1.0) matches §5.1; unknown = null/"unknown"; `source_class` per-field; `confidence/tolerance` fields.
- [ ] Rust `crates/machine-profile` (or TS equivalent in workspace): load/validate/save; ingestion paths 1–3 all read-only into the store.
- [ ] Manual path: form → profile with `source_class=src`, confidence low until corroborated.
- [ ] API path: pulls property catalog, runs a sanity model, flags low-confidence fields (never asserts); a contradictory-model capture is recorded as low confidence with `[?]`-style provenance.
- [ ] Online catalog: version-pinned, hash-checked, user-approve to apply; never silently overrides manual/measured — conflict raises for human resolution.
- [ ] Fail-closed pre-flight: feature requiring a capability not declared → rejected with capability name + profile id; unit tests cover missing `continuous_z`, missing joints, null build volume.
- [ ] Qualification lifecycle: `unqualified → shadow → qualified`; nozzle/firmware/toolhead change event → auto `unqualified` + revoked_reason + in-flight stop at next safe boundary.
- [ ] Bundled reference profile present with `<MACHINE_TYPE>` / `<PRINTER_ID>` / `<FW_VERSION>` placeholders only (sanitizer-clean); no product hardware default.
- [ ] Health gate green.

### S6-004 — Versioned project schema + content-addressed artifacts

| Field                | Value                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S6-004                                                                                                     |
| **Title**            | Project schema v1 (objects/ops/undo/revisions) + content-addressed artifact store                          |
| **Priority**         | P0                                                                                                         |
| **Type**             | Feature                                                                                                    |
| **Estimated Effort** | L                                                                                                          |
| **Source Finding**   | Invest. Rev 2.0 §2.2 (no durable model today), §6.1 (content-addressed artifacts), §4.6 (revision/journal) |
| **Status**           | ⏳ Planned                                                                                                 |

#### Context

The legacy editor has an in-memory singleton scene: no snapshots, autosave, undo graph, stable
object IDs or versioned schema (Rev 2.0 §2.2). R0 introduces the durable project model that R1
will drive from the Blender scene: objects with stable IDs, ops journal, revisions, and
content-addressed geometry artifacts keyed by hash. Geometry blobs live outside the DB
(hash→file reference). The project model also persists the **slicing mode** per project
(§3.0a): a typed `slicing_mode` field (`standard` | `nonplanar`, default `standard`) so the
dual-mode requirement is data from day one.

#### Acceptance Criteria

- [ ] Schema v1 in rusqlite: `projects`, `objects` (stable UUID ids), `ops` (journal), `revisions`, `artifacts` (sha256 → path); schema versioned and migratable.
- [ ] `slicing_mode` persisted per project: typed enum column, default `standard`, validated (invalid value rejected at the schema/API layer), included in the job record once slicing exists (§3.0a mode lifecycle).
- [ ] Artifact store: write/read by content hash; dedupe tested (two identical meshes → one blob); DB stores only the reference.
- [ ] Undo graph stubs: ops journal append-only; revisions monotonic; replays target a revision (R1 will implement re-validation).
- [ ] Autosave + crash-recovery skeleton: periodic snapshot + journal replay to the last committed revision (integration test simulates a kill and replays).
- [ ] Migration test: v1→v2 upgrade preserves data (incl. `slicing_mode`); `PRAGMA user_version` asserted.
- [ ] Health gate green.

### S6-005 — Loopback bridge to preserved Node MCP server (read-only legacy scene)

| Field                | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| **Ticket ID**        | S6-005                                                                                 |
| **Title**            | Read-only loopback REST/SSE bridge to the existing Node MCP/CAD server                 |
| **Priority**         | P1                                                                                     |
| **Type**             | Feature (bridge)                                                                       |
| **Estimated Effort** | L                                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §7.1 (worker bridge), §2 (preserved contract), §10 R0 (migration gate) |
| **Status**           | ✅ Complete (2026-09-28, commit `a61782e`)                                             |

#### Context

During migration the legacy `ui/cad.html` scene must be readable through the new app — the §1.1
migration gate "legacy scene reads through the bridge with no data loss". The existing Node
server + MCP surface is preserved as-is; the new app consumes it over loopback REST/SSE
(temporary, read-only for the legacy scene until cutover at R5+). No legacy edits through the
new UI yet.

#### Acceptance Criteria

- [x] Loopback bridge crate/TS client spawns the preserved Node server (`scripts/mcp-entry.mjs` path) on a random localhost port with a session token (no fixed port, token-gated).
- [x] Get-only surface: scene object list + mesh read + project read round-trips against a fixture project; zero write paths over the bridge in R0.
- [x] Stale/absent server: bridge reports clean `unavailable` state (UI shows "legacy server not running") — never a silent fallback or crash.
- [x] Integration test: start server, load a fixture 3MF through bridge, assert identical object/mesh JSON to direct server read (no data loss).
- [x] Legacy `ui/cad.html` **frozen**: an ignore/check rule prevents re-adding new authoring paths to it (read-only during migration; retired at cutover).
- [x] Health gate green.

#### Implementation Notes

- `scripts/loopback-bridge.mjs` — `startBridge({ inputPath, port, token, timeoutMs })` spawns the
  preserved server through `scripts/mcp-entry.mjs` (auto-builds `dist/` on a fresh clone), calls
  `cad_open_workspace` with `{ open_browser:false, idle_timeout_min:0 }` to obtain the per-session
  upstream token + URL, and serves a **get-only** REST surface on a second random loopback port:
  `GET /health`, `GET /objects`, `GET /object?name=X`, `GET /mesh/<name>`, `GET /project`.
  Any non-GET → `405`; unknown GET → `404`; stale upstream → `{ ok:false, state:"unavailable",
error:"legacy server not running" }` (never a crash or silent fallback). Also usable as a CLI:
  `node scripts/loopback-bridge.mjs [--input <file.stl>]`.
- `scripts/check-architecture.mjs` **rule 5 (frozen UI)**: `ui/cad.html` is pinned by SHA-256 and
  an API-action allowlist — any content change or new `/api/<action>` / `api("action")` reference
  fails the gate (read-only during migration; retired at cutover R5+).
- `tests/integration/loopback-bridge.test.mjs` — proves:
  1. bridge round-trips a fixture 3MF (`tests/fixtures/slab-20mm.3mf`, generated by
     `tools/3mf/make-slab-3mf.mjs`, converted to STL by `scripts/import-3mf-mesh.mjs`) with
     object/mesh JSON identical to the direct preserved-server read and to the parsed source STL
     (no data loss);
  2. killing the child marks every route `unavailable` with no crash;
  3. write paths rejected (`405`), unknown routes `404`, token gate enforced (`401`).

- Verified full health gate green (192 unit + 5 integration + 25 rust + smoke 106 + e2e PASS +
  licenses + architecture + sanitizer 0) before commit `a61782e`.

### S6-006 — Auth service scaffold (separable, loopback) — editor runs without it

| Field                | Value                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S6-006                                                                                                   |
| **Title**            | Auth service skeleton: loopback module/process, separate auth.db, zero editor-core dependency            |
| **Priority**         | P1                                                                                                       |
| **Type**             | Feature (skeleton)                                                                                       |
| **Estimated Effort** | M                                                                                                        |
| **Source Finding**   | Invest. Rev 2.0 §6.1/§6.4 (separable service; local `auth.db` XOR Postgres; auth tenant ≠ printer creds) |
| **Status**           | ⏳ Planned                                                                                               |

#### Context

Auth must be a separately-deployable service with its own store — NOT a file the editor reads
(§6.1, `[BUG] Auth file-only`). In R0 only the skeleton lands: the auth API contract
(who/scope/sync), a local loopback service with its own `auth.db`, and proof the editor core
runs with auth off. OAuth PKCE and memory scoping are full work in Sprint 10 (R4); here we
establish the seams.

#### Acceptance Criteria

- [ ] Auth API v1 contract documented (versioned endpoints: who/scope/sync tokens); storage is swappable behind it.
- [ ] Local mode: loopback-only auth process/module with its own `auth.db` (users, device sessions, scopes, audit_log, sync_state); never the editor DB.
- [ ] Editor core boots and operates with the auth process **killed** (integration test); auth off → `synced` reads unavailable, no fallback to another user (empty result + UI marker when UI exists).
- [ ] Auth tenant ≠ printer credential: printer/cloud tokens keep flowing through the preserved `scripts/auth-login.mjs` DPAPI path; the auth service cannot see them.
- [ ] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-6): R0 foundation — shell, capability contract, project schema, bridge"

- S6-001: Tauri 2 + React 19 scaffold (apps/editor)
- S6-002: Rust broker skeleton + workspace.db (no auth dep)
- S6-003: machine capability contract v1 + 3 ingestion paths
- S6-004: versioned project schema + content-addressed artifacts
- S6-005: read-only loopback bridge to preserved Node MCP server
- S6-006: auth service skeleton (separable, editor runs without it)
```
