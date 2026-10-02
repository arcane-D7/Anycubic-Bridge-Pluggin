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

/**
 * S9.10-001 — "lay on plate" (OrcaSlicer/BambuStudio convention): compute a
 * transform whose WORLD min-Y touches the plate top (Y=0) — objects must
 * never sit through the bed. With the snapshot's mesh-offset semantics
 * (world = transform + bounds*scale), the world bottom is
 * `transform.y + bounds.min[1] * sy`, so settling means
 * `transform.y = -bounds.min[1] * sy`. X/Z and rotation/scale are preserved.
 * Pure — no three.js — headless-testable.
 */
export function settleOnPlateTransform(o: {
  readonly bounds: { readonly min: readonly [number, number, number] };
  readonly transform?: SceneTransform;
}): SceneTransform {
  const n = normalizeTransform(o.transform);
  const minY = o.bounds.min[1];
  // `-0` (from -0*sy) is a nasty equality trap — normalize to 0.
  return {
    x: n.x,
    y: -minY * n.sy || 0,
    z: n.z,
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
