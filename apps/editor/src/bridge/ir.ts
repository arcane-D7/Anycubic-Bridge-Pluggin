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
  readonly kind: IrPathKind;
  readonly layer: number;
  readonly chain_id?: string;
  readonly segment_id?: string;
  readonly execution_order?: number;
  readonly object_id?: string;
  readonly part_id?: string;
  readonly tool_id?: number | null;
  readonly material_id?: string | null;
  readonly speed?: { readonly mm_s: number | null };
  readonly flow?: { readonly q_mm3_s: number | null; readonly e_mm: number | null };
  readonly bead?: { readonly area_mm2: number | null; readonly variable: boolean | null };
  readonly cooling?: { readonly fan_pct: number | null };
  readonly temperature?: { readonly nozzle_c: number | null; readonly bed_c: number | null };
  readonly layer_height_mm?: number | null;
  readonly line_width_mm?: number | null;
  readonly gcode_line_start?: number | null;
  readonly gcode_line_end?: number | null;
  readonly provenance?: {
    readonly generator?: string;
    readonly revision?: number | string;
    readonly layer?: number;
  };
  readonly pose: IrPose;
  readonly orientation: readonly [number, number, number];
}

export type IrPathKind =
  | "WALL"
  | "OUTER_WALL"
  | "INNER_WALL"
  | "INFILL"
  | "SOLID_INFILL"
  | "TOP_SURFACE"
  | "BOTTOM_SURFACE"
  | "SUPPORT"
  | "SUPPORT_INTERFACE"
  | "BRIDGE"
  | "GAP_INFILL"
  | "BRIM"
  | "SKIRT"
  | "TRAVEL"
  | "RETRACTION"
  | "SEAM"
  | "PRIME"
  | "PURGE"
  | "TOOL_CHANGE";

/** Op-IR document (slice-ir toIrDocument subset). */
export interface IrDocument {
  readonly version: string;
  readonly mode: SlicingMode;
  readonly dialect: string;
  readonly coordinate_frame: "slice-ir";
  readonly units: "mm";
  readonly job_id?: string;
  readonly source_revision?: number;
  readonly target_ids?: readonly string[];
  readonly placement?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly build_volume?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly segments: readonly IrSegment[];
}

const IR_VERSION = "1.1";
const IR_KINDS = new Set<IrPathKind>([
  "WALL",
  "OUTER_WALL",
  "INNER_WALL",
  "INFILL",
  "SOLID_INFILL",
  "TOP_SURFACE",
  "BOTTOM_SURFACE",
  "SUPPORT",
  "SUPPORT_INTERFACE",
  "BRIDGE",
  "GAP_INFILL",
  "BRIM",
  "SKIRT",
  "TRAVEL",
  "RETRACTION",
  "SEAM",
  "PRIME",
  "PURGE",
  "TOOL_CHANGE",
]);
const IR_MAX_SEGMENTS = 200_000;
const IR_Z_EPSILON = 1e-6;

