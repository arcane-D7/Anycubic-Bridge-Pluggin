/**
 * Transform inspector core (S9.3-002) — dependency-free pure helpers for the
 * numeric transform inspector. No React/zustand imports: headless-testable
 * under Node 24 native TS like transform-core / viewport-core.
 *
 * The transform shape matches `SceneObjectSnapshot.transform` in
 * `apps/editor/src/bridge/types.ts`: position {x,y,z} mm, euler rotation
 * {rx,ry,rz} DEGREES, scale {sx,sy,sz} unitless. Missing slots default
 * position 0 / rotation 0 / scale 1 (same convention as transform-core).
 */

export type TransformKind = "position" | "rotation" | "scale";
export type TransformAxis = "x" | "y" | "z";

/** The normalized transform value type used by the inspector core. */
export interface InspectorTransform {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}

/** Axis fields per kind (mono row, X/Y/Z). */
export const AXES_PER_KIND: Record<TransformKind, readonly TransformAxis[]> = {
  position: ["x", "y", "z"],
  rotation: ["x", "y", "z"],
  scale: ["x", "y", "z"],
};

/** Axis field names per kind in the normalized transform. */
export const FIELD_PER_AXIS: Record<
  TransformKind,
  Record<TransformAxis, keyof InspectorTransform>
> = {
  position: { x: "x", y: "y", z: "z" },
  rotation: { x: "rx", y: "ry", z: "rz" },
  scale: { x: "sx", y: "sy", z: "sz" },
};

/** Label used in the UI row header (position → P, rotation → R, scale → S). */
export const KIND_LABEL: Record<TransformKind, string> = {
  position: "P",
  rotation: "R",
  scale: "S",
};

export function identityTransform(): InspectorTransform {
  return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
}

/** Normalize a partial snapshot transform into the full shape (defaults). */
export function normalizeTransform(
  t:
    | {
        readonly x?: number;
        readonly y?: number;
        readonly z?: number;
        readonly rx?: number;
        readonly ry?: number;
        readonly rz?: number;
        readonly sx?: number;
        readonly sy?: number;
        readonly sz?: number;
      }
    | undefined,
): InspectorTransform {
  return {
    x: t?.x ?? 0,
    y: t?.y ?? 0,
    z: t?.z ?? 0,
    rx: t?.rx ?? 0,
    ry: t?.ry ?? 0,
    rz: t?.rz ?? 0,
    sx: t?.sx ?? 1,
    sy: t?.sy ?? 1,
    sz: t?.sz ?? 1,
  };
}

/**
 * Parse a raw text field into a finite number in mm (position), degrees
 * (rotation) or unitless (scale). Empty string → 0; non-finite → null.
 */
export function parseAxisValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (Number.isNaN(n) || !Number.isFinite(n)) return null;
  return n;
}

/** Read one axis value off a normalized transform. */
export function axisValue(kind: TransformKind, axis: TransformAxis, t: InspectorTransform): number {
  switch (kind) {
    case "position":
      return t[axis];
    case "rotation":
      return axis === "x" ? t.rx : axis === "y" ? t.ry : t.rz;
    case "scale":
      return axis === "x" ? t.sx : axis === "y" ? t.sy : t.sz;
  }
}

/** Produce a transform with ONE axis replaced by an absolute value. */
export function withAxisValue(
  kind: TransformKind,
  axis: TransformAxis,
  value: number,
  t: InspectorTransform,
): InspectorTransform {
  const base = { ...t };
  switch (kind) {
    case "position":
      return { ...base, [axis]: value };
    case "rotation": {
      const out = { ...base };
      if (axis === "x") out.rx = value;
      else if (axis === "y") out.ry = value;
      else out.rz = value;
      return out;
    }
    case "scale": {
      const out = { ...base };
      if (axis === "x") out.sx = value;
      else if (axis === "y") out.sy = value;
      else out.sz = value;
      return out;
    }
  }
}

/**
 * Default reset value per kind: origin for position/rotation, identity 1
 * for scale.
 */
export function resetValue(
  kind: TransformKind,
  axis: TransformAxis,
  t: InspectorTransform,
): InspectorTransform {
  return withAxisValue(kind, axis, kind === "scale" ? 1 : 0, t);
}

/**
 * Apply an edited kind row (absolute mode) over a committed base. Only the
 * edited kind changes — the other two kinds stay untouched. Returns a new
 * transform.
 */
export function applyAbsolute(
  committed: InspectorTransform,
  kind: TransformKind,
  values: Readonly<Record<TransformAxis, number>>,
): InspectorTransform {
  let out = committed;
  out = withAxisValue(kind, "x", values.x, out);
  out = withAxisValue(kind, "y", values.y, out);
  out = withAxisValue(kind, "z", values.z, out);
  return out;
}

/**
 * Apply an edited kind row in RELATIVE mode over a committed base.
 * Position/rotation are additive (committed + delta); scale is
 * multiplicative (committed × factor, identity 1 = no change). Returns a
 * new transform.
 */
