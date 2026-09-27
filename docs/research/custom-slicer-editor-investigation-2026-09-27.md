# Custom Slicer Investigation — React/Tauri UI, Non-Planar Slicing, Blender-Style Editing, BYOK Agent Harness

Date: 2026-09-27
Status: architecture investigation completed; no implementation in this commit
Scope: desktop 3D-printing-focused editor/slicer with React + Tauri shell, Blender-like object editing, non-planar slicing research path, headless-Blender backend option, BYOK LLM integration, MCP/plugin ecosystem reuse, specialized 3D-printing harness with sandbox, chat/context/global-memory UI, separate auth database.

---

## 1. Executive Summary

The current repository is **not** a desktop editor — it is a mature Node/MCP control plane over
Anycubic Slicer Next, a cloud/LAN printer stack, and an in-memory CAD workspace with Three.js UI.
The requested product is a **new application** that should *reuse* this MCP contract as one of its
foundations, not attempt to absorb the whole repo into a UI.

Three conclusions drive the recommended architecture:

1. **Non-planar slicing on stock fixed-Z hardware is research-grade, not product-grade.**
   The only actively-maintained software path to non-planar G-code on a 3-axis printer is
   FullControl (scripted toolpaths) and COMPAS slicer (curved layers, G-code export, no collision
   system). CurviSlicer and the Zip-o-mat lineage work on 3-axis printers but are unmaintained
   research prototypes. S3-Slicer, NeuralSlicer, Open5x and S4 require multi-axis hardware.
   The realistic staged plan is: planar-first engine, then top-surface curved finishing
   (Hamburg/Zip-o-mat approach), then conformal layers via CurviSlicer-style deformation,
   and only then multi-axis — on new hardware, not the Kobra S1.

2. **Blender headless is a legitimate optional geometry worker, not the editor.**
   bpy in background mode is production-ready for boolean ops, modifiers, mesh repair, and
   conversion, but is context-sensitive, single-threaded per process, and provides no embeddable
   UI. Selection, gizmos, snapping, transforms, undo, and modifier stacks must be implemented in
   our own React/Rust domain layer regardless. Blender should be an optional, process-isolated
   worker behind our own command contract — never the identity of the app.

3. **Agent autonomy requires a permission broker, not a sandbox UI.**
   The existing CAD "sandbox" is a lexical denylist around `new Function` — it is not isolation.
   The correct pattern is Tauri/Rust as trusted policy broker: BYOK keys never leave the broker,
   model actions are typed *proposals*, execution happens in bounded workers (WASI for procedural
   scripts, process workers for Blender, VMs for arbitrary native code later), and every
   committed effect is journaled with provenance and undo.

---

## 2. What We Already Have (Verified Repository Audit)

### 2.1 Reusable foundations

| Capability | Location | Notes |
|---|---|---|
| Parametric solids (box/cylinder/sphere/cone/extrude/boolean) | `scripts/cad-parametric-engine.mjs` | manifold-3d, manifoldCAD entry |
| Mesh CSG | `scripts/cad-csg-engine.mjs` | three-bvh-csg, requires `uv` attribute |
| STEP export (partial) | `scripts/cad-step-export.mjs` | replicad OCCT WASM throws on Node 24 → STL fallback |
| Arrange / plate packing | `scripts/cad-arrange.mjs`, `cad-arrange-utils.mjs` | pure functions, tested |
| 3MF read/import | `scripts/read-3mf.mjs`, `import-3mf-mesh.mjs` | custom zip + XML parse, validated on real projects |
| Slicer CLI adapter | `scripts/slicer-cli.mjs` | discover/preset/args/run/collect/compat-validate |
| Slicer GUI adapter | `scripts/slice-via-app.mjs` | UIA allowlisted actions |
| Agentic slicer control | `scripts/slicer-tools.mjs`, `slicer-live-settings.mjs`, `slicer-operation-log.mjs` | live snapshot/rollback, preflight, plan, history, capability catalog |
| MCP surface | `vendor/server.mjs`, `schemas/tools.json`, `schemas/openapi.json` | ~100 tools, confirmation-gated writes |
| CAD workspace REST/SSE | `vendor/server.mjs` handleApi | loopback-only, per-session token, SSE revisions |
| Auth/credentials | `scripts/auth-login.mjs`, `token-crypt.ps1` | DPAPI Windows, cloud token storage |
| LLM translation | `scripts/cad-ai-translator.mjs` | BYOK (CAD_AI_API_KEY/BASE_URL/MODEL), OpenAI-compatible |

