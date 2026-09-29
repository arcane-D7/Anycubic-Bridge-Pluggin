// S8-001 unit tests for the planar parity comparator
// (scripts/compare-planar-runs.mjs) on synthetic summaries — no I/O, no
// slicer required.

import test from "node:test";
import assert from "node:assert/strict";

import { analyzeGcode, analyzeIr, comparePlanarRuns } from "../scripts/compare-planar-runs.mjs";

function refSummary() {
  return {
    layers: Array.from({ length: 11 }, (_, i) => ({
      index: i,
      wallCount: 2,
      infillExtrusion: i === 0 || i === 10 ? 0 : 100,
      solidExtrusion: 0,
      totalExtrusion: i === 0 || i === 10 ? 50 : 150,
      eValue: 0,
      bbox: [0, 0, 0, 20, 20, 20],
      hasWallType: true,
    })),
    layerCount: 11,
    bbox: [0, 0, 0, 20, 20, 20],
    totalExtrusion: 1500,
    perLayerWalls: Array.from({ length: 11 }, () => 2),
  };
}

test("identical summaries pass the declared budget", () => {
  const ref = refSummary();
  const cmp = comparePlanarRuns(ref, ref, {
    wallCountDelta: 0,
    infillVolumePct: 15,
    bboxMm: 0.5,
  });
  assert.ok(cmp.pass);
  const byName = Object.fromEntries(cmp.metrics.map((m) => [m.metric, m]));
  assert.equal(byName.wall_count.delta, 0);
  assert.equal(byName.infill_volume_pct.delta, 0);
  assert.equal(byName.bbox_mm.delta, 0);
});

test("wall-count mismatch breaks the ±0 budget", () => {
  const ref = refSummary();
  const cand = structuredClone(ref);
  cand.perLayerWalls = cand.perLayerWalls.map((w, i) => (i === 3 ? w + 1 : w));
  const cmp = comparePlanarRuns(ref, cand, { wallCountDelta: 0, infillVolumePct: 15, bboxMm: 0.5 });
  assert.equal(cmp.pass, false);
  const walls = cmp.metrics.find((m) => m.metric === "wall_count");
  assert.equal(walls.delta, 1);
  assert.equal(walls.pass, false);
});

test("bbox delta above budget fails", () => {
  const ref = refSummary();
  const cand = structuredClone(ref);
  cand.bbox = [0, 0, 0, 20.5, 20, 20]; // 0.5 exactly at budget → pass
  const atBudget = comparePlanarRuns(ref, cand, {
    wallCountDelta: 0,
    infillVolumePct: 15,
    bboxMm: 0.5,
  });
  assert.equal(atBudget.pass, true);
  cand.bbox = [0, 0, 0, 21.0, 20, 20]; // 1.0 > 0.5 budget
  const over = comparePlanarRuns(ref, cand, {
    wallCountDelta: 0,
    infillVolumePct: 15,
    bboxMm: 0.5,
  });
  assert.equal(over.pass, false);
  const bbox = over.metrics.find((m) => m.metric === "bbox_mm");
  assert.equal(bbox.delta, 1.0);
});

test("infill volume % delta compared against declared budget", () => {
  const ref = refSummary();
  const cand = structuredClone(ref);
  cand.totalExtrusion = 1700; // (1700-1500)/1500 = 13.3% → within 15%
  const ok = comparePlanarRuns(ref, cand, { wallCountDelta: 0, infillVolumePct: 15, bboxMm: 0.5 });
  assert.equal(ok.pass, true);
  cand.totalExtrusion = 1800; // 20% → over
  const over = comparePlanarRuns(ref, cand, {
    wallCountDelta: 0,
    infillVolumePct: 15,
    bboxMm: 0.5,
  });
  assert.equal(over.pass, false);
});

