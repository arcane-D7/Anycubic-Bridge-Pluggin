// S8-005 unit tests for the layer-preview view model
// (apps/editor/src/viewport/preview-model.ts) — pure, no React/three.
// Imported directly under Node 24 native TS support (same pattern as the
// S7-004 viewport-core integration tests).

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "viewport", "preview-model.ts"),
);
const {
  buildPreviewModel,
  previewLayerAt,
  playbackSegmentsAt,
  previewPlaybackStep,
  visiblePlaybackSegments,
} = await import(modelUrl.href);

const irUrl = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "ir.ts"));
const { parseIrDocument } = await import(irUrl.href);

function wallLayer(layer, z, from, to) {
  return {
    mode: "standard",
    kind: "WALL",
    layer,
    chain_id: `WALL#${layer}#1`,
    pose: { from: { x: from[0], y: from[1], z }, to: { x: to[0], y: to[1], z } },
  };
}

function infillSegment(layer, z, from, to) {
  return {
    mode: "standard",
    kind: "INFILL",
    layer,
    chain_id: `INFILL#${layer}#2`,
    pose: { from: { x: from[0], y: from[1], z }, to: { x: to[0], y: to[1], z } },
  };
}

function rampSegment(layer, from, to) {
  return {
    mode: "nonplanar",
    kind: "WALL",
    layer,
    chain_id: `WALL#${layer}#3`,
    pose: { from: { x: from[0], y: from[1], z: from[2] }, to: { x: to[0], y: to[1], z: to[2] } },
  };
}

test("buildPreviewModel: groups per-layer toolpaths + overlay counts", () => {
  const ir = {
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    build_volume: { x: 220, y: 220, z: 250 },
    segments: [
      wallLayer(0, 0.2, [10, 10], [20, 10]),
      wallLayer(0, 0.2, [20, 10], [20, 30]),
      infillSegment(0, 0.2, [12, 12], [18, 12]),
      wallLayer(1, 0.4, [10, 10], [20, 10]),
    ],
  };
  const model = buildPreviewModel(ir);
  assert.equal(model.version, "1.0");
  assert.equal(model.mode, "standard");
  assert.equal(model.layerCount, 2);
  assert.equal(model.layers.length, 2);
  assert.equal(model.layers[0].index, 0);
  assert.equal(model.layers[0].z, 0.2);
  assert.equal(model.layers[0].toolpaths.length, 3);
  assert.equal(model.layers[0].kindCounts.wall, 2);
  assert.equal(model.layers[0].kindCounts.infill, 1);
  assert.equal(model.layers[1].kindCounts.wall, 1);
  assert.equal(model.hasRamps, false);
});

test("buildPreviewModel: nonplanar ramps are tagged, never a layer jump", () => {
  const ir = {
    version: "1.1",
    mode: "nonplanar",
    dialect: "anycubic",
    build_volume: { x: 220, y: 220, z: 250 },
    segments: [
      wallLayer(0, 0.2, [10, 10], [20, 10]),
      rampSegment(0, [10, 10, 0.2], [20, 10, 1.2]), // continuous Z ramp layer 0
    ],
  };
  const model = buildPreviewModel(ir);
  assert.equal(model.hasRamps, true);
  assert.equal(model.layers[0].toolpaths.length, 2);
  const ramp = model.layers[0].toolpaths.find((t) => t.ramp);
  assert.ok(ramp, "ramp must be tagged");
  assert.equal(ramp.from[2], 0.2);
  assert.equal(ramp.to[2], 1.2);
  // Ramp is rendered as a continuous line (from→to), not as a jump.
  assert.deepEqual([...ramp.from], [10, 10, 0.2]);
  assert.deepEqual([...ramp.to], [20, 10, 1.2]);
});