### 2.2 Known gaps for the target product

- No React/TypeScript renderer; `ui/cad.html` is a single-file Three.js app with CDN imports.
- No Tauri project; existing ADRs (`docs/adr-electron-shell.md`) chose Electron for the *bridge*,
  which remains valid there — Tauri is for the *new* editor app, not a rewrite of the bridge.
- No durable project model: in-memory singleton scene, no snapshots, no autosave, no undo graph,
  no stable object IDs, no versioned schema.
- No printer-profile-driven build volume/capability model in the CAD UI (hardcoded 220x220).
- Sandbox is lexical, not process/WASI isolation.
- No separate auth database; token storage is Windows-DPAPI only.
- No global memory system; no chat/conversation persistence.
- No non-planar capability at all.
- `package.json` still references `src/index.ts` which does not exist (doc/runtime drift).

---

## 3. Non-Planar Slicing — Evidence and Staged Path

### 3.1 Landscape verdicts (verified 2026-09-27)

| Project | Maintenance | License | Production-ready | Works on stock 3-axis printer |
|---|---|---|---|---|
| S3-Slicer (`zhangty019/S3_DeformFDM`) | dormant, 1 contributor | BSD-3 | No | No (multi-axis/robot only) |
| CurviSlicer (`mfx-inria/curvislicer`) | low, ~1 yr | AGPL-3.0 | No ("research prototype") | **Yes** — 3-axis, best on deltas, needs ~45° nozzle cone |
| Zip-o-mat Slic3r nonplanar | dead, 3 yrs | AGPL-3.0 | No | **Yes** — top-surface only |
| → teachingtechYT PrusaSlicer 2.6 port | alpha, 2 yrs | AGPL-3.0 | No | **Yes** — top-surface only |
| RotBot Transform / ZHAW | dead / partial | GPL-3.0 | No | **Yes** — conical transform, any printer, small tilt angles |
| NeuralSlicer | dormant, 2 yrs | GPL-3.0 | No | No (needs S3 + CUDA) |
| Open5x | dormant, 2 yrs | MIT | No | No (adds 2 rotary axes) |
| FullControl | **active** (3 weeks) | GPL-3.0 | Yes (scripted toolpaths) | **Yes** — native non-planar by construction, but you author paths |
| COMPAS slicer | **active** (6 mo) | MIT | Research/AEC-grade | **Partial** — curved layers + G-code, no collision system |
| S4_Slicer | low, 1 yr | GPL-3.0 | No | Not directly (4-axis Core R-Theta) |
| Kiri:Moto (grid-apps) | **active** (v4.7.3) | MIT | Yes (planar) | No non-planar FDM; belt mode is 45° planar |

### 3.2 Staged implementation path

**Stage N0 — planar baseline (own the slicer core, not just orchestrate).**
Build or embed a planar slicer core that *we own* so non-planar becomes an extension, not a fork.
Candidates to embed rather than reimplement: Kiri:Moto engine (MIT, permissive, embeddable worker)
or libSlic3r-derived C++ core behind a Rust/FFI boundary. PrusaSlicer stays the "reference
validation" slicer for firmware-compatible output on Anycubic — it does not become our engine.

