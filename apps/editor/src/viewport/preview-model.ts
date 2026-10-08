/**
 * preview-model.ts — S8-005: pure IR → layer-preview view model.
 *
 * Consumed by the R3F layer preview in the viewport and tested headless under
 * the Node test runner (no React, no three.js — same pattern as
 * `state/viewport-core.ts`).
 *
 * AC 3 (layer preview): viewport shows per-layer toolpaths + infill/walls
 * overlays from IR; a layer slider works; `mode` metadata is consumed —
 * `standard` renders layer-aligned, `nonplanar` ramps render as continuous
 * ramps, never a layer jump.
 *
 * This module is deliberately dependency-free and deterministic: the same IR
 * always yields the same preview model (byte-identical JSON).
 */
import type { SlicingMode } from "../contract";
import type {
  IrDocument as IrDocumentShape,
  IrPathKind,
  IrSegment as IrSegmentShape,
} from "../bridge/ir";

/** Minimal IR segment shape the preview needs (subset of slice-ir output). */
export type PreviewIrSegment = IrSegmentShape;

/** Minimal IR document shape consumed by the preview. */
export type PreviewIrDocument = IrDocumentShape;

/** One previewable toolpath (per-layer). */
export interface PreviewToolpath {
  readonly kind: IrPathKind;
  readonly layer: number;
  readonly segmentId: string | null;
  readonly executionOrder: number;
  readonly objectId: string | null;
  readonly partId: string | null;
  readonly toolId: number | null;
  readonly materialId: string | null;
  readonly speedMmS: number | null;
  readonly flowMm3S: number | null;
  readonly extrusionMm: number | null;
  readonly beadAreaMm2: number | null;
  readonly fanPct: number | null;
  readonly nozzleTemperatureC: number | null;
  readonly bedTemperatureC: number | null;
  readonly layerHeightMm: number | null;
  readonly lineWidthMm: number | null;
  readonly gcodeLineStart: number | null;
  readonly gcodeLineEnd: number | null;
  readonly placementMm: readonly [number, number, number] | null;
  readonly provenance: PreviewIrSegment["provenance"] | null;
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /** True when the segment is a nonplanar ramp (continuous Z change). */
  readonly ramp: boolean;
}

/** One previewable layer. */
export interface PreviewLayer {
  readonly index: number;
  /** Layer plane Z (mm) — the nominal z for standard mode. */
  readonly z: number;
  readonly zAvailable: boolean;
  readonly toolpaths: readonly PreviewToolpath[];
  /** Overlay counts: walls/infill/extrusion totals for the UI. */
  readonly kindCounts: {
    readonly wall: number;
    readonly infill: number;
    readonly support: number;
    readonly adhesion: number;
    readonly travel: number;
    readonly other: number;
  };
}

/** The full preview view model. */
export interface PreviewModel {
  readonly version: string;
  readonly mode: SlicingMode;
  readonly layerCount: number;
  readonly layers: readonly PreviewLayer[];
  /** Any segment tagged nonplanar (ramp) anywhere in the IR. */
  readonly hasRamps: boolean;
  readonly jobId: string | null;
  readonly sourceRevision: number | null;
  readonly targetIds: readonly string[];
  readonly placementMm: readonly [number, number, number] | null;
  readonly orderedSegments: readonly PreviewToolpath[];
  readonly playbackPositions: ReadonlyMap<PreviewToolpath, PreviewPlaybackPosition>;
  readonly executionOrderIndices: ReadonlyMap<number, number>;
  readonly layerExecutionSegments: readonly (readonly PreviewToolpath[])[];
}

export interface PreviewPlaybackPosition {
  readonly layerPosition: number;
  readonly segmentPosition: number;
  readonly accumulated: boolean;
}

export interface PreviewPathFilters {
  readonly [kind: string]: boolean | undefined;
}

/** True when the segment is a Z-ramp (continuous Z change along the path). */
function isRamp(seg: PreviewIrSegment): boolean {
  const dz = Math.abs(seg.pose.to.z - seg.pose.from.z);
  return dz > 1e-6;
}

