# Custom Slicer / Editor Investigation — Rev 2.0

**Version 2.0.0** · 2026-09-28 · supersedes 2026-09-27 v1.0 — **architecture re-scoped:**
Blender is the _required_ primary modeling backend (not an optional worker); the product is an
_own_ React/Tauri editor that replaces the legacy editor entirely with _no_ legacy fallback;
_own_ non-planar engine (planar comparison is a validation baseline, not the product goal);
detailed versioned machine capability contract; continuous learning with deterministic safety
limits; isolated BYOK tool harness; separate auth service (not just a separate file).

Status: architecture investigation completed; **no implementation** — the legacy editor is
_designated_ for retirement but is not deleted in this doc; runtime deletion belongs to the
implementation roadmap (R0), not this investigation.

---

## 🔒 LICENSE POLICY (user-confirmed 2026-09-28 — binding for all sprints)

**[SPEC]**

- **Direct use / implementation: Apache-2.0 and MIT only.**
- **All other licenses (GPL, AGPL, BSD-3, LGPL, MPL, …) = reference of information,
  comparison and code examples only.** They may be studied, cited and compared, and their
  algorithms re-implemented as **clean implementations from published knowledge**, but their
  code is **never copied, imported, linked or bundled into this product** — this avoids
  importing their license obligations.
- **External-process dependencies are allowed only as user-installed / discovered
  prerequisites** (e.g. Blender, GPL) or as clearly separate vendor tooling (e.g. Anycubic
  Slicer Next CLI for validation). They are **never bundled or statically linked** into our
  artifacts, and the pinned version + legal notices travel with any documentation.
- Every dependency added in any sprint must be **license-checked** by a CI gate
  (`scripts/check-licenses.mjs`, added in Sprint 5) that fails if a non-Apache/MIT dependency
  enters the dependency graph on a direct-use path.
- This policy **overrides** any earlier "adapt/port from X" wording in this document: anything
  previously marked "source-adaptation of a permissive reference is a valid fallback" applies
  **only** to Apache-2.0/MIT references. All GPL/AGPL/BSD-3 references are study-only.

---

## AI READING INSTRUCTION

Read `[SPEC]` and `[BUG]` blocks for authoritative facts. Read `[NOTE]` only if additional
context is needed. `[?]` blocks are unverified — treat with lower confidence. All
machine-specific values use AGENTS.md §3 placeholders (`<MACHINE_TYPE>`, `<PRINTER_ID>`,
`<FW_VERSION>`, `<LAN_IP>`, `<DEVICE_KEY>`); all JSON examples below use **synthetic** values
(`0`, `""`, `127.0.0.1`, `"redacted"`) — never real IDs or LAN IPs. Design proposals are
labeled _design proposal_; factual external claims are cited inline in §11.

**[NOTE]** Supersession map — v1 decisions explicitly reversed by this revision (see §13 for the
full `[BUG]` log):
| v1 claim (2026-09-27) | v2 decision (2026-09-28) |
|---|---|
| Blender is an _optional_ process-isolated worker (v1 §1.2, §4.2) | Blender is the _required_ geometry authority and primary modeling backend (v2 §4) |
| App must work identically _without_ Blender installed (v1 §4.2) | Blender install (pinned, version-pinned) is a hard prerequisite (v2 §4.3) |
| Slicer planar: _embed_ Kiri:Moto (MIT) or libSlic3r (v1 §3.2 N0, §8) | Own planar→nonplanar engine; Kiri:Moto/libSlic3r are **references only**; planar output is a _validation baseline_, not the product goal (v2 §3) |
| Kobra S1 as the de-facto product/hardware default (v1 §1, §9 R5, §10.4) | Machine capability contract is the source of truth; any specific printer is a _profile_ (one bundled reference profile, placeholders only) that **fails closed** when unsupported (v2 §5) |
| Separate auth = separate SQLite _file_; separate _process_ dismissed as over-engineering (v1 §6.1, §10.3) | Auth is a separate **service** with its own process/container _and_ its own store (local `auth.db` or Postgres); editor core has **no** auth dependency (v2 §6) |
| T2 "chroot-equivalent scratch dir" sandboxing (v1 §5.2) | Process separation is fault containment **only**, never security isolation; generated tools run in WASI capability sandboxes or VMs (v2 §7) |
| "AGPL contaminates" (v1 §8, §10.1) | Removed. AGPL is a copyleft _license_, not a contamination mechanism; license diligence per §3.4, no clean-room legal claims (v2 §13) |

---

## 1. Executive Summary

The current repository is **not** a desktop editor — it is a mature Node/MCP control plane over
Anycubic Slicer Next, a cloud/LAN printer stack, and an in-memory CAD workspace with a Three.js
UI. The product is a **new application** that **completely replaces** the legacy editor (its UI
and its geometric authoring execution) while **preserving, independently**, every printer-control,
cloud, and MCP contract the repo already serves: `vendor/server.mjs` MCP surface, `scripts/slicer-*`
and `scripts/printer-*` adapters, `scripts/anycubic-cloud.mjs`, `presets/catalog.json`,
`schemas/*`.

Five conclusions drive the architecture:

1. **The legacy editor is retired, with a migration path and no fallback.**
   The in-repo `ui/cad.html` single-file Three.js CAD app and its in-memory "CAD workspace
   REST/SSE" execution path (the scene singleton in `vendor/server.mjs handleApi`) are **retired
   as the product editor**. Retirement/migration/backward-compat strategy (v2, _design_ decision):
   - _Retire:_ the `ui/cad.html` scene editor as a product surface; its scene singleton remains
     only as a **read-only** bridge during migration (R0) so existing MCP clients keep working.
   - _Migrate:_ scene data exported as versioned project files (3MF + a project JSON sidecar with
     stable object IDs) so nothing user-created is lost; legacy projects imported on open.
   - _Backward compat:_ the **MCP tool names/schemas** are the compatibility surface and are
     preserved as-is; the retired editor's _REST/SSE scene API_ is frozen, not extended, and
     deprecated with a deprecation header; **no runtime legacy fallback** — once a surface is
     cut over, the old path is removed, never shadowed by the new one.
2. **Blender is the required primary modeling backend and the geometry authority (design).**
   The new app drives a pinned, headless Blender (bpy) server over a command contract for all
   modeling operations; Blender's evaluated scene is the single source of truth for geometry.
   Our **own React/Tauri UI** re-implements the Blender _workflow_ — the target is exact
   modeling workflow, shortcuts and semantics (objects; edit-mode vertices/edges/faces; G/R/S
   with constraints, numeric entry, pivot, snap, proportional; extrude/inset/bevel/loop cut/
   knife; merge/dissolve/normals; mirror/array/subdivision/solidify/boolean; geometry nodes;
   sculpt), not a promise. One Blender process per active scene; bpy is a server the UI drives,
   not a disposable worker. Blender licensing (GPL) applies and must be honored — required
   notices/source stay with redistribution; this is a **legal packaging decision gate** before
   first public distribution (v2 §4). No claim is made that Blender natively ingests STEP/IGES
   at CAD fidelity: Blender's own BRep/STEP path is OCCT-based and partial — OCCT (replicad /
   OpenCascade.js) is a **separate, optional CAD-conversion** tier, not a replacement modeling
   kernel and not a Blender feature (v2 §4.4, §13 `[BUG] STEP`).
3. **The slicer is ours — a genuinely non-planar engine, not a planar wrapper (design).**
   The planar comparator (e.g. PrusaSlicer / Anycubic Slicer Next output) is a **validation
   baseline only**. Multiple strategies are pursued: topology-conformal layering, volumetric
   deformation/field approaches, and indexed and continuous multi-axis deposition on new
   hardware — no claim that any single hardware class is "always wrong" for any approach, and
   no blanket assertion that any planar E value is always wrong (the extrusion correction is
   derived, §3.3, with stated limitations). Pipeline: field → paths → bead/flow (volumetric
   mode / filament-length conversion / local bead geometry each tracked separately, §3.3) →
   kinematic/time planning → **continuous collision** on deposited material, toolhead, bed and
   fixtures → per-machine postprocessor → **independent emitted-program validation** → approved
   dispatch (v2 §3). Machine capability per §5 — fail closed when unsupported.
4. **Learning is continuous, bounded, and never touches safety (design).**
   Every job is an immutable record (inputs, hashes, revisions, machine/material/environment,
   telemetry, timestamps, labels, uncertainty); sensor and human evidence are kept distinct;
   _retrieval_ (similar past jobs), _parameter optimization_ (bounded deltas) and _model
   training_ are three different mechanisms with different gates. Deterministic collision
   limits are **never** self-modifiable; sensor latency and emergency-stop paths are independent
   of any learning path (v2 §3.5).
5. **Isolation is capability-based, and auth is a separable service (design).**
   Process separation is fault containment, not a sandbox. Model-generated tools run WASI
   (capability imports, Wasmtime) only for _compatible_ tools — **not** bpy (native Blender runs
   as a trusted, pinned, untrusted-input-kept-out worker; cwd plus child process is **not** a
   sandbox). Untrusted native Python/Blender scripts require VM or real OS-level isolation.
   Auth is an explicitly separate **service** (own process/container, loopback API) with its own
   backing store (local `auth.db` or an independent service/Postgres) — not silently "a separate
   file"; OAuth for external identity uses external-browser + PKCE; the auth tenant is **not** a
   printer credential (v2 §6, §7).

---

## 2. What We Already Have (Verified Repository Audit)

**[SPEC]**
Scope boundary (design decision, revision 2026-09-28):

- **Preserve, independently**: `vendor/server.mjs` MCP surface (tool names/schemas are the
  compatibility contract), `scripts/slicer-*`, `scripts/printer-*`, `scripts/anycubic-cloud.mjs`,
  `scripts/auth-login.mjs` (cloud-token path — distinct from the new local auth service, §6),
  `presets/catalog.json`, `schemas/*`, `tests/`.
- **Retire as product editor**: the `ui/cad.html` single-file Three.js scene editor and the
  in-memory "CAD workspace REST/SSE" scene singleton in `vendor/server.mjs` _as the authoring
  surface_. The scene singleton stays **read-only** during migration (R0) so existing MCP clients
  keep working; it is frozen, deprecated with a header, and removed after cutover — **no legacy
  runtime fallback** (strategy in §1.1).

### 2.1 Reusable foundations

| Capability                                                   | Location                                                                           | Notes                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parametric solids (box/cylinder/sphere/cone/extrude/boolean) | `scripts/cad-parametric-engine.mjs`                                                | manifold-3d, manifoldCAD entry                                                                                                                                                                                                                                          |
| Mesh CSG                                                     | `scripts/cad-csg-engine.mjs`                                                       | three-bvh-csg, requires `uv` attribute                                                                                                                                                                                                                                  |
| STEP export (DEGRADED)                                       | `scripts/cad-step-export.mjs`                                                      | **[BUG] STEP bbox** — builds a bbox-cuboid, and replicad OCCT WASM throws on Node 24 → always falls back to STL; not a real mesh→STEP path. See §13.                                                                                                                    |
| Arrange / plate packing                                      | `scripts/cad-arrange.mjs`, `cad-arrange-utils.mjs`                                 | pure functions, tested                                                                                                                                                                                                                                                  |
| 3MF read/import                                              | `scripts/read-3mf.mjs`, `import-3mf-mesh.mjs`                                      | custom zip + XML parse, validated on real projects                                                                                                                                                                                                                      |
| Slicer CLI adapter                                           | `scripts/slicer-cli.mjs`                                                           | discover/preset/args/run/collect/compat-validate                                                                                                                                                                                                                        |
| Slicer GUI adapter                                           | `scripts/slice-via-app.mjs`                                                        | UIA allowlisted actions                                                                                                                                                                                                                                                 |
| Agentic slicer control                                       | `scripts/slicer-tools.mjs`, `slicer-live-settings.mjs`, `slicer-operation-log.mjs` | live snapshot/rollback, preflight, plan, history, capability catalog                                                                                                                                                                                                    |
| MCP surface                                                  | `vendor/server.mjs`, `schemas/tools.json`, `schemas/openapi.json`                  | ~100 tools, confirmation-gated writes **[?] exact count re-verify at R0** (v1 said "~100"; reconcile via `node scripts/smoke.mjs`)                                                                                                                                      |
| Headless Blender PoC (discovery + MSIX alias)                | `tools/render-headless.mjs`, `tools/HEADLESS-RENDER.md`                            | validated with `BLENDER_VERSION` MSIX; the repo evidence scopes the stdout limitation to the **MSIX launcher alias** path (not a universal Blender claim) — framed stdio/IPC with a binary-artifact channel is the working contract; JSON-over-file is the PoC fallback |
| Auth/credentials (cloud token)                               | `scripts/auth-login.mjs`, `token-crypt.ps1`                                        | DPAPI Windows, cloud token storage — **not** the new local auth service (§6)                                                                                                                                                                                            |
| LLM translation                                              | `scripts/cad-ai-translator.mjs`                                                    | BYOK (CAD_AI_API_KEY/BASE_URL/MODEL), OpenAI-compatible                                                                                                                                                                                                                 |

### 2.2 Known gaps for the target product

- No React/TypeScript editor; `ui/cad.html` is a single-file Three.js app, **designated for
  retirement** (§2 scope boundary).