**Stage N1 — top-surface curved finishing (3-axis, Kobra S1-compatible in principle).**
Hamburg/Zip-o-mat approach: planar interior, curved top layers, printable-region detection,
collision check against nozzle cone. This is the highest-value, lowest-risk non-planar feature and
the only one with any real-world community usage today. Requires: mesh→heightfield lifting,
slope threshold rejection, travel-move clearance checks, G-code Z/E recomputation per segment.

**Stage N2 — conformal curved layers (3-axis, experimental).**
CurviSlicer-style: deform model to planar space, slice conventionally, inverse-map. Requires
OSQP or Gurobi-equivalent solver, variable-thickness validation, and the maintainer's documented
constraint that deformed-space layer height must stay fixed or collisions/violations occur.
Target: decorative/art parts, not structural.

**Stage N3 — multi-axis (future hardware).**
S3-Slicer (BSD-3 — cleanest license for a product), NeuralSlicer, Open5x, S4 references.
Requires adding rotary axes; Kobra S1 firmware has no coordinated extra-axis support. Marlin
2.0.9+ A/B/C, Klipper MANUAL_STEPPER/GCODE_AXIS, LinuxCNC 5-axis kinematics are the firmware
substrates. Motion planning references: `zhangty019/MultiAxis_3DP_MotionPlanning` (RA-L 2021,
singularity-aware, collision graph search), ConcurrentTrajOpt. MoveIt for infrastructure.

**Stage N4 — curved supports and force-aware deposition (research).**
`zhangty019/Support_Generation_for_Curved_RoboFDM` (ICRA 2023), force-based adaptive deposition
(Huang et al. 2025/2026, UR5e + Duet). Not on the S1 path.

### 3.3 Hard constraints regardless of stage

- Extrusion must be recomputed from real 3D path length and local bead cross-section — reusing
  planar E values produces over/under-extrusion immediately on any slope.
- Collision checking must be swept-volume against evolving print + supports + fixtures + gantry,
  not point checks.
- Deposition physics (Z dynamics, pressure response, cooling at variable height) dominates
  quality on curved layers; dimensional results degrade before visual results do.
- Every generated path needs a deterministic, reproducible intermediate representation before
  machine postprocessing (position, tool orientation, deposition params, frames, provenance).

---

## 4. Blender Integration — Evidence and Decision

### 4.1 What bpy/headless provides (verified)

- Background mode (`blender -b`) runs Python reliably; modifiers, boolean, mesh ops, conversion,
  rendering all work headless.
- bpy is **context-sensitive** (operators depend on active object/mode) — use `bpy.data`/BMesh
  APIs, not UI operators, for deterministic automation.
- Python threading is unsupported in Blender; one process = one state. Parallelism = N processes.
- No embeddable UI: gizmos, snapping, edit-mode interactions, modifier panels, undo stack are
  application-level work regardless of backend.
- Licensing: GPL; subprocess separation does not automatically resolve distribution obligations.
  Bundled-Blender vs user-installed-Blender must be a deliberate licensing decision.

### 4.2 Decision

**Blender is an optional, process-isolated worker**, spawned on demand with a command contract
(JSON requests over stdio), pinned to user-installed or explicitly user-authorized Blender
installations. It is used for: heavy mesh repair, modifier-stack evaluation, boolean batches we
don't want in WASM, STEP/IGES interop we can't do with replicad, and rendering previews.
It is **not** used for: the object model, undo, selection, transforms — those live in our
Rust/TypeScript domain layer so the app works identically without Blender installed.

Geometry kernel tier list for our own core:

| Tier | Component | Role |
|---|---|---|
| Core (WASM, in-worker) | Manifold | boolean/CSG guarantee for manifold meshes — Apache-2.0 |
| Core (WASM, in-worker) | three-bvh-csg | fast mesh CSG for interactive editing |
| Optional worker (process) | Blender bpy | repair, modifiers, conversion, render |
| Optional worker (process) | OCCT via OpenCascade.js or replicad | STEP/IGES/BRep for CAD-grade parts |
| Core (Rust, later) | custom slicing kernels | planar → non-planar stages above |