export function applyRelative(
  committed: InspectorTransform,
  kind: TransformKind,
  deltas: Readonly<Record<TransformAxis, number>>,
): InspectorTransform {
  if (kind === "scale") {
    let out = committed;
    out = withAxisValue(kind, "x", committed.sx * deltas.x, out);
    out = withAxisValue(kind, "y", committed.sy * deltas.y, out);
    out = withAxisValue(kind, "z", committed.sz * deltas.z, out);
    return out;
  }
  let out = committed;
  out = withAxisValue(kind, "x", axisValue(kind, "x", committed) + deltas.x, out);
  out = withAxisValue(kind, "y", axisValue(kind, "y", committed) + deltas.y, out);
  out = withAxisValue(kind, "z", axisValue(kind, "z", committed) + deltas.z, out);
  return out;
}

/** The zero-delta starting fields for relative mode (add 0 / scale ×1). */
export function relativeZero(kind: TransformKind): Readonly<Record<TransformAxis, number>> {
  return kind === "scale" ? { x: 1, y: 1, z: 1 } : { x: 0, y: 0, z: 0 };
}

/** Copy the X value into Y and Z (per-axis copy → uniform, e.g. scale). */
export function uniformCopy(
  kind: TransformKind,
  values: Readonly<Record<TransformAxis, number>>,
): Readonly<Record<TransformAxis, number>> {
  return { x: values.x, y: values.x, z: values.x };
}

/**
 * Apply a kind edit over the committed base.
 *
 * Absolute: the values ARE the new axis values.
 * Relative: position/rotation are additive, scale is multiplicative.
 * The other kinds stay untouched (position edit never moves rotation).
 */
export function resolveKind(
  committed: InspectorTransform,
  kind: TransformKind,
  values: Readonly<Record<TransformAxis, number>>,
  isRelative: boolean,
): InspectorTransform {
  if (kind === "scale") {
    const vx = isRelative ? committed.sx * values.x : values.x;
    const vy = isRelative ? committed.sy * values.y : values.y;
    const vz = isRelative ? committed.sz * values.z : values.z;
    return { ...committed, sx: vx, sy: vy, sz: vz };
  }
  const get = (axis: TransformAxis) => axisValue(kind, axis, committed);
  const vx = isRelative ? get("x") + values.x : values.x;
  const vy = isRelative ? get("y") + values.y : values.y;
  const vz = isRelative ? get("z") + values.z : values.z;
  if (kind === "position") return { ...committed, x: vx, y: vy, z: vz };
  return { ...committed, rx: vx, ry: vy, rz: vz };
}

/** Compare two normalized transforms for numeric equality. */
export function sameTransform(a: InspectorTransform, b: InspectorTransform): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.rx === b.rx &&
    a.ry === b.ry &&
    a.rz === b.rz &&
    a.sx === b.sx &&
    a.sy === b.sy &&
    a.sz === b.sz
  );
}

/**
 * Detect which kinds differ between the committed snapshot transform and a
 * live draft (dirty state for the status bar, AC-3). Returns null when the
 * draft matches the committed value exactly (all numeric slots equal).
 */
export function dirtyKinds(
  committed: InspectorTransform,
  draft: InspectorTransform,
): readonly ("position" | "rotation" | "scale")[] | null {
  const touched: ("position" | "rotation" | "scale")[] = [];
  if (committed.x !== draft.x || committed.y !== draft.y || committed.z !== draft.z) {
    touched.push("position");
  }
  if (committed.rx !== draft.rx || committed.ry !== draft.ry || committed.rz !== draft.rz) {
    touched.push("rotation");
  }
  if (committed.sx !== draft.sx || committed.sy !== draft.sy || committed.sz !== draft.sz) {
    touched.push("scale");
  }
  return touched.length === 0 ? null : touched;
}

/** True when any scale axis differs from 1 (i.e. the object is resized). */
export function isResized(t: InspectorTransform): boolean {
  return t.sx !== 1 || t.sy !== 1 || t.sz !== 1;
}

/**
 * True when scale is non-uniform (thin-walls risk — the inspector shows a
 * warning). Uniform includes identity (1,1,1) or any axis-equal value.
 */
export function isNonUniformScale(t: InspectorTransform): boolean {
  return t.sx !== t.sy || t.sy !== t.sz;
}

/** Round a rotation to 2 decimals (UX: avoids euler float noise). */
export function prettyRotation(deg: number): number {
  return Math.round(deg * 100) / 100;
}

/** Round a scale to 3 decimals (UX: keeps sliders/numeric tight). */
export function prettyScale(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Stringify one axis for the input field (plain, no forced decimals). */
export function axisDisplay(kind: TransformKind, v: number): string {
  if (kind === "scale") return String(prettyScale(v));
  return String(prettyRotation(v));
}