function kindClass(kind: IrPathKind): PreviewLayer["kindCounts"] {
  const k = kind.toUpperCase();
  return {
    wall: k.includes("WALL") ? 1 : 0,
    infill: k.includes("INFILL") ? 1 : 0,
    support: k.includes("SUPPORT") ? 1 : 0,
    adhesion: k === "BRIM" || k === "SKIRT" || k === "PRIME" || k === "PURGE" ? 1 : 0,
    travel: k === "TRAVEL" ? 1 : 0,
    other:
      k.includes("WALL") ||
      k.includes("INFILL") ||
      k.includes("SUPPORT") ||
      ["BRIM", "SKIRT", "PRIME", "PURGE", "TRAVEL"].includes(k)
        ? 0
        : 1,
  };
}

/**
 * Build the layer-preview view model from an IR document.
 *
 * Standard mode: toolpaths are grouped by `layer` with the nominal plane z;
 * ramps cannot exist (the independent validator rejects them — this model
 * never invents them).
 * Nonplanar mode: ramps render as continuous from→to lines within their
 * layer group (never as a layer jump), and the document `mode` flag tells the
 * viewport how to interpret them.
 *
 * @param ir — minimal IR document
 * @returns deterministic PreviewModel
 */
export function buildPreviewModel(ir: PreviewIrDocument): PreviewModel {
  if (!Array.isArray(ir?.segments)) {
    throw new Error("preview: IR segments required");
  }
  const byLayer = new Map<number, PreviewToolpath[]>();
  const counts = new Map<number, PreviewLayer["kindCounts"]>();
  let hasRamps = false;

  for (const [sourceIndex, seg] of ir.segments.entries()) {
    const from: readonly [number, number, number] = [
      seg.pose.from.x,
      seg.pose.from.y,
      seg.pose.from.z,
    ];
    const to: readonly [number, number, number] = [seg.pose.to.x, seg.pose.to.y, seg.pose.to.z];
    const ramp = isRamp(seg);
    if (ramp) hasRamps = true;
    const path: PreviewToolpath = {
      kind: seg.kind,
      layer: seg.layer,
      segmentId: seg.segment_id ?? null,
      executionOrder: seg.execution_order ?? sourceIndex,
      objectId: seg.object_id ?? null,
      partId: seg.part_id ?? null,
      toolId: seg.tool_id ?? null,
      materialId: seg.material_id ?? null,
      speedMmS: seg.speed?.mm_s ?? null,
      flowMm3S: seg.flow?.q_mm3_s ?? null,
      extrusionMm: seg.flow?.e_mm ?? null,
      beadAreaMm2: seg.bead?.area_mm2 ?? null,
      fanPct: seg.cooling?.fan_pct ?? null,
      nozzleTemperatureC: seg.temperature?.nozzle_c ?? null,
      bedTemperatureC: seg.temperature?.bed_c ?? null,
      layerHeightMm: seg.layer_height_mm ?? null,
      lineWidthMm: seg.line_width_mm ?? null,
      gcodeLineStart: seg.gcode_line_start ?? null,
      gcodeLineEnd: seg.gcode_line_end ?? null,
      placementMm: ir.placement ? [ir.placement.x, ir.placement.y, ir.placement.z] : null,
      provenance: seg.provenance ?? null,
      from,
      to,
      ramp,
    };
    const layer = Number.isFinite(seg.layer) ? seg.layer : 0;
    const list = byLayer.get(layer) ?? [];
    list.push(path);
    byLayer.set(layer, list);
    const c = counts.get(layer) ?? {
      wall: 0,
      infill: 0,
      support: 0,
      adhesion: 0,
      travel: 0,
      other: 0,
    };
    const classified = kindClass(path.kind);
    counts.set(layer, {
      wall: c.wall + classified.wall,
      infill: c.infill + classified.infill,
      support: c.support + classified.support,
      adhesion: c.adhesion + classified.adhesion,
      travel: c.travel + classified.travel,
      other: c.other + classified.other,
    });
  }

  const layers: PreviewLayer[] = [];
  for (const [index, toolpaths] of byLayer) {
    toolpaths.sort((left, right) => left.executionOrder - right.executionOrder);
    const zs = toolpaths.map((t) => t.from[2]).filter(isFinite);
    const zAvailable = zs.length > 0;
    const z = zAvailable ? Math.min(...zs) : Number.NaN;
    layers.push({
      index,
      z,
      zAvailable,
      toolpaths: Object.freeze([...toolpaths]),
      kindCounts: counts.get(index) ?? {
        wall: 0,
        infill: 0,
        support: 0,
        adhesion: 0,
        travel: 0,
        other: 0,
      },
    });
  }
  layers.sort((a, b) => a.index - b.index);
  const orderedSegments = layers
    .flatMap((layer) => layer.toolpaths)
    .sort((left, right) => left.executionOrder - right.executionOrder);
  const playbackPositions = new Map<PreviewToolpath, PreviewPlaybackPosition>();
  const executionOrderIndices = new Map<number, number>();
  const layerExecutionSegments = layers.map(() => [] as PreviewToolpath[]);
  for (const [index, path] of orderedSegments.entries()) {
    executionOrderIndices.set(path.executionOrder, index);
  }
  for (const [layerPosition, layer] of layers.entries()) {
    for (const [segmentPosition, path] of layer.toolpaths.entries()) {
      playbackPositions.set(path, { layerPosition, segmentPosition, accumulated: false });
      layerExecutionSegments[layerPosition]!.push(path);
    }
  }
  for (const paths of layerExecutionSegments) {
    paths.sort((left, right) => left.executionOrder - right.executionOrder);
    Object.freeze(paths);
  }

  return {
    version: "1.0",
    mode: ir.mode ?? "standard",
    layerCount: layers.length,
    layers: Object.freeze(layers),
    hasRamps,
    jobId: ir.job_id ?? null,
    sourceRevision: ir.source_revision ?? null,
    targetIds: Object.freeze([...(ir.target_ids ?? [])]),
    placementMm: ir.placement ? [ir.placement.x, ir.placement.y, ir.placement.z] : null,
    orderedSegments: Object.freeze(orderedSegments),
    playbackPositions,
    executionOrderIndices,
    layerExecutionSegments: Object.freeze(layerExecutionSegments),
  };
}