type IrPoint = { readonly x: number; readonly y: number; readonly z: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIrPathKind(value: unknown): value is IrPathKind {
  return typeof value === "string" && IR_KINDS.has(value as IrPathKind);
}

export class IrDocumentError extends Error {
  readonly code: "IR_INVALID" | "IR_LIMIT" | "IR_REFERENCE";
  readonly path: string;

  constructor(message: string) {
    super(`parseIrDocument: ${message}`);
    this.name = "IrDocumentError";
    this.code = /exceeds the maximum/.test(message)
      ? "IR_LIMIT"
      : /not in target_ids|must be unique|precedes/.test(message)
        ? "IR_REFERENCE"
        : "IR_INVALID";
    this.path = message.match(/^(\$|[\w.[\]]+)/)?.[1] ?? "$";
  }
}

function irFail(message: string): never {
  throw new IrDocumentError(message);
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

function optionalFinite(
  raw: Record<string, unknown>,
  key: string,
  label: string,
): number | null | undefined {
  if (!(key in raw)) return undefined;
  return raw[key] === null ? null : irFinite(raw[key], label);
}

function optionalText(
  raw: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!(key in raw)) return undefined;
  if (typeof raw[key] !== "string" || raw[key].length === 0)
    irFail(`${label} must be a nonempty string`);
  return raw[key];
}

function optionalGroup(
  raw: Record<string, unknown>,
  key: string,
  fields: readonly string[],
  index: number,
) {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (value === null) return null;
  if (!isRecord(value)) irFail(`segments[${index}].${key} must be an object or null`);
  const result: Record<string, number | boolean | null> = {};
  for (const field of fields) {
    if (!(field in value)) continue;
    const item = value[field];
    if (item === null) result[field] = null;
    else if (typeof item === "boolean" && field === "variable") result[field] = item;
    else result[field] = irFinite(item, `segments[${index}].${key}.${field}`);
  }
  return Object.freeze(result);
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
  if (!isIrPathKind(kind)) {
    irFail(`${label}.kind (${JSON.stringify(kind)}) is not a supported manufacturing path kind`);
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
  const provenance = raw.provenance;
  let normalizedProvenance: IrSegment["provenance"];
  if (provenance !== undefined) {
    if (!isRecord(provenance)) irFail(`${label}.provenance must be an object`);
    const revisionRaw = provenance.revision;
    const revision =
      revisionRaw === undefined || revisionRaw === null
        ? revisionRaw
        : typeof revisionRaw === "string"
          ? revisionRaw.length > 0
            ? revisionRaw
            : irFail(
                `${label}.provenance.revision must be a nonempty string or nonnegative integer`,
              )
          : irFinite(revisionRaw, `${label}.provenance.revision`);
    const provenanceLayer = optionalFinite(provenance, "layer", `${label}.provenance.layer`);
    if (typeof revision === "number" && (!Number.isSafeInteger(revision) || revision < 0))
      irFail(`${label}.provenance.revision must be a nonnegative integer`);
    if (provenanceLayer !== undefined && provenanceLayer !== null && provenanceLayer !== layer)
      irFail(`${label}.provenance.layer does not match segment layer`);
    normalizedProvenance = Object.freeze({
      ...(typeof provenance.generator === "string" ? { generator: provenance.generator } : {}),
      ...(revision !== undefined && revision !== null ? { revision } : {}),
      ...(provenanceLayer !== undefined && provenanceLayer !== null
        ? { layer: provenanceLayer }
        : {}),
    });
  }
  const executionOrder = optionalFinite(raw, "execution_order", `${label}.execution_order`);
  if (
    executionOrder === null ||
    (executionOrder !== undefined && (!Number.isSafeInteger(executionOrder) || executionOrder < 0))
  ) {
    irFail(`${label}.execution_order must be a nonnegative safe integer when supplied`);
  }
  const toolId = optionalFinite(raw, "tool_id", `${label}.tool_id`);
  if (toolId !== undefined && toolId !== null && (!Number.isInteger(toolId) || toolId < 0))
    irFail(`${label}.tool_id must be a nonnegative integer`);
  const lineStart = optionalFinite(raw, "gcode_line_start", `${label}.gcode_line_start`);
  const lineEnd = optionalFinite(raw, "gcode_line_end", `${label}.gcode_line_end`);
  for (const [name, value] of [
    ["gcode_line_start", lineStart],
    ["gcode_line_end", lineEnd],
  ] as const) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0))
      irFail(`${label}.${name} must be a nonnegative safe integer`);
  }
  if (lineStart != null && lineEnd != null && lineEnd < lineStart)
    irFail(`${label}.gcode_line_end precedes gcode_line_start`);
  const segment: IrSegment = {
    mode: docMode,
    kind,
    layer,
    pose,
    orientation: Object.freeze(orientation),
    ...(chainId !== undefined ? { chain_id: chainId } : {}),
    ...(optionalText(raw, "segment_id", `${label}.segment_id`) !== undefined
      ? { segment_id: raw.segment_id as string }
      : {}),
    ...(executionOrder !== undefined ? { execution_order: executionOrder } : {}),
    ...(optionalText(raw, "object_id", `${label}.object_id`) !== undefined
      ? { object_id: raw.object_id as string }
      : {}),
    ...(optionalText(raw, "part_id", `${label}.part_id`) !== undefined
      ? { part_id: raw.part_id as string }
      : {}),
    ...(toolId !== undefined ? { tool_id: toolId } : {}),
    ...("material_id" in raw
      ? raw.material_id === null || typeof raw.material_id === "string"
        ? { material_id: raw.material_id }
        : irFail(`${label}.material_id must be a string or null`)
      : {}),
    ...(raw.speed !== undefined
      ? { speed: optionalGroup(raw, "speed", ["mm_s"], index) as IrSegment["speed"] }
      : {}),
    ...(raw.flow !== undefined
      ? { flow: optionalGroup(raw, "flow", ["q_mm3_s", "e_mm"], index) as IrSegment["flow"] }
      : {}),
    ...(raw.bead !== undefined
      ? { bead: optionalGroup(raw, "bead", ["area_mm2", "variable"], index) as IrSegment["bead"] }
      : {}),
    ...(raw.cooling !== undefined
      ? { cooling: optionalGroup(raw, "cooling", ["fan_pct"], index) as IrSegment["cooling"] }
      : {}),
    ...(raw.temperature !== undefined
      ? {
          temperature: optionalGroup(
            raw,
            "temperature",
            ["nozzle_c", "bed_c"],
            index,
          ) as IrSegment["temperature"],
        }
      : {}),
    ...(["layer_height_mm", "line_width_mm"] as const).reduce(
      (fields, key) => {
        const value = optionalFinite(raw, key, `${label}.${key}`);
        if (value !== undefined) fields[key] = value;
        return fields;
      },
      {} as { layer_height_mm?: number | null; line_width_mm?: number | null },
    ),
    ...(lineStart !== undefined ? { gcode_line_start: lineStart } : {}),
    ...(lineEnd !== undefined ? { gcode_line_end: lineEnd } : {}),
    ...(normalizedProvenance !== undefined ? { provenance: normalizedProvenance } : {}),
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
  if (input.coordinate_frame !== "slice-ir") {
    irFail(`coordinate_frame (${JSON.stringify(input.coordinate_frame)}) must be "slice-ir"`);
  }
  if (input.units !== "mm") {
    irFail(`units (${JSON.stringify(input.units)}) must be "mm"`);
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
  const sourceRevision = input.source_revision;
  if (
    sourceRevision !== undefined &&
    (typeof sourceRevision !== "number" ||
      !Number.isSafeInteger(sourceRevision) ||
      sourceRevision < 0)
  )
    irFail("source_revision must be a nonnegative safe integer");
  const jobId = input.job_id;
  if (jobId !== undefined && (typeof jobId !== "string" || jobId.length === 0))
    irFail("job_id must be a nonempty string");
  let targetIds: readonly string[] | undefined;
  if (input.target_ids !== undefined) {
    if (
      !Array.isArray(input.target_ids) ||
      input.target_ids.some((id) => typeof id !== "string" || id.length === 0)
    )
      irFail("target_ids must contain nonempty strings");
    if (new Set(input.target_ids).size !== input.target_ids.length)
      irFail("target_ids must be unique");
    targetIds = Object.freeze([...input.target_ids]);
  }
  let placement: IrDocument["placement"];
  if (input.placement !== undefined) {
    if (input.placement === null) placement = null;
    else if (isRecord(input.placement))
      placement = Object.freeze({
        x: irFinite(input.placement.x, "placement.x"),
        y: irFinite(input.placement.y, "placement.y"),
        z: irFinite(input.placement.z, "placement.z"),
      });
    else irFail("placement must be an object or null");
  }
  const rawSegments = input.segments;
  if (!Array.isArray(rawSegments)) irFail("segments must be an array");
  if (rawSegments.length === 0) irFail("segments must be a nonempty array");
  if (rawSegments.length > IR_MAX_SEGMENTS) {
    irFail(`segments length ${rawSegments.length} exceeds the maximum of ${IR_MAX_SEGMENTS}`);
  }
  const segments = Object.freeze(rawSegments.map((raw, index) => irSegment(raw, docMode, index)));
  const segmentIds = segments.flatMap((segment) =>
    segment.segment_id ? [segment.segment_id] : [],
  );
  if (new Set(segmentIds).size !== segmentIds.length) irFail("segment_id values must be unique");
  const executionOrders = segments.flatMap((segment) =>
    segment.execution_order === undefined || segment.execution_order === null
      ? []
      : [segment.execution_order],
  );
  if (new Set(executionOrders).size !== executionOrders.length)
    irFail("execution_order values must be unique");
  for (const [index, segment] of segments.entries()) {
    if (targetIds && segment.object_id && !targetIds.includes(segment.object_id))
      irFail(`segments[${index}].object_id is not in target_ids`);
  }
  const document: IrDocument = {
    version: IR_VERSION,
    mode: docMode,
    dialect: input.dialect,
    coordinate_frame: "slice-ir",
    units: "mm",
    ...(jobId !== undefined ? { job_id: jobId } : {}),
    ...(sourceRevision !== undefined ? { source_revision: sourceRevision } : {}),
    ...(targetIds !== undefined ? { target_ids: targetIds } : {}),
    ...(placement !== undefined ? { placement } : {}),
    segments,
    ...(buildVolume !== undefined ? { build_volume: buildVolume } : {}),
  };
  return Object.freeze(document);
}