- No Tauri project; existing ADRs (`docs/adr-electron-shell.md`) chose Electron for the _bridge_,
  which remains valid there — Tauri is for the _new_ editor app, not a rewrite of the bridge.
- No durable project model: in-memory singleton scene, no snapshots, no autosave, no undo graph,
  no stable object IDs, no versioned schema.
- No printer-profile-driven capability model in the CAD UI (a hardcoded 220x220 build volume in
  the legacy `ui/cad.html`). The new app replaces this with the machine capability contract (§5);
  the hardcoded value is cited here only as the defect that motivates it, and is not a product
  assumption.
- No Blender-as-primary-backend wiring; only the PoC headless render path exists
  (`tools/HEADLESS-RENDER.md`).
- Sandbox is lexical, not process/WASI isolation.
- No separate auth **service**; token storage is Windows-DPAPI only (new design in §6).
- No global memory system; no chat/conversation persistence.
- No non-planar capability at all (own engine in §3).
- `package.json` still references `src/index.ts` which does not exist (doc/runtime drift) **[?] re-verify at R0** — if a later commit fixed it, delete this line.

---

## 3. Own Non-Planar Engine — Strategies, Pipeline, Learning

**[SPEC]**
Re-scoping (revision 2026-09-28): the product goal is a **own non-planar deposition engine** —
not a planar slicer with a curved-skin wrapper. The planar comparator (PrusaSlicer / Anycubic
Slicer Next output via the existing CLI adapter) is kept **only as a validation baseline**:
every emitted program is checked against planar reference behavior where the geometry is planar,
and divergence is measured, not assumed. v1's "embed Kiri:Moto (MIT) / libSlic3r" plan is
**superseded** as the _embed-as-primary_ path (see §12): the Kiri:Moto _engine's_ distribution/
embedding terms are **unconfirmed** (the client app is MIT; the engine is a separate artifact —
§3.4, §11-3, §12), so it is **not assumed MIT-embeddable** here; libSlic3r is AGPL-3.0. Both are
**references/study material** for the own engine, not embedded dependencies — and **source-level
adaptation of a permissively-licensed reference is a valid fallback** when an _embed_ is not
possible under its terms, per the own-engine objective (§3.4, §11-3, matrix row). Integration
against the grid-apps engine has **not been tested** in this revision — it is a candidate/
reference only.

### 3.0a Slicing modes — Standard (planar) AND Non-planar, both first-class (user-confirmed 2026-09-28)

**[SPEC]** The slicer ships with **two mutually-exclusive slicing modes**, selectable **per
project**; the **standard (planar) mode is the default** and is always available; the
**non-planar mode is an opt-in experimental mode** offered only when the active machine
profile declares the required capabilities. Both modes are implemented by **one engine /
one IR / one validator** (runtime feature flag — not separate binaries; validated by the
Consultor against Bambu/Cura/Prusa practice, 2026-09-28).

- **Standard mode (planar, default).** Complete product-grade pipeline: slice (planar) → IR →
  postprocess → independent validation → preview. This is the R2 planar core + S1 parity
  baseline; it is **not** a research stub and never requires non-planar capabilities. Users
  who disable non-planar get a fully standard slicing model.
- **Non-planar mode (experimental, opt-in).** More capable, less trusted: curved-top (S2),
  conformal (S3), later multi-axis (S4). Selectable **per project only when the active
  machine profile declares the required capabilities** (e.g. `continuous_z.supported`,
  slope budget, joint/kinematic model per §5); otherwise the selector is **disabled with a
  named reason** — never a silent fallback to standard.
- **Mode lifecycle rules (enforced by the pipeline, §3.7):**
  1. `slicing_mode` is a persisted, typed, **per-project** field (`standard` | `nonplanar`),
     default `standard`; explicit project-level UI toggle in the print-settings panel (mirrors
     Cura/Bambu/Prusa per-project config, not a global app setting).
  2. The mode is written into the **job record** (input hash, §3.5) and into **every IR
     segment's provenance** (§3.6). Z-ramp / non-planar segments are tagged
     `mode: nonplanar` at segment level; the layer preview consumes the flag so continuous-Z
     is never rendered as a layer change (Prusa/Bambu pitfall).
  3. The **independent emitted-program validator is mode-aware**: it rejects any segment
     inconsistent with the selected mode (a Z-ramp inside a `standard` job; a layer-jump
     inside a `nonplanar` job) with a named reason + segment id (consultor AC-3).
  4. **Slice-cache key includes the mode**: switching modes invalidates the cache and forces
     a re-slice with explicit UI confirmation — no stale-mode gcode leak (consultor AC-4).
  5. Non-planar **Z/flow generation lives in a dedicated stage applied after extrusion
     math** (same E/Z accounting code path as planar, with a per-mode tolerance) — isolated
     like Prusa's SpiralVase postprocessor, never mixed mid-pipeline (consultor AC-6).
  6. Both modes short-circuit identically through the **safety box** (§3.5): non-planar
     proposals outside the box are rejected; standard mode also passes the same validation.
- **Capability gating (non-planar mode):** same rule as every §5 feature — a profile lacking
  `continuous_z.supported` (or slope budget / joint model as required by the S2/S3/S4 feature)
  has the non-planar selector **disabled with the named missing capability**, and a pre-flight
  with non-planar mode on that profile is **rejected**, not silently degraded (consultor AC-2
  → aligns with §5.3 fail-closed).
- _Acceptance (from consultor, paste-ready):_ AC-1 persisted per-project enum default
  `standard`, no global setting; AC-2 selector enabled iff profile declares capabilities, else
  disabled with reason, no silent fallback path in code; AC-3 validator rejects mode-inconsistent
  segments; AC-4 cache key includes mode with forced re-slice on switch; AC-5 preview consumes
  mode metadata; AC-6 Z-ramp generation isolated post-extrusion with one shared E/Z path.

### 3.1 Strategies (multiple pursued, not all-or-nothing)

1. **Topology-conformal layering.** Layer surfaces follow the part's topology rather than
   global Z. Research substrate: CurviSlicer (deform→slice→inverse-map; published algorithm,
   AGPL implementation — algorithm study only), Zip-o-mat/Hamburg top-surface line (unmaintained
   reference). _Claim limit_: conformal quality on 3-axis hardware is research-grade today; no
   hardware class is asserted "always wrong" — capability depends on the machine profile (§5):
   continuous-Z interpolation, max tilt/slope, collision budget.
2. **Volumetric deformation / field approaches.** Represent fields (height, slope, flow, cooling)
   on the volume and derive paths from them instead of planar layer planes. Reuse research
   algorithms and tooling where licenses permit (see §3.4 license diligence) — this is the
   substrate for continuous multi-axis work.
3. **Indexed and continuous multi-axis.** Rotary (A/B/C) and robotic kinematics as first-class
   targets of the _same_ engine, driven by the machine capability contract's joint/kinematic
   model (LinuxCNC 5-axis kinematics conventions as a reference for topology-specific
   transforms, pivot offsets and tool-length compensation — cited §11), not a separate slicer.

### 3.2 Landscape verdicts (maintained from v1, 2026-09-27 — **historical, unverified since**)

**[?]** All maintenance states below were checked on 2026-09-27 against external GitHub state at
that time. They are **historical** here and must be re-verified (record last release / head
commit + check date) before any decision relies on them — a star count or a "3 weeks" claim
stale by 30 days is not evidence. No "latest version as of today" is asserted in this document.

| Project                               | Maintenance (as of 2026-09-27, unverified since) | License                                                                                                                                                                                                        | Production-ready          | Works on stock 3-axis printer                                     |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| S3-Slicer (`zhangty019/S3_DeformFDM`) | dormant, 1 contributor                           | BSD-3                                                                                                                                                                                                          | No                        | No (multi-axis/robot only)                                        |
| CurviSlicer (`mfx-inria/curvislicer`) | low, ~1 yr                                       | AGPL-3.0                                                                                                                                                                                                       | No ("research prototype") | **Yes** — 3-axis, best on deltas, needs ~45° nozzle cone          |
| Zip-o-mat Slic3r nonplanar            | dead, 3 yrs                                      | AGPL-3.0                                                                                                                                                                                                       | No                        | **Yes** — top-surface only                                        |
| → teachingtechYT PrusaSlicer 2.6 port | alpha, 2 yrs                                     | AGPL-3.0                                                                                                                                                                                                       | No                        | **Yes** — top-surface only                                        |
| RotBot Transform / ZHAW               | dead / partial                                   | GPL-3.0                                                                                                                                                                                                        | No                        | **Yes** — conical transform, any printer, small tilt angles       |
| NeuralSlicer                          | dormant, 2 yrs                                   | GPL-3.0                                                                                                                                                                                                        | No                        | No (needs S3 + CUDA)                                              |
| Open5x                                | dormant, 2 yrs                                   | MIT                                                                                                                                                                                                            | No                        | No (adds 2 rotary axes)                                           |
| FullControl                           | **active** (3 weeks)                             | GPL-3.0                                                                                                                                                                                                        | Yes (scripted toolpaths)  | **Yes** — native non-planar by construction, but you author paths |
| COMPAS slicer                         | **active** (6 mo)                                | MIT                                                                                                                                                                                                            | Research/AEC-grade        | **Partial** — curved layers + G-code, no collision system         |
| S4_Slicer                             | low, 1 yr                                        | GPL-3.0                                                                                                                                                                                                        | No                        | Not directly (4-axis Core R-Theta)                                |
| Kiri:Moto (grid-apps)                 | **active** (v4.7.3)                              | client MIT / engine distribution terms — **[BUG] Kiri license** v1 stated embeddable MIT for the engine; engine distribution/embedding terms are **unconfirmed** (not assumed MIT-embeddable). Reference only. |

**[?]** The two load-bearing rows for the N1/N2 path — **FullControl** (if it stalls, the
"scripted toolpath" reference path goes away) and **COMPAS slicer** (load-bearing for
"curved layers + G-code, no collision") — must be re-verified before the N1/N2 spikes start.

### 3.3 Extrusion and flow — volume-conservation derivation with limitations

**[SPEC]**
Units: lengths `L`, `s` in **mm**; areas `A_bead`, `A_filament` in **mm²**; volume `V` in
**mm³**; volumetric feed rate `Q` in **mm³/s**; filament feed `ΔE` in **mm** (filament-length
mode, filament speed in **mm/s**), unless stated otherwise.

The deposited volume of a bead path with local cross-sectional area `A_bead(s)` along arc
length `0 … L` is, by volume conservation,

    V = ∫₀ᴸ A_bead(s) ds   (mm³).

For a segment with **constant** bead cross-section this reduces to the closed form

    V = A_bead · L   (mm³).

- **Extrusion (filament-length mode only).** Filament area, from the calibrated filament
  diameter `d_filament` (mm):

      A_filament = π · d_filament² / 4   (mm²),

  and the filament length to feed for deposited volume `V`:

      ΔE = V / A_filament = 4·V / (π · d_filament²)   (mm).

  **Volumetric (E-by-mm³) mode and filament-length mode are distinct calibration targets** —
  each is calibrated per machine, never derived from the other. No single closed-form
  "extrusion `e`" is asserted across modes.

- **Steady volumetric flow.** Under the same steady-state assumptions (constant local section),
  the volumetric feed rate is

      Q = A_bead · v   (mm³/s; `v` in mm/s).

**[NOTE]** No `h/cos θ` (slope-depth chord) model is used in this revision: v1's
`V = A_bead · (h / cos θ)` was exact only for a special constant-thickness horizontal-slice
geometry and is **not** a general extrusion law — removed, not generalized.

Limitations (stated, not blanket):

- The integral `V = ∫₀ᴸ A_bead(s) ds` is exact by volume conservation; the closed forms
  (`V = A_bead·L`, `Q = A_bead·v`) hold only for constant section and steady state. For
  variable-thickness conformal layers `A_bead(s)` is a **design input**, not a closed form.
- **No predictive-deposition guarantee**: the local bead section `A_bead(s)` and any
  calibration are machine/material/geometry-dependent — line spacing, nozzle orientation,
  material behavior, flow dynamics — so they do **not** guarantee predicted deposited geometry.
  Where the deposition profile is within tolerance of planar, the planar value applies and the
  correction may be skipped (tolerance is a machine-profile parameter) — **not** a claim that
  _any_ planar E value is _always_ wrong on _any_ slope.
- Flow (`Q = A_bead · v` at steady state) and the extrusion conversion are **machine-
  calibrated** terms — they vary with temperature, pressure advance/response and line width — so
  they are deployment parameters, not closed-form constants. The deposition-physics terms (Z
  dynamics, pressure response, cooling at variable height) dominate real quality — dimensional
  results degrade before visual ones do (v1 §3.3 hard constraint, retained).

### 3.4 License diligence for reused research (no "contamination" claims)

**[SPEC]**

- License _incompatibility_ is a build/distribution fact, not a "contamination" fact; this
  revision removes v1's "AGPL contaminates" wording (§13 `[BUG] AGPL wording`). The correct
  question for each reused algorithm/tool is: (a) which artifact is reused (code, algorithm,
  tool); (b) its license terms for that artifact; (c) whether our distribution form (source,
  binary, network service, separate process) triggers obligations.
