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
import type { IrDocument as IrDocumentShape, IrSegment as IrSegmentShape } from "../bridge/ir";

/** Minimal IR segment shape the preview needs (subset of slice-ir output). */
export type PreviewIrSegment = IrSegmentShape;

/** Minimal IR document shape consumed by the preview. */
export type PreviewIrDocument = IrDocumentShape;

/** One previewable toolpath (per-layer). */
export interface PreviewToolpath {
  readonly kind: string;
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
  readonly toolpaths: readonly PreviewToolpath[];
  /** Overlay counts: walls/infill/extrusion totals for the UI. */
  readonly kindCounts: {
    readonly wall: number;
    readonly infill: number;
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
}

/** True when the segment is a Z-ramp (continuous Z change along the path). */
function isRamp(seg: PreviewIrSegment): boolean {
  const dz = Math.abs(seg.pose.to.z - seg.pose.from.z);
  return dz > 1e-6;
}

function kindClass(kind: string): PreviewLayer["kindCounts"] {
  const k = (kind ?? "").toUpperCase();
  return {
    wall: k.includes("WALL") ? 1 : 0,
    infill: k.includes("INFILL") ? 1 : 0,
    other: k.includes("WALL") || k.includes("INFILL") ? 0 : 1,
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

  for (const seg of ir.segments) {
    const from: readonly [number, number, number] = [
      seg.pose?.from?.x ?? 0,
      seg.pose?.from?.y ?? 0,
      seg.pose?.from?.z ?? 0,
    ];
    const to: readonly [number, number, number] = [
      seg.pose?.to?.x ?? 0,
      seg.pose?.to?.y ?? 0,
      seg.pose?.to?.z ?? 0,
    ];
    const ramp = isRamp(seg);
    if (ramp) hasRamps = true;
    const path: PreviewToolpath = {
      kind: String(seg.kind ?? "TRAVEL").toUpperCase(),
      from,
      to,
      ramp,
    };
    const layer = Number.isFinite(seg.layer) ? seg.layer : 0;
    const list = byLayer.get(layer) ?? [];
    list.push(path);
    byLayer.set(layer, list);
    const c = counts.get(layer) ?? { wall: 0, infill: 0, other: 0 };
    counts.set(layer, {
      wall: c.wall + kindClass(path.kind).wall,
      infill: c.infill + kindClass(path.kind).infill,
      other: c.other + kindClass(path.kind).other,
    });
  }

  const layers: PreviewLayer[] = [];
  for (const [index, toolpaths] of byLayer) {
    const zs = toolpaths.map((t) => t.from[2]).filter(isFinite);
    const z = zs.length > 0 ? Math.min(...zs) : 0;
    layers.push({
      index,
      z,
      toolpaths: Object.freeze([...toolpaths]),
      kindCounts: counts.get(index) ?? { wall: 0, infill: 0, other: 0 },
    });
  }
  layers.sort((a, b) => a.index - b.index);

  return {
    version: "1.0",
    mode: ir.mode ?? "standard",
    layerCount: layers.length,
    layers: Object.freeze(layers),
    hasRamps,
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
  layerIndex: number,
): readonly PreviewToolpath[] {
  const target = model.layers.find((l) => l.index === layerIndex);
  if (!target) return [];
  if (!model.hasRamps) return target.toolpaths;
  // Nonplanar: gather the target layer's toolpaths plus any ramp toolpath that
  // spans the target's z band (continuous ramps are never a layer jump).
  const zBand = target.z;
  return model.layers.flatMap((l) =>
    l.index === layerIndex
      ? l.toolpaths
      : l.toolpaths.filter((t) => t.ramp && Math.abs(t.from[2] - zBand) < 0.5),
  );
}