---

## 5. Harness, Sandbox, BYOK, MCP — Architecture

### 5.1 Trust model

The existing repo's distinction is worth carrying forward verbatim:

- **Orchestration is not authorization.** Model says "run this"; broker decides if it may.
- **Process separation is not sandboxing.** A child process with user privileges is not isolated.
- **MCP is interoperability, not isolation.** Local MCP servers inherit client privileges.

### 5.2 Tiered execution sandbox

| Tier | Content | Isolation | Limits |
|---|---|---|---|
| T0 | Read-only inspection tools (property maps, catalogs, scene queries) | in-broker, no side effects | n/a |
| T1 | Procedural CAD scripts (parametric, mesh transforms, model-authored geometry) | Wasmtime WASI worker | fuel/epochs + external wall-clock deadline, memory cap, no net, no fs except injected scratch |
| T2 | Blender/OCCT/geometry workers | OS process, spawned per job, chroot-equivalent scratch dir, no secrets in env | wall clock, output-size cap, killable |
| T3 | Arbitrary model-authored tools/plugins | dedicated VM (Hyper-V/Windows containers later); deny-by-default | full deny list, network allowlist, resource quotas |

Critical Wasmtime caveat: fuel/epochs **cannot interrupt blocking host calls** — every WASI
worker must have an external watchdog process regardless.

### 5.3 BYOK and provider adapters

- Keys live only in the Rust broker, protected by OS keystore (Windows DPAPI/Stronghold) —
  never in prompts, checkpoints, memory embeddings, or worker environments.
- Destination-bound: each key is pinned to approved base URLs; provider changes require consent.
- BYOK adapter contract mirrors existing `cad-ai-translator.mjs` (OpenAI-compatible base URL +
  model) but generalizes to multi-provider with per-model capability discovery.
- Local models (Ollama/LM Studio/vLLM) are first-class — same adapter, loopback-only base URL.

### 5.4 Agent runtime

- **Goose** (`block/goose`, Rust, maintained) is the closest reusable runtime for BYOK + MCP —
  reuse as an *adapter/reference*, not as the product shell.
- **Pydantic AI** for typed multi-provider calls if a Python-side agent loop is ever needed.
- LangGraph only if durable replayable workflows become a requirement (mutations must tolerate
  replay — dangerous for side-effectful CAD ops; prefer our own journal).

### 5.5 MCP ecosystem reuse

The existing ~100-tool MCP surface becomes a **tool provider** to the new harness, consumed via
standard MCP stdio — the same way any external client uses it today. New app adds its own
editor-domain MCP server (scene ops, project ops, non-planar slicing) so external agents can
also drive the editor. Version-pin every MCP server; show exact startup commands before
enabling; re-approve on any privilege/transport change.

### 5.6 Approval UX

Approve **effects**, not effort: show the exact geometry diff / file write / outbound data /
spend. Allow-once, allow-session, allow-project scopes. Destructive actions (delete objects,
overwrite projects, printer commands) always explicit. Sandbox execution approval is separate
from artifact-commit approval. Every approval is journaled with model, provider, prompt hash,
tool args hash, input revision, and outcome.

---

## 6. Data, Auth, Memory

### 6.1 Databases

| Concern | Store | Notes |
|---|---|---|
| Projects, scene ops, undo journal, chat, context, memory | SQLite (Rust-owned, e.g. rusqlite) | single-writer, embedded, perfect fit |
| Auth/identity | **separate SQLite database file** (or optional Postgres later) | separation is for data hygiene/migration, not security; real boundary is broker ownership |
| BYOK keys | OS keystore via broker (Stronghold/DPAPI) | never in DB |
| Geometry artifacts | content-addressed files (hash → blob) outside DB, referenced by ID | keeps DB small, enables dedupe |
| Optional cloud sync | Postgres + Supabase Auth, OAuth PKCE (RFC 8252) | opt-in; offline editing never requires login |

