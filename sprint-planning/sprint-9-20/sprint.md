# Sprint 9.20 — Cross-Integration, Real-Input QA, Performance & Evidence Closure

## Sprint Metadata

| Field                 | Value                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Cross-domain acceptance, input-real regression, performance and evidence-backed closure                                                      |
| **Sprint Goal**       | Prove integrated user workflows across providers, UI and AI, then close documentation findings only where current evidence supports closure. |
| **Duration Estimate** | ~3 weeks                                                                                                                                     |
| **Priority**          | P1                                                                                                                                           |
| **Sprint Type**       | Test + Performance + Documentation                                                                                                           |
| **Primary Owner**     | Editor integration and release validation                                                                                                    |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-14–AUD-15; sections 18–19                 |
| **Depends On**        | Sprint 9.19                                                                                                                                  |
| **Status**            | ⏳ Planned                                                                                                                                   |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Close cross-domain gaps with real user-input E2E rather than DOM-forced clicks, and measure representative slice/Preview/resource budgets. Validate PT/EN, accessibility and provider failure states, then reconcile sprint/audit status against verifiable product evidence. This sprint does not authorize hardware testing; any physical evidence requires a separately approved target-specific task.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Run focused real-input/browser, performance and documentation consistency checks before the full gate. Do not use forced DOM clicks as proof of accessible interaction.

## Tickets

### S9.20-001 — Real-input integrated workflows and provider truthfulness

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.20-001                                                                       |
| **Title**            | Verify end-to-end user workflows with physical input and real backend artifacts |
| **Priority**         | P1                                                                              |
| **Type**             | Test + Integration                                                              |
| **Estimated Effort** | XL                                                                              |
| **Source Finding**   | AUD-01–AUD-14; audit sections 18–19                                             |
| **Status**           | ⏳ Planned                                                                      |

#### Context

Presence tests and synthetic DOM clicks can pass while a user-visible control is covered or a backend is mocked. Validate representative context action, project edit, real repair/boolean, slice-to-Preview, AI dispatch and controlled device transport flows, labeling each evidence layer.

#### Acceptance Criteria

- [ ] Representative context-menu and toolbar workflows use actual pointer/keyboard input and hit testing, not `el.click()`, forced clicks or synthetic dispatch as accessibility evidence.
- [ ] UI, menu/shortcut and AI pathways reach the same operation handler and observable domain result for shared actions.
- [ ] Real-backend artifacts/revisions are checked; Demo, unit, integration, product E2E and hardware evidence are reported as distinct levels.
- [ ] Provider unavailable, stale, error, partial, cancel and empty states are covered; no silent mock success.
- [ ] Cross-domain stale revision/artifact, recovery and duplicate-retry regressions are tested.
- [ ] Run focused integration checks, full gate and sanitizer dry-run successfully; no physical action.

### S9.20-002 — Responsive, i18n, accessibility and performance acceptance

| Field                | Value                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| **Ticket ID**        | S9.20-002                                                                |
| **Title**            | Verify PT/EN, accessibility and measured application performance budgets |
| **Priority**         | P1                                                                       |
| **Type**             | Test + Performance                                                       |
| **Estimated Effort** | L                                                                        |
| **Source Finding**   | AUD-03/AUD-05/AUD-14/AUD-15; sections 9, 12, 16, 19                      |
| **Status**           | ⏳ Planned                                                               |

#### Context

Cross-page controls, chat and technical Preview must remain usable at constrained layouts and with long localized strings. Measure representative load, playback/scrub and memory behavior rather than declaring performance from parser limits or a single device.

#### Acceptance Criteria

- [ ] PT/EN coverage includes long labels, errors, disabled reasons, pluralization and accessible names across the four pages.
- [ ] Keyboard/focus, forced-colors and real pointer hit-target checks cover contextual menu, plate info, playback and chat approvals.
- [ ] Layout checks cover stated viewport widths, sidebar sizes, zoom and long locales without clipped or overlapping text.
- [ ] Slice/Preview load, scrub and resource budgets are measured on representative corpus and documented with limitations.
- [ ] Run focused locale/accessibility/performance checks, full gate and sanitizer dry-run successfully.

### S9.20-003 — Evidence-based audit and sprint roadmap reconciliation

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9.20-003                                                                  |
| **Title**            | Reconcile sprint and audit statuses against concrete verification evidence |
| **Priority**         | P1                                                                         |
| **Type**             | Documentation                                                              |
| **Estimated Effort** | M                                                                          |
| **Source Finding**   | AUD-15; DOC-01–DOC-03                                                      |
| **Status**           | ⏳ Planned                                                                 |

#### Context

The current overview marks S9.12 planned while its fourth ticket's checked boxes conflict with pending status, and omits documented S9.13. Status changes must be supported by actual test/provider evidence; this planning task itself does not close implementation findings.

#### Acceptance Criteria

- [ ] **DOC-01:** S9.12 heading, ticket checkboxes and evidence agree; any incomplete work remains pending rather than inferred done.
- [ ] **DOC-02:** S9.13 is indexed with its documented cloud discovery/read scope and no unsupported write-side claim.
- [ ] **DOC-03:** Closed findings link concrete focused/full-gate and product evidence; unresolved or unsupported capabilities remain open/unavailable.
- [ ] Current audit content remains unchanged; overview coverage map and execution order match the seven plans.
- [ ] Run documentation consistency validation, full gate and sanitizer dry-run successfully.

## Sprint Commit

Each ticket commit uses `test(s9.20-00x): <imperative summary>` or `docs(s9.20-00x): <imperative summary>`, only after focused validation, both health commands and evidence review pass; no push.
