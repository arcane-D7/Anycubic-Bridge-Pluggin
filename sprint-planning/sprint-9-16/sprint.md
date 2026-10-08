# Sprint 9.16 — Project Materials, Real Slice Artifacts & Technical Preview

## Sprint Metadata

| Field                 | Value                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Project material authority, real slicing and artifact-backed Preview                                                                |
| **Sprint Goal**       | Bind project intent to validated slice outputs and provide a technically faithful, performant Preview of those artifacts.           |
| **Duration Estimate** | ~5 weeks                                                                                                                            |
| **Priority**          | P0                                                                                                                                  |
| **Sprint Type**       | Feature + Performance                                                                                                               |
| **Primary Owner**     | Editor project, slice engine and Preview                                                                                            |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-04–06/AUD-13; sections 10–12, 19 |
| **Depends On**        | Sprint 9.15                                                                                                                         |
| **Status**            | 🔄 In progress (2/4 delivered)                                                                                                      |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Separate durable project materials from physical spool bindings, execute the selected real slice provider against an immutable current scene snapshot, and publish Preview only for independently validated artifacts. Preserve IR provenance and implement playback from actual segment ordering; estimates, Demo outputs and unsupported capabilities must never imply a real printable result.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Run the focused slice/IR/render/performance suites before the full gate. No upload or print action is authorized.

## Tickets

### S9.16-001 — Project materials and explicit physical bindings

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-001                                                                  |
| **Title**            | Persist project material assignments separately from device spool bindings |
| **Priority**         | P1                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | L                                                                          |
| **Source Finding**   | AUD-04–05; MAT-01–MAT-08                                                   |
| **Status**           | ✅ Delivered (2026-10-08)                                                  |

#### Context

Current slot matching can override an explicit project choice and confuse render appearance with physical availability. Keep stable project material identity/assignment and versioned printer/tool/slot binding separate; presentation mode must not mutate geometry.

#### Acceptance Criteria

- [x] **MAT-01–MAT-02:** Mesh/Slicer presentation differs as intended; Slicer is solid/opaque by default with optional diagnostic edges and no geometry/revision mutation.
- [x] **MAT-03–MAT-05:** Explicit assignment survives mismatched loaded slots; same polymer may bind distinct colors; offline/unassigned/stale state is diagnostic, not arbitrary recoloring.
- [x] **MAT-06–MAT-07:** Printer-store subscriptions refresh appearance; generated planar UVs drive procedural texture; owned geometry/material resources are disposed on replacement/unmount.
- [x] **MAT-08:** Tree, Prepare, Preview and send-preflight share project object assignments and the pure binding diagnostic projection.
- [x] Run focused material/render/resource checks, full gate and sanitizer dry-run successfully.

#### Implementation Notes (S9.16-001)

- Project material identity remains `filamentId`; physical spool binding is a separate optional, versioned `materialBinding` on the durable project object (`printerId`, explicit `toolId`, box/slot indices, snapshot revision). A dedicated `setMaterialBinding` mutation commits and clears it through the existing `set_material` project-authority journal operation without resetting the project assignment.
- Resolver precedence is explicit matching physical binding → exact project preset ID → neutral. Unbound telemetry never recolors; material incompatibility, missing slot, stale snapshot, printer mismatch and offline state return diagnostics while preserving the project color. Explicit unknown material IDs no longer fall through to a generic same-polymer preset.
- Object settings exposes explicit Save/Clear controls from the selected printer snapshot. The object tree, slicer viewport and send approval use `materialBindingDiagnostics`; the existing send readiness policy remains unchanged and does not guess a spool for an unbound object.
- Slicer rendering subscribes to printer snapshot/status, is opaque, adds generated planar UVs for the procedural map, and disposes replaced per-object geometry/materials. No geometry or project revision is changed by presentation mode.
- Focused validation: 27 material/resource/settings/provider tests pass; TypeScript and Prettier pass; both UI E2E suites pass with zero page errors.
- Final `pnpm run check`: exit 0; unit 752/752; integration 11/11; Rust checks pass; build emits `dist/server.mjs` (255608 bytes); smoke 115 tools; both UI E2E suites pass; licenses 59; architecture clean; integrated sanitizer 0 files/groups. Standalone sanitizer also reports 0 files/groups.