- Concrete consequences: **libSlic3r = AGPL-3.0** (network use of a modified slicer in a
  distributed product can trigger §13 — decide per artifact, not per repo). **Kiri:Moto engine**
  distribution/embedding terms are **unconfirmed** — not assumed MIT-embeddable as v1 stated
  (the client app is MIT; the engine is a separate artifact; §11-3, §12). **A source-level
  adaptation of a permissively-licensed reference is a valid fallback** to reach parity when an
  _embed_ is not possible under its terms — **bounded by §🔒 LICENSE POLICY to Apache-2.0/MIT
  references only**. **FullControl = GPL-3.0** (reference/inspiration only for a separate
  engine; GPL code may not be linked into our engine). **CurviSlicer = AGPL-3.0** — the
  _algorithm_ is published in its paper; re-implementing an algorithm from a paper is a different
  legal posture from copying its code, but that determination is **legal work, not this
  document's** — this doc makes no clean-room or "no contamination" legal claims.
- Goose (`block/goose`) license: **[?] not guessed in this revision** — v1 marked it "MIT?";
  verify the actual license text before any reuse decision.

### 3.5 Continuous learning from failures — bounded, journaled, never safety-touching (design)

**[SPEC]**

- **Immutable job record.** Every slice→print job is an append-only record: input hashes
  (mesh, profile, material, environment), schema + content revisions, machine/material/telemetry
  values with sources, timestamps, outcome labels, and explicit **uncertainty** fields. The
  `source = sensor | human` provenance is recorded per evidence item — human labels never
  silently overwrite sensor data and vice versa; conflicts are stored, not resolved in place.
- **Three distinct mechanisms, three gate levels:** (1) _retrieval_ — "find similar past jobs" —
  read-only, lowest gate; (2) _parameter optimization_ — bounded numeric deltas to profile
  parameters, must pass offline validation and fit inside the deterministic safety box; (3) _
  model training_ — separate dataset, separate review, separate promotion path.
- **Offline validation**: holdout sets are partitioned **by machine and by material** (never
  time-shuffled across the same unit, to avoid leakage); shadow mode first (learned
  parameters logged but not applied), then **bounded experiments** (explicitly scoped, capped
  duration/parameter range, user-approved), then promotion; rollback restores the
  last-known-good parameter set atomically with a journal entry.
- **Never self-modified**: the deterministic collision limits, swept-volume budgets, hard
  clearances and endstop limits are profile-owned and human-approved. The learner provably
  cannot propose changes outside the safety box — the clamp is in the _validator_, not the
  learner. A proposal that fails validation is journaled as a reject and reverted.
- **Independence from safety paths**: sensor latency handling and the emergency-stop path are
  implemented **outside** and independent of any learned pipeline — no learned component sits
  in the E-stop chain, by construction.
- **[?] Jev** — v1/requirements name "Jev" as unidentified; this document does **not** invent an
  integration. Generic adapter placeholder only: an external learning-service adapter whose
  identity, contract and license are unknown; no code or API claim is made about it.

### 3.6 Hard constraints regardless of stage (retained from v1 §3.3)

- Extrusion must be recomputed from real 3D path length and local bead cross-section — see the
  corrected derivation and its limitations in §3.3.
- Collision checking must be **swept-volume** and **continuous** — against deposited material,
  toolhead (full swept envelope, not just the nozzle cone), bed and fixtures — not point checks.
- Deposition physics (Z dynamics, pressure response, cooling at variable height) dominates
  quality on curved layers; dimensional results degrade before visual results do.
