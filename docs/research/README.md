# Research Archive

This directory contains protocol investigations, live-validation notes, expansion audits, recovery findings, and historical design research.

Research documents are evidence and design context. They are not the runtime contract by themselves; executable behavior is defined by `scripts/`, tests, schemas, and the health gate.

Current research areas:

- Expansion roadmap and audit history.
- Cloud, LAN Mode, and printer protocol validation.
- Slicer CLI compatibility and export behavior.
- Recovery and incident analysis.
- Historical protocol and architecture research.
- Native Anycubic Slicer Next, Workbench, MQTT and request-layer analysis.

The native analysis report is [ghidra-slicer-analysis-2026-09-27.md](ghidra-slicer-analysis-2026-09-27.md).

- Custom slicer/editor architecture (Rev 2.0): React/Tauri desktop editor that **replaces the
  legacy editor UI and its in-memory REST/SSE authoring path entirely (no legacy runtime
  fallback)**, while preserving the existing printer/cloud/MCP contracts independently. **
  Blender is the required primary modeling backend and geometry authority** (headless, version-
  pinned, discovered per `tools/HEADLESS-RENDER.md`); the React viewport is a **view** of the
  live scene. **Own** non-planar engine (planar comparison = validation baseline, not the
  product goal); **detailed versioned machine capability contract** (fail-closed, qualification
  - revocation, no "any printer" guarantee); **bounded continuous learning** with deterministic
    safety limits; **capability-based BYOK tool harness** (WASM/WASI + VM tiers, prompt-injection
    posture); **auth as a separable service** (local `auth.db` OR independent service+Postgres,
    both first-class — not just a separate file) with OAuth PKCE; chat/context/global memory UI.
    Legacy `ui/cad.html` scene is **retired** (designated for removal at R0 cutover); runtime
    deletion is implementation work, not this investigation.

The custom slicer/editor investigation is
[custom-slicer-editor-investigation-2026-09-27.md](custom-slicer-editor-investigation-2026-09-27.md)
(**Rev 2.0, 2026-09-28**, supersedes 2026-09-27 v1.0 — see the doc's §13 Corrected Claims Log
and §14 Changelog).
