# Sprint 11 — R5: Non-Planar S2 (Curved Top Surfaces)

## Sprint Metadata

| Field                 | Value                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | R5 — height-field curved-top non-planar paths (S2) with per-profile slope envelopes and machine pre-flight budgets         |
| **Sprint Goal**       | Turn curved-top non-planar slicing (S2) into working, gated software: height-field lifting on the planar baseline, per-machine slope rejection via lampower tools not fallbacks, swept-envelope collision checks, per-machine gcode postprocessing with independent validation, and a physical coupon gate on the bundled reference profile. |
| **Duration Estimate** | ~6 weeks                                                                                                                |
| **Priority**          | P1                                                                                                                      |
| **Sprint Type**       | Feature                                                                                                                 |
| **Primary Owner**     | engine-nonplanar                                                                                                        |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §3.1 (S2 height-field), §3.3 (formulas), §3.0a (nonplanar = opt-in per-project), §4/§8 (Blender IPC), §5.1 (envelope), §10 R5 |
| **Depends On**        | Sprint 8 (R2 planar core + IR)                                                                                           |
| **Status**            | ⏳ Planned                                                                                                              |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

Non-planar S2 is the first "own engine" step beyond planar: the top surface of a part is
represented as a height-field lifted from the planar baseline. Slope rejection is **per machine
profile** — if a machine does not declare `continuous_z.supported`, S2 candidates are rejected
pre-flight, never silently degraded. §3.1's "practical content" is enforced: absolutely no
`h/cosθ` model and no predictive-deposition guarantee; Z and E per segment come from §3.3.
Every generated toolpath is collision-checked against the full swept envelope (§5.1
`tool_envelope`, not a nozzle cone). Physical coupon on the bundled reference profile uses
only placeholders (`<MACHINE_TYPE>` etc.). Continuous-Z pre-flight is mandatory and
fail-closed.

> **Dual-mode (user-confirmed 2026-09-28, §3.0a):** this sprint turns the **non-planar mode
> on**, but only as the **opt-in per-project** experimental mode. **Standard (planar) mode
> remains the default and is untouched**: a user who disables non-planar gets a fully standard
> slicing model; a `standard` job on even a continuous-Z profile slices as pure standard. The
> `nonplanar` project selector is enabled **iff** the active profile declares
> `continuous_z.supported` + slope budget; otherwise disabled with the named missing
> capability — never a silent fallback.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
pnpm run nonplanar-s2   # S2 e2e: planar baseline → height-field lift → slope per-profile → envelope check → postprocess → validate → preview; plus the pre-flight rejection matrix
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S11-001 — Height-field top-surface lifting over the planar baseline

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S11-001                                                                |
| **Title**            | Height-field top-surface model + curved-top path generation               |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | XL                                                                     |
| **Source Finding**   | Invest. Rev 2.0 §3.1 (S2 height-field lift), §3.3 (Z/E formulas), §10 R5 |
| **Status**           | ⏳ Planned                                                             |

#### Context

A top surface is a height-field `z = f(x, y)` over a planar region. S2 lifts the top few
planar layers onto this surface: segment endpoints compute Z from the height-field and E from
true 3D path length via the bead cross-section (§3.3 `ΔE = V/A_filament` in filament-length
mode). No `h/cosθ` approximation and no predictive-deposition claim.

#### Acceptance Criteria

- [ ] Height-field model registered in the IR (per-segment Z + orientation from f(x,y) + mesh normals) — feeds S11-004/S11-005 and (S12) conformal paths later.
- [ ] Curved-top paths generated over the top-surface region; E computed from real 3D arc length × bead section; unit pins the §3.3 formulas on a known-delta fixture (no `h/cosθ`).
- [ ] Rails/interpolation: S2 supports the given top surface; curvature inversion (overhang beyond slope limit) is rejected per profile (S11-002), never approximated.
- [ ] The viewport renders S2 layers with Z-offset ramps + orientation markers.
- [ ] Health gate green.

### S11-002 — Per-machine slope-limit envelope + pre-flight rejection (fail-closed)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S11-002                                                                |
| **Title**            | Slope budgets/kinematic limits per profile; pre-flight continuous-Z gate |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §5.1 (`continuous_z.supported`), §3.1 (slope rejection per profile); fail-closed pre-flight |
| **Status**           | ⏳ Planned                                                             |

#### Context

Machines differ (Kobra S1-style continuous-Z vs Z-hop only). The capability contract declares
`continuous_z.supported` and slope budgets. Pre-flight: S2 for a profile without
`continuous_z.supported` or without the geometry within slope budget → `REJECTED` with reason
journaled; never a silent degrade down to planar.

#### Acceptance Criteria

- [ ] Per-profile slope budget + kinematic Z limits loaded from the §5.1 contract (missing/unknown = not continuous-Z → rejected).
- [ ] Pre-flight S2 check: geometry → per-segment slope vs profile → pass/fail with reason (unit test matrix: continuous-Z profile accepts in-budget surface; Z-hop profile rejects; unknown → rejects).
- [ ] Rejection surfaces in UI (pre-flight panel) and is journaled with reason + machine + geometry hash.
- [ ] Health gate green.