/**
 * Layer-aligned visibility helper for the viewport: given the selected layer
 * and the model, return the toolpaths that render on the slider position.
 *
 * Standard (default): only toolpaths whose layer == `layerIndex` are visible,
 * and they render at their own z (all approximately the layer plane).
 * Nonplanar: ramps from adjacent layers are included so a continuous Z path
 * is never shown as a jump when the user scrubs past it.
 *
 * @param model — buildPreviewModel output
 * @param layerIndex — current slider position
 * @returns toolpaths visible at that position
 */
export function previewLayerAt(
  model: PreviewModel,
  layerPosition: number,
): readonly PreviewToolpath[] {
  const target = model.layers[layerPosition];
  if (!target) return [];
  if (!model.hasRamps) return target.toolpaths;
  // Nonplanar: gather the target layer's toolpaths plus any ramp toolpath that
  // spans the target's z band (continuous ramps are never a layer jump).
  const zBand = target.z;
  return model.layers.flatMap((l, position) =>
    position === layerPosition
      ? l.toolpaths
      : l.toolpaths.filter((t) => t.ramp && Math.abs(t.from[2] - zBand) < 0.5),
  );
}

export function previewLayerSegmentsAt(
  model: PreviewModel,
  layerPosition: number,
): readonly PreviewToolpath[] {
  return model.layers[layerPosition]?.toolpaths ?? [];
}

/** Return layer segments in known output order, optionally through one segment. */
export function playbackSegmentsAt(
  model: PreviewModel,
  layerPosition: number,
  segmentPosition = Number.MAX_SAFE_INTEGER,
  accumulated = false,
): readonly PreviewToolpath[] {
  if (
    !Number.isInteger(layerPosition) ||
    layerPosition < 0 ||
    layerPosition >= model.layers.length
  ) {
    return [];
  }
  const currentLayer = model.layers[layerPosition]!;
  const currentSegment =
    currentLayer.toolpaths[
      Math.max(0, Math.min(currentLayer.toolpaths.length - 1, segmentPosition))
    ];
  if (!currentSegment) return [];
  if (!accumulated) {
    const layerPaths = model.layerExecutionSegments[layerPosition] ?? [];
    let layerLow = 0;
    let layerHigh = layerPaths.length;
    while (layerLow < layerHigh) {
      const middle = layerLow + Math.floor((layerHigh - layerLow) / 2);
      if (layerPaths[middle]!.executionOrder <= currentSegment.executionOrder)
        layerLow = middle + 1;
      else layerHigh = middle;
    }
    return layerPaths.slice(0, layerLow);
  }
  let low = 0;
  let high = model.orderedSegments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (model.orderedSegments[middle]!.executionOrder <= currentSegment.executionOrder)
      low = middle + 1;
    else high = middle;
  }
  const throughOrder = model.orderedSegments.slice(0, low);
  return throughOrder;
}

