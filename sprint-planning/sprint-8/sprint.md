# Sprint 8 — R2: Own Planar Core (Validation Baseline) + Context-Dependent Op IR

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | R2 — own planar core (S1 spike), profiles mapping, layer preview, op IR + independent emitted-program validator                                                                                                                                                                                            |
| **Sprint Goal**       | Ship our own planar slicing core as a validation baseline (walls + infill on the corpus), spike S1 parity vs Anycubic Slicer Next within a declared budget, map existing presets into the machine capability schema, and define the context-dependent op IR with an independent emitted-program validator. |
| **Duration Estimate** | ~4 weeks                                                                                                                                                                                                                                                                                                   |
| **Priority**          | P0                                                                                                                                                                                                                                                                                                         |
| **Sprint Type**       | Feature                                                                                                                                                                                                                                                                                                    |
| **Primary Owner**     | engine-core                                                                                                                                                                                                                                                                                                |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §3 (own engine, S1, §3.3, §3.6, §3.7), §3.0a (dual modes — standard default), §5 (profiles), §10 R2, §2 (presets/catalog.json)                                            |
| **Depends On**        | Sprint 7 (R1)                                                                                                                                                                                                                                                                                              |
| **Status**            | ⏳ Planned                                                                                                                                                                                                                                                                                                 |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

The product goal is a non-planar engine; the planar core is the **validation baseline** — it
must match the Anycubic Slicer Next reference within a _declared, pre-declared_ measurement
budget (S1 spike), NOT be a product feature wrapper. Kiri:Moto and libSlic3r are **reference
only** (per §3.4 + §🔒 license policy; the Kiri engine terms are unconfirmed; libSlic3r is
AGPL) — the planar core is our own clean Rust implementation (thin: layers + walls + infill).
R2 also maps the preserved `presets/catalog.json` into the §5 machine capability schema,
implements layer preview / per-layer toolpath visualization, and introduces the
context-dependent op IR (pose, orientation, bead section, flow, cooling, speed, collision-free
interval, provenance) with an **independent** emitted-program validator (separate code path
from the generator) and per-machine postprocessing via kinematics-aware FK.

> **Dual-mode requirement (user-confirmed 2026-09-28, §3.0a):** the slicer ships BOTH modes,
> first-class — **standard (planar) mode = the default, always available, product-grade**; the
> non-planar engine is an **opt-in experimental mode** selected **per project** only when the
> active machine profile declares the required capabilities. **R2 delivers the standard-mode
> pipeline in full** (slice → IR → postprocess → validate → preview) and all dual-mode
> mechanics (mode persisted per project from S6-004, mode in IR provenance + cache key,
> mode-aware validator, no global mode setting). Non-planar S2/S3 come online later (Sprint
> 11/12) as a capability-gated per-project opt-in.

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

| Field                | Value                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Ticket ID**        | S8-001                                                                                                 |
| **Title**            | Spike S1 — planar parity baseline vs Anycubic Slicer Next (declared budget)                            |
| **Priority**         | P0                                                                                                     |
| **Type**             | Test/Research spike                                                                                    |
| **Estimated Effort** | L                                                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §3.8 S1, §10 R2 acceptance; §3 (planar output = validation baseline, not product goal) |
| **Status**           | ✅ Done                                                                                                |

#### Context

Before building the planar core, the _measurement_ must exist. The fixed 3-part corpus
(fixtures committed in tests), Anycubic Slicer Next reference slicing via the preserved CLI
adapter (`scripts/slicer-cli.mjs`), and a comparator must be in place. Budget numbers
(per-layer wall count ±0, infill volume ≤ declared %, bounding box ≤ declared mm) are written
**before** running; the comparator reports measured deltas. The spike records the numbers and
gates R2.

#### Acceptance Criteria

- [x] 3-part planar corpus committed (small, deterministic meshes; e.g. cube, cylinder, bracket) — sanitizer-clean fixtures.
- [x] Comparator script `scripts/compare-planar-runs.mjs` (or crate) parses own + Anycubic 3MF/gcode outputs and computes: per-layer wall count delta, infill volume % delta, bounding box delta.
- [x] Declared budget recorded in `docs/evidence/s1-budget-*.md` **before** the run: wall count ±0, infill volume ≤ 15%, bbox ≤ 1.0 mm (revised from ≤0.5 mm with journaled rationale: the reference measures outer-wall bead centre, ~0.45 mm inside the model surface per side).
- [x] Reference run captured via `scripts/slicer-cli.mjs` (slicer_cli slice, Anycubic CLI) and artifacts stored in `poc-output/` (gitignored) with a results summary in `docs/evidence/`.
- [x] Measured deltas documented with pass/fail vs declared budget; the S1 gate for R2 is green (or the budget is revised with a journaled reason).
- [x] Health gate green (+ comparator unit tests on synthetic fixups).