test("previewLayerAt: standard renders only the selected layer, layer-aligned", () => {
  const ir = {
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    build_volume: { x: 220, y: 220, z: 250 },
    segments: [wallLayer(0, 0.2, [10, 10], [20, 10]), wallLayer(1, 0.4, [10, 10], [20, 10])],
  };
  const model = buildPreviewModel(ir);
  const layer0 = previewLayerAt(model, 0);
  assert.equal(layer0.length, 1);
  assert.equal(layer0[0].from[2], 0.2);
  const layer1 = previewLayerAt(model, 1);
  assert.equal(layer1.length, 1);
  assert.equal(layer1[0].from[2], 0.4);
  assert.equal(previewLayerAt(model, 99).length, 0);
});

test("previewLayerAt: nonplanar ramps bridge adjacent layers (no jump)", () => {
  const ir = {
    version: "1.1",
    mode: "nonplanar",
    dialect: "anycubic",
    build_volume: { x: 220, y: 220, z: 250 },
    segments: [
      wallLayer(0, 0.2, [10, 10], [20, 10]),
      rampSegment(0, [10, 10, 0.2], [20, 10, 1.2]),
      wallLayer(1, 1.4, [20, 10], [30, 10]),
    ],
  };
  const model = buildPreviewModel(ir);
  const layer1 = previewLayerAt(model, 1);
  // The ramp spans the 0.2→1.2 z band; at layer 1 (z=1.4) the ramp is not
  // within the band → only the wall shows. Scrubbing to layer 0 shows the ramp
  // continuously.
  const layer0 = previewLayerAt(model, 0);
  assert.ok(
    layer0.some((t) => t.ramp),
    "layer 0 shows the continuous ramp",
  );
  assert.ok(!layer1.some((t) => t.ramp), "layer 1 band is past the ramp");
});

test("model is deterministic: same IR → identical JSON", () => {
  const ir = {
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    segments: [wallLayer(0, 0.2, [10, 10], [20, 10])],
  };
  const a = JSON.stringify(buildPreviewModel(ir));
  const b = JSON.stringify(buildPreviewModel(structuredClone(ir)));
  assert.equal(a, b);
});

function parsedSegment(overrides = {}) {
  return {
    mode: "standard",
    kind: "WALL",
    layer: 0,
    orientation: [0, 0, 1],
    pose: { from: { x: 10, y: 10, z: 0.2 }, to: { x: 20, y: 10, z: 0.2 } },
    ...overrides,
  };
}

function validDoc(overrides = {}) {
  return {
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    coordinate_frame: "slice-ir",
    units: "mm",
    build_volume: { x: 220, y: 220, z: 250 },
    segments: [parsedSegment()],
    ...overrides,
  };
}

test("parseIrDocument: rejects an unknown mode", () => {
  assert.throws(() => parseIrDocument(validDoc({ mode: "spiral" })), /mode/);
  assert.throws(() => parseIrDocument(validDoc({ mode: 1 })), /mode/);
});

test("parseIrDocument: requires the declared IR frame and millimetre units", () => {
  assert.throws(
    () => parseIrDocument(validDoc({ coordinate_frame: "editor-world" })),
    /coordinate_frame/,
  );
  assert.throws(() => parseIrDocument(validDoc({ units: "in" })), /units/);
  const missingFrame = validDoc();
  delete missingFrame.coordinate_frame;
  assert.throws(() => parseIrDocument(missingFrame), /coordinate_frame/);
});

test("parseIrDocument: rejects nonfinite numbers", () => {
  const nanSeg = parsedSegment();
  nanSeg.pose.to.z = Number.NaN;
  assert.throws(() => parseIrDocument(validDoc({ segments: [nanSeg] })), /finite/);
  assert.throws(
    () => parseIrDocument(validDoc({ build_volume: { x: 0, y: 220, z: 250 } })),
    /positive/,
  );
  assert.throws(() => parseIrDocument(validDoc({ segments: [] })), /nonempty/);
});

test("parseIrDocument: rejects segment mode mismatch", () => {
  const doc = validDoc({ mode: "nonplanar", segments: [parsedSegment({ mode: "standard" })] });
  assert.throws(() => parseIrDocument(doc), /does not match document mode/);
});