/** Move one segment in execution order, crossing layer boundaries deterministically. */
export function previewPlaybackStep(
  model: PreviewModel,
  layerPosition: number,
  segmentPosition: number,
  delta: -1 | 1,
): PreviewPlaybackPosition {
  const layers = model.layers;
  if (layers.length === 0) return { layerPosition: 0, segmentPosition: 0, accumulated: false };
  let layer = Math.max(0, Math.min(layers.length - 1, layerPosition));
  let segment = Math.max(0, Math.min(layers[layer]!.toolpaths.length - 1, segmentPosition));
  const current = layers[layer]!.toolpaths[segment];
  if (!current || model.orderedSegments.length === 0) {
    return { layerPosition: layer, segmentPosition: segment, accumulated: false };
  }
  const currentOrderIndex = model.executionOrderIndices.get(current.executionOrder) ?? 0;
  const nextOrderIndex = Math.max(
    0,
    Math.min(model.orderedSegments.length - 1, currentOrderIndex + delta),
  );
  const next = model.orderedSegments[nextOrderIndex];
  if (next) {
    const position = model.playbackPositions.get(next);
    if (position) {
      layer = position.layerPosition;
      segment = position.segmentPosition;
    }
  }
  return { layerPosition: layer, segmentPosition: segment, accumulated: false };
}

/** Visualization-only path filtering; does not alter the artifact or slice. */
export function visiblePlaybackSegments(
  model: PreviewModel,
  position: PreviewPlaybackPosition,
  filters: PreviewPathFilters,
): readonly PreviewToolpath[] {
  return playbackSegmentsAt(
    model,
    position.layerPosition,
    position.segmentPosition,
    position.accumulated,
  ).filter((path) => {
    return filters[path.kind] !== false;
  });
}

export type PreviewAttribute =
  "speed" | "flow" | "beadWidth" | "lineWidth" | "layerHeight" | "temperature";

export interface PreviewAttributeSummary {
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly count: number;
  readonly histogram: readonly number[];
}

export function previewAttributeSummary(
  paths: readonly PreviewToolpath[],
  attribute: PreviewAttribute,
): PreviewAttributeSummary | null {
  const valueFor = (path: PreviewToolpath): number | null => {
    const value =
      attribute === "speed"
        ? path.speedMmS
        : attribute === "flow"
          ? path.flowMm3S
          : attribute === "beadWidth"
            ? path.beadAreaMm2
            : attribute === "lineWidth"
              ? path.lineWidthMm
              : attribute === "layerHeight"
                ? path.layerHeightMm
                : path.nozzleTemperatureC;
    return value !== null && Number.isFinite(value) ? value : null;
  };
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const path of paths) {
    const value = valueFor(path);
    if (value === null) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    count += 1;
  }
  if (count === 0) return null;
  const histogram = Array.from({ length: 5 }, () => 0);
  for (const path of paths) {
    const value = valueFor(path);
    if (value === null) continue;
    const bin = max === min ? 0 : Math.min(4, Math.floor(((value - min) / (max - min)) * 5));
    histogram[bin] = histogram[bin]! + 1;
  }
  const unit =
    attribute === "speed"
      ? "mm/s"
      : attribute === "flow"
        ? "mm3/s"
        : attribute === "beadWidth"
          ? "mm2"
          : attribute === "temperature"
            ? "C"
            : "mm";
  return Object.freeze({
    unit,
    min,
    max,
    count,
    histogram: Object.freeze(histogram),
  });
}