### S11-003 — Swept-envelope collision check (full tool envelope, not nozzle cone)

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S11-003                                                                |
| **Title**            | Collision check against full swept envelope from §5.1 tool_envelope      |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §5.1 (`tool_envelope` [SPEC]); §4 (Blender geometry backend for meshes/intersections) |
| **Status**           | ⏳ Planned                                                             |

#### Context

Before any non-planar move is emitted, the full swept volume of the tool (envelope from the
capability contract) along the proposed path must not intersect the part or fixture plates
(Blender geometry engine, T2 pinned, broker-proxied). A nozzle cone is insufficient (that was
§3.1's "practical content").

#### Acceptance Criteria

- [ ] Swept volume computed from `tool_envelope` (lateral extent X/Y at each Z + extension) — §5.1 field, no cone assumption; envelope value from profile, never a constant.
- [ ] Collision test: per-segment swept envelope vs mesh (Blender geometry check via broker capability) with interface distance threshold; a violating segment fails the move (journaled) or is pre-rejected by slope budget.
- [ ] Unit tests on synthetic envelopes (cone, capsule, cylinder shapes) proving the check is shape-aware (a cone whose radius shrinks with Z passes where a capsule fails).
- [ ] Health gate green.

### S11-004 — Per-machine gcode postprocessing + independent emitted-program validation for S2

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S11-004                                                                |
| **Title**            | S2 postprocessor (continuous-Z dialect whitelist) + independent check    |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §3.7 (per-machine FK + dialect whitelist), §10 R5 (per-machine postprocess + validation) |
| **Status**           | ⏳ Planned                                                             |

#### Context

S2 toolpaths must be emitted only through the machine's dialect whitelist — a continuous-Z move
on a Z-hop-only machine is a hardware-clash risk, so the whitelist is the gate. The independent
validator (S8-004) re-checks emitted S2 lines (E/Z consistency, envelope in-bounds, mode
consistency per §3.0a, no out-of-dialect codes). **Standard-mode jobs are unaffected**: the S2
postprocessor only activates when `slicing_mode = nonplanar` for that project; otherwise the
standard pipeline emits pure planar gcode.

#### Acceptance Criteria

- [ ] S2 lines emitted only for profiles whose dialect whitelist includes continuous-Z moves; otherwise pre-flight rejection wins (already S11-002) — double gate, no silent degrade.
- [ ] Postprocessor emits per-machine codes for S2 ramps (e.g. G1 Z ramp with E delta per §3.3); only active in `nonplanar` mode.
- [ ] Independent validator re-checks S2 emitted program (E conservation, slope vs profile budget, envelope in-bounds, dialect whitelist) with a seeded-bug test (validator catches a bogus Z ramp); mode-tagged: `nonplanar` Z-ramps accepted, same code in a `standard` job rejected.
- [ ] E2E: height-field part → S2 generate → validate → postprocess → preview renders curved-top layers; the same part in `standard` mode slices as pure planar (no Z-ramp).
- [ ] **Selector gating**: project `slicing_mode` selector offers `nonplanar` only when the active profile declares continuous-Z + slope budget; otherwise disabled with tooltip reason (no fallback path in code).
- [ ] Health gate green.

### S11-005 — Physical coupon on bundled reference profile (placeholders only) + declared budget

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S11-005                                                                |
| **Title**            | Printed curved-top coupon + measured budget vs declared (envelope walkthrough) |
| **Priority**         | P1                                                                     |
| **Type**             | Process/Gate evidence                                                    |
| **Estimated Effort** | M                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §10 R5 (coupon on `<MACHINE_TYPE>` reference, `poc-output/` gitignored); AGENTS.md (synthetic placeholders only) |
| **Status**           | ⏳ Planned                                                             |

#### Context

The S2 engine earns a physical-coupon gate: print small curved-top coupons on the bundled
reference profile (identity always placeholder `<MACHINE_TYPE>`/`<PRINTER_ID>`/`<FW_VERSION>`
— sanitized; no real machine identity in the repo) and measure layer-height deviation on the
curved section against the **declared** budget (e.g. ± declared-mm on top-surface Z). Budget is
declared pre-print, results recorded as evidence (redacted, JSON-safe).

#### Acceptance Criteria

- [ ] Coupon model + slicing via S2 pipeline; budget numbers declared in `docs/evidence/s2-coupon-budget-*.md` before printing.
- [ ] Print record uses placeholder identity only; gcode/3MF artifacts in `poc-output/` (gitignored); measured deviations recorded in `docs/evidence/` (redacted per redact-evidence-json).
- [ ] Continuous-Z pre-flight passed before the print (mandatory, fail-closed) — log this.
- [ ] Pass/fail vs declared budget documented; R6 (conformal) starts from within-budget S2.
- [ ] Health gate green (script asserts the evidence file parses and contains the declared budget).

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-11): R5 — non-planar S2 (curved top surfaces) gated"

- S11-001: height-field top-surface lift + §3.3 Z/E per segment
- S11-002: per-profile slope budgets + fail-closed pre-flight
- S11-003: swept-envelope collision (tool_envelope, shape-aware)
- S11-004: S2 postprocessor + independent S2 validation
- S11-005: physical coupon on placeholder-only reference profile
```