test("parseIrDocument: rejects Z ramps on standard extrusions but allows TRAVEL", () => {
  const ramped = parsedSegment({
    kind: "WALL",
    pose: { from: { x: 10, y: 10, z: 0.2 }, to: { x: 20, y: 10, z: 1.2 } },
  });
  assert.throws(() => parseIrDocument(validDoc({ segments: [ramped] })), /Z ramp/);
  const travel = parsedSegment({
    kind: "TRAVEL",
    pose: { from: { x: 10, y: 10, z: 0.2 }, to: { x: 20, y: 10, z: 1.2 } },
  });
  const doc = parseIrDocument(validDoc({ segments: [travel] }));
  assert.equal(doc.segments.length, 1);
  assert.equal(doc.segments[0].kind, "TRAVEL");
});

test("parseIrDocument: accepts a valid sample and returns detached data", () => {
  const ir = validDoc();
  const doc = parseIrDocument(ir);
  assert.equal(doc.version, "1.1");
  assert.equal(doc.mode, "standard");
  assert.equal(doc.dialect, "anycubic");
  assert.equal(doc.coordinate_frame, "slice-ir");
  assert.equal(doc.units, "mm");
  assert.equal(doc.build_volume?.x, 220);
  assert.equal(doc.segments.length, 1);
  assert.equal(doc.segments[0].kind, "WALL");
  assert.equal(doc.segments[0].layer, 0);
  assert.deepEqual([...doc.segments[0].orientation], [0, 0, 1]);
  assert.deepEqual([doc.segments[0].pose.from.x, doc.segments[0].pose.from.z], [10, 0.2]);
  ir.segments[0].pose.from.x = 999;
  ir.build_volume.x = 0;
  assert.equal(doc.segments[0].pose.from.x, 10);
  assert.equal(doc.build_volume?.x, 220);
  assert.throws(() => parseIrDocument(validDoc({ segments: ["nope"] })), /must be an object/);
});

test("parseIrDocument and preview preserve native artifact identity, attributes and layer IDs", () => {
  const segment = parsedSegment({
    kind: "BRIM",
    layer: 7,
    segment_id: "seg-7-0",
    object_id: "object-a",
    part_id: "part-a",
    execution_order: 0,
    gcode_line_start: 21,
    gcode_line_end: 22,
    tool_id: null,
    material_id: "pla-project",
    speed: { mm_s: 30 },
    flow: { q_mm3_s: 2.7, e_mm: 0.374 },
    bead: { area_mm2: 0.09, variable: false },
    cooling: { fan_pct: 100 },
    layer_height_mm: 0.2,
    line_width_mm: 0.45,
    provenance: { generator: "planar-core-section-v2", revision: 42, layer: 7 },
  });
  const parsed = parseIrDocument(
    validDoc({
      source_revision: 42,
      target_ids: ["object-a"],
      placement: { x: 11, y: 12, z: 13 },
      segments: [segment, parsedSegment({ kind: "TRAVEL", layer: 23 })],
    }),
  );
  assert.equal(parsed.segments[0].segment_id, "seg-7-0");
  assert.equal(parsed.segments[0].object_id, "object-a");
  assert.equal(parsed.segments[0].flow?.q_mm3_s, 2.7);
  assert.equal(parsed.segments[0].speed?.mm_s, 30);
  assert.equal(parsed.source_revision, 42);

  const model = buildPreviewModel(parsed);
  assert.deepEqual(
    model.layers.map((layer) => layer.index),
    [7, 23],
  );
  assert.equal(model.layers[0].toolpaths[0].kind, "BRIM");
  assert.equal(model.layers[0].toolpaths[0].segmentId, "seg-7-0");
  assert.equal(model.layers[0].toolpaths[0].flowMm3S, 2.7);
  assert.equal(model.layers[0].toolpaths[0].placementMm[0], 11);
  assert.equal(model.layers[0].zAvailable, true);
  assert.equal(model.layers[1].toolpaths[0].speedMmS, null);
});

