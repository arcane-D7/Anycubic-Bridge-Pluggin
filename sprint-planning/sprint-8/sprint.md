# Sprint 8 — R2: Own Planar Core (Validation Baseline) + Context-Dependent Op IR

## Sprint Metadata

| Field                 | Value                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | R2 — own planar core (S1 spike), profiles mapping, layer preview, op IR + independent emitted-program validator            |
| **Sprint Goal**       | Ship our own planar slicing core as a validation baseline (walls + infill on the corpus), spike S1 parity vs Anycubic Slicer Next within a declared budget, map existing presets into the machine capability schema, and define the context-dependent op IR with an independent emitted-program validator. |
| **Duration Estimate** | ~4 weeks                                                                                                                |
| **Priority**          | P0                                                                                                                      |
| **Sprint Type**       | Feature                                                                                                                 |
| **Primary Owner**     | engine-core                                                                                                             |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §3 (own engine, S1, §3.3, §3.6, §3.7), §5 (profiles), §10 R2, §2 (presets/catalog.json) |
| **Depends On**        | Sprint 7 (R1)                                                                                                           |
| **Status**            | ⏳ Planned                                                                                                              |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

The product goal is a non-planar engine; the planar core is the **validation baseline** — it
must match the Anycubic Slicer Next reference within a *declared, pre-declared* measurement
budget (S1 spike), NOT be a product feature wrapper. Kiri:Moto and libSlic3r are **reference
only** (per §3.4 + §🔒 license policy; the Kiri engine terms are unconfirmed; libSlic3r is
AGPL) — the planar core is our own clean Rust implementation (thin: layers + walls + infill).
R2 also maps the preserved `presets/catalog.json` into the §5 machine capability schema,
implements layer preview / per-layer toolpath visualization, and introduces the
context-dependent op IR (pose, orientation, bead section, flow, cooling, speed, collision-free
interval, provenance) with an **independent** emitted-program validator (separate code path
from the generator) and per-machine postprocessing via kinematics-aware FK.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
pnpm run slices       # run the S1 parity corpus comparator (new script; compares own planar output vs Anycubic reference on the fixed 3-part corpus)
node scripts/sanitize-repo.mjs --dry-run
```

> S1 budget numbers are **declared before** the spike runs (ticket S8-001) and recorded in
> docs/evidence — the comparator measures actual deltas against those declared numbers.

## Tickets

### S8-001 — S1 spike: declare & measure planar parity budget

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S8-001                                                                 |
| **Title**            | Spike S1 — planar parity baseline vs Anycubic Slicer Next (declared budget) |
| **Priority**         | P0                                                                     |
| **Type**             | Test/Research spike                                                     |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §3.8 S1, §10 R2 acceptance; §3 (planar output = validation baseline, not product goal) |
| **Status**           | ⏳ Planned                                                             |

#### Context

Before building the planar core, the *measurement* must exist. The fixed 3-part corpus
(fixtures committed in tests), Anycubic Slicer Next reference slicing via the preserved CLI
adapter (`scripts/slicer-cli.mjs`), and a comparator must be in place. Budget numbers
(per-layer wall count ±0, infill volume ≤ declared %, bounding box ≤ declared mm) are written
**before** running; the comparator reports measured deltas. The spike records the numbers and
gates R2.

#### Acceptance Criteria

- [ ] 3-part planar corpus committed (small, deterministic meshes; e.g. cube, cylinder, bracket) — sanitizer-clean fixtures.
- [ ] Comparator script `scripts/compare-planar-runs.mjs` (or crate) parses own + Anycubic 3MF/gcode outputs and computes: per-layer wall count delta, infill volume % delta, bounding box delta.
- [ ] Declared budget recorded in `docs/evidence/s1-budget-*.md` **before** the run: wall count ±0, infill volume ≤ X%, bbox ≤ X mm (concrete numbers chosen this sprint).
- [ ] Reference run captured via `scripts/slicer-cli.mjs` (slicer_cli slice, Anycubic CLI) and artifacts stored in `poc-output/` (gitignored) with a results summary in `docs/evidence/`.
- [ ] Measured deltas documented with pass/fail vs declared budget; the S1 gate for R2 is green (or the budget is revised with a journaled reason).
- [ ] Health gate green (+ comparator unit tests on synthetic fixups).

### S8-002 — Own planar core (clean Rust): layers + walls + infill

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S8-002                                                                 |
| **Title**            | Planar slice core in Rust (layers, walls, infill) — clean implementation |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | XL                                                                     |
| **Source Finding**   | Invest. Rev 2.0 §3 (own engine), §3.8 S1 (thin: layer + walls + infill), §10 R2; §🔒 policy (Kiri/libSlic3r reference-only) |
| **Status**           | ⏳ Planned                                                             |

#### Context

The planar core is a thin, deterministic Rust slice engine: layer heights, wall loops,
infill, E computed by volume conservation from real 3D path length and bead cross-section
(§3.3 — `V = ∫A_bead(s)ds`, `ΔE = V/A_filament` in filament-length mode, `Q = A_bead·v`
steady state). No source-adaptation of libSlic3r (AGPL) or Kiri:Moto engine (terms
unconfirmed); any reference use is study-only per §🔒 LICENSE POLICY.

#### Acceptance Criteria

- [ ] Rust `crates/planar-core` slices baseline parts: uniform layers, wall loops, infill pattern (grid/gyroid subset), brim/skirt basic.
- [ ] Extrusion computed per §3.3 (mm path length × local bead section; filament-length E; volumetric Q); unit tests pin the closed-form formulas and the constant-section assumptions.
- [ ] Deterministic: same input + profile → byte-identical slice metadata (hash test); no float nondeterminism.
- [ ] Machine capability gates: build volume from profile (never hardcoded); unsupported dialect → pre-flight rejection (reuses §5 contract).
- [ ] Output: intermediate IR (S8-004) + per-machine gcode subset via postprocessor (S8-005); no generic Cartesian emitter claim yet.
- [ ] Health gate green.

### S8-003 — Profiles mapping: presets/catalog.json → §5 machine capability schema

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S8-003                                                                 |
| **Title**            | Profile system (machine/process/filament) mapped from preserved catalog with contract as source of truth |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §10 R2 (profiles import from `presets/catalog.json` mapped into §5.1), §5 (contract is source of truth) |
| **Status**           | ⏳ Planned                                                             |

#### Context

`presets/catalog.json` + slicer process/filament presets already exist in the repo (preserved).
R2 imports them where possible into the capability schema — the schema is the source of truth,
the catalog is a *provider*. Unmapped keys are flagged `unknown`/null, never guessed; conflicts
(process vs profile) surface for human resolution per §5.2/§5.3.

#### Acceptance Criteria

- [ ] Mapper crate/TS: catalog preset → `machine-profile` schema fields; process presets → slicing params; filaments → material capability entries.
- [ ] Every unmapped or conflicting field is stored as `unknown`/null or flagged with provenance + confidence — no silent default (unit tests).
- [ ] Conflicts between catalog/profile entries raise a human-resolution workflow entry (journaled), never auto-preference.
- [ ] A profile is only *qualified* for a feature after the §5 qualification rules pass (ties into S6-003).
- [ ] Health gate green.

### S8-004 — Context-dependent op IR + independent emitted-program validator

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S8-004                                                                 |
| **Title**            | Op IR per segment (pose/orientation/bead/flow/cooling/speed/collision/provenance) + separate validator |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | XL                                                                     |
| **Source Finding**   | Invest. Rev 2.0 §3.6 (deterministic IR + independent validator), §3.7 pipeline, §10 R2 |
| **Status**           | ⏳ Planned                                                             |

#### Context

Every generated path needs a deterministic, reproducible intermediate representation before
machine postprocessing, and the emitted program must be validated by an **independent**
validation pass that does not share the generator's code path (§3.6). This IR is the seam the
non-planar engine (R5/R6) plugs into later. It carries per-segment: pose, tool orientation,
bead cross-section, flow, cooling, speed, collision-free interval, and provenance (revision,
generator, inputs).

#### Acceptance Criteria

- [ ] IR schema v1 versioned (JSON or bincode): segments with pose (position + orientation), bead `A_bead(s)` (variable section allowed), flow `Q`, cooling params, speed, collision-free interval, provenance; the segment's Z/E derivation uses §3.3 formulas.
- [ ] Generator writes IR deterministically (hash test); IR is the contract between generator and postprocessor.
- [ ] **Independent validator** (separate crate/code path, no shared functions with the generator): re-checks every segment: extrusion conservation (∫A_bead ds ≈ ΣE·A_filament), continuity, no out-of-profile moves, build-volume containment, dialect whitelist; a seeded bug in the generator is caught by the validator in a test.
- [ ] Validator failures surface as journaled rejections, never silent pass.
- [ ] Health gate green.

### S8-005 — Per-machine postprocessor (kinematics-aware FK → joint targets)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S8-005                                                                 |
| **Title**            | Kinematics-aware postprocessor + layer preview/toolpath visualization    |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §3.7 (per-machine FK → joint targets), §5.1 (joints/controller dialect), §10 R2 (layer preview) |
| **Status**           | ⏳ Planned                                                             |

#### Context

The postprocessor maps IR → controller dialect per the machine profile: joints from the
capability schema (linear/R-theta/robotic), a gcode whitelist per `controller_dialect`, and
no out-of-whitelist emission. Layer preview / per-layer toolpath visualization renders IR in
the R3F viewport for inspection.

#### Acceptance Criteria

- [ ] Postprocessor emits only whitelisted dialect codes from the profile (`gcode_whitelist`); a code outside the whitelist fails the validator test.
- [ ] Kinematics-aware: for a cartesian profile the FK is identity (X/Y/Z); for a rotary profile the joint targets are computed from IR pose (rectilinear segments; continuous multi-axis is R7/S4 — no over-claim).
- [ ] Layer preview: viewport shows per-layer toolpaths + infill/walls overlays from IR; layer slider works.
- [ ] E2E: slice fixture → IR → postprocess → validate → preview renders without errors.
- [ ] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-8): R2 — own planar core as validation baseline + op IR"

- S8-001: S1 spike — declared planar parity budget vs Anycubic reference
- S8-002: clean Rust planar core (layers/walls/infill, §3.3 extrusion)
- S8-003: profiles mapping from preserved catalog into §5 schema
- S8-004: context-dependent op IR + independent emitted-program validator
- S8-005: per-machine kinematics-aware postprocessor + layer preview
```