### 6.2 Memory system

- Project-scoped context by default; global memory only stores user-approved preferences/facts.
- Every memory entry carries provenance (source, model, revision, timestamp, scope, retention).
- Retrieval is filtered by scope before injection into prompts; embeddings/summaries are derived
  artifacts deleted when the source memory is deleted.
- Memory **never grants permissions** — it is data, not authority.
- UI must make memory visible, editable, and deletable per entry.

### 6.3 Auth DB schema sketch

Separate file (e.g. `auth.db` vs `workspace.db`): users, sessions (local device sessions),
providers (BYOK records — key refs, not keys), scopes/roles, audit_log (approvals, denials,
tool executions), sync_state. Local-first: app is fully usable with zero users configured
(single anonymous local profile), auth layer activates only for sync/multi-user features.

---

## 7. UI Architecture (React + Tauri)

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

### 7.3 Chat/context/memory UI requirements

- Context sources shown explicitly (which memories, which scene state, which files were injected).
- Token budget meter per request.
- Approval cards rendered inline in chat, each showing the concrete effect and scope.
- Global memory browser with per-entry provenance and delete.
- BYOK provider/model picker with per-key health, spend tracking, and rate-limit feedback.

---

## 8. Reuse / Build-from-Scratch Decision Matrix

| Capability | Reuse source | Build vs reuse | Notes |
|---|---|---|---|
| MCP tool surface (printer/cloud/slicer) | this repo | **Reuse as-is** via stdio MCP | ~100 validated tools |
| Parametric + CSG kernels | manifold-3d, three-bvh-csg | Reuse (WASM) | Already in repo |
| Arrange/packing | `cad-arrange.mjs` | Port to TS/Rust | Pure functions |
| 3MF read/write | `read-3mf.mjs` | Port + extend | Needs write support for editor |
| Slicing (planar) | Kiri:Moto engine or libSlic3r | **Embed** | MIT / AGPL decision needed |
| Slicing (planar, Anycubic-compatible output) | Anycubic Slicer Next CLI/GUI via existing adapters | Reuse (external) | Firmware-compat constraint |
| Non-planar stage N1 | Zip-o-mat/teachingtech approach | **Build from scratch** | Reference implementations are unmaintained |
| Non-planar stage N2 | CurviSlicer (AGPL) | Study, likely re-implement | AGPL contaminates; algorithm is published |
| Multi-axis (future) | S3-Slicer (BSD-3) | Build on top | Cleanest license |
| Toolpath designer | FullControl (GPL) | Inspiration only | GPL |
| Curved layers, robotic | COMPAS slicer (MIT) | Reference | Python/robotic focus |
| Agent runtime | Goose (MIT?) | Adapter/reference | Not the product shell |
| BYOK translation | `cad-ai-translator.mjs` | Generalize | Already BYOK |
| Blender worker | Blender bpy | Reuse as optional worker | License review needed |
| Auth DB | Build | **From scratch** | Small, local-first |
| UI | Build (React 19 + R3F 9) | **From scratch** | No existing React base |

---

## 9. Roadmap (Staged, Each Independently Shippable)

### R0 — Foundation (desktop shell + domain model)
- Tauri 2 + React 19 scaffold, Rust broker skeleton, SQLite workspace.db + auth.db.
- Versioned project schema (objects, ops, undo, revisions), content-addressed artifacts.
- Scene state fully in Rust; React renderer is a pure view.
- Loopback REST/SSE bridge to existing Node server for slicer/MCP tools (temporary).

### R1 — Editing core
- Viewport (R3F) with gizmos, selection, transforms, snapping.
- Object tree, materials/filaments per printer profile, build volume from profile (not hardcoded).
- Undo/redo graph, autosave, crash recovery.
- Import: STL/OBJ/3MF/glTF. Export: STL/OBJ/3MF/glTF.
- Optional Blender worker (spawn, stdio JSON, timeout, kill).