test("parseIrDocument rejects unsupported kinds and invalid cross-references", () => {
  assert.throws(
    () => parseIrDocument(validDoc({ segments: [parsedSegment({ kind: "UNKNOWN" })] })),
    /kind/,
  );
  assert.throws(
    () =>
      parseIrDocument(
        validDoc({
          source_revision: 1,
          segments: [
            parsedSegment({ segment_id: "duplicate" }),
            parsedSegment({ segment_id: "duplicate" }),
          ],
        }),
      ),
    /unique/,
  );
});

test("parseIrDocument exposes stable structured diagnostics for invalid and oversized artifacts", () => {
  assert.throws(
    () => parseIrDocument(validDoc({ mode: "spiral" })),
    (error) => error.code === "IR_INVALID" && error.path === "mode",
  );
  assert.throws(
    () => parseIrDocument(validDoc({ segments: Array(200_001).fill(parsedSegment()) })),
    (error) => error.code === "IR_LIMIT" && error.path === "segments",
  );
});

test("preview playback uses execution order and positional layer selection for noncontiguous IDs", () => {
  const ir = {
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    coordinate_frame: "slice-ir",
    units: "mm",
    segments: [
      {
        ...parsedSegment({ layer: 12, kind: "BRIM", segment_id: "b", execution_order: 2 }),
        provenance: undefined,
      },
      {
        ...parsedSegment({ layer: 3, kind: "WALL", segment_id: "a", execution_order: 0 }),
        provenance: undefined,
      },
      {
        ...parsedSegment({ layer: 12, kind: "INFILL", segment_id: "c", execution_order: 1 }),
        provenance: undefined,
      },
    ],
  };
  const model = buildPreviewModel(parseIrDocument(ir));
  const layer0 = previewLayerAt(model, 0);
  assert.equal(model.layers[0].index, 3);
  assert.deepEqual(
    layer0.map((path) => path.segmentId),
    ["a"],
  );
  const layer1 = previewLayerAt(model, 1);
  assert.deepEqual(
    layer1.map((path) => path.segmentId),
    ["c", "b"],
  );
  assert.deepEqual(
    model.layers[1].toolpaths.map((path) => path.executionOrder),
    [1, 2],
  );
});

test("preview playback steps segments in execution order and filters only the view", () => {
  const model = buildPreviewModel({
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    segments: [
      {
        ...parsedSegment({ layer: 4, kind: "WALL", segment_id: "s1", execution_order: 0 }),
        provenance: undefined,
      },
      {
        ...parsedSegment({ layer: 4, kind: "TRAVEL", segment_id: "s2", execution_order: 1 }),
        provenance: undefined,
      },
      {
        ...parsedSegment({ layer: 9, kind: "INFILL", segment_id: "s3", execution_order: 2 }),
        provenance: undefined,
      },
    ],
  });
  assert.deepEqual(
    playbackSegmentsAt(model, 0).map((segment) => segment.segmentId),
    ["s1", "s2"],
  );
  assert.deepEqual(
    playbackSegmentsAt(model, 0, 1).map((segment) => segment.segmentId),
    ["s1", "s2"],
  );
  assert.deepEqual(
    playbackSegmentsAt(model, 1, 0, true).map((segment) => segment.segmentId),
    ["s1", "s2", "s3"],
  );
  assert.deepEqual(previewPlaybackStep(model, 0, 0, 1), {
    layerPosition: 0,
    segmentPosition: 1,
    accumulated: false,
  });
  assert.deepEqual(previewPlaybackStep(model, 0, 1, 1), {
    layerPosition: 1,
    segmentPosition: 0,
    accumulated: false,
  });
  assert.deepEqual(
    visiblePlaybackSegments(
      model,
      { layerPosition: 1, segmentPosition: 0, accumulated: true },
      { WALL: false, TRAVEL: false },
    ).map((segment) => segment.segmentId),
    ["s3"],
  );
});