### S9.16-002 — Immutable real slice jobs and validated artifacts

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-002                                                                        |
| **Title**            | Slice the captured project snapshot and publish only current validated artifacts |
| **Priority**         | P0                                                                               |
| **Type**             | Feature + Security                                                               |
| **Estimated Effort** | XL                                                                               |
| **Source Finding**   | AUD-06; SLC-01–SLC-08                                                            |
| **Status**           | ✅ Delivered (2026-10-08; Preview-only native artifact provider)                 |

#### Context

The simulated UI stages are not a slice result. A job must capture project revision, targets, evaluated geometry, resolved settings/materials and provider identity, then validate IR/program and freshness before enabling Preview/export/send.

#### Acceptance Criteria

- [x] **SLC-01–SLC-03:** The real Tauri provider captures the durable project revision, visible active-plate stable IDs, evaluated indexed meshes, transforms, machine volume, process settings, material ID, mode, frame, and provider version. Native planar-core sectioning produces actual IR 1.1 and a motion program; independent checks gate a content-addressed artifact before `ready`. Slice passes that IR directly to the strict loader and opens Preview without JSON import. Output is explicitly `preview-only`; send remains unavailable for this provider.
- [x] **SLC-04–SLC-06:** Native cancellation and the final publication gate are serialized; controlled tests prove cancelled or stale jobs do not persist ready records. Each job uses its captured plate ID/target set. App compares artifact source revision with the live project and visibly marks Preview stale after edits.
- [x] **SLC-07–SLC-08:** SHA-256 cache identity binds source revision, sorted stable IDs, full captured objects/transforms, all declared output settings, coordinate frame, slicing mode, machine/profile identity and version, material, and provider version; transient job ID is excluded. Missing artifact cannot satisfy a cache hit. Physical-send is not enabled by this preview-only provider.
- [x] Unsupported supports, nonplanar mode, per-object settings, parent transforms, mixed/unknown material assignments, physical slot binding, unknown object/mesh/transform fields, and non-default unmodeled thermal/fan/speed settings fail preflight with named diagnostics. No slicer fallback or fabricated mass/per-object-volume statistics are used.
- [x] Focused slice, geometry, capture, cache, frame, cancellation, stale-revision and emitted-program tests pass; full `pnpm run check` and standalone sanitizer dry-run pass.

#### Implementation Notes (S9.16-002)

- `crates/planar-core/src/slice.rs` sections actual triangle meshes at each layer, welds and validates closed contour graphs, classifies nested rings/holes, offsets polygon regions, and clips grid/gyroid paths against those regions. Invalid/open/non-manifold sections fail closed. Regression meshes cover an L-shaped prism, a hollow prism, and two disjoint prisms; their infill cannot enter the missing quadrant, cavity, or gap.
- The Tauri `slice_job_run` command reads the authoritative project snapshot and artifact-backed evaluated geometry, pins revision/plate/target IDs and resolved inputs, evaluates object transforms, then applies the shared editor-world → slice-IR basis exactly once. Work runs without holding the project mutex. Before publication it locks against cancellation, re-reads the current project revision, independently validates IR fields/bounds/extrusion conservation and emitted command/coordinate/extrusion constraints, then persists the artifact and ready job in the project artifact store.
- The UI Slice action calls this job for the real Tauri provider and sends the returned IR directly to Preview. Native progress is indeterminate rather than simulated; cancel reaches the native job. Demo retains its isolated mock estimate, labeled “Demo estimate only” and never treated as a validated artifact. Preview artifacts are visibly marked preview-only and stale after project edits. Print approval UI is not mounted for the real provider.
- Native slice statistics include measured path volume and estimated path time only; unavailable material mass is `null` and rendered unavailable. No physical printer, upload, heat, or print command is invoked.
- Focused evidence: `tests/slice-job.test.mjs` 3/3; `cargo test -p planar-core` 37/37; Tauri `slice_job_tests` 8/8, including controlled SQLite authority → blob hydration → concave native slice → IR/program/artifact, unknown-modifier rejection, cache identity, frame conversion, stale revision, and cancellation. Full gate and sanitizer status recorded after completion below.

### S9.16-003 — IR fidelity, preview mapping and declared units

| Field                | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-003                                                                   |
| **Title**            | Preserve artifact attributes and map paths/metadata faithfully into Preview |
| **Priority**         | P1                                                                          |
| **Type**             | Feature + Test                                                              |
| **Estimated Effort** | L                                                                           |
| **Source Finding**   | AUD-04/AUD-06; PRV-01–PRV-04, PRV-06–PRV-07, PRV-09                         |
| **Status**           | ✅ Delivered (2026-10-08)                                                   |

