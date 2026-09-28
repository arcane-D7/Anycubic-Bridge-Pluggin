# Sprint 12 — R6: Non-Planar S3 (Conformal / Field-Based Slicing)

## Sprint Metadata

| Field                 | Value                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | R6 — conformal/field-based non-planar slicing (fully-curved parts) with the CurviSlicer paper studied and OSQP solver in Rust |
| **Sprint Goal**       | Ship general conformal (S3): deformation/inverse-map AND field-based strategies over arbitrary curved surfaces, with the CurviSlicer algorithm implemented only from the published paper (AGPL code never copied), an OSQP (Rust) solver for field strategies, variable-thickness validation, and an experimental art/decorative-only gate until structural acceptance is demonstrated within a declared budget. |
| **Duration Estimate** | ~6 weeks                                                                                                                |
| **Priority**          | P1                                                                                                                      |
| **Sprint Type**       | Feature/Research                                                                                                        |
| **Primary Owner**     | engine-nonplanar                                                                                                        |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §3.1 (S3: deformation/inverse-map or field-based strategies 1/2), §3.3/§3.9 (research boundary), §3.0a (nonplanar mode extends to conformal), §🔒 LICENSE POLICY, §10 R6 |
| **Depends On**        | Sprint 11 (R5 S2)                                                                                                       |
| **Status**            | ⏳ Planned                                                                                                              |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

S3 generalizes beyond height-fields: conformal slicing of fully curved parts via
deformation/inverse-mapping OR field-based strategies (path fields on the surface). The
CurviSlicer algorithm is studied from the **published paper** only — the AGPL implementation is
never copied, linked, adapted or imported (per §🔒 LICENSE POLICY; see §3.9 research
boundary). The OSQP solver is implemented in Rust for field strategies, with variable-thickness
validation and controls, and everything ships behind an experimental flag restricted to
art/decorative uses until structural acceptance (measured against a declared tolerance budget
on the S1 corpus + 2 curved parts) passes.

> **Dual-mode (user-confirmed 2026-09-28, §3.0a):** S3 is another engine inside the same
> **opt-in `nonplanar` mode** — extended from S2 curved-top to conformal whole-surface paths.
> **Standard (planar) mode remains the default and is untouched** regardless of the S3 flag
> state; a `standard` job never contains conformal segments. The `nonplanar` selector keeps
> its profile gating (now slope budget + joint model).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
pnpm run conformal-s3    # S3 e2e: conformal field over fixture curved part (deform + field strategies), tolerance vs planar budget, validator, art-only flag gating
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S12-001 — CurviSlicer study (paper) + implementation design lock

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S12-001                                                                |
| **Title**            | CurviSlicer paper study → design notes; AGPL never imported              |
| **Priority**         | P0                                                                     |
| **Type**             | Research                                                                |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §3.9 (algorithms studied from published papers only), §🔒 (AGPL = study-only) |
| **Status**           | ⏳ Planned                                                             |

#### Context

General non-planar slicing has published research (CurviSlicer, Étienne et al.). We study the
paper, the math, the variable-thickness layer model and its assumptions, and write our own
algorithm. Reference to AGPL/BSD/MIT source is for **information only**, never copied (§3.9;
§🔒). This ticket produces the design doc that locks the algorithm approach before any solver
work.

#### Acceptance Criteria

- [ ] Design doc `docs/research/s3-conformal-design.md`: CurviSlicer paper summary (methodology, thickness criteria: zero-slope-first & layer-angle-budget), our chosen strategy: deformation/inverse-map AND field-based variants, and the variable-thickness validation model.
- [ ] Explicit license note: CurviSlicer repo is AGPL-3.0 → study-only; no AGPL file/logic copied into our codebase; only the published math, formulas and pseudocode (facts) may be re-implemented; every adapted asset has its license listed in `docs/licenses.md`.
- [ ] Open questions (§11 Unknowns) updated with S3-solver unknowns (see S12-002).
- [ ] Health gate green (doc lint + license registry check).

### S12-002 — OSQP quadratic-program solver in Rust (field strategies)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S12-002                                                                |
| **Title**            | OSQP solver port/implementation in Rust for surface field QP                |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | XL                                                                     |
| **Source Finding**   | Invest. Rev 2.0 §3.1 (S3 field strategy needs a QP solver); §10 R6      |
| **Status**           | ⏳ Planned                                                             |

#### Context

Field-based strategies solve a quadratic program over the surface (e.g. minimizing curvature
deviation / smoothing the direction field). OSQP is a standard prox-type solver; we need it in
Rust under Apache-2.0 wiring, or a clean compatible implementation. Accuracy/performance tests
against hand-computable small QPs.

#### Acceptance Criteria

- [ ] Rust QP solver integrated (OSQP via its Apache-2.0 Rust wrapper, or a clean re-implementation of the sparse QP based on published algorithm descriptions — license-annotated per §🔒).
- [ ] Unit tests: convex small QP fixtures with analytic solutions (box constraints, equality constraints, smoothing QP) — relative error under declared epsilon.
- [ ] Behavior with degenerate/infeasible QPs: solver fails gracefully (rejection journaled).
- [ ] Field strategy: compute per-vertex direction field minimizing energy (smoothness + alignment to a goal direction) and trace paths along the field.
- [ ] Determinism: same inputs → same results (hash), thread-safe (no global state).
- [ ] Health gate green.