test("preview playback follows global execution order when layer IDs are interleaved", () => {
  const model = buildPreviewModel({
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    coordinate_frame: "slice-ir",
    units: "mm",
    segments: [
      {
        ...parsedSegment({ layer: 12, kind: "INFILL", segment_id: "second", execution_order: 1 }),
        provenance: undefined,
      },
      {
        ...parsedSegment({ layer: 3, kind: "WALL", segment_id: "first", execution_order: 0 }),
        provenance: undefined,
      },
      {
        ...parsedSegment({ layer: 12, kind: "TRAVEL", segment_id: "third", execution_order: 2 }),
        provenance: undefined,
      },
    ],
  });

  assert.deepEqual(
    playbackSegmentsAt(model, 1, 0).map((segment) => segment.segmentId),
    ["second"],
  );
  assert.deepEqual(
    playbackSegmentsAt(model, 1, 1, true).map((segment) => segment.segmentId),
    ["first", "second", "third"],
  );
  assert.deepEqual(previewPlaybackStep(model, 0, 0, 1), {
    layerPosition: 1,
    segmentPosition: 0,
    accumulated: false,
  });
  assert.deepEqual(previewPlaybackStep(model, 1, 0, 1), {
    layerPosition: 1,
    segmentPosition: 1,
    accumulated: false,
  });
});

test("preview corpus meets declared 40k-segment load, scrub and heap budgets", () => {
  const segmentCount = 40_000;
  const segments = Array.from({ length: segmentCount }, (_, executionOrder) => ({
    ...parsedSegment({
      layer: Math.floor(executionOrder / 400) * 3 + 2,
      kind: executionOrder % 4 === 0 ? "TRAVEL" : "WALL",
      segment_id: `corpus-${executionOrder}`,
      execution_order: executionOrder,
      pose: {
        from: { x: executionOrder % 200, y: 1, z: executionOrder / 1000 },
        to: { x: (executionOrder % 200) + 0.5, y: 1.5, z: executionOrder / 1000 },
      },
    }),
    provenance: undefined,
  }));
  const beforeHeap = process.memoryUsage().heapUsed;
  const loadStart = performance.now();
  const model = buildPreviewModel({
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    segments,
  });
  const loadMs = performance.now() - loadStart;
  const loadHeapBytes = Math.max(0, process.memoryUsage().heapUsed - beforeHeap);
  assert.equal(model.orderedSegments.length, segmentCount);
  assert.ok(loadMs < 10_000, `preview load ${loadMs.toFixed(1)}ms exceeded 10,000ms`);
  assert.ok(
    loadHeapBytes < 256 * 1024 * 1024,
    `preview model heap delta ${loadHeapBytes} exceeded 256MiB`,
  );

  const lastLayer = model.layerCount - 1;
  const lastLayerModel = model.layers[lastLayer];
  assert.ok(lastLayerModel, "corpus must produce at least one layer");
  const lastSegment = lastLayerModel.toolpaths.length - 1;
  const scrubStart = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    const next = previewPlaybackStep(model, lastLayer, lastSegment, index % 2 === 0 ? -1 : 1);
    playbackSegmentsAt(model, next.layerPosition, next.segmentPosition, false);
  }
  const scrubMs = performance.now() - scrubStart;
  assert.ok(scrubMs < 5_000, `1,000 single-layer scrubs ${scrubMs.toFixed(1)}ms exceeded 5,000ms`);
  const cumulativeStart = performance.now();
  for (let index = 0; index < 100; index += 1) {
    playbackSegmentsAt(model, lastLayer, lastSegment, true);
  }
  const cumulativeMs = performance.now() - cumulativeStart;
  assert.ok(
    cumulativeMs < 5_000,
    `100 cumulative scrubs ${cumulativeMs.toFixed(1)}ms exceeded 5,000ms`,
  );
  console.log(
    `preview corpus: segments=${segmentCount}, layers=${model.layerCount}, load=${loadMs.toFixed(1)}ms, singleLayerScrub1000=${scrubMs.toFixed(1)}ms, cumulativeScrub100=${cumulativeMs.toFixed(1)}ms, heapDeltaMiB=${(loadHeapBytes / 1024 / 1024).toFixed(1)}; budgets load<10000ms singleLayerScrub1000<5000ms cumulativeScrub100<5000ms heap<256MiB`,
  );
});
