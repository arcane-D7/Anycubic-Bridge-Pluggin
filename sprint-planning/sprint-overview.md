# Sprint Overview — Anycubic Bridge CAD Engine

**Last updated:** 2026-09-13
**Canonical source:** This file is the authoritative index for sprint status,
ticket coverage, execution order, and roadmap.

## Delivery Status

- **All 4 sprints complete** — S1 `892f39d` (test 132/132, smoke 79), S2 `6739dfc`
  (test 144/144, smoke 80), S3 `df28066` (test 155/155, smoke 82), S4 docs.
- Health gate per sprint: `pnpm install` + `pnpm run test` + `node scripts/smoke.mjs`
  (S4 docs-only: `git diff --stat`).
- All new runtime deps are MIT/Apache-2.0 (three, three-mesh-bvh, three-bvh-csg,
  manifold-3d, replicad, replicad-opencascadejs).

## Sprint Summary Table

| # | Priority | Focus | Tickets | Effort | Status | Plan | Commit |
|--:| :------: | ----- | ------: | ------ | ------ | ---- | ------ |
| 1 | P1 | Robust in-browser CSG (three-bvh-csg) | 4 | M | ✅ Done | [sprint](sprint-1/sprint.md) | `892f39d` |
| 2 | P1 | Parametric engine (Manifold + Replicad) | 5 | L | ✅ Done | [sprint](sprint-2/sprint.md) | `6739dfc` |
| 3 | P1 | AI text-to-cad (prompt → parametric script → mesh) | 4 | L | ✅ Done | [sprint](sprint-3/sprint.md) | `df28066` |
| 4 | P2 | Electron packaging (plan-only) | 3 | M | ✅ Done | [sprint](sprint-4/sprint.md) | docs commit |

## Finding Coverage Matrix

| Requirement / finding | Sprint | Tickets | Coverage |
| --------------------- | ------ | ------- | -------- |
| Robust boolean CSG for CAD UI | 1 | S1-001..S1-003 | Replaces half-space kernel with three-bvh-csg (MIT) on Node + viewer |
| MIT/Apache-only dependencies | 1,2,3 | all | All new deps are MIT (three-bvh-csg, three, three-mesh-bvh, manifold-3d, replicad, replicad-opencascadejs) |
| Parametric code-CAD (Blender-like via code) | 2 | S2-001..S2-005 | Manifold WASM engine + Replicad STEP export |
| AI text-to-cad | 3 | S3-001..S3-004 | `cad_generate_from_prompt` tool driving parametric script → mesh → STL |
| Test coverage (unit/integration/e2e) | 1,2,3 | S1-004, S2-005, S3-004 | `node --test` suites + bundle smoke + browser e2e for cad.html |
| SOLID/DRY architecture | 1,2,3 | all | Pure engine modules; MCP tools as thin adapters; shared mesh/export helpers |
| Future Electron packaging | 4 | S4-001..S4-003 | Plan-only: structure, assets, distribution checklist |

## Legend

✅ Done · 📌 Active · ⏳ Planned · ⏹️ Archived · 🔄 In progress

## Execution Order

1. Sprint 1 → 2 → 3 → 4 (dependencies point to earlier sprints only).
2. Sprint 4 is plan-only (documentation + packaging checklist, no runnable Electron shell).
