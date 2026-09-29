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
const { buildPreviewModel, previewLayerAt } = await import(modelUrl.href);

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
    version: "1.0",
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
    version: "1.0",
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
    version: "1.0",
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
    version: "1.0",
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
    version: "1.0",
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
    version: "1.0",
    mode: "standard",
    dialect: "anycubic",
    build_volume: { x: 220, y: 220, z: 250 },
    segments: [parsedSegment()],
    ...overrides,
  };
}

test("parseIrDocument: rejects an unknown mode", () => {
  assert.throws(() => parseIrDocument(validDoc({ mode: "spiral" })), /mode/);
  assert.throws(() => parseIrDocument(validDoc({ mode: 1 })), /mode/);
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
  assert.equal(doc.version, "1.0");
  assert.equal(doc.mode, "standard");
  assert.equal(doc.dialect, "anycubic");
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
