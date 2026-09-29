/**
 * Shared IR preview contract types — S8-005.
 *
 * Matches the slice-ir.mjs emit shape (subset) so the postprocessor, preview
 * model and viewport all consume the SAME contract (single source of truth).
 */
import type { SlicingMode } from "../contract";

/** IR segment pose (mm), part-local coordinates (placement is S8-005 FK). */
export interface IrPose {
  readonly from: { readonly x: number; readonly y: number; readonly z: number };
  readonly to: { readonly x: number; readonly y: number; readonly z: number };
}

/** Op-IR segment emitted by slice-ir.mjs toIrSegment (subset). */
export interface IrSegment {
  readonly mode: SlicingMode;
  readonly kind: string; // WALL | INFILL | BRIM | SKIRT | TRAVEL (uppercase)
  readonly layer: number;
  readonly chain_id?: string;
  readonly pose: IrPose;
  readonly orientation: readonly [number, number, number];
}

/** Op-IR document (slice-ir toIrDocument subset). */
export interface IrDocument {
  readonly version: string;
  readonly mode: SlicingMode;
  readonly dialect: string;
  readonly build_volume?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly segments: readonly IrSegment[];
}

const IR_VERSION = "1.0";
const IR_KINDS = new Set(["WALL", "INFILL", "BRIM", "SKIRT", "TRAVEL"]);
const IR_MAX_SEGMENTS = 200_000;
const IR_Z_EPSILON = 1e-6;

type IrPoint = { readonly x: number; readonly y: number; readonly z: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function irFail(message: string): never {
  throw new Error(`parseIrDocument: ${message}`);
}

function irFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    irFail(`${label} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function irPoint(raw: unknown, label: string): IrPoint {
  if (!isRecord(raw)) irFail(`${label} must be an object`);
  return Object.freeze({
    x: irFinite(raw.x, `${label}.x`),
    y: irFinite(raw.y, `${label}.y`),
    z: irFinite(raw.z, `${label}.z`),
  });
}

function irPose(raw: unknown, label: string): IrPose {
  if (!isRecord(raw)) irFail(`${label} must be an object`);
  return Object.freeze({
    from: irPoint(raw.from, `${label}.from`),
    to: irPoint(raw.to, `${label}.to`),
  });
}

function irSegment(raw: unknown, docMode: SlicingMode, index: number): IrSegment {
  const label = `segments[${index}]`;
  if (!isRecord(raw)) irFail(`${label} must be an object`);
  if (raw.mode !== docMode) {
    irFail(
      `${label}.mode (${JSON.stringify(raw.mode)}) does not match document mode ("${docMode}")`,
    );
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !IR_KINDS.has(kind)) {
    irFail(
      `${label}.kind (${JSON.stringify(kind)}) must be one of WALL, INFILL, BRIM, SKIRT, TRAVEL`,
    );
  }
  const layer = raw.layer;
  if (typeof layer !== "number" || !Number.isInteger(layer) || layer < 0) {
    irFail(`${label}.layer (${JSON.stringify(layer)}) must be a nonnegative integer`);
  }
  const chainId = raw.chain_id;
  if (chainId !== undefined && typeof chainId !== "string") {
    irFail(`${label}.chain_id must be a string when supplied`);
  }
  const pose = irPose(raw.pose, `${label}.pose`);
  const orientationRaw = raw.orientation;
  if (!Array.isArray(orientationRaw) || orientationRaw.length !== 3) {
    irFail(`${label}.orientation must be an array of 3 numbers`);
  }
  const orientation: [number, number, number] = [
    irFinite(orientationRaw[0], `${label}.orientation[0]`),
    irFinite(orientationRaw[1], `${label}.orientation[1]`),
    irFinite(orientationRaw[2], `${label}.orientation[2]`),
  ];
  if (
    docMode === "standard" &&
    kind !== "TRAVEL" &&
    Math.abs(pose.to.z - pose.from.z) > IR_Z_EPSILON
  ) {
    irFail(
      `${label} (${kind}) has a Z ramp (${pose.from.z} → ${pose.to.z}); extrusion Z ramps are only valid in nonplanar mode`,
    );
  }
  const segment: IrSegment = {
    mode: docMode,
    kind,
    layer,
    pose,
    orientation: Object.freeze(orientation),
    ...(chainId !== undefined ? { chain_id: chainId } : {}),
  };
  return Object.freeze(segment);
}

export function parseIrDocument(input: unknown): IrDocument {
  if (!isRecord(input)) irFail("input must be a JSON object");
  if (input.version !== IR_VERSION) {
    irFail(`version (${JSON.stringify(input.version)}) must be "${IR_VERSION}"`);
  }
  const mode = input.mode;
  if (mode !== "standard" && mode !== "nonplanar") {
    irFail(`mode (${JSON.stringify(mode)}) must be "standard" or "nonplanar"`);
  }
  const docMode: SlicingMode = mode;
  if (input.dialect !== "anycubic" && input.dialect !== "cura") {
    irFail(`dialect (${JSON.stringify(input.dialect)}) must be "anycubic" or "cura"`);
  }
  let buildVolume: IrDocument["build_volume"];
  if (input.build_volume !== undefined) {
    if (input.build_volume === null) {
      buildVolume = null;
    } else {
      const rawVolume = input.build_volume;
      if (!isRecord(rawVolume)) irFail("build_volume must be an object or null");
      const volume = Object.freeze({
        x: irFinite(rawVolume.x, "build_volume.x"),
        y: irFinite(rawVolume.y, "build_volume.y"),
        z: irFinite(rawVolume.z, "build_volume.z"),
      });
      if (volume.x <= 0 || volume.y <= 0 || volume.z <= 0) {
        irFail("build_volume.x/y/z must be positive when supplied");
      }
      buildVolume = volume;
    }
  }
  const rawSegments = input.segments;
  if (!Array.isArray(rawSegments)) irFail("segments must be an array");
  if (rawSegments.length === 0) irFail("segments must be a nonempty array");
  if (rawSegments.length > IR_MAX_SEGMENTS) {
    irFail(`segments length ${rawSegments.length} exceeds the maximum of ${IR_MAX_SEGMENTS}`);
  }
  const segments = Object.freeze(rawSegments.map((raw, index) => irSegment(raw, docMode, index)));
  const document: IrDocument = {
    version: IR_VERSION,
    mode: docMode,
    dialect: input.dialect,
    segments,
    ...(buildVolume !== undefined ? { build_volume: buildVolume } : {}),
  };
  return Object.freeze(document);
}
