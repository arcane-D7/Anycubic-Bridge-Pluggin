# Sprint 5 — Architecture Design + Code Quality Foundations

## Sprint Metadata

| Field                 | Value                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Architecture design, code-quality levels, inspection tooling, SOLID/DRY doctrine, repo boundaries                       |
| **Sprint Goal**       | Lock the target architecture for the new React/Tauri editor, codify code-quality levels and repo boundaries, and install the quality/typing/license inspection gates that every later sprint must pass. |
| **Duration Estimate** | ~2 weeks                                                                                                                |
| **Priority**          | P0                                                                                                                      |
| **Sprint Type**       | Architecture / Docs / Tooling                                                                                           |
| **Primary Owner**     | platform-core                                                                                                           |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md), Rev 2.0 §2, §4, §5, §6, §7, §8, §9, §10 + user license policy (Apache/MIT direct-use only) |
| **Depends On**        | Sprint 4 (legacy CAD sprints 1–4 history)                                                                               |
| **Status**            | ⏳ Planned                                                                                                              |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

The Rev 2.0 investigation defines the *what*: an own non-planar engine, Blender as required
geometry authority (external process, never bundled), machine capability contract, harness
sandbox, separable auth. This sprint turns that into the *how*: a committed architecture
design document (`docs/architecture.md`) with module boundaries, process model, IPC contracts
and the preserved-root boundary; **code-quality levels** (strict TypeScript, ESLint flat
config, Prettier, Knip, license check) wired into a single health gate so every future sprint
runs the same quality bar; **SOLID/DRY doctrine** as repo rule; and **repository boundaries**
that keep the preserved MCP/scripts contracts agnostic while the new Tauri/React workspace is
added. No runtime feature code lands here — this sprint installs the rails every other
sprint runs on.

## Health Check Commands (must pass before commit)

```bash
node scripts/build.mjs && node --test "tests/*.test.mjs" && node scripts/smoke.mjs
pnpm run typecheck            # strict tsc --noEmit on new workspace + existing JS via JSDoc where applicable
pnpm run lint                # eslint flat config
pnpm run format-check        # prettier --check
pnpm run knip                # list unused deps/exports (warn gate)
pnpm run check:licenses      # fail on non-Apache/MIT direct-use deps
git diff --check
node scripts/sanitize-repo.mjs --dry-run   # must remain 0 files / 0 groups
```

> Notes: `typecheck`, `lint`, `format-check`, `knip`, `check:licenses` are **new scripts** to
> be added in this sprint (ticket S5-003). They must be green before commit. The pre-existing
> gate (`build && test && smoke`) must stay green — nothing in this sprint may break the
> preserved MCP contract.

## Tickets

### S5-001 — Architecture design document (target architecture)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S5-001                                                                 |
| **Title**            | `docs/architecture.md` — committed architecture for the new editor     |
| **Priority**         | P0                                                                     |
| **Type**             | Architecture/Docs                                                      |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §1, §4, §5, §6, §7, §8, §9, §10; user "primeiro passo ... desenho de arquitetura" |
| **Status**           | ⏳ Planned                                                             |

#### Context

The investigation is research; this ticket makes it a design that can be implemented and
reviewed. It must commit module boundaries, the process model (Blender external process vs
Rust broker vs React UI vs separable auth service), the framed-stdio/IPC command contract
(§4.6), the machine capability contract schema (§5.1), and the retired/legacy boundary — with
every external dependency justified against the §🔒 license policy (Apache/MIT direct-use;
GPL/AGPL/BSD-3 = study/reference only; Blender = user-installed prerequisite, never bundled).

#### Acceptance Criteria

- [ ] `docs/architecture.md` exists and cites the investigation sections for each decision.
- [ ] Contains: process model (React/Tauri UI → Rust broker → Blender bpy T2 worker → optional OCCT tier; separable auth service), one-BLEND-per-process rule, framed stdio/IPC contract with binary artifact channel and stale-revision handling (§4.6).
- [ ] Contains: module/package boundaries (preserved repo root vs `apps/editor` vs `crates/` or `packages/`), dependency directions (no UI→DB, no tool→secret), and the machine capability contract as the single source of truth.
- [ ] Every dependency/artifact row is annotated with its license and its direct-use vs reference-only classification per §🔒 LICENSE POLICY; Blender is explicitly user-installed/discovered, never bundled.
- [ ] Contains: retirement boundary — `ui/cad.html` + legacy in-memory scene frozen/read-only; preserved MCP contract (`tools.json` names/schemas) untouchable.
- [ ] Draws a C4-level context/container diagram (Mermaid) for system + containers.
- [ ] Run the health check command successfully.

### S5-002 — Repository boundaries & workspace layout

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S5-002                                                                 |
| **Title**            | Enforce repository/workspace boundaries (preserved root vs new app)    |
| **Priority**         | P0                                                                     |
| **Type**             | Architecture/Tooling                                                   |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §2 scope boundary; AGENTS.md repo agnostic rules; user "boundrys do repositório" |
| **Status**           | ⏳ Planned                                                             |

