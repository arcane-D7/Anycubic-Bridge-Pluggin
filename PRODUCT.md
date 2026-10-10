# Product

## Register

product

## Users

People preparing and inspecting 3D models for printing, including users familiar with Blender and slicers such as OrcaSlicer, Bambu Studio, and Anycubic Slicer Next. They need precise, reversible model and plate workflows, clear slice results, and trustworthy printer status and actions.

## Product Purpose

The editor aims to support a coherent path from project setup through model preparation and slice preview to printer workbench tasks. The repository also contains a local-first MCP plugin for orchestrating Anycubic Slicer Next and supported printer integrations. Keep these surfaces and their capabilities distinct. Local-first means machine-specific operations stay behind explicit local integrations and policy boundaries; it does not mean every editor action is already connected to a real backend.

Success means users can tell what changed, which project and revision it applies to, whether an operation is real, simulated, pending, or unavailable, and what requires approval. A successful UI response alone is not evidence of a real geometry change, completed slice, printer command, or physical print.

## Brand Personality

Precise, capable, candid. Speak plainly, use domain terms consistently, and report progress, limitations, errors, and outcomes without overstating certainty.

## Anti-references

- Marketing-style hero pages, decorative dashboards, oversized metrics, and generic SaaS card grids.
- Nested cards, redundant toolbars, decorative glass or motion, and controls that obscure the model or plate.
- Blender, OrcaSlicer, Bambu Studio, or Anycubic Slicer Next presented as parity claims; they are workflow references, not evidence of equivalent behavior.
- Demo or mock behavior presented as completed production work, real slicing, geometry repair, printer control, or physical execution.

## Design Principles

- Keep the model, plate, and task context central; make tools serve the active operation.
- Preserve project state across navigation and make selection, revision, and operation results legible.
- Reuse established modeling and slicer conventions when they reduce learning cost; do not claim parity without verified behavior.
- Make real, demo, unavailable, pending, rejected, and failed states distinguishable. Require the appropriate explicit approval before consequential actions.
- Prefer compact, predictable controls and progressive disclosure over redundant chrome.

## Accessibility & Inclusion

Treat keyboard operation, visible focus, readable contrast, non-color status cues, and reduced-motion support as engineering requirements. Preserve the existing light and dark theme choices. These are targets, not a claim of completed WCAG evaluation or certification; verify affected flows and contrast during implementation.

## Source and Status

This guide reflects repository documentation and the editor audit dated 2026-10-07, read on 2026-10-09. The audit records findings and proposed direction, not completed fixes. Recheck current code and tests before asserting implementation status.
