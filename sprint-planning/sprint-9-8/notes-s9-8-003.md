# S9.8-003 implementation notes — Measure tool (G42)

Measure mode (toolbar toggle / `M` key): gizmo-less probe on click against REAL
imported geometry (raycast into the S9.2 buffers). Distance between two points,
circumradius of a circular edge, angle between edges — readout bottom-left in
mono, cleared on mode exit.

## Files

| File                          | Purpose                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `viewport/measure-core.ts`    | Pure headless core — `distance3`, `circumRadius` (degenerate → null), `angleDeg`, `pushProbe` (click-stream reducer, residual last point), `formatMeasure` (locale-independent)                                                |
| `state/measure.ts`            | `useMeasure` zustand bus: `active/kind/probes/result/markToken` + `setActive/setKind/pushProbe/clear/bumpMarkers`; `setActive`/`setKind` reset the stream                                                                      |
| `viewport/MeasureTool.tsx`    | In-canvas collector: `useEffect` drives `setActive` from `useUi().tool === "measure"`; canvas click → `THREE.Raycaster` against `scene.getObjectByName(o.name).traverse(mesh)`; markers = world-space spheres (1.2) + polyline |
| `viewport/MeasureReadout.tsx` | Out-of-canvas overlay (bottom-left, mono) — kind switcher Dist/R/∠, live value, clear; subscribes to the bus (no canvas re-renders)                                                                                            |
| `state/ui.ts`                 | `ToolMode += "measure"`; `grabToolFor`/`grabToolToMode` extended (measure has no grabs)                                                                                                                                        |
| `state/shortcuts-core.ts`     | `ToolCommandId += "tool.measure"`; `M` → tool measure                                                                                                                                                                          |
| `viewport/TransformGizmo.tsx` | `modeToGizmoMode("measure") → null` (gizmo hidden)                                                                                                                                                                             |
| `viewport/Toolbar.tsx`        | Measure toggle in TOOLS (icon `measure`); toggle back to select on second click; tooltip from registry `measure.toggle`                                                                                                        |
| `viewport/Viewport.tsx`       | `MeasureTool` in-canvas + `MeasureReadout` overlay (both `!preview`)                                                                                                                                                           |
| `styles.css`                  | `.measure-readout` (mono, bottom-left), `.measure-kind-btn`, `.measure-clear`                                                                                                                                                  |
| `tests/measure.test.mjs`      | 9 headless tests (Euclidean, circumcenter Thales R=5, collinear degraded, angle 90/180, reduce residuals, format)                                                                                                              |
| `tests/shortcuts.test.mjs`    | + `M` toggles measure (fires during grab, no-op in inputs)                                                                                                                                                                     |

## Behavior

- **Distance**: 2 clicks → euclidean distance; residual keeps the last point.
- **Radius**: 3 clicks on a circular edge → circumradius via triangle plane (no
  Rodrigues); degenerate/collinear triple → `null` result, last point kept.
- **Angle**: 3 clicks apex-first → angle between rays (0..180°).
- Empty canvas / overlay clicks never probe; overlay buttons stop propagation.
- `Esc` or switching to another tool clears the stream (`setActive`/`setKind`
  reset); the readout hides when the mode exits.

## Gate evidence

- unit: 561 (baseline) + 9 (measure) + 1 (M shortcut) = **571 pass / 0 fail**
- integration 11 · smoke 106 tools · licenses 59 · architecture OK
- `pnpm run check` EXIT:0 · sanitize DRY-RUN 0
