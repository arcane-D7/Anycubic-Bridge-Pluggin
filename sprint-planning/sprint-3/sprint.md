# Sprint 3 — AI Text-to-CAD

## Sprint Metadata

| Field                 | Value                                              |
| --------------------- | -------------------------------------------------- |
| **Sprint Name**       | AI Text-to-CAD                                     |
| **Sprint Goal**       | Add an MCP tool that turns a natural-language prompt into a parametric script (text-to-cad skill, MIT), executes it on the Sprint 2 engine, and materializes the mesh in the workspace. |
| **Duration Estimate** | ~2–3 days                                          |
| **Priority**          | P1                                                 |
| **Sprint Type**       | Feature + Test                                     |
| **Primary Owner**     | cad-engine                                          |
| **Source**            | [CAD research](../docs/cad-engine-research.md) finalist #5 (text-to-cad, MIT) |
| **Depends On**        | Sprint 2                                           |
| **Status**            | ✅ Complete · commit `df28066`                     |
| **Health Gate**       | `pnpm run test` 155/155 · smoke 82 tools            |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

Sprint 2 gave a parametric engine and `cad_generate_parametric`. This sprint
adds the AI layer: `cad_generate_from_prompt` accepts a natural-language
description plus optional parameters, calls a configurable LLM provider (via an
MIT-compatible SDK or plain fetch with env-provided keys — never hardcoded
secrets) to produce a parametric script conforming to the engine's declarative
API, validates the script (dry-run parse), executes it, and materializes the
mesh — optionally exporting STL/STEP. A structured-prompt template enforces the
script contract (prompt-engineering, MIT-compatible prompting practice). Out of
scope: fine-tuning models, multi-turn design conversation.

## Health Check Commands (must pass before commit)

```bash
pnpm install
pnpm run test
node scripts/smoke.mjs
```

## Tickets

### S3-001 — Prompt→script translation module

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S3-001                    |
| **Title**            | `scripts/cad-ai-translator.mjs` — prompt→parametric script |
| **Priority**         | P0                        |
| **Type**             | Feature                   |
| **Estimated Effort** | L                         |
| **Source Finding**   | text-to-cad agent-skill pattern (MIT) + prompt-engineering practice |
| **Status**           | ⏳ Planned                |

#### Context

The AI layer must be decoupled (SOLID): a translator takes a prompt + parameters
and returns a validated script string. It builds a system prompt that pins the
script to the engine's declarative API (documented in S2-001), calls the
configured provider (OpenAI-compatible `/chat/completions` via `fetch`, or an
MIT SDK when present), extracts the script, and runs a dry syntax check. Secrets
come only from env vars (`CAD_AI_API_KEY`, `CAD_AI_BASE_URL`, `CAD_AI_MODEL`),
never from tool input.

#### Acceptance Criteria

- [ ] `translatePromptToScript(prompt, params?) → { script, model, usage? }`.
- [ ] Provider config from env only; unset → clean `{ ok:false, error:"AI provider not configured" }`.
- [ ] System prompt embeds the engine API contract (see S2-001 exports).
- [ ] Dry-run parse validation rejects non-conforming scripts with a readable error.
- [ ] `dryRun:true` input returns the script WITHOUT calling the provider (deterministic + testable).
- [ ] Pure module — no bundle dependency; unit-testable.
- [ ] Run the health check command successfully.

### S3-002 — Validation & sandbox reuse

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S3-002                    |
| **Title**            | Reuse S2 sandbox + new script-validator |
| **Priority**         | P1                        |
| **Type**             | Refactor                   |
| **Estimated Effort** | S                         |
| **Source Finding**   | Sandbox implemented in S2-003 |
| **Status**           | ⏳ Planned                |

#### Context

DRY: the sandbox in `cad_generate_parametric` (S2-003) must be extracted into a
shared validator used by both the parametric tool and the AI translator. This
avoids duplicating the forbidden-globals/API-allowlist logic and gives one place
to strengthen it.

#### Acceptance Criteria

- [ ] Shared `validateParametricScript(script)` extracted (no duplication).
- [ ] Both S2 tool and S3 translator call the same validator.
- [ ] Forbidden: `process`, `require`, `import`, `fetch`, `eval`, `Function`, network/fs globals.
- [ ] Allowed: engine declarative API names only (plus plain JS literals/loops/ifs).
- [ ] Existing S2 sandbox tests still pass unchanged.
- [ ] Run the health check command successfully.

### S3-003 — Tool `cad_generate_from_prompt`

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S3-003                    |
| **Title**            | MCP tool for AI CAD generation |
| **Priority**         | P0                        |
| **Type**             | Feature                   |
| **Estimated Effort** | M                         |
| **Source Finding**   | AI capability request (text-to-cad) |
| **Status**           | ⏳ Planned                |

#### Context

Agent-facing tool: `{ prompt, params?, object_name?, export_format?, dry_run? }`.
Calls S3-001, validates via S3-002, executes on the engine, materializes the
mesh, exports optionally. `dry_run:true` returns the script only (no execution,
no provider), so agents can preview. Timeouts and retry on the provider call.

#### Acceptance Criteria

- [ ] Tool registered and listed by the bundle (smoke includes it).
- [ ] `dry_run:true` returns `{ ok, script, model }` without provider/execution.
- [ ] Full run: provider → script → validate → execute → materialize → optional export.
- [ ] Provider/timeout errors → clean `isError` structured result, no crash.
- [ ] Secrets never appear in output (redaction pattern).
- [ ] Run the health check command successfully.

### S3-004 — AI tests (unit/integration/e2e)

| Field                | Value                     |
| -------------------- | ------------------------- |
| **Ticket ID**        | S3-004                    |
| **Title**            | Tests for translator, sandbox, tool, UI |
| **Priority**         | P1                        |
| **Type**             | Test                      |
| **Estimated Effort** | M                         |
| **Source Finding**   | test convention + skill |
| **Status**           | ⏳ Planned                |

#### Context

Unit-test the translator with a mocked provider (fetch interception) and with
`dryRun`; test the validator aggressively; integration-test the tool registration
and a dry-run through the bundle; e2e asserts the cad.html AI panel calls
dry-run and surfaces the script without a real API key.

#### Acceptance Criteria

- [ ] Translator unit tests: mock fetch returns good/bad/missing-script responses.
- [ ] Dry-run test: returns script deterministically, no fetch.
- [ ] Validator tests: rejects each forbidden global; accepts allowed API.
- [ ] Integration: tool listed + dry-run answers `{ ok:true, script }`.
- [ ] E2E: browser AI panel dry-run flow renders script; shows "not configured" hint when env unset.
- [ ] `pnpm run test` + smoke pass.
- [ ] Run the health check command successfully.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-3): AI text-to-cad via cad_generate_from_prompt"

- S3-001: `scripts/cad-ai-translator.mjs` (prompt→script, provider-agnostic)
- S3-002: shared script validator (DRY reuse from S2 sandbox)
- S3-003: MCP tool `cad_generate_from_prompt`
- S3-004: AI unit/integration/e2e tests
```
