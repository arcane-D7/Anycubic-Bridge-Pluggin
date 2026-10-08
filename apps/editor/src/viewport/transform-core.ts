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

/** Fill missing rotation/scale fields so consumers always read defined slots. */
export type NormalizedTransform = Required<
  Pick<SceneTransform, "x" | "y" | "z" | "rx" | "ry" | "rz" | "sx" | "sy" | "sz">
>;

/** Typed identity so `normalizeTransform`'s return is fully-defined. */
export function identityTransform(): NormalizedTransform {
  return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
}

export function normalizeTransform(t: SceneTransform | undefined): NormalizedTransform {
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

export interface Bounds3Mm {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function validateParentMatrix(matrix: readonly number[] | undefined): void {
  if (matrix && (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value)))) {
    throw new Error("parent world transform must be a finite 4x4 matrix");
  }
}

/** Transform the eight corners of evaluated local bounds into editor-world mm. */
export function evaluatedBoundsWorld(
  bounds: Bounds3Mm,
  transform?: SceneTransform,
  parentWorldMatrix?: readonly number[],
): Bounds3Mm {
  validateParentMatrix(parentWorldMatrix);
  if (
    [...bounds.min, ...bounds.max].some((value) => !Number.isFinite(value)) ||
    bounds.min.some((value, axis) => value > bounds.max[axis]!)
  ) {
    throw new Error("evaluated bounds must be finite and ordered");
  }
  const n = normalizeTransform(transform);
  const [rx, ry, rz] = [n.rx, n.ry, n.rz].map((degrees) => (degrees * Math.PI) / 180);
  const [sinX, sinY, sinZ] = [Math.sin(rx!), Math.sin(ry!), Math.sin(rz!)];
  const [cosX, cosY, cosZ] = [Math.cos(rx!), Math.cos(ry!), Math.cos(rz!)];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const sx = x * n.sx;
        const sy = y * n.sy;
        const sz = z * n.sz;
        const local: [number, number, number] = [
          n.x +
            sx * cosZ! * cosY! +
            sy * (cosZ! * sinY! * sinX! - sinZ! * cosX!) +
            sz * (cosZ! * sinY! * cosX! + sinZ! * sinX!),
          n.y +
            sx * sinZ! * cosY! +
            sy * (cosZ! * cosX! + sinZ! * sinY! * sinX!) +
            sz * (-cosZ! * sinX! + sinZ! * sinY! * cosX!),
          n.z - sx * sinY! + sy * cosY! * sinX! + sz * cosY! * cosX!,
        ];
        const matrix = parentWorldMatrix;
        const world: [number, number, number] = matrix
          ? [
              matrix[0]! * local[0] + matrix[4]! * local[1] + matrix[8]! * local[2] + matrix[12]!,
              matrix[1]! * local[0] + matrix[5]! * local[1] + matrix[9]! * local[2] + matrix[13]!,
              matrix[2]! * local[0] + matrix[6]! * local[1] + matrix[10]! * local[2] + matrix[14]!,
            ]
          : local;
        for (const axis of [0, 1, 2] as const) {
          min[axis] = Math.min(min[axis], world[axis]);
          max[axis] = Math.max(max[axis], world[axis]);
        }
      }
    }
  }
  return { min, max };
}

/** Convert a world translation vector into the parent's local coordinate frame. */
export function worldTranslationToParentLocal(
  delta: readonly [number, number, number],
  parentWorldMatrix?: readonly number[],
): [number, number, number] {
  validateParentMatrix(parentWorldMatrix);
  if (!parentWorldMatrix) return [...delta];
  const m = parentWorldMatrix;
  const a = m[0]!;
  const b = m[4]!;
  const c = m[8]!;
  const d = m[1]!;
  const e = m[5]!;
  const f = m[9]!;
  const g = m[2]!;
  const h = m[6]!;
  const i = m[10]!;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error("parent world transform is not invertible");
  }
  return [
    ((e * i - f * h) * delta[0] + (c * h - b * i) * delta[1] + (b * f - c * e) * delta[2]) /
      determinant,
    ((f * g - d * i) * delta[0] + (a * i - c * g) * delta[1] + (c * d - a * f) * delta[2]) /
      determinant,
    ((d * h - e * g) * delta[0] + (b * g - a * h) * delta[1] + (a * e - b * d) * delta[2]) /
      determinant,
  ];
}

