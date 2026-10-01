/**
 * S9.3 transform core — dependency-free pure helpers for the real gizmo.
 * No three.js imports here (Node 24 runs it headless via the test harness).
 *
 * - `applyTransform` → props for the R3F <group> (position/rotation/scale).
 * - `transformToEuler` → rad rotation array.
 * - `identityTransform` / `normalizeTransform` → snapshot-shaped placement.
 * - `isOverlayPanel` → pointer-event isolation decision (AC-4): a pointer at
 *   (x,y) that lands on a floating panel rect must NOT reach the gizmo.
 */

export interface SceneTransform {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
  readonly sx?: number;
  readonly sy?: number;
  readonly sz?: number;
}

export interface GroupTransformProps {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number];
  readonly scale: [number, number, number];
}

export function identityTransform(): SceneTransform {
  return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
}

/** Fill missing rotation/scale fields so consumers always read defined slots. */
export function normalizeTransform(t: SceneTransform | undefined): SceneTransform {
  if (!t) return identityTransform();
  return {
    x: t.x ?? 0,
    y: t.y ?? 0,
    z: t.z ?? 0,
    rx: t.rx ?? 0,
    ry: t.ry ?? 0,
    rz: t.rz ?? 0,
    sx: t.sx ?? 1,
    sy: t.sy ?? 1,
    sz: t.sz ?? 1,
  };
}

/** R3F group props from a snapshot transform. Rotation is euler DEGREES in
 * the snapshot; three expects radians — convert here (pure, testable). */
export function applyTransform(t: SceneTransform | undefined): GroupTransformProps {
  const n = normalizeTransform(t);
  const d2r = Math.PI / 180;
  return {
    position: [n.x, n.y, n.z],
    rotation: [n.rx! * d2r, n.ry! * d2r, n.rz! * d2r],
    scale: [n.sx!, n.sy!, n.sz!],
  };
}

/** True when the pointer (clientX, clientY) falls inside any floating panel
 * rect — the gizmo must ignore those events (AC-4 pointer isolation). */
export function isOverlayPanel(
  x: number,
  y: number,
  rects: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[],
): boolean {
  return rects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
}
