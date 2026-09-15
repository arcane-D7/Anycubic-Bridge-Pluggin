import { test } from "node:test";
import assert from "node:assert/strict";
import {
  booleanMesh,
  normalizeOp,
  makeBox,
  makeCylinder,
  makeSphere,
  buildGeometry,
  geometryToMesh,
  CSG_OPS,
  OP_NAMES,
} from "../scripts/cad-csg-engine.mjs";

// ---------------------------------------------------------------------------
// Pure engine unit tests (S1-001)
// ---------------------------------------------------------------------------

test("makeBox produces a watertight box mesh with 12 tris", () => {
  const box = makeBox(10, 20, 30);
  assert.equal(box.tris.length, 12);
  // THREE.BoxGeometry is indexed: 8 corner verts but with per-face normals it
  // carries 24 unique positions; geometryToMesh keeps the indexed contract.
  assert.equal(box.positions.length / 3, 24);
  assert.equal(box.watertight, true);
  assert.equal(box.op, "box");
});

test("makeCylinder produces a manifold cylinder mesh", () => {
  const cyl = makeCylinder(5, 10, 32);
  assert.ok(cyl.tris.length > 30);
  // bounding: cylinder height 10 along Y
  const ys = [];
  for (let i = 0; i < cyl.positions.length; i += 3) ys.push(cyl.positions[i + 1]);
  assert.ok(Math.abs(Math.max(...ys) - 5) < 1e-6);
  assert.ok(Math.abs(Math.min(...ys) + 5) < 1e-6);
});

test("normalizeOp accepts canonical ops and rejects unknown", () => {
  assert.equal(normalizeOp("add"), "add");
  assert.equal(normalizeOp("SUBTRACT"), "subtract");
  assert.equal(normalizeOp("intersect"), "intersect");
  assert.equal(normalizeOp("difference"), "difference");
  assert.ok(OP_NAMES.length === 4);
  assert.ok(Object.keys(CSG_OPS).length === 4);
  assert.throws(() => normalizeOp("bogus"), /unsupported boolean op/);
  assert.throws(() => normalizeOp(""), /unsupported boolean op/);
});

test("buildGeometry rejects malformed inputs", () => {
  assert.throws(() => buildGeometry({ positions: [1, 2], tris: [] }), /divisible by 3/);
  assert.throws(() => buildGeometry({ positions: [], tris: [] }), /non-empty/);
});

test("box subtract cylinder leaves watertight result (non-convex operands)", () => {
  const box = makeBox(30, 30, 10);
  const cyl = makeCylinder(6, 12, 48);
  const shifted = {
    ...cyl,
    positions: cyl.positions.map((v, i) => (i % 3 === 1 ? v + 3 : v)),
  };
  const result = booleanMesh(box, shifted, "subtract");
  assert.equal(result.watertight, true);
  assert.ok(result.tris.length >= 12, `expected >= 12 tris, got ${result.tris.length}`);
  // A hole was cut: three-bvh-csg splits triangles along the intersection ring,
  // so the result carries more faces than the plain box.
  assert.ok(
    result.tris.length > box.tris.length,
    `subtract should add hole walls (> ${box.tris.length} tris), got ${result.tris.length}`,
  );
  // indexed tris must be co-consistent
  const maxIdx = Math.max(...result.tris.flatMap((t) => [t.a, t.b, t.c]));
  assert.ok(maxIdx < result.positions.length / 3);
});

test("box union cylinder builds a combined watertight mesh", () => {
  const box = makeBox(20, 20, 20);
  const cyl = makeCylinder(4, 30, 32);
  const shifted = {
    ...cyl,
    positions: cyl.positions.map((v, i) => (i % 3 === 1 ? v + 2 : v)),
  };
  const result = booleanMesh(box, shifted, "add");
  assert.equal(result.watertight, true);
  const triCount = result.tris.length;
  assert.ok(triCount > 12, `union should have more than box tris, got ${triCount}`);
});

test("cylinder intersect box yields closed mesh", () => {
  const box = makeBox(20, 20, 20);
  const cyl = makeCylinder(4, 30, 32);
  const shifted = {
    ...cyl,
    positions: cyl.positions.map((v, i) => (i % 3 === 1 ? v + 2 : v)),
  };
  const result = booleanMesh(box, shifted, "intersect");
  assert.equal(result.watertight, true);
  assert.ok(result.tris.length >= 12);
});

test("empty result cases do not throw (difference outside)", () => {
  // Two far-apart boxes: intersect should produce empty manifold (three-bvh-csg
  // may return a degenerate or empty geometry). We only assert it does not throw.
  const a = makeBox(10, 10, 10);
  const b = makeBox(10, 10, 10);
  const shifted = {
    ...b,
    positions: b.positions.map((v, i) => {
      const idx3 = i % 3;
      if (idx3 === 0) return v + 100;
      return v;
    }),
  };
  const result = booleanMesh(a, shifted, "intersect");
  // three-bvh-csg returns a valid (possibly empty) Brush; geometry exists.
  assert.ok(result);
});

test("geometryToMesh round-trips non-indexed geometry", () => {
  const geo = buildGeometry(makeBox(5, 5, 5));
  const m = geometryToMesh(geo, "add");
  assert.equal(m.tris.length, 12);
  assert.equal(m.positions.length / 3, 36);
  assert.equal(m.op, "add");
});
