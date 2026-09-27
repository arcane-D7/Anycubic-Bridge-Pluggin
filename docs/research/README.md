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

- Custom slicer/editor architecture: React/Tauri shell, Blender-style object editing, non-planar
  slicing stages, headless-Blender backend, BYOK agent harness, sandbox tiers, chat/context/global
  memory UI, separate auth database.

The custom slicer/editor investigation is
[custom-slicer-editor-investigation-2026-09-27.md](custom-slicer-editor-investigation-2026-09-27.md).