### R2 — Planar slicing (owned engine)
- Embed Kiri:Moto or libSlic3r core behind Rust worker.
- Profiles system (machine/process/filament) — import from existing presets where possible.
- Layer preview, per-layer toolpaths, infill/walls visualization.
- G-code export + compatibility validation against Anycubic reference slicer.

### R3 — Harness v1
- BYOK provider adapters (OpenAI-compatible + Anthropic + local).
- T1 WASI sandbox for procedural CAD scripts (replaces lexical denylist).
- Approval journal, spend tracking, provenance.
- Chat UI with context sources, token budget, approval cards.
- MCP client: consume existing repo MCP server + new editor MCP server.

### R4 — Memory + auth
- Global memory with provenance, scopes, retention, embedding lifecycle.
- auth.db + local sessions; optional Supabase sync behind explicit login.
- Multi-project workspaces with per-project context isolation.

### R5 — Non-planar N1 (curved top surfaces)
- Height-field lifting over planar base, slope rejection, nozzle-cone collision checks.
- G-code post-processing with per-segment Z/E recomputation.
- Validation coupons on Kobra S1.

### R6 — Non-planar N2 (conformal layers)
- Deform/inverse-map pipeline (CurviSlicer algorithm re-implementation, avoid AGPL).
- Solver integration (OSQP in Rust), thickness validation.
- Experimental feature flag, art/decorative parts only.

### R7 — T2/T3 sandbox hardening + multi-axis research
- VM-based execution for arbitrary model-authored tools.
- S3-Slicer-based multi-axis exploration against new hardware (not S1).

---

## 10. Key Unknowns and Open Questions

1. **Planar engine choice** — Kiri:Moto (MIT, JS worker, embeds naturally in Tauri webview
   runtime but not in Rust core) vs libSlic3r (C++, AGPL, native FFI, battle-tested). License
   posture and Rust-vs-JS worker split decide this. Needs a dedicated spike.
2. **Blender licensing posture** — user-installed (no bundling obligations, worse UX) vs bundled
   (GPL obligations for distribution). Must be decided before R1 ships publicly.
3. **Auth DB "separateness"** — user asked for separate DB; confirm whether this means separate
   SQLite file (recommended) or a separate server process (over-engineering for local-first).
4. **Non-planar validation hardware** — Kobra S1 accepts curved top-surface G-code only if
   firmware interpolates continuous Z properly during the curved region; needs a physical coupon
   test before R5 claims support.
5. **Windows VM sandbox maturity** — Hyper-V isolated Windows containers for T3 tier have
   significant setup cost; may defer T3 to Linux dev-VM only initially.

---

## 11. References

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
- Kiri:Moto: https://github.com/GridSpace/grid-apps (MIT)
- Multi-axis motion planning: https://github.com/zhangty019/MultiAxis_3DP_MotionPlanning
- Curved supports: https://github.com/zhangty019/Support_Generation_for_Curved_RoboFDM
- Reinforced FDM: https://guoxinfang.github.io/ReinforcedFDM.html
- Implicit MultiAxis: https://neelotpal-d.github.io/Implicit_MultiAxis/
- Hamburg non-planar research: https://tams.informatik.uni-hamburg.de/research/3d-printing/nonplanar_printing/

### Blender
- bpy limitations: https://docs.blender.org/api/current/info_advanced_blender_as_bpy.html
- Operator gotchas: https://docs.blender.org/api/current/info_gotchas_operators.html
- Threading gotchas: https://docs.blender.org/api/current/info_gotchas_threading.html
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
- Kobra S1 specs: https://store.anycubic.com/products/kobra-s1
- Open3DViewer (import/view reference): https://github.com/kovacsv/Online3DViewer