/** Drop only the world-vertical delta needed to place evaluated bounds on the plate. */
export function settleOnPlateTransform(o: {
  readonly bounds: Bounds3Mm;
  readonly transform?: SceneTransform;
  readonly plateTopYmm?: number;
  readonly parentWorldMatrix?: readonly number[];
}): SceneTransform {
  const n = normalizeTransform(o.transform);
  const worldBounds = evaluatedBoundsWorld(o.bounds, n, o.parentWorldMatrix);
  const delta = worldTranslationToParentLocal(
    [0, (o.plateTopYmm ?? 0) - worldBounds.min[1], 0],
    o.parentWorldMatrix,
  );
  return {
    x: n.x + delta[0],
    y: n.y + delta[1] || 0,
    z: n.z + delta[2],
    rx: n.rx,
    ry: n.ry,
    rz: n.rz,
    sx: n.sx,
    sy: n.sy,
    sz: n.sz,
  };
}

/**
 * S9.10-001 — clamp a move draft so the object's world bottom never sinks
 * below Y=0 (the plate top). `minY` is the mesh's local bottom (bounds.min[1]);
 * the world bottom = `draft.y + minY * draft.sy`. Orca/Bambu allow hovering
 * (draft.y > -minY*sy) but never penetrating the bed. Pure + headless.
 */
