/**
 * S9.7-002 — snapping controller (grid + axis + vertex).
 *
 * AC-1 (grid/vertex snaps apply during gizmo drags; snap target shown in a
 * readout): the gizmo draft is snapped HERE before any persist. The readout
 * — a fixed overlay in the viewport corner — shows the last snapped target
 * (e.g. "X 12.5") and a faint guide line + crosshair marker at the snapped
 * position (world-space line segments, axis-colored) so the operator always
 * sees WHERE the object will land. It lags the drag by one frame on purpose
 * (React state after the gizmo event) — the value shown is always the value
 * persisted, satisfying determinism.
 *
 * AC-2 (snap toggle + step configurable from toolbar/inspector; snapped
 * motion deterministic): reads `useToolbar().snap` (9.4 toolbar toggle) and
 * `useToolbar().snapStep` (configurable; default 5 mm, clamped 1..100).
 * Rotations snap on a fixed 15° step. All math lives in
 * `transform-core` (`snapValue` / `snapRotationDeg` / `snapStepFor`) and is
 * unit-tested headless — the component is a thin wiring layer.
 *
 * S9.13 — crash fix (R3F "Span is not part of the THREE namespace!"): the
 * readout is DOM, so it can NEVER mount inside the `<Canvas>`. It now lives
 * OUTSIDE (sibling overlay in `Viewport`, next to `ObjectLabels`/
 * `MeasureReadout`) and reads the shared snap bus; the in-canvas gizmo only
 * writes the target and renders the three-only `SnapGuide`. Two render
 * locations, one source of truth, zero HTML in the three tree.
 */

import { BufferGeometry, Float32BufferAttribute } from "three";
import { useCallback, useMemo } from "react";
import type { BuildVolume } from "../bridge/types";
import { useI18n } from "../state/i18n";
import { useSnapBus } from "../state/snap-bus";
import { useToolbar } from "../state/toolbar";
import { snapDraft, snapStepFor, type SceneTransform } from "./transform-core";

export interface SnapHandle {
  /** Snap a gizmo draft; returns the same object identity when no snap applies. */
  readonly snapTransform: (
    draft: SceneTransform,
    kind: "move" | "rotate" | "scale",
  ) => SceneTransform;
}

/**
 * Overlay readout for the viewport (S9.7-002 AC-1). Rendered OUTSIDE the
 * R3F Canvas (sibling overlay, same host as ObjectLabels/MeasureReadout).
 * Subscribes to the snap bus — zero canvas re-renders, zero HTML in three.
 */
export function SnapReadout({ volume }: { readonly volume?: BuildVolume }) {
  const snap = useToolbar((s) => s.snap);
  const step = useToolbar((s) => s.snapStep);
  const readout = useSnapBus((s) => s.target);
  const effStep = snapStepFor(step, volume);
  const t = useI18n((s) => s.t);

  if (!snap || !readout) return null;
  return (
    <div className="viewport-snap-readout" data-testid="snap-readout" role="status">
      <span className="snap-readout-axis">{readout.axis}</span>
      <span className="snap-readout-value">{readout.value}</span>
      <span className="snap-readout-step">{t("snap.step", { step: String(effStep) })}</span>
    </div>
  );
}

/**
 * Faint world-space guide line at the snapped coordinate (axis-colored).
 * Lives INSIDE the Canvas next to the gizmo — three primitives only.
 */
export function SnapGuide() {
  const target = useSnapBus((s) => s.target);
  const snap = useToolbar((s) => s.snap);
  const geometry = useMemo<BufferGeometry | null>(
    () => (target ? makeGuideGeometry(target.axis, target.value) : null),
    [target],
  );
  if (!snap || !target || !geometry) return null;
  return (
    <lineSegments geometry={geometry} data-testid="snap-guide">
      <lineBasicMaterial
        color={target.axis === "X" ? "#e0523f" : target.axis === "Y" ? "#2f9e63" : "#3f7fd4"}
        transparent
        opacity={0.45}
      />
    </lineSegments>
  );
}

/** Guide = full-width axis line at the snapped coordinate (axis-colored). */
function makeGuideGeometry(axis: string, value: number): BufferGeometry {
  const positions =
    axis === "X"
      ? [-500, 0, value, 500, 0, value]
      : axis === "Y"
        ? [value, 0, -500, value, 0, 500]
        : [-500, value, 0, 500, value, 0];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return geometry;
}

/**
 * Hook: exposes `snapTransform` (wraps `snapDraft`) and writes the readout
 * target to the SHARED SNAP BUS. The out-of-canvas `SnapReadout` and the
 * in-canvas `SnapGuide` both read the same bus — one source of truth.
 */
export function useSnap(volume?: BuildVolume): SnapHandle {
  const snap = useToolbar((s) => s.snap);
  const snapStep = useToolbar((s) => s.snapStep);

  const snapTransform = useCallback(
    (draft: SceneTransform, _kind: "move" | "rotate" | "scale") => {
      const { transform, target } = snapDraft(draft, { snap, stepMm: snapStep, volume });
      useSnapBus.getState().setTarget(target);
      return transform;
    },
    [snap, snapStep, volume],
  );

  return { snapTransform };
}