#### Context

The repo currently is a single-root Node/MCP project. The new product adds a pnpm workspace
member (Tauri 2 + React/TS). Without explicit boundaries, the new app could leak into the
preserved scripts (`scripts/*`, `vendor/server.mjs`, `schemas/*`), break the MCP contract, or
introduce machine-specific values. Boundaries must be stated in `docs/architecture.md` AND
enforced by tooling (ignore rules, package scopes, a boundary test that fails if the
preserved contract files change shape).

#### Acceptance Criteria

- [ ] `pnpm-workspace.yaml` extended: root stays the MCP/scripts contract; new `apps/editor` (Tauri+React) and `crates/`/`packages/*` (Rust core) are separate workspace members with isolated deps.
- [ ] `.gitignore` / sanitizer SKIP rules updated so build artifacts (`target/`, `dist*`, `node_modules`, `*.blend`, scratch) never enter git; no real path/IP/ID can be committed (sanitizer dry-run stays 0).
- [ ] A guarded-areas contract documented: `scripts/*`, `vendor/server.mjs`, `schemas/tools.json`, `schemas/openapi.json`, `presets/catalog.json` and `tests/*` = **preserved**; the new editor must consume them **as-is** (MCP stdio / read-only), not fork them.
- [ ] Boundary integration test added: asserts `schemas/tools.json` tool names/schemas remain superset-compatible with `smoke.mjs` expected list (fails on breaking rename).
- [ ] Run the health check command successfully.

### S5-003 — Code-quality levels & inspection tooling

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S5-003                                                                 |
| **Title**            | Install code-quality gates: typecheck, lint, format, knip, licenses    |
| **Priority**         | P0                                                                     |
| **Type**             | Tooling                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | User: "ajustar níveis de code-quality, tools de inspeção de qualidade de codigo" |
| **Status**           | ⏳ Planned                                                             |

#### Context

No type-check, linter, formatter or license gate exists project-wide (`tsconfig.json` does not
exist; script "dev" references a nonexistent `src/index.ts`). Every subsequent sprint must
run against a strict quality baseline. This ticket adds: strict `tsc --noEmit` (new TS
workspace; `checkJs` for preserved `.mjs` where practical), ESLint flat config, Prettier,
Knip (dead-code) and a license validator, exposed as pnpm scripts and documented in
`docs/architecture.md` § code-quality levels.

#### Acceptance Criteria

- [ ] `tsconfig.json` (strict) for the new TS/React workspace; `pnpm run typecheck` is green (new code) and does not claim a pass on the legacy root build (`pnpm run build` remains the esbuild artifact gate).
- [ ] `eslint.config.mjs` flat config (typescript-eslint + react recommended) with `pnpm run lint` green.
- [ ] `.prettierrc` + `pnpm run format-check` green.
- [ ] Knip configured (`pnpm run knip`) — runs with no errors; remaining warnings documented.
- [ ] `scripts/check-licenses.mjs`: walks the dependency graph for the new workspace and **fails** on any direct-use package whose license is not Apache-2.0 or MIT; allowlist for explicitly-approved exceptions (e.g. dev-only tooling) with comment justification. `pnpm run check:licenses` green against current dep set.
- [ ] Health gate doc section updated (`docs/architecture.md` § code-quality levels) listing the exact command order every sprint runs.
- [ ] Run the health check command successfully.

### S5-004 — SOLID & DRY doctrine for the repo

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S5-004                                                                 |
| **Title**            | SOLID/DRY rules as repository doctrine                                 |
| **Priority**         | P1                                                                     |
| **Type**             | Docs/Rules                                                             |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | User: "regras SOLID e DRY"; existing repo practice (pure engine modules + thin MCP adapters) |
| **Status**           | ⏳ Planned                                                             |

#### Context

The repo already follows good patterns informally (pure engine modules, thin tool adapters,
shared mesh/export helpers). This ticket makes the rules explicit and enforceable for the new
codebase: single-responsibility boundaries (engine vs adapter vs broker), open/closed
extension points (capability registry, tool registry), interface segregation (T0/T1/T2/T3a/T3b
surfaces), dependency inversion (broker owns secrets; tools depend on capability names), and
DRY with a **measured** limit — no copy-paste of geometry math or MCP registration glue, with
the DRY test as a lint-level check.

#### Acceptance Criteria

- [ ] `docs/architecture.md` § engineering rules (or `docs/solid-dry-rules.md`) states: SRP per module; OCP via extension registries; ISP per harness tier; DIP broker→capability-named tool calls; DRY with duplication-measured exceptions (explicit `// DESIGN: duplicated on purpose` markers are banned by default).
- [ ] Concrete examples mapped to real files: engine modules (pure), MCP tool adapters (thin), broker (orchestration + approvals), planner kernels (own), etc.
- [ ] A DRY/architecture rule check is added to lint or a tiny `node scripts/check-architecture.mjs` (e.g. fails if a `register*Tools` file grows a duplicate schema block instead of importing a shared zod schema from `schemas/`).
- [ ] Run the health check command successfully.

