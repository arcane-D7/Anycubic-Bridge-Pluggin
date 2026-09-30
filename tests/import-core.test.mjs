// S9.2-005 unit tests — import normalization core (prepareImportedObject +
// toSceneObject + classifyFile). Pure functions only (no React/three.js) —
// imported directly under Node's native TS support.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreUrl = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "import-core.ts"));
const importerUrl = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "import.ts"));

const core = await import(coreUrl.href);
const importer = await import(importerUrl.href);

// ---------------------------------------------------------------- fixtures ---
/** A small triangle fan in the XZ plane (like an STL imported with Y=0 base). */
function fanBuffers() {
  // two triangles forming a 10x10 flat square in XY at z=0..0
  const positions = new Float32Array([
    // tri 1
    0,
    0,
    0, //
    10,
    0,
    0, //
    10,
    10,
    0, //
    // tri 2
    0,
    0,
    0, //
    10,
    10,
    0, //
    0,
    10,
    0, //
  ]);
  const normals = new Float32Array([
    0,
    0,
    -1, //
    0,
    0,
    -1, //
    0,
    0,
    -1, //
    0,
    0,
    -1, //
    0,
    0,
    -1, //
    0,
    0,
    -1, //
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  return {
    kind: "stl",
    name: "flat.stl",
    positions,
    normals,
    indices,
    bounds: { min: [0, 0, 0], max: [10, 10, 0] },
    vertexCount: 6,
    triangleCount: 2,
  };
}

function boxBuffers() {
  // A degenerate "box" — actually two triangles forming a cube face at X=0.
  const positions = new Float32Array([
    0,
    0,
    0, //
    0,
    10,
    0, //
    0,
    10,
    10, //
    0,
    0,
    0, //
    0,
    10,
    10, //
    0,
    0,
    10, //
  ]);
  const normals = new Float32Array([
    -1,
    0,
    0, //
    -1,
    0,
    0, //
    -1,
    0,
    0, //
    -1,
    0,
    0, //
    -1,
    0,
    0, //
    -1,
    0,
    0, //
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  return {
    kind: "3mf",
    name: "panel.3mf",
    positions,
    normals,
    indices,
    bounds: { min: [0, 0, 0], max: [0, 10, 10] },
    vertexCount: 6,
    triangleCount: 2,
  };
}

// ---------------------------------------------------------------- tests ----
test("classifyFile: stl/3mf extensions + rejects", () => {
  assert.equal(core.classifyFile("cube.stl"), "stl");
  assert.equal(core.classifyFile("CUBE.STL"), "stl");
  assert.equal(core.classifyFile("model.3mf"), "3mf");
  assert.equal(core.classifyFile("model.3mf.zip"), "3mf");
  assert.equal(core.classifyFile("model.obj"), null);
  assert.equal(core.classifyFile("model.txt"), null);
  assert.equal(core.classifyFile(""), null);
});

test("fitFactor: clamps to 1 for small meshes, shrinks oversized to bed", () => {
  // 50mm mesh on 220mm bed → keep (already fits).
  assert.equal(core.fitFactor({ min: [0, 0, 0], max: [50, 30, 20] }), 1);
  // 500mm mesh → 220/500 = 0.44.
  assert.equal(core.fitFactor({ min: [0, 0, 0], max: [500, 10, 10] }), 0.44);
  // takes the LONGEST extent (Z here).
  assert.equal(core.fitFactor({ min: [0, 0, 0], max: [50, 50, 440] }), 0.5);
  // degenerate → 1 (no crash).
  assert.equal(core.fitFactor({ min: [0, 0, 0], max: [0, 0, 0] }), 1);
});

test("prepareImportedObject: stays flat, z=0, centered XY by default", () => {
  const out = core.prepareImportedObject(fanBuffers());
  assert.equal(out.triangles, 2);
  assert.equal(out.vertices, 6);
  assert.equal(out.watertight, false); // open fan
  // min Z is 0 → sits on the plate
  assert.equal(out.bounds.min[2], 0);
  // centered X/Y: extent halves around 0
  assert.ok(Math.abs(out.bounds.min[0] + 5) < 1e-6);
  assert.ok(Math.abs(out.bounds.max[0] - 5) < 1e-6);
  assert.ok(Math.abs(out.bounds.min[1] + 5) < 1e-6);
  // transform is a no-op placement (buffer-centric shell)
  assert.deepEqual(out.transform, { x: 0, y: 0, z: 0 });
});

test("orientFlat rotates a vertical panel so its dominant axis pair lies flat", () => {
  // panel is thin in X (0), height in Y and Z → lift Z? No: smallest extent is
  // X (0) → lift = X axis → the panel rotates so its large Y/Z face lies flat.
  const out = core.prepareImportedObject(boxBuffers(), { orientFlat: true });
  // after rotation the smallest (X) axis becomes Z: max-z extent ~0, base z=0.
  assert.ok(Math.abs(out.bounds.max[2]) < 1e-6);
  assert.ok(out.sizeMm[2] < 1e-6); // height ≈ 0 after lifting the thin axis
  // still watertight? open face → false
  assert.equal(out.watertight, false);
});

test("center=false keeps the source position (no XY shift)", () => {
  const out = core.prepareImportedObject(fanBuffers(), { center: false, orientFlat: false });
  // min X/Y stay at 0 (no centering)
  assert.ok(Math.abs(out.bounds.min[0]) < 1e-6);
  assert.ok(Math.abs(out.bounds.min[1]) < 1e-6);
  assert.equal(out.transform.x, 0);
});

test("scale multiplies dimensions", () => {
  const out = core.prepareImportedObject(fanBuffers(), { scale: 2, orientFlat: false });
  assert.ok(Math.abs(out.sizeMm[0] - 20) < 1e-6);
  assert.ok(Math.abs(out.sizeMm[1] - 20) < 1e-6);
});

test("toSceneObject: payload matches the store snapshot shape (visible/locked/geometry)", () => {
  const prepared = core.prepareImportedObject(fanBuffers());
  const obj = core.toSceneObject(prepared);
  assert.equal(obj.name, "flat.stl");
  assert.equal(obj.triangles, 2);
  assert.equal(obj.vertices, 6);
  assert.equal(obj.watertight, false);
  assert.equal(obj.visible, true);
  assert.equal(obj.locked, false);
  assert.equal(obj.parentId, null);
  assert.equal(obj.geometry.positions.length, prepared.positions.length);
  assert.ok(obj.transform);
  // the geometry arrays are the same buffers (no accidental copy/corruption)
  assert.equal(obj.geometry.positions, prepared.positions);
});

test("prepareImportedObject: real STL mesh reports correct geometry + triangle count", () => {
  // Note: cube-20mm.stl (12 tri binary STL) is NOT a closed manifold — its
  // corners land at [-1,0,0]..[20,20,20], so watertight=false is expected.
  // The test validates the parser + normalization produce consistent counts
  // and a ~20mm cube bounds.
  const fixture = path.join(root, "tests", "fixtures", "cube-20mm.stl");
  const fileBuf = fs.readFileSync(fixture);
  const buf = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
  const parsed = importer.parseStl(buf, "cube-20mm.stl");
  assert.equal(parsed.triangleCount, 12);
  const out = core.prepareImportedObject(parsed, { orientFlat: false });
  assert.equal(out.watertight, false); // open cube fixture
  assert.equal(out.triangles, 12);
  assert.equal(out.vertices, 36);
  // size approx 20mm cube (20×20×20 ±0.2). Note fixture spans [-1,0,0]..[20,20,20]
  // so X span is 21 — allow that.
  assert.ok(Math.abs(out.sizeMm[0] - 20) < 1.2, `X size ${out.sizeMm[0]}`);
  assert.ok(Math.abs(out.sizeMm[1] - 20) < 0.3, `Y size ${out.sizeMm[1]}`);
  assert.ok(Math.abs(out.sizeMm[2] - 20) < 0.3, `Z size ${out.sizeMm[2]}`);
});
