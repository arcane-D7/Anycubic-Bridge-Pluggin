# SOLID & DRY Rules — Repository Doctrine

> **Sprint 5 / S5-004.** These rules are enforced by `scripts/check-architecture.mjs`
> and documented here so reviewers can cite them. They apply to the NEW workspace
> (`apps/editor`, `crates/*`) and, where noted, the preserved root.

## 1. Single Responsibility (SRP)

Each module owns exactly one axis of change:

| Module                                               | Responsibility                                          | Multiple-change test                                  |
| ---------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Engine modules (`crates/engine`, `crates/nonplanar`) | Pure geometry/slicing math — no I/O, no UI, no secrets  | Changing a formula must not touch a registration file |
| MCP tool adapters                                    | Thin adapters map capability calls ↔ schema validation  | Adding a tool must not change engine math             |
| Broker (`crates/broker`)                             | Orchestration, approvals, job lifecycle, keystore       | Printer logic must not live in the UI                 |
| Planner kernels (`crates/*`)                         | Own the slicing-mode algorithms (standard + non-planar) | Modes register via registry, never if/switch spam     |

## 2. Open/Closed (OCP)

Extension points are **registries**:

- **Capability registry** (`broker.declareCapability(name, handler)`) — new engine
  features register; no engine switch bloat.
- **Tool registry** (`broker.registerTools(defs)`) — new MCP tools register with a
  `requires: capabilityName`; registration fails if the capability is undeclared
  (fail-closed, see integration test).
- **Slicing-mode registry** — a mode (`standard` | `nonplanar`) registers its
  generator + validator pair; the engine is closed for modification, open for
  extension.

## 3. Interface Segregation (ISP)

Harness tiers **T0/T1/T2/T3a/T3b** have separate surfaces:

- T0/T1 (local/integrated) never grant anything T3a/T3b gets.
- T2 (Blender worker) exposes only the **named geometry capabilities** through the
  broker proxy — **no raw Blender handle**, no bpy import outside the worker.
- T3a/T3b (generated code / VM) are native-level isolated; bpy is **excluded**
  from sandboxed tiers entirely.

## 4. Dependency Inversion (DIP)

- The **broker owns secrets** (BYOK keystore). No other layer touches
  `process.env.ANYCUBIC_*` or the keystore.
- Tools depend on **capability names** (`geometry.kernel`, `slice.standard`,
  `slice.nonplanar`), never on another module's internals.
- UI depends on broker IPC; broker depends on engine via trait/lib boundary;
  engine depends on nothing external.

## 5. DRY — with a measured limit

- Shared zod schemas live in `schemas/`; register*Tools files must **import** them,
  not inline duplicates (enforced by `check-architecture.mjs`).
- Geometry math (Z/E per segment §3.3) exists once, in the engine.
- **Banned marker**: `// DESIGN: duplicated on purpose` is NOT an acceptable
  justification anywhere in the workspace (enforced by `check-architecture.mjs`).

## How to review

Opening a PR? Run `pnpm run check:architecture`. Passing means: no UI→DB import,
no secret outside broker/keystore, no inline schema block in a register file, and
no banned duplication marker.