#### Context

The parser and renderer must preserve supported engine facts and artifact placement rather than substituting zeros, generic path classes or current-scene transforms. Validate schema/version, bounds and references before render.

#### Acceptance Criteria

- [x] **PRV-01–PRV-04:** Supported segment identity, flow/E/bead/speed/cooling/temperature/dimensions and provenance survive strict parsing/model projection; known path kinds retain distinct classes; noncontiguous layer IDs are preserved. Native execution order is explicit and deterministic. G-code-line/object/part/tool/material attribution remains nullable because the native backend merges captured objects and emits no instruction-line mapping; it is not invented.
- [x] **PRV-06–PRV-07:** `slice-ir` millimetres and Z-up are retained; native captured source revision and stable target IDs are attached to the IR document. Object placement is explicitly null because transforms are baked into the combined slice coordinates. Unsupported numeric attributes remain unavailable, never zero-filled.
- [x] **PRV-09:** Native Preview consumes the returned immutable artifact IR, labels job/source revision and preview-only status, and centers the baked coordinates without reading current-scene transforms.
- [x] Invalid, oversized, duplicate-ID/order and mismatched target-reference inputs fail with `IrDocumentError` structured code/path diagnostics.
- [x] Focused parser/model and Tauri artifact checks, full gate and standalone sanitizer dry-run pass.

#### Implementation Notes (S9.16-003)

- `bridge/ir.ts` remains IR 1.1 compatible and now explicitly validates/preserves optional supported native fields, document job/source/targets/placement, full supported path-kind vocabulary, execution order, nullable values, bounds and references. Unknown optional properties remain ignored only when they are outside the supported contract; supported values are never silently stripped. Structured failures expose `code` (`IR_INVALID`, `IR_LIMIT`, `IR_REFERENCE`) and `path` while preserving the existing human-readable Error message.
- `preview-model.ts` carries layer IDs, artifact identity, placement availability, path category, segment IDs/order and nullable manufacturing measurements. It no longer fabricates coordinates/layer zero. Renderer batches each path kind and gives BRIM/SKIRT/prime/purge, supports and auxiliary paths their own visual classes instead of rendering them as travel.
- Native artifact IR now carries the exact job ID, captured source revision, stable sorted target IDs, sequential execution order, actual layer/line-width values, and existing generator provenance. The current backend merges objects before slicing, so per-segment object/part/tool/material and G-code line references are not provided; those values remain absent/unavailable. Captured placement is null because transforms are baked into the slice-IR coordinates.
- Focused evidence: Preview/parser 14/14; Tauri `slice_job_tests` 9/9, including SQLite/CAS artifact round-trip and the provenance/order/dimensions assertions. No physical hardware path was invoked.
- Final `pnpm run check`: exit 0; unit 758/758, integration 11/11, Rust workspace + Tauri shell pass, build emits `dist/server.mjs` (255608 bytes), smoke 115 tools, both UI E2Es pass, licenses 59, architecture clean, integrated sanitizer 0 files/groups. Standalone `node scripts/sanitize-repo.mjs --dry-run`: 0 files/groups.

### S9.16-004 — Artifact playback, filters and performance budgets

| Field                | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| **Ticket ID**        | S9.16-004                                                                 |
| **Title**            | Implement ordered artifact playback and measured Preview resource budgets |
| **Priority**         | P1                                                                        |
| **Type**             | Feature + Performance                                                     |
| **Estimated Effort** | L                                                                         |
| **Source Finding**   | AUD-06; PRV-05, PRV-08, PRV-10; audit section 12.3–12.4                   |
| **Status**           | ⏳ Planned                                                                |

#### Context

Playback must track actual execution order and segment IDs without reparsing the full artifact on every pointer move. Establish representative corpus budgets before tuning and release GPU/buffer resources when artifacts change.

#### Acceptance Criteria

- [ ] **PRV-05:** Play/pause/step/scrub tracks known artifact segments and their instruction mapping.
- [ ] **PRV-08:** Single-layer and cumulative filters affect visualization only, not slice output.
- [ ] **PRV-10:** Representative corpus meets documented load/scrub/memory budgets with repeatable measurements.
- [ ] Old artifact preparation is cancelled and removed GPU resources are released.
- [ ] Run focused playback/performance checks, full gate and sanitizer dry-run successfully.

## Sprint Commit

Each ticket commit uses `feat(s9.16-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and applicable artifact checks pass; no push.