- Every generated path needs a deterministic, reproducible intermediate representation before
  machine postprocessing (position, tool orientation, deposition params, frames, provenance);
  the emitted program is then checked by an **independent validation pass** (a validator that
  does not share the generator's code path) before approved dispatch.

### 3.7 Pipeline (design)

```
field (height/slope/flow fields)
  → paths (deposition curves on the field)
  → bead/flow (local cross-section, flow, cooling per segment)
  → kinematic/time planning (per-machine FK → joint targets + timing,
      LinuxCNC-5-axis kinematics conventions as reference)
  → continuous collision (deposited material + toolhead swept envelope + bed + fixtures)
  → per-machine postprocessor (controller dialect, G-code subset per capability contract §5)
  → independent emitted-program validation (separate validator; planar baseline where applicable)
  → approved dispatch (broker approval, journaled)
```

### 3.8 Staged spikes (testable, not generic "phases")

- **S1 — planar parity baseline.** Own planar core (thin: layer + walls + infill for baseline
  parts) must match Anycubic Slicer Next reference output within a declared measurement budget
  (proposed, not measured: e.g. per-layer wall count, infill volume, bounding box — each spike
  sets an explicit number before running). _Acceptance_: measured deltas on a fixed 3-part corpus.
- **S2 — top-surface curved finishing (N1).** Height-field lifting over a planar base, slope-
  rejection per machine profile, per-segment Z/E from §3.3, nozzle-cone + swept-envelope
  collision. _Acceptance_: physical coupon on the bundled reference profile `<MACHINE_TYPE>`
  (continuous-Z firmware required; fail closed otherwise, §5).
- **S3 — conformal curved layers (N2).** Deform/inverse-map or field-based; solver integration
  (OSQP in Rust); variable-thickness validation. _Acceptance_: tolerance vs. planar-baseline
  deviation on the S1 corpus extended with 2 curved parts; labeled art/decorative-only until
  structural results are measured.
- **S4 — multi-axis.** Continuous multi-axis deposition on new hardware per §5 joint model;
  references: S3-Slicer (BSD-3), Open5x (MIT), S4 (GPL-3.0, study), FullControl (GPL-3.0,
  inspiration). _Acceptance_: defined at spike time against a hardware profile that actually
  exists in the capability catalog — no "any printer" claim.

### 3.8b Residual v1 staging (N0–N4) — SUPERSEDED, history only

**[NOTE]**
The v1 "Stage N0–N4" staged implementation path (embed Kiri:Moto/libSlic3r → top-surface →
conformal → multi-axis → curved supports) is **superseded** by the strategy set and staged
spikes in §3.1 and §3.8 of this revision. It is retained below **only as historical record of
what v1 decided and why v2 rejected it** (the rejection is: "embed Kiri:Moto engine — MIT"
is **unverified** as stated in v1 → engine distribution/embedding terms unconfirmed, see §3.4
and §13 `[BUG] Kiri license`); it is **not** a current plan.

| v1 Stage                                   | v2 status                         | Reason                                                                                                                                                                                                                                                 |
| ------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N0 — embed Kiri:Moto/libSlic3r planar core | superseded                        | Kiri:Moto engine embeddability **unconfirmed** (client MIT only; engine terms unknown); libSlic3r AGPL; own planar core per spike S1 (source-adaptation of a permissive reference remains a valid fallback), planar output is validation-only baseline |
| N1 — top-surface curved finishing          | absorbed into S2                  | same technique, but now against machine profile (§5) with fail-closed gate                                                                                                                                                                             |
| N2 — conformal curved layers               | absorbed into S3                  | same, plus field-based alternative strategy (§3.1 strategy 2)                                                                                                                                                                                          |
| N3 — multi-axis                            | absorbed into S4                  | joint/kinematic model moved into machine capability contract (§5)                                                                                                                                                                                      |
| N4 — curved supports / force-aware         | retained as research, out of path | unchanged (research-grade)                                                                                                                                                                                                                             |

---

## 4. Blender — Required Primary Modeling Backend and Geometry Authority

### 4.1 Decision (reverses v1 §4.2 — see §13)

**[SPEC]**

- Blender (pinned `BLENDER_VERSION`) is a **required** dependency and the **geometry authority**:
  the evaluated Blender scene is the single source of truth for geometry. The app does **not**
  run without Blender installed (v1's "works identically without Blender" is **superseded**).
- The app is **our own React/Tauri UI** that drives a headless Blender (bpy) server over a
  command contract. It re-implements the Blender _workflow_ — the **target** is exact modeling
  workflow, shortcuts and semantics per the parity matrix in §4.2. This is a target definition
  for engineering, **not a promise**: each matrix row carries a parity check (§4.2) and due
  milestone (§9); parity is measured against the parity corpus, not asserted.
- **UI branding is independent**: the app is not a Blender skin. Required legal notices and
  source attribution **remain** with any redistribution per the GPL terms (see §4.5 legal gate) —
  branding and licensing are separate decisions.
- **Headless facts**: background mode (`blender -b`) reliably executes Python — modifiers,
  booleans, mesh ops, conversions, rendering (v1 verified, retained). bpy is **context-sensitive**
  (operators depend on active object/mode): use `bpy.data`/BMesh APIs, not UI operators, for
  deterministic automation (cited §11). Python threading is unsupported in Blender; one process
  = one state (cited §11). No embeddable UI: gizmos, snapping, edit-mode interactions, modifier
  panels, and the undo stack are application-level work in our UI (§4.2/§4.6) regardless of backend.

### 4.2 Feature parity matrix (workflow target — measured, not promised) (design)

**[SPEC]**
Every row is a work item with a measurable parity check; the "due" value is the roadmap milestone (#9)
where that row is _complete_. "Headless blocker" states what prevents the capability in a pure
headless/bpy context.

**[NOTE]**
Workflow semantics per row: objects; edit-mode vertices/edges/faces; transform (G/R/S)
with constraints, numeric entry, pivot, snap, proportional; extrude/inset/bevel/loop cut/knife;
merge/dissolve/normals; mirror/array/subdivision/solidify/boolean; geometry nodes; sculpt.

| Capability                                           | Parity target (exact workflow semantics)                                                                                                                                                                                       | Headless/bpy blocker (if any)                                                                                                                                                                                                      | Due         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Object mode: add/delete/transform/gizmos             | G/R/S with numeric entry, pivot points, snap (vertex/edge/face/incr/…), proportional editing with falloff                                                                                                                      | none — BMesh/bpy.data drive the mesh; gizmos + numeric entry live in our UI                                                                                                                                                        | R1          |
| Edit-mode selection: vert/edge/face                  | exact Blender selection invariants: **selection state must be flushed/validated against mesh state after every topology-changing op** (stale selection is a corruption vector); BMesh API requires this either way (cited §11) | none — bpy/bmesh expose the same internal edit operations as native tools (cited §11); flushing is _our_ responsibility                                                                                                            | R1          |
| Mesh topology ops                                    | extrude, inset, bevel, loop cut, knife                                                                                                                                                                                         | knife/loop-cut are UI-driven; underlying mesh ops exist in bpy — exact shortcut/interaction parity is UI work                                                                                                                      | R1–R2       |
| Merge/dissolve/normals                               | merge by distance, dissolve, recalc normals — exact result equality on corpus                                                                                                                                                  | none                                                                                                                                                                                                                               | R2          |
| Modifiers: mirror/array/subdivision/solidify/boolean | exact modifier-stack semantics; modifier evaluation is Blender's                                                                                                                                                               | none (Blender is the evaluator — the reason it is the authority)                                                                                                                                                                   | R2          |
| Geometry nodes                                       | subset first (curve/point primitives, mesh boolean via GN); full GN later                                                                                                                                                      | GN graph evaluation runs headless; **node-graph UI authoring** is major UI work — subset-gated                                                                                                                                     | R3+         |
| Sculpt                                               | basic sculpt strokes via bpy mesh ops or a dedicated sculpt module                                                                                                                                                             | **blocker**: sculpt is UI/brush-driven; no headless brush engine in bpy — treat as a separate module, not a bpy call; where sculpt parity on the corpus is required headless, invoke the §4.3(d) native source-adaptation fallback | R4+ (later) |
| Selection invariants (global)                        | no op may leave selection referencing deleted elements; every IPC round-trip validates selection against mesh revision                                                                                                         | ours (§4.6 stale-revision handling)                                                                                                                                                                                                | R1          |
| Undo/redo                                            | Blender-undo equivalence on corpus ops                                                                                                                                                                                         | bpy has no UI undo stack; our command journal (§4.6) is the undo authority and must _replay_ into bpy state                                                                                                                        | R1          |

**[SPEC]** Parity corpus (design):

- A fixed, versioned corpus: small meshes + scripted op sequences + recorded expected outcomes
  (native BLEND snapshots, mesh hashes, selection snapshots).
- **Selection invariants** and **topology ID/remapping** are explicit corpus assertions: mesh
  integer indices are **not** stable across ops; the IPC delta carries the remapping table and
  our UI's stable object/element IDs are mapped onto Blender element indices per session (§4.6).
- **Authoritative native snapshots** are Blender state (BLEND file / evaluated BMesh), **not**
  the renderer's evaluated triangles. The renderer is a view; native snapshot vs renderer
  triangles that disagree = renderer bug, snapshot wins.

### 4.3 Headless Blender build options — honest assessment (design)

**[SPEC]** Decision rule: **choose the untrimmed pinned baseline first; minimize only after
parity is proven** on that baseline — minimizing earlier risks build issues indistinguishable
from engine issues.

| Option                                           | What it is                                                                                                                                                                                                                                                                                                                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Full official Blender, `blender -b --python` | Untrimmed user-installed Blender (MSIX alias **or classic**), version-pinned; discovery path proven in-repo (`tools/HEADLESS-RENDER.md`: MSIX launcher alias has the scoped stdout limitation; **framed stdio/IPC + binary-artifact channel** is the working contract, JSON-over-file the PoC fallback — a classic non-alias install may use stdio framing directly, §4.6)         | **Baseline — starts here.** Practical Windows path.                                                                                                                                                                                                                                                                                                                                                              |
| (b) bpy as Python module                         | `make bpy` / `bpy_module.cmake` per Blender build handbook (builds the Python module against a matched Python; `building_blender/python_module`, cited §11). Documented background-mode limitations track the release line — do **not** infer a universal "bpy can't do X" from current doc wording; re-verify against the pinned version in both directions before relying on it. | Secondary: lighter embed, primarily a Linux/macOS story; on Windows a self-contained bpy + matched CPython is not an established install path — research spike, not baseline.                                                                                                                                                                                                                                    |
| (c) Custom minimal Blender build                 | Disable editors/Cycles/UI to strip size + deps                                                                                                                                                                                                                                                                                                                                     | **Only after parity on (a)**; minimization must re-run the full §4.2 corpus on the trimmed build. Significant Windows build cost; licensing posture unchanged.                                                                                                                                                                                                                                                   |
| (d) Source-level native adaptation               | Port **or fork** Blender's native edit-mode / contextual-operator / modal / sculpt paths into our own core                                                                                                                                                                                                                                                                         | **Retained fallback — not categorically rejected.** bpy docs describe context-dependent operator polls and modal-lifecycle machinery (cited §11); if headless bpy cannot reach the §4.2 parity target on contextual, modal, or sculpt rows (measured against the corpus), a native source adaptation/fork remains the valid fallback. Deferred while (a) is the baseline; re-armed only on measured parity gaps. |

**[SPEC]** Process model: **one active BLEND per process** (bpy limitation, cited §11).
Multi-scene = N processes. Process = fault + state boundary; it is **not** a security boundary
(§7, T2).

### 4.4 STEP/IGES honesty (corrects v1 §4.2) (design)

**[SPEC]**

- No assertion that Blender natively handles STEP/IGES at CAD fidelity.
- Blender's own BRep/STEP pipeline is **OCCT-based** and partial/lossy for CAD-grade BRep;
  mesh→BRep reconstruction is approximate from tessellation in particular (NURBS-surface fidelity)
  (cited §11 — the OCCT lineage is Blender's BRep foundation).
- The in-repo replicad-WASM and OpenCascade.js are **the same OCCT family** — moving OCCT
  (Node WASM → Blender → dedicated process) does **not** change the STEP-fidelity gap.
- OCCT is a **separate, optional CAD-conversion tier**, not a replacement modeling kernel:
  the kernel is Blender (bpy/BMesh + WASM cores below); OCCT only converts representations.
- Current repo artifact is the **degraded bbox-cuboid path** (§2.1 `[BUG] STEP bbox`); any real
  mesh→STEP feature is separate work with a declared fidelity budget.

| Tier                    | Component                          | Role                                                                                                           |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Authority (process)** | Blender bpy (pinned)               | **Primary modeling backend + geometry authority**: all §4.2 capabilities, modifier evaluation, render previews |
| Core (WASM, in-worker)  | Manifold                           | boolean/CSG guarantee for manifold meshes — Apache-2.0                                                         |
| Core (WASM, in-worker)  | three-bvh-csg                      | fast mesh CSG for interactive editing                                                                          |
| Optional (process)      | OCCT via OpenCascade.js / replicad | STEP/IGES **conversion only** — approximate BRep from mesh, lossy for NURBS; not a modeling kernel (§4.4)      |
| Core (Rust)             | own slicing kernels                | planar → non-planar engine (§3)                                                                                |

### 4.5 Licensing: legal packaging decision gate (design)

**[SPEC]**

- Blender is **GPL**; the relevant obligations are redistribution-of-Blender and the conditions
  for bundled bpy scripts (per blender.org license page, cited §11). **This document is not
  legal advice.**
- The decision — _user-installed-discovered_ (default: no Blender redistribution by us, the
  pinned `BLENDER_VERSION` is a declared requirement) vs _bundled_ (GPL redistribution
  obligations attach to the combined distribution artifact) — is a **legal packaging decision
  gate** that must be closed **before first public distribution**. Required notices/source
  attribution remain whatever the packaging decision is; UI branding being independent does not
  remove those obligations.
- v1 §10's open question "user-installed vs bundled" is thus **resolved to a gated decision**:
  default = user-installed/discovered (MSIX alias per `tools/HEADLESS-RENDER.md`); bundling is a
  later, separate, legally-reviewed option.

### 4.6 IPC contract: modal ops, undo, stale revisions, binary deltas (design)

**[SPEC]**

- **Command contract**: the UI issues typed commands (op + params + **expected revision**);
  the bpy server executes and returns (result, new revision, topology remapping table, selection
  state). The in-repo PoC resolves `BLENDER_EXE` and runs under the **MSIX launcher alias**, and
  repo evidence (`tools/HEADLESS-RENDER.md`) scopes the stdout limitation to that _alias_ — it
  does **not** establish "Blender stdout is uncapturable" as a universal contract. The working
  transport in the repo is therefore **framed stdio / framed IPC** (delimited JSON or
  length-framed records, not raw stdout scraping) with a **binary artifact channel** (files on
  disk or a shared buffer) for geometry payloads; **JSON-over-file** is retained as the PoC's
  concrete fallback. **Lifecycle validation (begin/heartbeat/commit/timeout, §4.6 modal
  lifecycle) is pending** against the pinned `BLENDER_VERSION` before the contract is declared.
  A classic (non-alias) install may use stdio framing directly.
- **Modal op lifecycle**: every interactive op follows begin → _(0+ updates: user drags/enters
  numeric)_ → commit | cancel. Begin opens the op with a revision; updates are provisional
  (not journaled); **commit** validates selection invariants, journals (undoable, §3.5 journal
  discipline), and advances revision; **cancel** rolls to begin-revision. No direct topology
  op outside a modal lifecycle.
- **Undo/recovery**: the command journal is the undo authority (bpy has no UI undo stack). Undo
  = replay of inverse command sequence to target revision, re-validated against the current mesh
  (an undo that would leave stale selection is refused with a reason, not applied lossily).
  Crash recovery = journal replay to last committed revision against the last BLEND snapshot.
- **Stale revisions**: every command carries `expected_revision`. Mismatch → rejected with the
  actual revision (the UI must re-base, never force). A BLEND file modified out-of-band
  (user opens it in Blender concurrently) **invalidates the session**: the UI detects
  revision/hash mismatch and offers re-import, not silent merge.
- **Transport**: binary deltas for geometry payloads (base64-of-binary in JSON envelope, or
  shared-memory/IPC buffer in a later milestone) with **explicit backpressure**: the UI stalls
  issuing while the pending-op queue exceeds a bound; oversized results are paged, not
  truncated. Wire format is versioned.
- **Session model**: a Blender session is **persistent for the user's active editing project**
  (one long-lived process per project scene). **AI jobs are disposable**: they run in a fresh
  pinned-process, read-only inputs (or a scratch copy of the project BLEND), write outputs to
  scratch, and die — the AI job process and the user session process are different processes
  and never share state (ties into §7 T2 vs T3a).

---

## 5. Machine Capability Contract (Design)

**[SPEC]**

- The machine capability contract is the **single versioned source of truth** for what a given
  machine can do. The env vars and cloud catalog _populate_ it; they are **never** the reverse.
  This supersedes all v1 hardware-default statements (Kobra S1 as product assumption — see §13
  `[BUG] Kobra-as-default`).
- **No "any printer" guarantee.** Unsupported profiles **fail closed**: a machine profile that
  does not declare a required capability for a requested feature (e.g. continuous-Z
  interpolation for curved top layers) causes the feature to be rejected _pre-flight_, not to
  degrade silently.
- A specific printer (e.g. the bundled reference profile) is one **profile** among many, referred
  to by placeholder `<MACHINE_TYPE>` (cloud id `<PRINTER_ID>`, firmware `<FW_VERSION>`) per
  AGENTS.md §3. It is used for validation coupons; it is **not** the product's assumed hardware.

### 5.1 Schema (versioned, illustrative — synthetic values only)

```jsonc
// machine_profile.schema = "1.0" — all values synthetic; real values come via §5.2 ingestion
{
  "schema_rev": "1.0",
  "profile_id": 0,
  "identity": {
    "model": "", // e.g. <MACHINE_TYPE>
    "vendor": "",
    "fw_version": "", // <FW_VERSION>
    "kinematics": "cartesian", // cartesian | corexy | delta | hybrid | multi_axis(R-theta) | robotic
  },
  "build_volume": {
    "shape": "rect", // rect | cylinder (delta) | cone (rotary clearance) | arbitrary (mesh clip)
    "min": [0, 0, 0],
    "max": [0, 0, 0],
    "cylinder_radius": null,
    "clip_mesh_ref": null,
  },
  "joints": [
    // one entry per actuated joint; unknown => null, never guessed
    {
      "id": "X",
      "type": "linear",
      "unit": "mm",
      "home": 0,
      "min": 0,
      "max": 0,
      "frame": "base",
      "pivot_offset": [0, 0, 0],
    },
    {
      "id": "A",
      "type": "rotary",
      "unit": "deg",
      "home": 0,
      "min": null,
      "max": null,
      "frame": "bed",
      "pivot_offset": null,
      "coupling": "turntable",
    }, // dangle | turntable | 4th-axis
  ],
  "tool_envelope": {
    "nozzle_radius": 0,
    "nozzle_to_hotend": 0,
    "hotend_to_carriage": 0,
    "carriage_swept_bbox": null, // full swept-volume, not just a cone
    "conical_clearance_deg": null, // only for legacy nozzle-cone checks; not the authority
  },
  "continuous_z": { "supported": false, "interpolation": "none", "source": "unknown" },
  "leveling": { "method": "unknown", "tcp_responsibility": "machine" }, // tcp_responsibility: machine | toolhead | both
  "thermal_flow": { "flow_dynamics_model": "none", "pressure_advance": false, "source": "unknown" },
  "controller_dialect": {
    "fw_family": "unknown", // Marlin | Klipper | Anycubic | other
    "gcode_whitelist": ["G0", "G1", "M104", "M109", "M114"],
    "max_extrude_rate_mm3_s": null,
  },
  "sensors_interlocks": { "probe": false, "endstops": {}, "estop_chain_independent": null },
  "collision_constraints": {
    "allow_bowden_droop": false,
    "min_bed_clearance": 0,
    "first_layer_speed_cap": null,
  },
  "provenance": { "source_class": "unknown", "qual_state": "unqualified", "acquired_at": "" },
  "qualification": { "state": "unqualified", "revoked_reason": null },
}
```

**[SPEC]**

- Unknowns are **null** (or `"unknown"` for enums) — never a default that hides ignorance.
- `src`/`measured` distinction is explicit: every non-null capability has a `source_class` in
  provenance: `src` (vendor-documented / source-derived) vs `measured` (observed on this
  machine). A `src` value that a `measured` observation contradicts → the profile is flagged
  for re-qualification, the measured value is kept alongside, and the feature **fails closed
  until the conflict is resolved** (human approval to prefer one, with the reason journaled).
- **qualification state** lifecycle: `unqualified` → `shadow` (feature runs; learned/inferred
  parameters are logged but not trusted as authority) → `qualified` (human-approved against
  measured evidence). **Revocation**: any change to nozzle or firmware (or any
  toolhead/kinematic hardware swap) resets `qualification.state` to `unqualified` **
  automatically** — qualification is bound to the exact nozzle+firmware+toolhead configuration
  that was measured, not to the model string.

### 5.2 Ingestion: three paths, all read-only into the contract (design)

| Path                  | What it does                                                                                                                              | Provenance rule                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Manual**         | user fills the profile in a form; written to the profile store                                                                            | `source_class = src`, confidence `low` until corroborated; no printer required                                                                                                                                                                                         |
| **2. API**            | pulled from the existing MCP/cloud property catalog (`scripts/printer-http-property-catalog.mjs`, `scripts/printer-property-catalog.mjs`) | **validated** against a local sanity model; **not** a reliable capability list on its own (per-repo evidence: one call returned _different-model_ metadata for a different input — the API path marks low-confidence fields `confidence = low` / `[?]`, never asserts) |
| **3. Online catalog** | vendor/known-machine catalog, version-pinned, hash-checked, user-approvable                                                               | `source_class = src`; **never** silently overrides a manual/measured value — conflicts are flagged, §5.1 rule applies                                                                                                                                                  |

**[SPEC]**

- All three paths are **read-only into the contract**: the profile is the source of truth for
  the slicer and the safety limits; ingestion _populates_ it, it does not _derive_ capabilities
  from ingestion output at runtime.
- `src` vs `measured` is a per-field tag, not a per-profile tag (a profile can be half-`src`,
  half-`measured`). A `measured` field **overrides** a conflicting `src` field for the purposes
  of fail-closed evaluation _within the same qualification window_ — but the profile is flagged
  for re-qualification (the conflict is resolved by a human, not by auto-preference).
- **Uncertainty is a field**, not an afterthought: every non-null numeric field can carry a
  `tolerance` / `confidence in {low, medium, high}`; safety-relevant fields default to `low`
  until corroborated.
- **No "any printer" guarantee, explicitly**: the contract is _per-profile_. A feature that
  requires a capability a profile does not declare → **pre-flight rejection** with the capability
  name and the profile id. This is _fail-closed by design_, not a limitation — the product
  refuses to print on a profile it cannot model, and says so, before the job starts.
- A bundled reference profile exists for validation coupons (S2 spike, §3.8) and is referenced
  only by placeholder (`<MACHINE_TYPE>`, cloud id `<PRINTER_ID>`, fw `<FW_VERSION>`).

### 5.3 Qualification, revocation, and the no-any-printer restatement (design)

**[SPEC]**

- A profile is usable for a feature only when `qualification.state` is `qualified **and** all
capability fields required for that feature are non-null **and** `source_class in
  {src, measured}`with`confidence > low`(for safety-relevant fields:`meas **or** src
  with a `measured` corroboration).
- **Revocation is event-driven and automatic**: nozzle swap, firmware change (detected via the
  cloud/LAN property catalog or a user-declared event — either triggers it), toolhead swap →
  `state = unqualified`, `revoked_reason` set, all in-flight jobs for that profile **stop
  at the next safe boundary**, and the feature is off until re-qualification completes.
- **Restating the no-any-printer rule**: the product makes **no** claim that it works on
  "any printer" or "any 3-axis printer". It works on profiles that are **`qualified`** for the
  requested feature. Everything else is a **pre-flight, named-capability rejection**.

---

## 8. Harness, Sandbox, BYOK, MCP — Architecture (renumbered from v1 §5)

### 8.1 Trust model (retained verbatim from v1 §5.1)

- **Orchestration is not authorization.** Model says "run this"; broker decides if it may.
- **Process separation is not sandboxing.** A child process with user privileges is not isolated.
  **(Promoted: this is the first rule of §7 — v1 stated it in §5.1 but the T2 row below it
  contradicted it; corrected now.)**
- **MCP is interoperability, not isolation.** Local MCP servers inherit client privileges.

### 8.2 Tiered execution (corrects v1 §5.2)

| Tier | Content                                                                           | What it _is_                                                                                                                         | What it _is not_                                                                                    | Limits                                                                                                              |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| T0   | Read-only inspection tools (property maps, catalogs, scene queries)               | in-broker, no side effects                                                                                                           | —                                                                                                   | n/a                                                                                                                 |
| T1   | Procedural CAD scripts, **only** tools that compile to/are native Wasm            | Wasmtime WASI (**capability imports**, §8.3), fuel/epochs + **mandatory external watchdog**                                          | not a general Python sandbox                                                                        | memory cap, no net (denied by default), fs = preopen scratch only                                                   |
| T2   | **Trusted first-party** workers — Blender (pinned), OCCT, geometry kernels        | OS process spawned per job; **fault containment only** (crash/OOM kill) — _not_ security isolation                                   | **not** a sandbox: a Windows child process with user privileges is not isolated (v1 §5.1, retained) | wall clock, output-size cap, killable; no secrets in env; scratch via junction; **host firewall denies its egress** |
| T3a  | **Model-generated / third-party** tools that are Wasm-compatible                  | Wasmtime `wasip2` **capability-based** sandbox: the tool requests a capability set, the broker grants a subset, unrequested = denied | does **not** isolate native code                                                                    | deny-by-default capabilities; network only via broker egress (§8.5)                                                 |
| T3b  | Untrusted **native** code (native Python/Blender scripts, arbitrary native tools) | real OS-level isolation: **VM first** (Linux dev VM), Hyper-V/Windows Sandbox later                                                  | —                                                                                                   | **off by default on Windows** until the VM path ships; deny                                                         |

Correcting v1's T2 "chroot-equivalent scratch dir": on Windows there is no chroot and a
directory is not an isolation boundary — the corrected table states T2 as fault-containment
only, which is what a process boundary actually gives. **cwd and a child process are not a
sandbox**; only T3a (Wasm capability imports) and T3b (VM/OS isolation) are security layers.

**[SPEC]** Wasmtime caveat (retained, now mandated): fuel/epochs **cannot interrupt blocking
host calls** — a WASI worker that makes a blocking preopen-dir call can outlive its epoch
deadline; the **external watchdog process is mandatory, not optional**, for every T1/T3a worker
ever (cited §11 Wasmtime security docs: isolation comes from _imports_, not from a language
runtime — WASI is not a Python isolation mechanism).

**[SPEC]** bpy is **not** a T1/T3a workload. Blender is native; it runs as a pinned, trusted
T2 first-party worker (§8.2 T2 row). Model-generated code that wants Blender's _results_
requests a named _geometry capability_ the broker proxies to the pinned Blender process (§8.5)
— the model never obtains a Blender handle; untrusted Python/Blender _scripts_ are T3b (VM),
not T1.

### 8.3 Specialized tool harness — lifecycle for self-created tools (design)

**[SPEC]** A self-created tool goes through a versioned lifecycle — none of these stages may
be skipped:

| Stage            | Meaning                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **manifest**     | versioned manifest: name, version, content hash, schema/version, runtime class (T1/T2/T3a/T3b), declared capabilities, provenance (who/what generated it) |
| **scratch**      | build/authoring in a scratch area with **no host shell** and no unrestricted exec                                                                         |
| **build**        | compile/validate to the declared runtime class; build logs recorded                                                                                       |
| **test**         | sandboxed run against a test corpus; failures recorded                                                                                                    |
| **approval**     | human approval of the _exact manifested artifact_ (hash-bound — approving a manifest does not approve a re-build)                                         |
| **registration** | registered in the tool registry by content hash, only then invocable by name                                                                              |
| **revocation**   | revocable by hash/version; revocation kills all running instances next tick; revocation is journaled                                                      |

- **Separation of trust**: trusted, **fixed** first-party operations (the pinned Blender
  invocation, the OCCT invoker) are **separated** from generated tools — a generated tool
  cannot invoke a trusted operation except by _requesting its named capability_ (§8.5).
- **Secrets and network**: the **broker** holds secrets and enforces network policy; tools
  never hold credentials. Egress is name-addressed and pinned per capability: the broker injects
  the key, not the tool (§8.5 rule). Provider pinning, per-key quotas and cost accounting sit in
  the broker's egress table.
- **No host shell, unrestricted, inside the harness**: the harness is a capability surface,
  not a terminal. Anything that needs a real shell is the developer's out-of-band work, never a
  tool capability.

### 8.4 Prompt injection posture (design)

**[SPEC]**

- Injection surfaces are **explicit**: CAD file contents (3MF/STL metadata, text fields), web
  content pulled in, MCP tool **outputs** (an MCP server is a model-input source, not a trusted
  authority), and memory entries. All are **untrusted input** to the model, regardless of how
  they arrived.
- Rules: (a) model output from an untrusted-input request is never auto-executed as a capability
  request — it is always _proposals_, broker-gated (§8.8 approval UX, retained from v1 §5.6);
  (b) the model has **no direct printer capability** — printer actions are broker-issued
  commands against the preserved MCP contract, journaled and approval-gated; (c) memory entries
  and MCP outputs carry a `source_class` marker injected into the prompt so the model can
  (and the broker _must_) treat them as data, not instructions (OWASP LLM prompt-injection
  cheat sheet, cited §11).

### 8.5 BYOK and provider adapters (retained + extended from v1 §5.3)

- Keys live only in the Rust broker, protected by OS keystore (Windows DPAPI/Stronghold) —
  never in prompts, checkpoints, memory embeddings, or worker environments.
- **The broker, not the tool, holds and injects credentials; tools address capabilities by
  name.** (Added — was missing in v1; required by the harness in §8.3.)
- Destination-bound: each key is pinned to approved base URLs; provider changes require consent.
- BYOK adapter contract mirrors existing `cad-ai-translator.mjs` (OpenAI-compatible base URL +
  model) but generalizes to multi-provider with per-model capability discovery; **local models
  are first-class** (same adapter, loopback-only base URL — Ollama/LM Studio/vLLM).
- Egress table per provider: pinned base URL, quota, cost accounting, revocation — enforced by
  the broker, visible in the approval UX (§8.6).

### 8.6 Agent runtime

- **Goose** (`block/goose`, Rust) is the closest reusable runtime for BYOK + MCP — reuse as an
  _adapter/reference_, not as the product shell. **[?] License re-verified not guessed in v2;
  verify actual license text before any reuse decision** (v1 marked it "MIT?").
- **Pydantic AI** for typed multi-provider calls if a Python-side agent loop is ever needed.
- LangGraph only if durable replayable workflows become a requirement (mutations must tolerate
  replay — dangerous for side-effectful CAD ops; prefer our own journal).

### 8.7 MCP ecosystem reuse (retained from v1 §5.5, boundary restated)

- The existing MCP surface (printer/cloud/slicer tools) becomes a **tool provider** to the new
  harness, consumed via standard MCP stdio — the same way any external client uses it today.
  This is the **preserved contract** from §2 scope boundary.
- The new app adds its own **editor-domain** MCP server (scene ops, project ops, non-planar
  slicing) so external agents can drive the _new_ editor.
- The **legacy** `ui/cad.html` editor MCP surface is **retired as a product surface** (frozen,
  read-only during migration per §2); it is not extended.
- Version-pin every MCP server; show exact startup commands before enabling; re-approve on any
  privilege/transport change.

### 8.8 Approval UX (retained verbatim from v1 §5.6)

Approve **effects**, not effort: show the exact geometry diff / file write / outbound data /
spend. Allow-once, allow-session, allow-project scopes. Destructive actions (delete objects,
overwrite projects, printer commands) always explicit. Sandbox execution approval is separate
from artifact-commit approval. Every approval is journaled with model, provider, prompt hash,
tool args hash, input revision, and outcome.

---

## 6. Data, Auth (Separable Service), Memory

### 6.1 Storage & the separable auth service (replaces v1 §6.1 — see §13 `[BUG] Auth file-only`)

**[SPEC]**

- **The editor core has no auth dependency.** Geometry, modeling (Blender backend), slicing
  and local saving are fully usable with **auth not loaded / not running**. Auth is a _feature
  gate_ for sync/multi-user/remote — not a startup prerequisite. (Was only implied in v1; now
  explicit.)
- Auth is a **separably-deployable service** with its own process/container and its own
  backing store. Two **first-class** deployments — **not** "a separate file is the default
  and a separate service is over-engineering" (v1 §10.3, **superseded**):
  - **Local mode** — auth **service** runs as its own **loopback-only** HTTP/gRPC process (or
    in-dev, in-process module behind the **same** auth API); store = **local `auth.db`
    (SQLite)**. Zero external network. Same auth API contract either way — the file is _one_
    storage backend _behind the API_, not the API itself. This is the "explicitly separate
    service/database", not silently "a separate file".
  - **Independent mode** — the auth service is its own process/container with an
    **independent store (Postgres)** (or remote), reached over loopback/network per deployment;
    editor talks to it **only** via the versioned auth API, never by sharing a DB file.
- **Design decision, not a silent settlement**: both local `auth.db` and independent
  service+Postgres are supported deployment forms selected at build/deploy; the document does
  **not** pick "file only". (Label: _design proposal_; the choice at R4 is a build-time
  flag, not a code fork.)

| Concern                                                  | Store                                                              | Notes                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Projects, scene ops, undo journal, chat, context, memory | SQLite (Rust-owned, e.g. rusqlite)                                 | single-writer, embedded; editor-core, no auth dep    |
| Auth/identity (local mode)                               | **separate `auth.db`** behind the auth service loopback API        | own process/module; never the editor DB              |
| Auth/identity (independent mode)                         | **Postgres** (independent service)                                 | own process/container; editor only sees the auth API |
| BYOK keys                                                | OS keystore via broker (Stronghold/DPAPI)                          | never in any DB, never in the auth store             |
| Geometry artifacts                                       | content-addressed files (hash → blob) outside DB, referenced by ID | keeps DB small, enables dedupe                       |
| Optional cloud sync                                      | Postgres + Supabase-style Auth, OAuth PKCE (RFC 8252)              | opt-in; offline editing never requires login         |

| Concern | Store | Note |
| ------- | ----- | ---- |

The auth service is its **own tenant**: an _auth_ identity (a _who_ for sync/multi-user) is
explicitly **not** a _printer credential_. Cloud/LAN printer access continues to use the
existing cloud-token path (`scripts/auth-login.mjs`, §2) — the two credential systems are
distinct and must not be merged. "Printer creds" belong to the preserved printer/cloud
MCP contract (§2); "auth tenant" belongs to this service.

### 6.2 OAuth for external identity (design)

**[SPEC]**

- External identity (e.g. Supabase/Google) uses **external-browser + PKCE** (RFC 8252 native
  apps): the desktop app opens the system browser, receives the code on a **loopback** redirect,
  exchanges for tokens via authorization-code + PKCE.
- **No desktop DB credentials**: the desktop never stores a _password_ or a _refresh credential_
  it generated; tokens are broker-owned, keystore-protected, and the editor core never sees
  them (same rule as BYOK keys, §8.5).
- **Memory scoping to the auth tenant**: memory entries carry a `service_scope`
  (`local-project` vs `synced`); `forget` deletes the source entry and its derived artifacts
  (§6.3 embedding rule); `synced`-scoped reads require the auth service running and the user
  authorized.

### 6.3 Memory system (retained from v1 §6.2, + fail-closed scoping)

**[SPEC]**

- Project-scoped context by default; global memory only stores user-approved preferences/facts.
- Every memory entry carries provenance (source, `service_scope`, model, `source_class`,
  revision, timestamp, retention).
- Retrieval is filtered by scope **before** injection into prompts; embeddings/summaries are
  derived artifacts **deleted when the source memory is deleted** (forget = source + derived,
  not just the row).
- Memory **never grants permissions** — it is data, not authority (§8.4 injection rule applies:
  memory is untrusted input to the model).
- **Fail-closed when auth is off**: when the auth service is disabled, cross-project / `synced`
  memory reads return **empty** — they do **not** fall back to another user's memory, and they
  do **not** fall back to local memory silently (the local-scope reads still work; the
  synced-scope reads simply have no data). UI shows "synced memory unavailable (auth off)".
- UI must make memory visible, editable, and deletable per entry (with the scope tag shown).

### 6.4 Auth store schema sketch (retained from v1 §6.3, split per deployment)

**[SPEC]**

- `auth.db` (local mode): users, local device sessions, scopes/roles, audit_log (approvals,
  denials, tool executions), `sync_state`. **BYOK keys are NOT here** (§8.5 — keystore only).
- Independent mode (Postgres): same relational shape, plus tenant/partition by user, same audit
  semantics. The auth service's public shape is the **versioned auth API** (who/scope/sync
  tokens), not the table layout — storage is swappable behind it.
- Local-first: app is fully usable with zero auth users configured (single anonymous local
  profile, `service_scope = local-project` only); the auth layer activates only for
  sync/multi-user features.

---

## 7. UI Architecture (React + Tauri) — renumbered from v1 §7

### 7.1 Stack

- Tauri 2 (Rust core) — trusted broker, process supervision, native dialogs, keystore, DB.
- React 19 + TypeScript + Vite.
- 3D: React Three Fiber 9 (stable) — R3F 10 is alpha; avoid.
- State: Zustand or Jotai for scene/selection; TanStack Query for REST/SSE.
- Worker bridge: Tauri commands for control plane; loopback REST/SSE to existing Node MCP/CAD
  server during migration (preserves the current contract), replaced incrementally by Rust
  commands for new features.

### 7.2 Layout

Single-window, resizable panels:

- **Left:** object tree, layers, modifiers, print settings presets.
- **Center:** 3D viewport (R3F) with build plate driven by printer profile, gizmos, edit-mode.
- **Right:** chat panel (model selector, context sources, memory viewer, approval feed).
- **Bottom:** timeline/undo graph, slicing progress, job queue.

### 7.3 Chat/context/memory UI requirements (retained from v1)

- Context sources shown explicitly (which memories, which scene state, which files were injected).
- Token budget meter per request.
- Approval cards rendered inline in chat, each showing the concrete effect and scope.
- Global memory browser with per-entry provenance + scope tag (`local-project`/`synced`) and delete.
- BYOK provider/model picker with per-key health, spend tracking, and rate-limit feedback.

### 7.4 Viewport is a _view_ of the Blender scene (consequence of §4 — design)

**[SPEC]**

- The 3D viewport is a **rendering view of the live Blender scene**, **not** an independent
  Rust/TS scene model that must be kept in sync. Blender is the geometry authority (§4.1);
  the viewport renders authoritative native snapshots (§4.2) and shows live deltas as they
  commit (§4.6). A renderer triangle that disagrees with the native snapshot is a **renderer
  bug**; the snapshot wins.
- Gizmos, modes, and shortcut bindings **replicate the Blender operator workflow** per the
  §4.2 parity matrix — the UI owns the _interaction_ (gizmo drag, numeric entry, pivot,
  proportional falloff) and issues _mode-lifecycle commands_ (§4.6) to the bpy backend;
  the mesh _state_ is owned by Blender. (This is the explicit correction to v1 §1.2/§4.2
  which put the object model / undo / selection / transforms in "our Rust/TS domain layer so
  the app works without Blender"—inverted by v2.)
- Branding is independent of Blender (§4.1); the workflow-semantics target (§4.2) does
  not make the UI a Blender clone in appearance, only in _operating_ behavior where it claims
  parity.

---

## 9. Reuse / Build / Retire Matrix — v2 (replaces v1 §8)

| Capability                                                          | Source                                                                                   | Reuse / Build / Retire                                      | Note                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP tool surface (printer/cloud/slicer)                             | this repo                                                                                | **Reuse as-is** (stdio MCP)                                 | Preserved contract, §2; **[?] verify tool count at R0**                                                                                                                                                                                                                                        |
| Parametric + CSG kernels                                            | manifold-3d, three-bvh-csg                                                               | Reuse (WASM)                                                | Already in repo                                                                                                                                                                                                                                                                                |
| Arrange/packing                                                     | `cad-arrange.mjs`                                                                        | Port to TS/Rust                                             | Pure functions                                                                                                                                                                                                                                                                                 |
| 3MF read/write                                                      | `read-3mf.mjs`                                                                           | Port + extend                                               | Needs write support for editor                                                                                                                                                                                                                                                                 |
| **Modeling backend / geometry authority**                           | Blender bpy (pinned, user-installed)                                                     | **Reuse as REQUIRED primary** (headless server)             | §4; legal packaging gate §4.5 before first public distribution; discovery per `tools/HEADLESS-RENDER.md`                                                                                                                                                                                       |
| STEP/IGES conversion                                                | OCCT (OpenCascade.js / replicad)                                                         | **Reuse — conversion only** (optional tier)                 | **Not** a modeling kernel, §4.4; current repo path is degraded bbox (§2.1 `[BUG]`)                                                                                                                                                                                                             |
| **Slicing (planar)**                                                | own Rust core                                                                            | **Build (own)**; Kiri:Moto / libSlic3r = **reference only** | Kiri:Moto **engine** distribution/embedding terms **unconfirmed** (client MIT only; not assumed MIT-embeddable) `[BUG] Kiri license`; per §🔒 LICENSE POLICY only Apache/MIT references may be source-adapted — anything else is study-only; libSlic3r AGPL-3.0; planar output is the validation baseline, not the product goal (§3). **Both slicing modes are first-class** (§3.0a): standard (planar, default) always available; non-planar (S2/S3/S4) is an opt-in experimental mode, selectable per project only when the machine profile declares the required capabilities (fail-closed otherwise). |
| Slicing (Anycubic-compatible reference output)                      | Anycubic Slicer Next CLI/GUI via existing adapters                                       | Reuse (external)                                            | firmware-compat validation only, not the engine                                                                                                                                                                                                                                                |
| Non-planar strategy 1 (conformal)                                   | CurviSlicer / Zip-o-mat-Hamburg                                                          | **Build own**; algorithm studied from published             | AGPL implementation = study only, §3.4                                                                                                                                                                                                                                                         |
| Non-planar strategy 2 (field/volumetric)                            | own + research reuse                                                                     | **Build own**                                               | license diligence per artifact, §3.4                                                                                                                                                                                                                                                           |
| Non-planar strategy 3 / multi-axis                                  | S3-Slicer (BSD-3), Open5x (MIT), S4 (GPL-3.0, study), FullControl (GPL-3.0, inspiration) | **Build own**; references as listed                         | joint/kinematic model = machine capability contract §5; no "any hardware" claim (§5.3). Per §🔒 LICENSE POLICY: only Open5x (MIT) may be source-adapted; S3-Slicer (BSD-3), S4 (GPL-3.0) and FullControl (GPL-3.0) are study/algorithm-reference only — never copied |
| Toolpath designer                                                   | FullControl (GPL-3.0)                                                                    | Inspiration only                                            | GPL — not linkable into own engine                                                                                                                                                                                                                                                             |
| Curved layers, robotic                                              | COMPAS slicer (MIT)                                                                      | Reference                                                   | Python/robotic focus                                                                                                                                                                                                                                                                           |
| Machine capability contract                                         | Build                                                                                    | **Build** (new, §5)                                         | versioned schema; fail-closed; qualification/revocation                                                                                                                                                                                                                                        |
| Continuous-learning journal + safety box                            | Build                                                                                    | **Build** (new, §3.5)                                       | immutable job records; bounded; never self-modifies safety limits                                                                                                                                                                                                                              |
| Harness: WASI capability sandbox (T1/T3a)                           | Wasmtime                                                                                 | Reuse (Wasmtime + watchdog)                                 | §8.2/§8.3; watchdog mandatory                                                                                                                                                                                                                                                                  |
| Harness: generated-tool lifecycle                                   | Build                                                                                    | **Build** (new, §8.3)                                       | manifest/version/hash/schema; approval/registration/revocation by hash                                                                                                                                                                                                                         |
| Harness: native untrusted isolation (T3b)                           | VM (Linux first)                                                                         | **Build** (deferred on Windows)                             | off by default until shipped (§8.2)                                                                                                                                                                                                                                                            |
| **Auth (service + store)**                                          | Build                                                                                    | **Build** (§8.1)                                            | local `auth.db` XOR independent service+Postgres — both first-class; editor core has no auth dep                                                                                                                                                                                               |
| BYOK adapter                                                        | `cad-ai-translator.mjs`                                                                  | Generalize                                                  | local models first-class; broker holds keys, §8.5                                                                                                                                                                                                                                              |
| Agent runtime                                                       | Goose (license **[?]**)                                                                  | Adapter/reference — **not** the product shell               | license re-check, §8.6; v1 marked "MIT?" — do not guess                                                                                                                                                                                                                                        |
| **Legacy `ui/cad.html` editor scene + its REST/SSE authoring path** | this repo                                                                                | **Retire (as product editor)**                              | read-only during migration; frozen, deprecated, removed after cutover; **no legacy runtime fallback**; MCP tool names/schemas preserved (§2, §1.1)                                                                                                                                             |
| UI                                                                  | Build (React 19 + R3F 9)                                                                 | **Build**                                                   | no existing React base; viewport is a view of the Blender scene (§7.4)                                                                                                                                                                                                                         |

---

## 10. Roadmap (Staged, Each Independently Shippable) — v2

**[NOTE]** Each stage lists a **testable acceptance** (a measurable check, or a research spike
whose output is a declared number). Stages depend on earlier ones only where noted; research
spikes (S1–S4, §3.8) run in parallel with the editing stages where hardware allows.

### R0 — Foundation (desktop shell + domain model + contracts)

- Tauri 2 + React 19 scaffold, Rust broker skeleton, SQLite workspace.db **behind the new auth
  service** (local mode, §8.1); the editor core itself has **no** auth dependency (§8.1).
- **Machine capability contract** v1 (§5): schema, three ingestion paths, one bundled reference
  profile (`<MACHINE_TYPE>` placeholders; **fail closed**, §5.3). No product hardware default.
- Versioned project schema (objects, ops, undo, revisions), content-addressed artifacts.
- Scene state = the **live Blender scene** (geometry authority, §4.1); React viewport renders it
  as a **view** (§7.4); no independent in-Rust scene twin.
- Loopback REST/SSE bridge to existing Node server for slicer/MCP tools (temporary, **read-only**
  for the legacy scene until cutover) — the §1.1 migration gate.
- **Retirement cutover**: when R5+ is green, the legacy `ui/cad.html` scene singleton is removed
  as an authoring surface; **no legacy runtime fallback** (§1.1). Existing MCP clients keep
  working against the preserved tool names/schemas.
- _Acceptance:_ a profile is created via each of the three ingestion paths; an unsupported feature
  is rejected pre-flight with the named capability; the legacy scene reads through the bridge with
  no data loss.

### R1 — Blender-primary editing core

- **Blender primary-backend wiring** (**not** "optional worker"): discovery per
  `tools/HEADLESS-RENDER.md` (MSIX alias), pinned `BLENDER_VERSION`, `blender -b --python`,
  **framed stdio / framed-IPC command contract with a binary artifact channel** (JSON-over-file
  retained as the PoC fallback; the MSIX-alias stdout limitation is scoped to the alias, §4.6),
  per-project persistent process, **disposable AI-job processes separate**
  (never shared state, §4.6). External watchdog on the process (mandatory §8.2 T2 note).
- **Parity corpus v1** (§4.2): ≥3 meshes + ≥20 recorded ops; selection-invariant + topology-
  remapping assertions per round-trip; **native BLEND snapshots are authoritative** (renderer
  triangles are a view, §4.2/§7.4).
- Viewport (R3F) **as a view of the live Blender scene** (§7.4): gizmos, selection, numeric entry,
  pivot, snap, proportional — the UI owns _interaction_ and issues **modal begin/update/commit/
  cancel** commands (§4.6); Blender owns _mesh state_.
- Object tree, materials/filaments sourced from the machine capability profile (§5), build volume
  from the profile (**not** hardcoded — the v1 220x220 default is gone, §2.2).
- **Undo/recovery = command-journal replay** to the target revision, **re-validated** against the
  current mesh (§4.6); autosave + crash recovery = journal replay to the last commit.
- Import: STL/OBJ/3MF/glTF. Export: STL/OBJ/3MF/glTF. (STEP/IGES **conversion only** via OCCT,
  §4.4 — not a modeling capability in R1.)
- _Acceptance:_ the R1-row set of the §4.2 parity matrix (object mode, edit-mode selection,
  mesh topology ops, merge/dissolve/normals, selection invariants, undo/redo) passes the corpus;
  a **stale-revision** command is rejected with the actual revision (not forced); crash recovery
  replays to the last committed revision with no stale selection.

**[NOTE] Slicing modes:** with the user-confirmed **dual-mode** requirement (§3.0a), R0 also
  ships the project-level `slicing_mode` persisted field. Both modes come online together at
  R2 (planar = standard, default) and R5/R6 (non-planar, opt-in capability-gated):
  R0 merely persists the mode; **no slicing pipeline ships before R2.**

### R2 — Own planar core (validation baseline) + context-dependent op IR

- **Own** planar core (Rust worker; S1 spike, §3.8) — walls + infill for the baseline corpus.
  **Kiri:Moto / libSlic3r are references only, not embedded** (§3.4, §13 `[BUG] Kiri license`).
  Planar output is a **validation baseline**, not the product goal (§3 scoping).
- Profiles system (machine/process/filament) — import from existing `presets/catalog.json` where
  possible, **mapped into the §5.1 machine capability schema** (contract is the source of truth).
- Layer preview, per-layer toolpaths, infill/walls visualization.
- **Context-dependent op IR** per segment (pose, orientation, bead cross-section, flow, cooling,
  speed, collision-free interval, provenance) + **independent emitted-program validator**
  (a separate code path from the generator, §3.6/§3.7). G-code via the per-machine postprocessor
  (kinematics-aware FK → joint targets), **not** a generic Cartesian emitter (§3.7).
- **Standard slicing mode ships here** (§3.0a): `slicing_mode` per-project (default `standard`);
  mode in the IR provenance + cache-key; mode-aware validator; standard-mode pipeline complete
  (slice → IR → postprocess → validate → preview). Non-planar S2/S3 (Sprint 11/12) enable
  `nonplanar` mode per-project, capability-gated.
- _Acceptance (S1):_ measured deltas vs. Anycubic Slicer Next reference on the fixed 3-part corpus
  within a **declared** budget — per-layer wall count (±0), infill volume (≤ declared %),
  bounding box (≤ declared mm). Each number declared _before_ the spike runs. Plus §3.0a
  acceptance: persisted per-project mode default `standard`; mode in cache key; validator
  rejects mode-inconsistent segments; no global mode setting.

### R3 — Harness v1 (BYOK + capability sandbox + learning journal)

- BYOK provider adapters (OpenAI-compatible + **local models first-class**, §8.5); broker egress
  pinning, per-provider quota/cost table; **AirRouter primary** (others optional / off by default).
- T1/T3a **WASI capability sandbox** (Wasmtime) + **mandatory external watchdog** (blocking host
  calls outlive epochs, §8.2); **bpy is not a T1/T3a workload** (§8.2). Generated tool lifecycle:
  manifest → scratch → build → test → approval (hash-bound) → registration → revocation (§8.3).
  T3b native = VM, **off by default on Windows** until the path ships (§8.2).
- **Continuous-learning journal v1 + deterministic safety box** (§3.5): immutable job records
  (input hashes, revisions, machine/material/environment, telemetry, timestamps, labels,
  uncertainty); retrieval vs parameter optimisation vs model training separated; offline
  validation holdout **by machine and by material**; shadow mode first, then bounded experiments,
  then promotion/rollback. **Safety limits are provably unmodifiable** (§3.5).
- Approval journal, spend tracking, provenance. Chat UI: context sources, token budget, approval
  cards. Prompt-injection posture: CAD/web/MCP/memory are untrusted input; **the model has no
  direct printer capability** (broker-issued, approval-gated, §7.4).
- MCP client: consume the existing repo MCP server (**preserved**, §2) + the new editor-domain
  MCP server (§8.7).
- _Acceptance:_ a generated Wasm tool runs only with **granted** capabilities (unrequested =
  denied); a learned parameter **outside** the safety box is **rejected** and journaled;
  a capability request that would touch a safety field is structurally impossible.

### R4 — Auth as a separable service + memory

- **Auth as a separable service** (§8.1): local mode (own `auth.db` + loopback service) **or**
  independent mode (own process/container + Postgres) — both first-class, selected at build.
  **Editor core runs with auth off** (no auth dependency). OAuth external-browser + PKCE (§8.2);
  no desktop DB credentials; auth tenant is **not** a printer credential.
- Global memory: provenance, `service_scope` (local-project / synced), retention, embeddings
  lifecycle (forget deletes source + derived). **Fail-closed synced reads when auth off**
  (empty, never another user's, §8.3).
- Multi-project workspaces with per-project context isolation.
- _Acceptance:_ with the auth process **killed**, local editing still works and **synced** memory
  reads return **empty** (not another user's, not a silent local fallback); the UI shows
  "synced memory unavailable (auth off)".

### R5 — Non-planar S2 (curved top surfaces)

- Height-field lifting over planar base, **slope rejection per machine profile** (capability-gated
  — not a global assumption), per-segment Z/E from the §3.3 derivation, **swept-envelope**
  collision (§5.1 `tool_envelope` — the full swept volume, not just a nozzle cone).
- **Non-planar mode goes live for curved-top here** (§3.0a): `slicing_mode = nonplanar` is
  enabled per-project **iff** the active profile declares `continuous_z.supported` + slope
  budget; selector disabled with the named missing capability when the profile cannot do it
  (never silent fallback to standard; cache invalidated on mode switch, §3.0a).
- G-code post-processing (per-machine, §3.7) + independent emitted-program validation
  (validator is mode-aware: Z-ramp in a `standard` job is rejected, §3.0a).
- **Validation coupons on the bundled reference profile `<MACHINE_TYPE>`** — referenced by
  placeholder only (cloud id `<PRINTER_ID>`, fw `<FW_VERSION>`); **continuous-Z firmware is a
  pre-flight requirement** — fail closed otherwise (§5.3). No product-hardware default.
- _Acceptance (S2):_ physical coupon on `<MACHINE_TYPE>`; measured layer-height deviation ≤
  declared budget; any profile lacking `continuous_z.supported` is **rejected pre-flight** (not
  degraded silently). Plus §3.0a acceptance: non-planar selector enabled iff profile declares
  capability; standard-mode jobs on a continuous-Z profile still slice as pure standard.

### R6 — Non-planar S3 (conformal / field-based)

- Deform/inverse-map **or** field-based (strategies 1/2, §3.1); **CurviSlicer algorithm studied
  from its published paper** (AGPL implementation = study only, **not** copied, §3.4 — no
  contamination claim, no clean-room claim).
- Solver integration (OSQP in Rust), **variable-thickness validation**.
- **`nonplanar` mode extends to conformal** (§3.0a): experimental feature flag;
  **art/decorative-only** until structural results are measured. Profile gating applies (slope
  budget + joint model); standard mode remains the default and is untouched.
- _Acceptance (S3):_ tolerance vs. planar-baseline deviation on the S1 corpus + 2 curved parts ≤
  declared budget; the feature is flagged art-only in the UI until structural acceptance is met.
  Standard-mode jobs keep slicing as pure standard regardless of flag state (§3.0a).

### R7 — Sandbox hardening (T3b VM) + S4 multi-axis research

- T3b **native untrusted execution in a VM**: Linux dev-VM first, Windows (Hyper-V isolated /
  Windows Sandbox) **deferred** — off by default on Windows until the path ships (§8.2). This is
  the only tier that isolates **native** model-generated code; T1/T3a (WASI) never cover it.
- S4 multi-axis: continuous multi-axis deposition on new hardware per the §5 joint/kinematic
  model (LinuxCNC 5-axis kinematics conventions as reference, cited §11); references S3-Slicer
  (BSD-3), Open5x (MIT), S4 (GPL-3.0, study), FullControl (GPL-3.0, inspiration). **The hardware
  must exist in the capability catalog** — no "any printer" claim (§5.3).
- _Acceptance (S4):_ defined at spike time against a profile that **actually exists** in the
  catalog, with a declared joint/rotary configuration; no claim is made for a profile absent
  from the catalog.

---

## 11. Key Unknowns and Open Questions (v2)

**[?] No **"latest version as of today"** or last-commit age is asserted anywhere in this
document.** v1's maintenance states (§3.2) are **historical from 2026-09-27** — re-verify
(record head commit / last release + check date) before any decision relies on them. Every
item below is unverified.

1. **Blender packaging (legal gate, §4.5).** Default = user-installed/discovered (no bundling
   obligations). Bundling (if ever chosen) triggers GPL redistribution obligations — close by
   legal review **before first public distribution**. Not a debate: the default is fixed; the
   gate is whether we ever ship bundled, and on what terms.
2. **bpy-on-Windows self-containedness (§4.3 option b).** Whether `make bpy` / `bpy_module.cmake`
   yields a usable self-contained bpy on Windows with a matched CPython is **unverified** —
   re-check against the pinned `BLENDER_VERSION` before depending on it. Baseline stays
   official full Blender under `-b` (option a).
3. **Kiri:Moto engine embeddability.** The engine's distribution/embedding terms are
   **unconfirmed** (the client app is MIT; the engine is a separate artifact — §3.4, §12,
   §13 `[BUG] Kiri license`). Confirm before any reuse decision. A **source-level adaptation
   of a permissively-licensed reference** is a valid fallback to reach parity when an _embed_
   is not possible under its terms — this is **not** a blanket rejection. If a permissive,
   _embeddable_ planar core is ever wanted, identify one and record its license terms — the
   real open question (not "MIT vs AGPL").
4. **Goose license.** v1 marked it "MIT?". **Do not guess** — read the actual LICENSE file
   before any reuse decision (§8.6).
5. **Per-profile non-planar capability.** Each candidate validation profile must declare
   `continuous_z` / max tilt / collision budget (else fail-closed, §5.3). Which **measured**
   values exist for the bundled reference profile `<MACHINE_TYPE>` are **not asserted here** —
   acquired per §5.2, never assumed. A physical coupon test is required before R5 claims
   support; no product-hardware default.
6. **Windows VM sandbox maturity (T3b).** Hyper-V isolated / Windows Sandbox for **native**
   untrusted code is high setup cost; **Linux dev-VM first, off by default on Windows** until
   shipped (§8.2, R7). A _scheduling_ unknown, not a design one.
7. **Parity corpus size / budgets.** All R1–R7 acceptance numbers are **proposed, not measured**
   — each spike declares its budget _before_ running; the corpus is versioned with expected
   outcomes captured from **native** snapshots (never the renderer, §4.2).
8. **Dual-mode isolation depth (consultor-validated patterns).** Mode-aware validator, cache
   key including mode, per-segment `mode` tags in IR, dedicated Z-ramp stage post-extrusion —
   all validated against Bambu/Cura/Prusa practice; the one open item is the **exact
   `slicing_mode` IR field + job-record schema key** to freeze (proposed: `standard` | `nonplanar`
   on the job record, segment `mode` tag on non-planar segments) — to freeze at R2/R5 with the
   acceptance criteria in §3.0a.

---

## 12. References

### Non-planar / multi-axis

- S3-Slicer: https://github.com/zhangty019/S3_DeformFDM (TOG 2022, BSD-3)
- CurviSlicer: https://github.com/mfx-inria/curvislicer (TOG 2019, AGPL-3.0)
- Zip-o-mat non-planar Slic3r: https://github.com/Zip-o-mat/Slic3r
- TeachingTech PrusaSlicer 2.6 non-planar port: https://github.com/teachingtechYT/PrusaSlicer
- RotBot Transform: https://github.com/RotBotSlicer/Transform
- ZHAW Nonplanar_Slicing: https://github.com/RotBotSlicer/Nonplanar_Slicing
- NeuralSlicer: https://github.com/RyanTaoLiu/NeuralSlicer (TOG 2024)
- Open5x: https://github.com/FreddieHong19/Open5x
- S4_Slicer: https://github.com/jyjblrd/S4_Slicer
- FullControl: https://github.com/FullControlXYZ/fullcontrol
- COMPAS slicer: https://github.com/compas-dev/compas_slicer
- Kiri:Moto: https://github.com/GridSpace/grid-apps — **client app MIT; engine distribution/embedding terms are separate and unconfirmed here** (§3.4, §13 `[BUG] Kiri license`). Do not treat as an MIT-embeddable engine.
- Multi-axis motion planning: https://github.com/zhangty019/MultiAxis_3DP_MotionPlanning
- Curved supports: https://github.com/zhangty019/Support_Generation_for_Curved_RoboFDM
- Reinforced FDM: https://guoxinfang.github.io/ReinforcedFDM.html
- Implicit MultiAxis: https://neelotpal-d.github.io/Implicit_MultiAxis/
- Hamburg non-planar research: https://tams.informatik.uni-hamburg.de/research/3d-printing/nonplanar_printing/

### Blender

- bpy limitations: https://docs.blender.org/api/current/info_advanced_blender_as_bpy.html
- Operator gotchas: https://docs.blender.org/api/current/info_gotchas_operators.html
- Threading gotchas: https://docs.blender.org/api/current/info_gotchas_threading.html
- BMesh API (Python accesses the same internal edit operations as native tools; selection flushing / state invariants — basis of §4.2 parity invariants and §4.1 "bpy = same C core"): https://docs.blender.org/api/current/bmesh.html
- Building a Python module (make bpy / bpy_module.cmake; matched-Python CPython build; documented headless limitations — §4.3 option b): https://developer.blender.org/docs/handbook/building_blender/python_module/
- Blender license (GPL redistribution + bpy script conditions; **not legal advice** — feeds §4.5 packaging gate): https://www.blender.org/about/license/
- Manifold: https://github.com/elalish/manifold (Apache-2.0)
- OpenCascade.js: https://github.com/xdengine/OpenCascade.js

### Shell / agent / sandbox

- Tauri 2 security: https://v2.tauri.app/security/
- Tauri sidecar: https://v2.tauri.app/develop/sidecar/
- Wasmtime security: https://docs.wasmtime.dev/security.html
- Wasmtime config (fuel/epochs limits): https://docs.rs/wasmtime/latest/wasmtime/struct.Config.html
- MCP security best practices: https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- Goose: https://github.com/block/goose
- Pydantic AI: https://pydantic.dev/docs/ai/overview/
- OWASP LLM prompt injection: https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
- Anthropic sandbox-runtime: https://github.com/anthropics/sandbox-runtime
- Windows DPAPI: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- SQLite when-to-use: https://www.sqlite.org/whentouse.html
- Tauri SQL plugin: https://v2.tauri.app/plugin/sql/
- Tauri Stronghold: https://v2.tauri.app/plugin/stronghold/
- RFC 8252 (OAuth native apps): https://www.rfc-editor.org/rfc/rfc8252
- Supabase Auth: https://supabase.com/docs/guides/auth
- MoveIt: https://moveit.picknik.ai/main/doc/concepts/motion_planning.html
- ConcurrentTrajOpt: https://github.com/Yongxue-Chen/ConcurrentTrajOpt
- LinuxCNC 5-axis kinematics: https://linuxcnc.org/docs/html/motion/5-axis-kinematics.html
- Klipper G-codes: https://www.klipper3d.org/G-Codes.html#manual_stepper
- Marlin G0/G1: https://marlinfw.org/docs/gcode/G000-G001.html

### Firmware / printer hardware references

- Kobra S1 specs (cited **only as evidence that an AnyCubic product line with a reference profile exists** — used as `<MACHINE_TYPE>` in v2, **not** as a product default): https://store.anycubic.com/products/kobra-s1
- Open3DViewer (import/view reference): https://github.com/kovacsv/Online3DViewer

---

## 13. Corrected Claims Log (v1 → v2, per explorer audit)

**[NOTE]** Each `[BUG]` records a **false/over-strong v1 claim**, its correction, inline-referenced
evidence, and status. These are the specific claims the 2026-09-28 revision resolves; they are
**not** a list of open work items.

**[BUG] STEP bbox (v1 overstated STEP/IGES as "read (via OCCT — lossy)")**

- **What v1 said:** STEP/IGES import is a supported, if lossy, read path ("OCCT can read STEP —
  lossy, but present").
- **Correction:** The current in-repo STEP path is **bbox-only** — on **Node 24**, the real OCCT
  path is skipped and a **bbox cuboid** is exported; on older Node, a **single-face mesh** (or
  that same bbox) is produced. OCCT reads STEP **as BRep**, not as mesh, and the mesh→BRep
  route is lossy. **This document does not claim Blender natively handles STEP/IGES** (it does
  not, without an add-on), and OCCT is **conversion-only** (not a modeling kernel) (§4.4).
- **Evidence:** `scripts/cad-step-export.mjs` (bbox path + Node-24 fallback); OpenCascade.js /
  replicad / Blender-BSTEP are all OCCT-family (lossy mesh→BRep). Marked in §2.1 `[BUG]` row.
- **Status:** v1 claim **reversed** in v2; STEP/IGES = **optional conversion tier** (manually
  re-checked at each use).

**[BUG] Kiri license (v1: "MIT, embeddable")**

- **What v1 said:** Kiri:Moto is MIT and can be **embedded** as a planar engine.
- **Correction:** Only the **client app** of grid-apps is MIT; the **engine is not MIT-**
  embeddable (distribution terms are separate and unconfirmed here). **Kiri:Moto / libSlic3r
  are reference-only** for the own planar core (§3, §3.4, §11-3, matrix row). The real open
  question is finding a **permissive, embeddable** planar core — not "MIT vs AGPL".
- **Evidence:** §3.4 license diligence; §11.3; §9 matrix "Slicing (planar)" row.
- **Status:** v1 decision **reversed**; own core + references only.

**[BUG] Kobra-as-default (v1: "Validation on Kobra S1" as product assumption)**

- **What v1 said:** Non-planar validation is on the **Kobra S1**, treated as the product's
  reference/default machine (multiple v1 locations: §1, §9, and the N-stage coupon wording).
- **Correction:** The target is **agnostic** — validation runs on **any profile that passes the
  capability contract (§5.3)**. The Kobra S1 is **evidence that a reference product line
  exists**, used only here as `<MACHINE_TYPE>` placeholders (cloud id `<PRINTER_ID>`, fw
  `<FW_VERSION>`). Continuous-Z firmware is a **pre-flight requirement** only for the
  **non-planar** S2/S3 strategies that need it — **fail closed** otherwise (§5.3, §11-5); it is
  **not** required of planar profiles. No "funded by the team's own hardware" default is
  asserted — that would re-introduce an implicit hardware default (§5.3).
- **Evidence:** §5.3 (no-any-printer restatement); R5 acceptance (coupon on `<MACHINE_TYPE>`).
- **Status:** v1 default **removed**; reference profile only, fail-closed otherwise.

**[BUG] Auth file-only (v1: "separate auth.db file" as the separateness design)**

- **What v1 said:** Separateness = a **separate `auth.db` file** (v1 §10.3: a separate server
  process is "over-engineering for local-first").
- **Correction:** Auth is a **separably-deployable service** — own process/container, own store.
  Two **first-class** deployments: local (`auth.db` behind a loopback service) **and** independent
  (own service + Postgres). The editor core has **no auth dependency**; the file is _one_
  backend _behind the auth API_, not the API itself (§6.1, §6.4). **No silent "file only"**
  settlement.
- **Evidence:** §6.1 storage table + design-decision NOTE; §6.4 schema per deployment; R4
  acceptance (auth-off fail-closed).
- **Status:** v1 framing **superseded**.

**[BUG] AGPL wording (v1: "linking AGPL contaminates the project")**

- **What v1 said:** Using libSlic3r/AGPL code **contaminates** the project / triggers clean-room
  obligations.
- **Correction:** The **"contamination" framing and clean-room legal claims are removed.** What
  remains is a **plain license-diligence** statement: each reused research artifact is tracked
  **per artifact** with its license and an "allowed for (a) build / (b) reference" decision
  (§3.4). AGPL artifacts may be **studied** (algorithm-level, from published work) but not
  **copied** (§3.4, R6). No legal claim about "contamination" or "clean room" is made.
- **Evidence:** §3.4; R6 (CurviSlicer = study from paper, not copy).
- **Status:** v1 wording **removed**.

**[BUG] T2 chroot-sandbox (v1: "process boundary + chroot = adequate for untrusted CAD")**

- **What v1 said:** T2 "process isolation + chroot" is a sufficient sandbox for untrusted
  model-authored native code.
- **Correction:** A **process is not a sandbox**, and **Windows has no chroot.** T2 fault
  containment (crash/leak isolation) is **not** a security boundary against native untrusted
  code. T2 is **restricted to trusted first-party** pinned Blender + OCCT (fault containment
  only). **Native untrusted code requires T3b (a real VM)**, off by default on Windows (§8.2). WASI
  (T1/T3a) is capability isolation via **imports**, and it does **not** cover native Python/bpy
  (§8.2).
- **Evidence:** Wasmtime security docs (imports/capabilities; epochs cannot interrupt a blocked
  host call → watchdog mandatory); §8.2 tier table (corrected).
- **Status:** v1 tier model **corrected**.

**[BUG] Blender optional worker (v1: "Blender is an optional worker; app works without Blender")**

- **What v1 said:** Blender is an **optional** worker; the app must **work without** Blender.
- **Correction:** Blender is the **required primary modeling backend** and **geometry authority**
  (§4.1). **Works-without-Blender is not a goal; it is a hard prerequisite.** The scene lives in
  Blender (native, persistent); the React viewport is a **view** (§7.4). Legacy "our Rust/TS
  domain layer owns object model/undo/selection" is **retired** (§1.1, §7.4 correction).
- **Evidence:** BMesh API (bpy = same internal edit ops as native tools); §4.1 decision;
  §7.4 view model.
- **Status:** v1 stance **reversed**.

### 13.1 Placeholder-compliance check (AGENTS.md)

**[NOTE]** The statuses below are **design-level review statements only** — sanitizer and test
runs were **not executed at authoring time**; compliance is established by the pre-push
verification below, not by this table.

| Rule                                                | Where enforced in this doc                                                                    | Status                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| No `C:\Users\<x>`, no real usernames/hosts          | All machine/config values use `<…>` placeholders (§5.1, §8.5, §6.1)                           | **Not verified (design review only)** |
| No LAN IPs `192.168.x.x` / `10.x` / `172.16-31.x`   | §5.1 JSON uses `127.0.0.1` (loopback) / placeholders only                                     | **Not verified (design review only)** |
| No real printer/task/gcode/user ids                 | §5.1 uses `0` / `"redacted"` / `<ID>`; Kobra S1 only as `<MACHINE_TYPE>` evidence (§13)       | **Not verified (design review only)** |
| No device keys / tokens / JWT                       | §8.5 broker-keystore rule; §6.1 "BYOK keys never in any DB"                                   | **Not verified (design review only)** |
| JSON parseable (synthetic values, no `<X>` in JSON) | §5.1 JSON uses `0` / `""` / `"redacted"` / `127.0.0.1`, no angle-bracket tokens               | **Not verified (design review only)** |
| Env vars for machine-specific config                | AGENTS.md §4 `ANYCUBIC_*` env-var list + `tools/HEADLESS-RENDER.md` (`BLENDER_EXE` discovery) | **Not verified (design review only)** |
| `tests/` fixtures allowed                           | Not touched by this doc                                                                       | **N/A** (no check run)                |

> **Final verification before push (not part of this doc's edits):** run `node
scripts/sanitize-repo.mjs --dry-run` and `node --test "tests/*.test.mjs"` (no code touched by
> this revision). None of the §13.1 statuses above were executed — pass/fail is established by
> those pre-push runs, not by this table. See §14.

---

## 14. Changelog

- **v1.0 (2026-09-27).** Original investigation: 4-stage staged architecture (N0–N4), Blender
  as _optional_ worker, Kiri:Moto/libSlic3r embed decision, Kobra S1 as validation default,
  separate `auth.db` framing, T1–T3 sandbox tiers, BYOK + memory UI, references and unknowns.
- **v2.0.0 (2026-09-28).** Revision resolving the explorer audit: (1) **legacy editor UI +
  geometric authoring fully replaced** (retire `ui/cad.html` scene; **no legacy runtime
  fallback**); printer/cloud/MCP contracts **preserved independently** (§1.1, §2, matrix);
  (2) **Blender = required primary modeling backend / geometry authority** with a Blender-style
  workflow _target_ (not a promise), build options compared, STEP/IGES honesty, legal gate,
  modal-IPC + undo-replay + stale-revision contract (§4); (3) **own non-planar engine** with
  three strategies, the extrusion correction _with limitations_, multi-artifact license
  diligence (no contamination claims), bounded continuous learning, hard constraints, pipeline,
  and testable spikes (§3); (4) **detailed versioned machine capability contract** with
  synthetic-value JSON, fail-closed, qualification + revocation, no-any-printer (§5); (5) the
  §8 harness (sandbox, BYOK, prompt-injection, tool lifecycle, MCP) with the T2
  correction, mandatory watchdog, and the capability-based generated-tool lifecycle; (6) **
  data + auth as a separable service** (both stores first-class; editor core auth-free) + OAuth
  PKCE + fail-closed memory + per-deployment schema (§6); (7) **reuse/build/retire matrix**
  rebuilt (including the retired-legacy row + the new machine-contract / learning / harness /
  auth rows) (§9); (8) **roadmap** with independently-shippable R0–R7 each carrying a _testable
  acceptance_ (§10); (9) **unknowns** reframed with no "latest-version" claims (§11); (10)
  **references** extended (bmesh, python_module build, blender.org license, Kiri:Moto caveat,
  Goose unverified) (§12); (11) this **corrected-claims log** (§13). No runtime editor
  code was written or deleted by this revision.
- **v2.0.1 (2026-09-28, planning follow-up — dual-mode requirement).** User-confirmed: the
  slicer must offer BOTH a standard (planar) mode (default, always available) AND an opt-in
  non-planar mode, selectable per project. Investigation updated: new §3.0a (Slicing modes
  SPEC), roadmap R0/R2/R5/R6 adjustments (mode persisted at R0; standard mode ships at R2 as
  the default; non-planar S2/S3 come online as capability-gated per-project opt-in), §11
  unknowns +8, and the §9 matrix "Slicing (planar)" row extended to state both modes are
  first-class. Design validated by the Consultor (AirRouter) against Bambu/Cura/Prusa mode
  patterns; kept one engine / one IR / one validator with a runtime feature flag — no separate
  binaries.
