# Sprint 9.18 — Operational AI Tool Loop, Authenticated Approval & Parity

## Sprint Metadata

| Field                 | Value                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Shared operation registry, real chat tool loop and backend approval authority                                                                       |
| **Sprint Goal**       | Let chat discover and execute the same authorized domain actions as UI while preserving backend-enforced consent, structured results and isolation. |
| **Duration Estimate** | ~4 weeks                                                                                                                                            |
| **Priority**          | P0                                                                                                                                                  |
| **Sprint Type**       | Feature + Security                                                                                                                                  |
| **Primary Owner**     | Broker chat, operation registry and editor transcript                                                                                               |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-09/AUD-10/AUD-12; sections 6, 15, 19             |
| **Depends On**        | Sprint 9.17                                                                                                                                         |
| **Status**            | ⏳ Planned                                                                                                                                          |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Replace echo/mock success paths with configured-provider status, contextual operation discovery and a bounded typed tool loop. UI and AI dispatch through the same domain handlers and policy; a trusted backend issues one-use approvals bound to the exact target, arguments, revision and artifact. Physical writers remain unavailable unless both provider capability and authenticated approval exist; test the boundary with stubs only.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Run focused broker/policy/transcript tests before the full gate. Never expose provider secrets to the webview or execute raw model-generated code.

## Tickets

### S9.18-001 — Safe provider bootstrap and operation discovery

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.18-001                                                                        |
| **Title**            | Bootstrap configured chat lane and discover capability-filtered typed operations |
| **Priority**         | P0                                                                               |
| **Type**             | Feature + Security                                                               |
| **Estimated Effort** | L                                                                                |
| **Source Finding**   | AUD-09/AUD-10; AI-01, AI-03–AI-04                                                |
| **Status**           | ⏳ Planned                                                                       |

#### Context

The configured broker endpoint must be reachable through a public-safe bootstrap without shipping credentials to the webview. The model needs discovery/description and availability reasons, while backend execution still revalidates current policy and capabilities.

#### Acceptance Criteria

- [ ] **AI-01:** Real provider bootstrap works with no secret in frontend bundles, runtime config or logs; missing/invalid endpoint reports unavailable, not fake model output.
- [ ] **AI-03:** Every public action has a versioned schema, discovery entry, policy and handler mapping or an explicit documented exclusion.
- [ ] **AI-04:** Backend rejects invalid, unavailable and revoked operations even if the client previously discovered them.
- [ ] Provider failure, unknown operation, invalid arguments and cancellation produce structured results.
- [ ] Run focused broker/config/registry tests, full gate and sanitizer dry-run successfully.

### S9.18-002 — Shared handler tool loop and durable structured transcript

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.18-002                                                              |
| **Title**            | Execute UI-parity tools and persist structured progress/results safely |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | XL                                                                     |
| **Source Finding**   | AUD-09; AI-02, AI-07–AI-10                                             |
| **Status**           | ⏳ Planned                                                             |

#### Context

Echo responses and text-only rendering cannot prove tool execution. Connect typed tool calls to the same domain handler as the UI and render/persist invocation IDs, progress, approval states, outputs and failures without replaying mutations on reconnect.

#### Acceptance Criteria

- [ ] **AI-02:** A reversible navigation/selection tool invokes the same handler as UI and has the same observable result.
- [ ] **AI-07:** Transcript persists tool IDs, progress, result, denial and error as structured parts.
- [ ] **AI-08:** UI-originated mutations refresh agent context and tool-originated mutations update UI snapshots/journal.
- [ ] **AI-09:** Switching conversation/project cannot expose prior context or approval references.
- [ ] **AI-10:** Retry, reconnect and cancellation do not duplicate mutating or physical effects; reconciliation is explicit.
- [ ] Tool step/time/budget limits and typed errors prevent unbounded execution; raw shell/Blender is not exposed.
- [ ] Run focused tool-loop/isolation/idempotency tests, full gate and sanitizer dry-run successfully.

### S9.18-003 — Backend-authenticated payload-bound approval

| Field                | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Ticket ID**        | S9.18-003                                                               |
| **Title**            | Require opaque, expiring, one-use backend approval for protected writes |
| **Priority**         | P0                                                                      |
| **Type**             | Security                                                                |
| **Estimated Effort** | L                                                                       |
| **Source Finding**   | AUD-12; AI-05–AI-06                                                     |
| **Status**           | ⏳ Planned                                                              |

#### Context

Textual `confirm` arguments do not prove human consent. Approval must come from an authenticated backend principal and bind the exact action/target/args digest plus relevant project revision or artifact, expiring and consuming before dispatch.

#### Acceptance Criteria

- [ ] **AI-05:** Protected write with `confirm` but no authenticated backend approval is rejected before transport invocation.
- [ ] **AI-06:** Approval binds payload, target, revision/artifact and principal; expiry, replay, revocation and one-use consumption are enforced.
- [ ] Changing device, material, artifact or relevant revision invalidates pending approval.
- [ ] Approval UI explains concrete effect; logs redact bearer material and secrets.
- [ ] Integration tests prove zero transport calls on all rejection paths; no physical hardware command is run.
- [ ] Run focused security tests, full gate and sanitizer dry-run successfully.

## Sprint Commit

Each ticket commit uses `feat(s9.18-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and policy tests pass; no push.
