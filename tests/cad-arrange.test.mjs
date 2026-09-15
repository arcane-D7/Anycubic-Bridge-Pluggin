import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeObjects } from "../scripts/cad-arrange.mjs";

// ---------------------------------------------------------------------------
// cad-arrange — distribuição uniforme de peças no plate (shelf packing)
// ---------------------------------------------------------------------------

/** Faz um box mesh {positions: Float32Array, tris} com centro em (cx,cy,cz). */
function boxMesh(w, d, h, cx = 0, cy = 0, cz = 0) {
  const positions = Float32Array.from([
    cx - w / 2, cy - d / 2, cz,
    cx + w / 2, cy - d / 2, cz,
    cx + w / 2, cy + d / 2, cz,
    cx - w / 2, cy + d / 2, cz,
    cx - w / 2, cy - d / 2, cz + h,
    cx + w / 2, cy - d / 2, cz + h,
    cx + w / 2, cy + d / 2, cz + h,
    cx - w / 2, cy + d / 2, cz + h,
  ]);
  const tris = [];
  // 6 faces, 2 tris each (winding irrelevant for bbox tests)
  const faces = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 3, 7, 4],
  ];
  for (const f of faces) {
    tris.push({ a: f[0], b: f[1], c: f[2] });
    tris.push({ a: f[0], b: f[2], c: f[3] });
  }
  return { positions, tris };
}

function bbox(mesh) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

function makeMap(entries) {
  return new Map(entries.map(([name, mesh]) => [name, mesh]));
}

test("arrange: 3 objects placed without overlap, all minZ=0, block centered", () => {
  const objects = makeMap([
    ["big", boxMesh(40, 20, 10)], // centrado na origem
    ["small", boxMesh(10, 10, 5, 100, -100, -3)], // fora do plate + flutuando
    ["mid", boxMesh(20, 30, 8, -80, 70, 2)],
  ]);
  const { objects: out, placed, warnings } = arrangeObjects(objects, {
    plateW: 220,
    plateD: 220,
    gap: 2,
  });
  assert.equal(placed.length, 3);
  assert.deepEqual(warnings, []);

  // Z check: all sit on plate
  for (const [name, m] of out) {
    const b = bbox(m);
    assert.ok(Math.abs(b.min.z) < 1e-6, `${name} should have minZ=0, got ${b.min.z}`);
  }

  // XY overlap check (pairwise, ignoring Z)
  const list = [...out.entries()].map(([name, m]) => ({ name, bb: bbox(m) }));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].bb, b = list[j].bb;
      const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
      const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
      assert.ok(ox <= 1e-6 || oy <= 1e-6, `${list[i].name} overlaps ${list[j].name}`);
    }
  }

  // Block centered: min/max symmetric-ish around 0 (allow small epsilon)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [, m] of out) {
    const b = bbox(m);
    minX = Math.min(minX, b.min.x); maxX = Math.max(maxX, b.max.x);
    minY = Math.min(minY, b.min.y); maxY = Math.max(maxY, b.max.y);
  }
  assert.ok(Math.abs((minX + maxX) / 2) < 1, `block not X-centered: ${(minX + maxX) / 2}`);
  assert.ok(Math.abs((minY + maxY) / 2) < 1, `block not Y-centered: ${(minY + maxY) / 2}`);

  // All within plate
  assert.ok(maxX <= 110 + 1e-3 && minX >= -110 - 1e-3, "X exceeds plate");
  assert.ok(maxY <= 110 + 1e-3 && minY >= -110 - 1e-3, "Y exceeds plate");
});

test("arrange: respects gap (no footprints closer than gap)", () => {
  const objects = makeMap([
    ["a", boxMesh(10, 10, 4)],
    ["b", boxMesh(10, 10, 4)],
  ]);
  const gap = 5;
  const { placed } = arrangeObjects(objects, { plateW: 220, plateD: 220, gap });
  assert.equal(placed.length, 2);
  assert.ok(placed[1].x - placed[0].x >= 10 + gap - 1e-6, "gap not respected (X)");
});

test("arrange: empty input → empty result, no crash", () => {
  const { objects, placed, warnings } = arrangeObjects(new Map(), {});
  assert.equal(objects.size, 0);
  assert.equal(placed.length, 0);
  assert.deepEqual(warnings, []);
});

test("arrange: warning when a piece exceeds the plate", () => {
  const objects = makeMap([["huge", boxMesh(300, 10, 5)]]);
  const { placed, warnings } = arrangeObjects(objects, { plateW: 220, plateD: 220, gap: 0 });
  assert.equal(placed.length, 1);
  assert.ok(warnings.length >= 1, "expected a warning for oversized piece");
});