#### Implementation Notes

- **Runner**: `pnpm run slices` (new script) executes the real Anycubic Slicer Next CLI on the
  3-part corpus, parses the reference `Metadata/plate_1.gcode` from the 3MF, computes deltas and
  journals `docs/evidence/s1-parity-results-*.json` (+ `s1-ref-*.json`). Exit 0 iff all parts
  pass the declared budget (never false-green: SKIP journals when the slicer is absent).
- **Comparator** (`scripts/compare-planar-runs.mjs`): parses BOTH `;LAYER_CHANGE`+`;Z:` (Anycubic)
  and `;LAYER:` (Cura-style); gates out preamble prime/wipe (`Custom`) and adhesion
  (skirt/brim/raft) moves from both bbox and extrusion; compares **bbox extents per axis**
  (reference gcode is plate-positioned at 125,125); Z extent comes from layer markers, not moves;
  wall-count delta excludes top/bottom skin layers (outer wall → surface pass is standard.
- **Measured (2026-09-28)**: cube PASS walls±0 infill 0.01% bbox±0.420mm · cylinder PASS walls±0
  infill −0.84% bbox±0.516mm · bracket PASS walls±0 infill 10.74% bbox±0.420mm. S1 gate GREEN.
- Gate EXIT:0 (unit 207, integration 10, Rust, smoke 106, licenses, architecture, sanitize 0).

### S8-002 — Own planar core (clean Rust): layers + walls + infill

| Field                | Value                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S8-002                                                                                                                      |
| **Title**            | Planar slice core in Rust (layers, walls, infill) — clean implementation                                                    |
| **Priority**         | P0                                                                                                                          |
| **Type**             | Feature                                                                                                                     |
| **Estimated Effort** | XL                                                                                                                          |
| **Source Finding**   | Invest. Rev 2.0 §3 (own engine), §3.8 S1 (thin: layer + walls + infill), §10 R2; §🔒 policy (Kiri/libSlic3r reference-only) |
| **Status**           | ✅ Done                                                                                                                     |

#### Context

The planar core is a thin, deterministic Rust slice engine: layer heights, wall loops,
infill, E computed by volume conservation from real 3D path length and bead cross-section
(§3.3 — `V = ∫A_bead(s)ds`, `ΔE = V/A_filament` in filament-length mode, `Q = A_bead·v`
steady state). No source-adaptation of libSlic3r (AGPL) or Kiri:Moto engine (terms
unconfirmed); any reference use is study-only per §🔒 LICENSE POLICY. This is the engine
behind **standard (planar) mode** — the default slicing model, always available (§3.0a); **not**
a research stub. It does **not** depend on any non-planar capability and is the baseline every
mode-aware validator checks against.

#### Acceptance Criteria

- [x] Rust `crates/planar-core` slices baseline parts: uniform layers, wall loops, infill pattern (grid/gyroid subset), brim/skirt basic.
- [x] Extrusion computed per §3.3 (mm path length × local bead section; filament-length E; volumetric Q); unit tests pin the closed-form formulas and the constant-section assumptions.
- [x] Deterministic: same input + profile → byte-identical slice metadata (hash test); no float nondeterminism.
- [x] Machine capability gates: build volume from profile (never hardcoded); unsupported dialect → pre-flight rejection (reuses §5 contract).
- [x] Output: intermediate IR (S8-004) + per-machine gcode subset via postprocessor (S8-005); no generic Cartesian emitter claim yet — engine emits `SliceMeta` (layer/toolpath/segment IR) as the seam S8-004/S8-005 consume; no generic Cartesian gcode emitter.
- [x] **Standard-mode role**: runs without any non-planar capability; a `standard` job never contains a Z-ramp or non-planar segment (validator enforces, §3.0a; engine invariant verified by tests).
- [x] Health gate green.

#### Implementation Notes

- **Crate** `crates/planar-core` (workspace member, edition 2021, rust-version 1.98; deps only
  serde/serde_json/thiserror + path `machine-profile` — Apache/MIT policy clean): `slice.rs`
  (engine), `extrusion.rs` (§3.3 closed forms), `infill.rs` (grid + gyroid subset),
  `offset.rs` (loop insets/outset), `lib.rs`, `tests_meta.rs` (34 tests),
  `bin/slice-json.rs` (CLI: STL + profile JSON → `SliceMeta` JSON).
- **Extrusion §3.3**: `ΔE = A_bead·ℓ / A_filament` (filament-length mode) with `A_bead` from the
  planar crown-section model; `volumetric_q` steady-state `Q = A_bead·v`. Unit tests pin the
  closed forms (incl. extrusion conservation: bead volume ≈ Σ(ΔE·A_filament)).
- **Determinism**: integer-ordered layer/wall/segment generation, FNV-1a 64 fingerprint over
  normalized floats/metadata; same input + profile → byte-identical JSON (hash test).
- **Machine gates**: `build_volume` read from the profile (never hardcoded — `slice-json` maps
  `build_volume` → `machine_profile::Volume`); dialect allowlist `anycubic|cura` rejected
  pre-flight (`UnsupportedDialect`), unsupported infill pattern rejected (`UnsupportedInfillPattern`).
- **Correctness (this ticket)**: layer count = part height (`bbox.max_z − bbox.min_z`), z offset
  by `bbox.min_z`; solid top/bottom shells (`top_bottom_layers`); bead line width 0.45 mm;
  infill clipped to innermost wall ring interior. 34 tests incl. `layer_count_matches_part_height`,
  `solid_shells_heavier_than_sparse_infill`, `zero_shells_disables_solid_fill`, planet invariants.
- **Parity (S1 budget, measured 2026-09-29 via real Anycubic CLI)**: cube −11.08% infill,
  cylinder +9.13%, bracket −2.07% (all ≤15% budget); walls ±0; bbox ±0.200 mm (≤1.0 mm).
  Journal: `docs/evidence/s1-parity-results-20260929.json` + `s1-ref-20260929.json`.
- **Runner wiring**: `scripts/slices-runner.mjs` `candidateSlice` now invokes the real Rust core
  via `cargo run -q -p planar-core --bin slice-json` (`CORE_PROFILE` exact JSON shape); parity
  journal updated by `pnpm run slices` — 3/3 PASS.
- Gate EXIT:0 (unit 207, integration 10, planar-core 34, smoke 106, licenses 38, architecture,
  sanitize 0 files).
- Commit `a85050d` — `feat(s8-002): planar-core Rust clean slice engine …`.

### S8-003 — Profiles mapping: presets/catalog.json → §5 machine capability schema

| Field                | Value                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S8-003                                                                                                                  |
| **Title**            | Profile system (machine/process/filament) mapped from preserved catalog with contract as source of truth                |
| **Priority**         | P1                                                                                                                      |
| **Type**             | Feature                                                                                                                 |
| **Estimated Effort** | M                                                                                                                       |
| **Source Finding**   | Invest. Rev 2.0 §10 R2 (profiles import from `presets/catalog.json` mapped into §5.1), §5 (contract is source of truth) |
| **Status**           | ✅ Done                                                                                                                 |

#### Context

`presets/catalog.json` + slicer process/filament presets already exist in the repo (preserved).
R2 imports them where possible into the capability schema — the schema is the source of truth,
the catalog is a _provider_. Unmapped keys are flagged `unknown`/null, never guessed; conflicts
(process vs profile) surface for human resolution per §5.2/§5.3.

#### Acceptance Criteria

- [x] Mapper crate/TS: catalog preset → `machine-profile` schema fields; process presets → slicing params; filaments → material capability entries.
- [x] Every unmapped or conflicting field is stored as `unknown`/null or flagged with provenance + confidence — no silent default (unit tests).
- [x] Conflicts between catalog/profile entries raise a human-resolution workflow entry (journaled), never auto-preference.
- [x] A profile is only _qualified_ for a feature after the §5 qualification rules pass (ties into S6-003).
- [x] Health gate green.

#### Implementation Notes

- **Pure mapper** `scripts/catalog-mapper.mjs` (no MCP wiring — the catalog provider loaders
  stay in `scripts/presets-tools.mjs`): `mapCatalogPreset` (known capability fields
  `build_volume_*`/`nozzle_diameter_mm`/`continuous_z` + process params
  layer_height/wall_loops/infill_* → typed fields; **every other key → `unknownKeys` with a
  named reason, never guessed**), `catalogProfileFromCapabilities` (§5 MachineProfile shape,
  `source_class=catalog`, `provenance=catalog@<version>`, `unknown=true` + null value when
  unmapped), `mapFilamentsToMaterialEntries` (material_type/nozzle/bed temps — never
  invented; name-only filaments stay unknown), `blockingMissingCapabilities` (S6-003 §5
  qualification gate: undeclared or unknown capability → blocked with named reason),
  `journalResolutionEntry` (conflict/unknown → human-resolution journal entry,
  `resolution:null` — never auto-preference).
- **Composition with the real catalog verified**: `marble-mix-2-colors` maps machine
  "Anycubic Kobra S1" → profile; its (unexpected) absent capabilities stay unknown and the
  qualification gate blocks — fail-closed, truthful.
- Gate EXIT:0 (unit 215 = 207+8 new, integration 10, smoke 106, licenses 38, sanitize 0).
- Commit `e041614` — `feat(s8-003): catalog→§5 profile mapper …`.

### S8-004 — Context-dependent op IR + independent emitted-program validator

| Field                | Value                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Ticket ID**        | S8-004                                                                                                 |
| **Title**            | Op IR per segment (pose/orientation/bead/flow/cooling/speed/collision/provenance) + separate validator |
| **Priority**         | P0                                                                                                     |
| **Type**             | Feature                                                                                                |
| **Estimated Effort** | XL                                                                                                     |
| **Source Finding**   | Invest. Rev 2.0 §3.6 (deterministic IR + independent validator), §3.7 pipeline, §10 R2                 |
| **Status**           | ⏳ Planned                                                                                             |

#### Context

Every generated path needs a deterministic, reproducible intermediate representation before
machine postprocessing, and the emitted program must be validated by an **independent**
validation pass that does not share the generator's code path (§3.6). This IR is the seam the
non-planar engine (R5/R6) plugs into later — and the seam where **mode** lives. It carries
per-segment: pose, tool orientation, bead cross-section, flow, cooling, speed, collision-free
interval, and provenance (revision, generator, inputs). A segment-level `mode` tag
(`standard` | `nonplanar`) makes the validator **mode-aware** (§3.0a): a Z-ramp in a
`standard` job, or a layer-jump in a `nonplanar` job, is rejected with a named reason +
segment id.

#### Acceptance Criteria

- [ ] IR schema v1 versioned (JSON or bincode): segments with pose (position + orientation), bead `A_bead(s)` (variable section allowed), flow `Q`, cooling params, speed, collision-free interval, provenance; the segment's Z/E derivation uses §3.3 formulas.
- [ ] **Mode tagging**: per-segment `mode` field (`standard` | `nonplanar`); non-planar segments (Z-ramp etc.) are tagged `nonplanar`; the preview consumes the flag so continuous-Z is never rendered as a layer change.
- [ ] Generator writes IR deterministically (hash test); IR is the contract between generator and postprocessor.
- [ ] **Independent validator** (separate crate/code path, no shared functions with the generator): re-checks every segment: extrusion conservation (∫A_bead ds ≈ ΣE·A_filament), continuity, no out-of-profile moves, build-volume containment, dialect whitelist, **and mode consistency — a Z-ramp inside a `standard` job is rejected (named reason + segment id)**; a seeded bug in the generator is caught by the validator in a test.
- [ ] **Slice-cache key includes the `slicing_mode`**: switching mode invalidates the cache and forces a re-slice with explicit UI confirmation (no stale-mode gcode leak, §3.0a).
- [ ] Validator failures surface as journaled rejections, never silent pass.
- [ ] Health gate green.

### S8-005 — Per-machine postprocessor (kinematics-aware FK → joint targets)

| Field                | Value                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S8-005                                                                                                          |
| **Title**            | Kinematics-aware postprocessor + layer preview/toolpath visualization                                           |
| **Priority**         | P1                                                                                                              |
| **Type**             | Feature                                                                                                         |
| **Estimated Effort** | L                                                                                                               |
| **Source Finding**   | Invest. Rev 2.0 §3.7 (per-machine FK → joint targets), §5.1 (joints/controller dialect), §10 R2 (layer preview) |
| **Status**           | ⏳ Planned                                                                                                      |

#### Context

The postprocessor maps IR → controller dialect per the machine profile: joints from the
capability schema (linear/R-theta/robotic), a gcode whitelist per `controller_dialect`, and
no out-of-whitelist emission. Layer preview / per-layer toolpath visualization renders IR in
the R3F viewport for inspection. In **standard mode** the preview renders layer-by-layer
(fictitious-layer detection disabled when a `nonplanar` tag is present, §3.0a).

#### Acceptance Criteria

- [ ] Postprocessor emits only whitelisted dialect codes from the profile (`gcode_whitelist`); a code outside the whitelist fails the validator test.
- [ ] Kinematics-aware: for a cartesian profile the FK is identity (X/Y/Z); for a rotary profile the joint targets are computed from IR pose (rectilinear segments; continuous multi-axis is R7/S4 — no over-claim).
- [ ] Layer preview: viewport shows per-layer toolpaths + infill/walls overlays from IR; layer slider works; `mode` metadata consumed (standard renders layer-aligned; nonplanar segments render as ramps, not layer jumps).
- [ ] E2E: slice fixture → IR → postprocess → validate → preview renders without errors, in `standard` (default) mode.
- [ ] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-8): R2 — standard slicing mode + own planar core + op IR"

- S8-001: S1 spike — declared planar parity budget vs Anycubic reference
- S8-002: clean Rust planar core (layers/walls/infill, §3.3 extrusion) = standard mode
- S8-003: profiles mapping from preserved catalog into §5 schema
- S8-004: context-dependent op IR (mode-tagged) + mode-aware independent validator
- S8-005: per-machine kinematics-aware postprocessor + mode-aware layer preview
```
