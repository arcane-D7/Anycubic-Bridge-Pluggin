# Design System

## Status and Scope

This is product UI context for `apps/editor`, grounded in `apps/editor/src/index.css`, `apps/editor/src/styles.css`, and `docs/design-system-liquid-glass.md` as inspected on 2026-10-09. The CSS token sets and selective glass treatments exist in the editor. The design-system document is an approved specification, not proof that every described component, value, or accessibility target is fully implemented. Preserve and verify the current code rather than rewriting it to match this guide.

The editor audit proposes the destination flow `Home → Prepare → Preview → Workbench`. Treat that as product direction, not a claim that all four destinations or their integrations are complete.

## Visual Direction

Use a restrained engineering workspace: keep the 3D viewport and plate readable, and make panels support focused tasks. Existing light and dark themes are explicit `data-theme` variants; do not force one theme or infer theme from operating-system preference. Glass is a selective functional surface treatment already used in the editor, not a default effect for every panel.

## Tokens

Use existing CSS variables as the source of truth. `apps/editor/src/index.css` defines the Inter/SF/system sans stack, JetBrains Mono/Cascadia/ui-monospace stack, a 6px base radius, and 120ms, 200ms, and 320ms transition tokens with an exponential ease-out. It exposes semantic namespaces for backgrounds, glass, borders, text, accent, status, selection, controls, shadows, and blur.

Light and dark variants define corresponding surface, text, border, accent, and semantic status colors. Consume semantic tokens instead of hardcoding theme colors. The editor CSS currently uses translucent glass fills, hairline borders, and blur on selected surfaces. Keep text and critical state readable over the actual rendered background; existing token names or comments are not a substitute for contrast testing.

## Layout and Components

- Favor a viewport-led work area with compact, task-relevant panels and controls.
- Keep navigation, project context, selection, and operation state coherent across Home, Prepare, Preview, and Workbench as those destinations are implemented.
- Avoid nested cards, duplicated toolbars, decorative panel framing, and overlays that hide geometry or important status.
- Keep ordinary controls visually consistent and expose clear default, hover, focus, active, disabled, loading, and error states where applicable.
- Use familiar iconography and keyboard-operable controls; do not make color the only status signal.

## Accessibility and Motion

Keyboard access, visible focus, sufficient contrast, responsive content, and reduced-motion behavior are implementation targets. Do not describe them as verified until tested. Motion should communicate a state change; respect reduced-motion preferences. The audit documents incomplete accessibility and validation work, so verify the relevant flow rather than relying on this guide.

## References

- Product workflow findings and proposed direction: `docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md`.
- Existing token implementation: `apps/editor/src/index.css` and `apps/editor/src/styles.css`.
- Approved design-system specification: `docs/design-system-liquid-glass.md`.