### S5-005 — License policy enforcement + reference registry

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S5-005                                                                 |
| **Title**            | License policy registry (`docs/licenses.md`) + enforced allowlist      |
| **Priority**         | P0                                                                     |
| **Type**             | Tooling/Docs                                                           |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | User approved: "usaremos diretamente apenas licenças Apache e MIT ... nunca uma implementação ... dentro do nosso" |
| **Status**           | ⏳ Planned                                                             |

#### Context

The policy (Apache/MIT direct; everything else reference-only) must be machine-enforced and
registered. All the landscape projects (CurviSlicer AGPL, FullControl GPL, S3-Slicer BSD-3,
Kiri:Moto client MIT/engine unconfirmed, COMPAS MIT, Open5x MIT, Blender GPL, Goose `[?]`)
need one row each in a registry stating license + how they may be used (study/reference/
direct). The check gate from S5-003 uses this registry.

#### Acceptance Criteria

- [ ] `docs/licenses.md` published with a table: project, license, allowed use classification (direct Apache/MIT | reference-only | external prerequisite), and rationale/citation.
- [ ] Entries cover: manifold-3d (Apache-2.0 → direct), three-bvh-csg (MIT → direct), three (MIT → direct), replicad/OCCT (Apache-2.0 family → direct, conversion-only tier), Wasmtime (Apache-2.0 → direct), Kiri:Moto (client MIT / engine unconfirmed → reference-only), CurviSlicer (AGPL-3.0 → study-only), Zip-o-mat, RotBot, NeuralSlicer, FullControl, S4_Slicer (GPL/AGPL → study-only), S3-Slicer (BSD-3 → study-only[^1]), COMPAS (MIT → reference), Open5x (MIT → reference), Blender (GPL → external user-installed prerequisite, never bundled), Goose (license re-check `[?]` → reference/verify).
- [ ] `scripts/check-licenses.mjs` (S5-003) consumes this registry — any package marked `direct` in `package.json` deps must resolve to an Apache/MIT SPDX id, else the gate fails with the registry row cited.
- [ ] Run the health check command successfully.

[^1]: BSD-3 is a permissive license but not Apache/MIT; per user policy it is reference-only — BSD-3 *code* is not copied.

### S5-006 — Health gate unification & CI wiring

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S5-006                                                                 |
| **Title**            | Unified health gate + CI workflow for the new workspace                |
| **Priority**         | P1                                                                     |
| **Type**             | Tooling/CI                                                             |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | User: "inclua todos os pontos de health check necessários, incluindo testes unitários, testes de tipagem, testes e2e e testes de integração" |
| **Status**           | ⏳ Planned                                                             |

#### Context

Every future sprint must run: unit tests, typing tests, integration tests, e2e tests and the
license/sanitizer gates. Today only `build + test + smoke` exists, with a docs-only e2e
(`tests/e2e/cad-ui.e2e.mjs`). This ticket standardizes the suite labels and wires them into
the repo script set and a GitHub Actions workflow so the gate is runnable locally and in CI.

#### Acceptance Criteria

- [ ] pnpm scripts defined and documented: `test:unit` (node --test), `test:type` (tsc --noEmit), `test:integration` (cross-module integration suite for the new workspace), `test:e2e` (browser e2e via the existing puppeteer/cad-ui harness pattern), `check` = ordered: format → lint → typecheck → unit → integration → build → smoke → e2e → licenses → sanitize.
- [ ] `.github/workflows/health.yml` (or reused pattern): runs `check` on push/PR; legible per-step failure (no `|| true`); annotates environment variables with `ANYCUBIC_*` defaults that are agnostic.
- [ ] Integration test harness: a `tests/integration/` dir (or equivalent) with at least one test that wires broker↔engine↔MCP tool registration without a live printer (all network fakes/stubs).
- [ ] E2E smoke: `tests/e2e/cad-ui.e2e.mjs` (or replacement) passes headless with the **legacy** UI read-only (no new editor UI yet in this sprint — added in Sprint 6).
- [ ] Unit tests keep going green: `node --test "tests/*.test.mjs"` (≥191 current) — no regressions.
- [ ] Run the health check command successfully.

## Sprint Commit

```bash
git add -A
git commit -m "docs(sprint-5): architecture + code-quality foundations"

- S5-001: docs/architecture.md — target architecture (investigation Rev 2.0)
- S5-002: repository/workspace boundaries, preserved-root contract
- S5-003: code-quality gates (typecheck/lint/format/knip/licenses)
- S5-004: SOLID/DRY doctrine
- S5-005: license policy registry + enforced allowlist
- S5-006: unified health gate + CI wiring (unit/type/integration/e2e)
```
