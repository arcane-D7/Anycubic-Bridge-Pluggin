# Sprint 10 — R4: Auth as a Separable Service + Memory

## Sprint Metadata

| Field                 | Value                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | R4 — separable auth service (local auth.db XOR service+Postgres), OAuth PKCE, global memory with fail-closed scoping       |
| **Sprint Goal**       | Complete the auth service as a sepably-deployable process/store (editor core has zero auth dependency), implement OAuth external-browser + PKCE with broker-held tokens, and land the global memory system with provenance, scope, retention and fail-closed synced reads when auth is off. |
| **Duration Estimate** | ~4 weeks                                                                                                                |
| **Priority**          | P1                                                                                                                      |
| **Sprint Type**       | Feature/Security                                                                                                        |
| **Primary Owner**     | auth-core                                                                                                               |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §6 (auth + memory), §10 R4; RFC 8252 |
| **Depends On**        | Sprint 9 (R3 harness; auth seams from Sprint 6)                                                                         |
| **Status**            | ⏳ Planned                                                                                                              |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

Auth is a separable **service**, storage swappable behind the versioned auth API: local mode
(own `auth.db`, loopback service) XOR independent mode (own process/container + Postgres). The
editor core must run fully with auth off — geometry, modeling, slicing and local saving never
require it. OAuth uses external-browser + PKCE (RFC 8252) with loopback redirect; the desktop
never stores database credentials; auth tenant (who) is distinct from printer credentials (the
preserved DPAPI cloud-token path stays untouched). Memory entries carry provenance + scope
(local-project/synced); synced reads fail closed (empty) when auth is off — never another
user's memory, never a silent local fallback.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
pnpm run auth         # auth e2e: local mode + independent mode harness (kill auth → editor operates, synced read empty), PKCE loopback flow against a stub identity provider
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S10-001 — Auth service MVP (local mode: own auth.db + loopback service)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S10-001                                                                |
| **Title**            | Auth service MVP — local mode implementation behind the versioned auth API |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §6.1 (separable service, local auth.db), §6.4 (store sketch), Sprint 6 S6-006 seams |
| **Status**           | ⏳ Planned                                                             |

#### Context

The R0 skeleton (S6-006) defined the seams; now the actual service lands. Local mode: the auth
service runs as its own loopback-only HTTP process (or in-dev in-process module behind the
same API) with its own `auth.db` (users, local device sessions, scopes/roles, audit_log,
sync_state). The editor talks only to the auth API — never a shared DB file. Local-first: fully
usable with zero auth users (anonymous local profile, `local-project` scope only).

#### Acceptance Criteria

- [ ] Auth API v1 implemented (who/scope/sync token endpoints) with loopback-only binding; versioned route namespace.
- [ ] `auth.db` schema per §6.4; BYOK keys nowhere in it (keystore-only — verified by test reading the DB rows).
- [ ] Local mode starts as a process or in-dev module behind the same API; an integration test swaps the storage backend via the API and asserts identical behavior (storage-agnostic contract).
- [ ] Anonymous local profile flows: no auth configured → editor fully functional, `service_scope = local-project`.
- [ ] Audit log: approvals/denials/tool executions recorded with provenance.
- [ ] Health gate green.

### S10-002 — Independent mode + storage swap (Postgres, build-time flag)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S10-002                                                                |
| **Title**            | Independent mode: separate process/container + Postgres backend, build-time flag |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §6.1 (independent mode first-class, not "file only"), §6.4 |
| **Status**           | ⏳ Planned                                                             |

#### Context

Both local and independent deployments are first-class; the choice is a build/deploy flag, not
a code fork. Independent mode = the auth service as its own process/container with Postgres.
The editor sees only the versioned auth API, never the DB.

#### Acceptance Criteria

- [ ] Postgres backend implements the same auth API contract (schema mirrors local: tenants, sessions, audit, sync_state).
- [ ] `--auth-backend local|postgres` build/deploy flag selects the backend; feature tests run both variants against the same API surface.
- [ ] Editor config deepens: independent mode reached over loopback/network per deployment; no DB file sharing.
- [ ] Migration path documented: local `auth.db` → Postgres import/export utilities (data shape parity).
- [ ] Health gate green (Postgres tests behind a docker/embedded flag — CI gate can run local mode; independent mode at least compiles + unit-tested with an in-memory faked PG).

