# Sprint 9.17 — Four-Page Workspace, History & Typed Device Transports

## Sprint Metadata

| Field                 | Value                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Home, Prepare, Preview and Workbench with truthful local history and device state                                                                             |
| **Sprint Goal**       | Deliver coherent page responsibilities, local-first history and typed, capability-gated device transports without confusing profiles with connected hardware. |
| **Duration Estimate** | ~4 weeks                                                                                                                                                      |
| **Priority**          | P1                                                                                                                                                            |
| **Sprint Type**       | Feature + Integration                                                                                                                                         |
| **Primary Owner**     | apps/editor workspace and device providers                                                                                                                    |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-11/AUD-13; sections 7, 14, 19                              |
| **Depends On**        | Sprint 9.16                                                                                                                                                   |
| **Status**            | ⏳ Planned                                                                                                                                                    |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Make Home the local workspace/history entry, Prepare the persistent authoring surface, Preview an honest artifact consumer, and Workbench the sole owner of live device operations. Device providers must distinguish declared profiles, stale snapshots, transport acceptance and observed effects. Hardware smoke tests require separate explicit permission and are not part of this sprint's automatic gate.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Use controlled transport stubs for command-path integration. Do not issue real heat, motion, feed, drying, upload or print commands.

## Tickets

### S9.17-001 — Local Home, recovery and separated histories

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.17-001                                                              |
| **Title**            | Build Home around local projects, recovery and truthful recent history |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | NAV-01; HIS-01–HIS-04; AUD-15                                          |
| **Status**           | ⏳ Planned                                                             |

#### Context

Projects, slice jobs and physical print history have distinct owners, identifiers and artifact availability. Home must remain useful without cloud login and must not invent missing history or reprint readiness.

#### Acceptance Criteria

- [ ] **NAV-01:** Home opens/creates/recovers local projects without cloud authentication.
- [ ] **HIS-01:** Project, slice-job and print-history records remain distinct with explicit origin.
- [ ] **HIS-02:** Missing artifacts are shown as missing, not reconstructed or implied available.
- [ ] **HIS-03:** Reprint creates a new proposal and validates current destination/artifact contract.
- [ ] **HIS-04:** Local history remains usable when cloud is unavailable.
- [ ] Run focused persistence/navigation tests, full gate and sanitizer dry-run successfully.

### S9.17-002 — Persistent Prepare and empty Preview navigation

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.17-002                                                                       |
| **Title**            | Preserve project authority across pages and provide a valid empty Preview state |
| **Priority**         | P1                                                                              |
| **Type**             | Feature                                                                         |
| **Estimated Effort** | M                                                                               |
| **Source Finding**   | NAV-02–NAV-03; audit section 7                                                  |
| **Status**           | ⏳ Planned                                                                      |

#### Context

Page changes must not reconstruct the scene or silently cancel a job. Preview is a real destination even before an artifact exists and must direct the user to a valid slice action.

#### Acceptance Criteria

- [ ] **NAV-02:** Prepare navigation preserves scene, selection and authoritative revision.
- [ ] **NAV-03:** Preview opens without an artifact and displays an honest empty state with an actionable Slice path.
- [ ] Navigation during active jobs preserves or explicitly resolves job continuity; no silent cancellation.
- [ ] Run focused navigation/E2E checks, full gate and sanitizer dry-run successfully.

### S9.17-003 — Workbench typed device transports and state reconciliation

| Field                | Value                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| **Ticket ID**        | S9.17-003                                                                     |
| **Title**            | Route device operations through typed providers and reconcile command effects |
| **Priority**         | P0                                                                            |
| **Type**             | Feature + Safety                                                              |
| **Estimated Effort** | XL                                                                            |
| **Source Finding**   | AUD-11; DEV-01–DEV-07, DEV-10–DEV-11                                          |
| **Status**           | ⏳ Planned                                                                    |

#### Context

Cloud discovery/read does not prove write transport support. Every writer must declare provider capability and revalidate target/freshness at execution, separating accepted from observed and preventing blind retries after ambiguity.

#### Acceptance Criteria

- [ ] **DEV-01–DEV-03:** Device identity is distinct from declared profile; typed commands revalidate capability, limits, target and current state.
- [ ] **DEV-04–DEV-07:** Device changes invalidate approvals; accepted/observed/refused/timeout/indeterminate differ; no blind retry; slot/box mapping is correct.
- [ ] **DEV-10:** Upload, queue/start/stop have separate typed effects and authorization.
- [ ] **DEV-11:** Automated tests use controlled transports; physical tests are opt-in only after explicit permission and redacted evidence plan.
- [ ] Unsupported writes return unavailable; they never fall back to the demo provider silently.
- [ ] Run focused transport/policy tests, full gate and sanitizer dry-run successfully; no real hardware commands.

### S9.17-004 — Workbench Live and shared page conversation context

| Field                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| **Ticket ID**        | S9.17-004                                                         |
| **Title**            | Host Live in Workbench and preserve correctly scoped chat context |
| **Priority**         | P1                                                                |
| **Type**             | Feature                                                           |
| **Estimated Effort** | L                                                                 |
| **Source Finding**   | NAV-04–NAV-05; DEV-08–DEV-09                                      |
| **Status**           | ⏳ Planned                                                        |

#### Context

Live camera, telemetry and artifact-backed 3D job paths are different evidence types. Workbench owns Live; chat remains available across all pages without carrying another project's context or implying an exact path for an unknown job.

#### Acceptance Criteria

- [ ] **NAV-04:** Live exists in Workbench and differentiates camera, telemetry and artifact-linked 3D representation.
- [ ] **NAV-05:** Active conversation persists across all four pages with correct project context.
- [ ] **DEV-08:** Camera is on-demand and reports permission/source state.
- [ ] **DEV-09:** Unknown job has no invented 3D representation; known artifact freshness is explicit.
- [ ] Run focused page/context/provider tests, full gate and sanitizer dry-run successfully; no hardware action.

## Sprint Commit

Each ticket commit uses `feat(s9.17-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and controlled-transport tests pass; no push.