export function clampBedY(draft: SceneTransform, minY: number): SceneTransform {
  const n = normalizeTransform(draft);
  const sy = n.sy ?? 1;
  const bedFloor = -minY * sy; // transform.y that puts the bottom exactly on 0
  if (n.y >= bedFloor) return draft;
  return { ...draft, y: bedFloor || 0 };
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

/** Axis names in scene order (X/Y/Z position, rotation around X/Y/Z, scale). */
export const AXES = ["x", "y", "z"] as const;
export type AxisName = (typeof AXES)[number];

/**
 * S9.3-003 — constrain a draft transform to one axis (keyboard X/Y/Z).
 *
 * Works per gesture kind:
 * - move    — zero every position axis except the constrained one
 *             (keeps the FIRST OTHER axis the user dragged/typed, so the
 *             object slides along the remaining free plane only).
 * - rotate  — zero rotation around the axes that are NOT locked.
 * - scale   — one axis → that axis scale = free value, others = 1; two axes
 *             → the given plane scales uniformly (S stays proportional).
 * - free    — passthrough.
 */
export function constrainToAxis(
  draft: SceneTransform,
  axis: AxisName | null,
  kind: "move" | "rotate" | "scale",
): SceneTransform {
  if (!axis) return draft;
  return kind === "move"
    ? {
        ...draft,
        x: axis === "x" ? draft.x : 0,
        y: axis === "y" ? draft.y : 0,
        z: axis === "z" ? draft.z : 0,
      }
    : kind === "rotate"
      ? {
          ...draft,
          rx: axis === "x" ? (draft.rx ?? 0) : 0,
          ry: axis === "y" ? (draft.ry ?? 0) : 0,
          rz: axis === "z" ? (draft.rz ?? 0) : 0,
        }
      : /* scale */
        {
          ...draft,
          sx: axis === "x" ? (draft.sx ?? 1) : 1,
          sy: axis === "y" ? (draft.sy ?? 1) : 1,
          sz: axis === "z" ? (draft.sz ?? 1) : 1,
        };
}

/**
 * S9.7-002 — deterministic grid snapping primitives (pure, headless).
 *
 * - `snapStepFor(gridStep, axis, volume)` — the effective snap step for a
 *   position axis: from the toolbar config when nonzero, else derived from
 *   the plate/profile footprint (largest side / 48, floored to 5 mm, min
 *   5 mm — the "step from plate/profile" AC).
 * - `snapValue(value, step)` — round-to-nearest step (deterministic; a
 *   value exactly between two steps rounds down, standard half-down).
 * - `snapRotationDeg(deg, stepDeg)` — rotation snap (default 15°).
 * - `snapTargetLabel(axis, value, kind)` — the readout string ("X 12.5").
 *
 * The same helpers drive the gizmo draft AND the readout, so the displayed
 * target always matches the persisted value (AC: snapped motion
 * deterministic).
 */

export const DEFAULT_SNAP_STEP_MM = 5;
export const ROTATION_SNAP_STEP_DEG = 15;

export function snapStepFor(
  gridStepMm: number,
  volume?: { widthMm?: number; depthMm?: number },
): number {
  if (gridStepMm > 0) return gridStepMm;
  const width = volume?.widthMm ?? 0;
  const depth = volume?.depthMm ?? 0;
  const ref = width > 0 && depth > 0 ? Math.max(width, depth) : 0;
  if (ref <= 0) return DEFAULT_SNAP_STEP_MM;
  const derived = Math.max(
    DEFAULT_SNAP_STEP_MM,
    Math.floor(ref / 48 / DEFAULT_SNAP_STEP_MM) * DEFAULT_SNAP_STEP_MM,
  );
  return derived;
}

/** Round to the nearest multiple of `step` (half-down for exact ties). */
export function snapValue(value: number, step: number): number {
  if (!Number.isFinite(value) || !(step > 0)) return value;
  return Math.round(value / step) * step;
}

/** Rotation snapping (degrees); default 15° keeps the standard 30/45 alignments. */
export function snapRotationDeg(deg: number, stepDeg: number = ROTATION_SNAP_STEP_DEG): number {
  return snapValue(deg, stepDeg);
}

/** Readout label for the snap target (axis-parallel; e.g. "X 12.5"). */
export function snapTargetLabel(axis: string, value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${axis} ${rounded}`;
}

/** S9.7-002 — what the snap produced (drives the readout/guide). */
export interface SnapTarget {
  readonly axis: string;
  readonly value: number;
  readonly kind: "move" | "rotate";
}

/**
 * S9.7-002 — pure draft → snapped draft (headless-testable).
 *
 * Move snaps X/Y/Z to the grid step (step from toolbar config, or derived
 * from the plate footprint via `snapStepFor`); rotate snaps rx/ry/rz to
 * 15°; scale passes through (axis/vertex snap is scoped to position/
 * rotation per the sprint AC). Returns the first changed axis as the target
 * for the readout; null when nothing snapped.
 */
export function snapDraft(
  draft: SceneTransform,
  opts: { snap: boolean; stepMm: number; volume?: { widthMm?: number; depthMm?: number } },
): { transform: SceneTransform; target: SnapTarget | null } {
  if (!opts.snap) return { transform: draft, target: null };
  const step = snapStepFor(opts.stepMm, opts.volume);
  let target: SnapTarget | null = null;
  let transform: SceneTransform = draft;
  for (const axis of ["x", "y", "z"] as const) {
    const source = transform[axis] ?? 0;
    const snapped = snapValue(source, step);
    if (snapped !== source) {
      transform = { ...transform, [axis]: snapped };
      if (target === null) {
        target = { axis: axis.toUpperCase(), value: snapped, kind: "move" };
      }
    }
  }
  for (const axis of ["rx", "ry", "rz"] as const) {
    const deg = (transform[axis] ?? 0) % 360;
    const snapped = snapRotationDeg(deg, ROTATION_SNAP_STEP_DEG);
    if (snapped !== deg) {
      transform = { ...transform, [axis]: snapped };
      if (target === null) {
        const label = axis === "rx" ? "X" : axis === "ry" ? "Y" : "Z";
        target = { axis: label, value: snapped, kind: "rotate" };
      }
    }
  }
  return { transform, target };
}