### S10-003 — OAuth external-browser + PKCE (RFC 8252) with broker-held tokens

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S10-003                                                                |
| **Title**            | OAuth authorization-code + PKCE via external browser + loopback redirect |
| **Priority**         | P0                                                                     |
| **Type**             | Feature/Security                                                        |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §6.2 (OAuth [SPEC]); RFC 8252 native apps              |
| **Status**           | ⏳ Planned                                                             |

#### Context

External identity (e.g. Supabase/Google) via external browser + PKCE: the app opens the system
browser, receives the code on a loopback redirect, exchanges via authorization-code + PKCE.
No desktop DB credentials: the desktop never stores a password or a refresh credential it
generated; tokens are broker-owned, keystore-protected; the editor core never sees them (same
rule as BYOK keys §8.5).

#### Acceptance Criteria

- [ ] PKCE flow implemented: verifier/challenge generation, loopback redirect listener (random port), code exchange, token storage in broker keystore (DPAPI/Stronghold).
- [ ] E2E with a stub identity provider: full external-browser flow completes; tokens land in keystore, not in any DB or memory.
- [ ] Security tests: an expired/revoked token fails gracefully (re-auth flow); loopback listener binds to 127.0.0.1 only; no token ever in editor-core memory or logs (redaction test).
- [ ] Auth tenant = who (sync/multi-user) — printer credentials continue through preserved `scripts/auth-login.mjs` DPAPI path; cross-test proves the two flows never touch.
- [ ] Health gate green.

### S10-004 — Global memory system (provenance, scope, retention, embeddings lifecycle)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S10-004                                                                |
| **Title**            | Memory store with service_scope, provenance, retention + derived-artifact cleanup |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §6.3 (memory [SPEC]) — provenance, retrieval filtered by scope, forget=source+derived, memory never grants permissions |
| **Status**           | ⏳ Planned                                                             |

#### Context

Memory is data, not authority (§8.4 injection rule: memory is untrusted input to the model).
Project-scoped by default; global memory stores only user-approved preferences/facts. Every
entry carries provenance (source, service_scope, model, source_class, revision, timestamp,
retention). Retrieval is filtered by scope **before** injection; embeddings/summaries are
derived artifacts deleted when the source is deleted (forget = source + derived).

#### Acceptance Criteria

- [ ] Memory store + entry schema with provenance and `service_scope` (local-project | synced) + retention.
- [ ] Retrieval API filters by scope before injection; a synced query while auth off returns **empty** (never another user's, never silent local fallback) and the UI shows "synced memory unavailable (auth off)" when the UI is up.
- [ ] `forget` deletes source entry AND its derived artifacts (embeddings/summaries) — integration test asserts no orphaned derived rows/files.
- [ ] Memory-are-data guard: a stored memory entry containing an instruction cannot cause execution without broker-approval (prompt-injection fixture test ties to S9-006 posture).
- [ ] Health gate green.

### S10-005 — Multi-project workspaces + per-project context isolation

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S10-005                                                                |
| **Title**            | Workspaces with per-project context isolation (chat/history/memory views) |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §10 R4 (multi-project workspaces); Sprint 9 chat UI    |
| **Status**           | ⏳ Planned                                                             |

#### Context

Multi-project workspaces with per-project context isolation: chat/conversation history,
memory retrieval and journal entries are scoped per project; switching projects cannot leak
context across them.

#### Acceptance Criteria

- [ ] Project switching in the UI: chat history, context sources, memory entries and journal views follow the active project.
- [ ] Isolation test: writing memory/chat in project A → project B sees none of it (and no auth-off fallback path).
- [ ] UI exposes the global memory browser with per-entry provenance + scope tag and delete (per §6.3).
- [ ] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-10): R4 — separable auth service + memory"

- S10-001: auth service MVP (local auth.db, loopback, zero editor-core dep)
- S10-002: independent mode (Postgres) + storage swap flag
- S10-003: OAuth external-browser + PKCE, broker-held tokens
- S10-004: global memory (provenance/scope/retention, forget=source+derived)
- S10-005: multi-project workspaces + context isolation
```