### S12-003 — Deform / inverse-map strategy

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S12-003                                                                |
| **Title**            | Deformable-surface conformal strategy (mesh parameterization)            |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §3.1 (S3 deformation/inverse-map strategy)              |
| **Status**           | ⏳ Planned                                                             |

#### Context

Alternative conformal strategy: parametrize (unfold) the curved surface to a plane, slice in
parameter space, and map back through the inverse map. This produces paths aligned with the
surface but must validate distortion limits (subsequent bead widths vary — handled by
variable-thickness validation S12-004). Runs only within `slicing_mode = nonplanar` (§3.0a);
standard-mode jobs never use it.

#### Acceptance Criteria

- [ ] Parameterization of a topologically disk-like curved surface (develop or near-isometric) with bounded area distortion (targets recorded).
- [ ] Inverse-map: parameter-space paths → surface paths; distortion above the per-profile threshold → rejected or re-mapped (journaled).
- [ ] Bounds: only parts whose curtain edges lie on slope-budget surfaces; no over-claim ("general free-form" is not claimed for S3 v1).
- [ ] Integration: paths go through IR S12-005/S8-004 (mode-tagged) and per-machine postprocessor.
- [ ] Health gate green.

### S12-004 — Variable-thickness layer validation + paint-ability check

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S12-004                                                                |
| **Title**            | Variable-thickness validation (thickness locked to bead painting); art flag enforces scope |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §10 R6 (variable thickness validation); §3.1            |
| **Status**           | ⏳ Planned                                                             |

#### Context

Non-constant layer thickness from painting is what separates *art* from *structure*. The
thickness model and the validation must agree (per §3.3 `ΔE = V/A_filament`; painted
thickness = bead cross-section area along the path). A "paint-ability" check verifies E/Z
feasibility per segment before anything structural. Until the structural acceptance gate
(against declared budget) passes, the feature only runs with the art/decorative flag.

#### Acceptance Criteria

- [ ] Paint-ability check in the validator: for each painted segment, the bead cross-section integral equals extruded volume (E) within the profile tolerance; out-of-profile E/Z/max-accel → rejected with journaled reason; unit tests on thin/thick painted paths.
- [ ] Non-uniform thickness along the path is encoded in the IR bead field (variable `A_bead(s)`), and the validator re-derives E from it (seeded-bug test: validator catches E computed from constant section while IR is variable).
- [ ] No-paint (uniform thickness) paths are validated identically (regression).
- [ ] The art/decorative flag: S3 runs only with the flag set until structural acceptance passes; the UI marks "experimental — art/decorative only" and warns on any structural use (no silent structural run).
- [ ] Health gate green.

### S12-005 — S3 tolerance vs baseline on corpus (declared budget) + art-only UI gate

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S12-005                                                                |
| **Title**            | S3 tolerance measurement vs planar baseline (declared budget) + UI flag gate |
| **Priority**         | P1                                                                     |
| **Type**             | Test/Evidence                                                          |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §10 R6 (tolerance vs planar baseline on S1 corpus + 2 curved parts, declared budget); §7 UI |
| **Status**           | ⏳ Planned                                                             |

#### Context

S3 must be measured against the planar baseline and its declared tolerance budget on the fixed
S1 corpus plus two curved parts: max deviation (mm) on an exposed top surface, wall thickness
deviation, and infill continuity metrics. Budget numbers are declared BEFORE measurement; only
results within budget upgrade the feature flag from art-only to art+structural. The UI gate is
explicit: when the flag is off, conformal tools are grayed out with the reason — and the
**standard mode toggle stays fully functional regardless**: standard-mode slices on the same
profile must remain byte-stable (regression) while S3 flag is off.

#### Acceptance Criteria

- [ ] Budget declared in `docs/evidence/s3-tolerance-budget-*.md` (pre-measurement): max top-surface deviation ≤ X mm, wall-thickness deviation ≤ Y mm, infill continuity ≥ Z %.
- [ ] Measurement harness: run S3 and planar baseline on the S1 corpus + 2 curved fixtures; comparator `scripts/compare-conformal-runs.mjs` computes the metrics; results recorded in `docs/evidence/` (redacted, JSON-safe).
- [ ] Pass/fail vs declared budget documented. On pass: feature flag flips to art+structural (still experimental label). On fail: remains art-only with the measured deltas and a journaled rollback path.
- [ ] UI gate test: with flag off (default), conformal toolbar tools are disabled with reason; flag set → enabled + "experimental" badge; `standard` mode unchanged (byte-stable standard slice regression on the corpus).
- [ ] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-12): R6 — conformal/field-based S3 (paper study, OSQP, art gate)"

- S12-001: CurviSlicer paper study + design lock (AGPL never imported)
- S12-002: OSQP QP solver in Rust (field strategies)
- S12-003: deform/inverse-map conformal strategy (nonplanar mode only)
- S12-004: variable-thickness validation + paint-ability check
- S12-005: S3 tolerance vs planar baseline + art-only UI gate (standard untouched)
```
