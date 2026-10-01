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
 */

import { BufferGeometry, Float32BufferAttribute } from "three";
import { useCallback, useMemo, useState } from "react";
import type { BuildVolume } from "../bridge/types";
import { useI18n } from "../state/i18n";
import { useToolbar } from "../state/toolbar";
import { snapDraft, snapStepFor, type SceneTransform, type SnapTarget } from "./transform-core";

export interface SnapHandle {
  /** Snap a gizmo draft; returns the same object identity when no snap applies. */
  readonly snapTransform: (
    draft: SceneTransform,
    kind: "move" | "rotate" | "scale",
  ) => SceneTransform;
  /** Last snapped target for the readout (null until a snap occurs). */
  readonly readout: SnapTarget | null;
}

/**
 * Overlay readout + guide for the viewport (S9.7-002 AC-1).
 */
export function SnapReadout({
  readout,
  volume,
}: {
  readonly readout: SnapTarget | null;
  readonly volume?: BuildVolume;
}) {
  const snap = useToolbar((s) => s.snap);
  const step = useToolbar((s) => s.snapStep);
  const effStep = snapStepFor(step, volume);
  const t = useI18n((s) => s.t);

  return (
    <>
      {snap && readout ? (
        <div className="viewport-snap-readout" data-testid="snap-readout">
          <span className="snap-readout-axis">{readout.axis}</span>
          <span className="snap-readout-value">{readout.value}</span>
          <span className="snap-readout-step">{t("snap.step", { step: String(effStep) })}</span>
        </div>
      ) : null}
      {snap && readout ? <SnapGuide target={readout} /> : null}
    </>
  );
}

/** Faint world-space guide line at the snapped coordinate (axis-colored). */
function SnapGuide({ target }: { readonly target: SnapTarget }) {
  const geometry = useMemo<BufferGeometry>(
    () => makeGuideGeometry(target.axis, target.value),
    [target.axis, target.value],
  );
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
 * Hook: exposes `snapTransform` (wraps `snapDraft`) and the readout state.
 * The TransformGizmo calls `snapTransform` in `onObjectChange` before
 * `mutateObject`; the readout state lives here so both share one source.
 */
export function useSnap(volume?: BuildVolume): SnapHandle {
  const snap = useToolbar((s) => s.snap);
  const snapStep = useToolbar((s) => s.snapStep);
  const [readout, setReadout] = useState<SnapTarget | null>(null);

  const snapTransform = useCallback(
    (draft: SceneTransform, _kind: "move" | "rotate" | "scale") => {
      const { transform, target } = snapDraft(draft, { snap, stepMm: snapStep, volume });
      setReadout(target);
      return transform;
    },
    [snap, snapStep, volume],
  );

  return { snapTransform, readout };
}
