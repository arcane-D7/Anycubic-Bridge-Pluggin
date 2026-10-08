/** Coordinate contracts at editor, IR and printer telemetry boundaries. */

export type Point3Mm = readonly [number, number, number];

export const COORDINATE_FRAMES = [
  "object-local",
  "editor-world",
  "plate",
  "machine-telemetry",
  "slice-ir",
  "screen",
] as const;

export type CoordinateFrame = (typeof COORDINATE_FRAMES)[number];

export const MILLIMETRES = "mm" as const;
export const CSS_PIXELS = "css-px" as const;

export type Point2CssPx = readonly [number, number];

function assertFinitePoint(point: Point3Mm): void {
  if (point.some((value) => !Number.isFinite(value))) {
    throw new Error("coordinate point must contain finite millimetre values");
  }
}

/** IR is Z-up; the editor scene is Y-up. This is a proper +90 degree X rotation. */
export function sliceIrToEditorWorld(point: Point3Mm): Point3Mm {
  assertFinitePoint(point);
  return [point[0] || 0, point[2] || 0, -point[1] || 0];
}

export function editorWorldToSliceIr(point: Point3Mm): Point3Mm {
  assertFinitePoint(point);
  return [point[0] || 0, -point[2] || 0, point[1] || 0];
}

export interface MachineTelemetryFrame {
  readonly originWorldMm: Point3Mm;
  readonly xAxisWorld: Point3Mm;
  readonly yAxisWorld: Point3Mm;
  readonly zAxisWorld: Point3Mm;
  readonly buildVolumeBoundsWorldMm: {
    readonly min: Point3Mm;
    readonly max: Point3Mm;
  };
}

/** Map machine coordinates only when its origin and axes are declared by a profile. */
export function machineTelemetryToEditorWorld(
  point: Point3Mm,
  frame: MachineTelemetryFrame | null,
): Point3Mm | null {
  if (!frame) return null;
  assertFinitePoint(point);
  assertFinitePoint(frame.originWorldMm);
  assertFinitePoint(frame.xAxisWorld);
  assertFinitePoint(frame.yAxisWorld);
  assertFinitePoint(frame.zAxisWorld);
  return [
    frame.originWorldMm[0] +
      point[0] * frame.xAxisWorld[0] +
      point[1] * frame.yAxisWorld[0] +
      point[2] * frame.zAxisWorld[0],
    frame.originWorldMm[1] +
      point[0] * frame.xAxisWorld[1] +
      point[1] * frame.yAxisWorld[1] +
      point[2] * frame.zAxisWorld[1],
    frame.originWorldMm[2] +
      point[0] * frame.xAxisWorld[2] +
      point[1] * frame.yAxisWorld[2] +
      point[2] * frame.zAxisWorld[2],
  ];
}