test("analyzeGcode extracts layers, wall counts, extrusion, bbox", () => {
  const gcode = `
;LAYER_COUNT:2
;LAYER:0
;TYPE:WALL-OUTER
G1 X1 Y2 E0.1
;TYPE:WALL-INNER
G1 X3 Y4 E0.2
;TYPE:INFILL
G1 X5 Y6 E0.3
;LAYER:1
;TYPE:WALL-OUTER
G1 X7 Y8 E0.4
`;
  const summary = analyzeGcode(gcode);
  assert.equal(summary.layerCount, 2);
  assert.equal(summary.layers.length, 2);
  assert.deepEqual(summary.perLayerWalls, [2, 1]);
  assert.equal(summary.totalExtrusion > 0, true);
  assert.equal(summary.bbox[3] - summary.bbox[0] > 0, true);
});

test("analyzeIr parses mode-tagged segments into the same summary shape", () => {
  const ir = {
    segments: [
      { layer: 0, kind: "wall_outer", extrusion_mm3: 5, positions: [0, 0, 0] },
      { layer: 0, kind: "wall_inner", extrusion_mm3: 5, positions: [10, 0, 0] },
      { layer: 0, kind: "infill", extrusion_mm3: 1, positions: [5, 5, 0] },
      { layer: 1, kind: "wall_outer", extrusion_mm3: 5, positions: [0, 0, 0.2] },
    ],
  };
  const summary = analyzeIr(ir);
  assert.equal(summary.layerCount, 2);
  assert.deepEqual(summary.perLayerWalls, [2, 1]);
  assert.ok(summary.totalExtrusion > 0);
});

test("IR and gcode summaries are comparable (same budget)", () => {
  const ref = analyzeIr({
    segments: [
      { layer: 0, kind: "wall_outer", extrusion_mm3: 5, positions: [0, 0, 0] },
      { layer: 0, kind: "wall_inner", extrusion_mm3: 5, positions: [10, 0, 0] },
      { layer: 0, kind: "infill", extrusion_mm3: 1, positions: [5, 5, 0] },
      { layer: 1, kind: "wall_outer", extrusion_mm3: 5, positions: [0, 0, 0.2] },
    ],
  });
  const cand = analyzeIr({
    segments: [
      { layer: 0, kind: "wall_outer", extrusion_mm3: 5, positions: [0, 0, 0] },
      { layer: 0, kind: "wall_inner", extrusion_mm3: 5, positions: [10, 0, 0] },
      { layer: 0, kind: "infill", extrusion_mm3: 1, positions: [5, 5, 0] },
      { layer: 1, kind: "wall_outer", extrusion_mm3: 5, positions: [0, 0, 0.2] },
    ],
  });
  const cmp = comparePlanarRuns(ref, cand, { wallCountDelta: 0, infillVolumePct: 15, bboxMm: 0.5 });
  assert.ok(cmp.pass);
});

test("analyzeGcode handles the Anycubic ;LAYER_CHANGE format", () => {
  // Real Anycubic Slicer Next output style: ;LAYER_CHANGE + ;Z: + ;TYPE:
  const gcode = `
; HEADER_BLOCK_START
; total layer number: 3
; HEADER_BLOCK_END
;EXECUTABLE_BLOCK_START
;TYPE:Custom
;LAYER_CHANGE
;Z:0.2
;HEIGHT:0.2
;TYPE:Outer wall
G1 X1 Y2 E0.1
;TYPE:Inner wall
G1 X3 Y4 E0.2
;TYPE:Bottom surface
G1 X5 Y6 E0.3
;LAYER_CHANGE
;Z:0.4
;TYPE:Outer wall
G1 X7 Y8 E0.4
`;
  const summary = analyzeGcode(gcode);
  assert.equal(summary.layerCount > 0, true);
  assert.equal(summary.layers.length, 2); // two LAYER_CHANGE markers
  // first layer: outer + inner wall → 2; second: outer → 1
  assert.equal(summary.perLayerWalls[0], 2);
  assert.equal(summary.perLayerWalls[1], 1);
  assert.ok(summary.bbox[3] > summary.bbox[0]);
});
