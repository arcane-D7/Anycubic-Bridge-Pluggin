import { test } from "node:test";
import assert from "node:assert/strict";
import { createParametricEngine, resetManifold, meshFromHandle } from "../scripts/cad-parametric-engine.mjs";
import { validateParametricScript, runParametric } from "../scripts/cad-parametric-tool.mjs";
import { exportStep, meshBounds, tryInitReplicad } from "../scripts/cad-step-export.mjs";

// ---------------------------------------------------------------------------
// S2-001 parametric engine (manifold core) — unit tests
// ---------------------------------------------------------------------------

test("engine primitives produce watertight meshes with positive volume", async () => {
  resetManifold();
  const e = await createParametricEngine();
  const box = e.meshFromHandle(e.box(20, 20, 10), "box");
  assert.equal(box.watertight, true);
  assert.ok(box.volumeMm3 > 0, "box volume > 0");
  assert.ok(box.tris.length >= 12);

  const cyl = e.meshFromHandle(e.cylinder(6, 12, 48), "cyl");
  assert.equal(cyl.watertight, true);
  assert.ok(cyl.volumeMm3 > 0);

  const sph = e.meshFromHandle(e.sphere(10, 32), "sph");
  assert.equal(sph.watertight, true);
  assert.ok(sph.volumeMm3 > 0);

  const cone = e.meshFromHandle(e.cone(10, 0, 20, 32), "cone");
  assert.equal(cone.watertight, true);
  assert.ok(cone.volumeMm3 > 0);

  const tetra = e.meshFromHandle(e.tetrahedron(20), "tetra");
  assert.equal(tetra.watertight, true);
  assert.ok(tetra.volumeMm3 > 0);
});

test("boolean subtract removes volume (hole in box)", async () => {
  const e = await createParametricEngine();
  const box = e.box(24, 24, 10);
  const hole = e.translate(e.cylinder(5, 40, 48), { x: 0, y: 3, z: 0 });
  const result = e.subtract(box, hole);
  const mesh = e.meshFromHandle(result, "holed");
  assert.equal(mesh.watertight, true);
  // The full box volume minus cylinder cross-section is strictly smaller.
  const fullVol = e.meshFromHandle(e.box(24, 24, 10)).volumeMm3;
  assert.ok(mesh.volumeMm3 < fullVol, `holed ${mesh.volumeMm3} < box ${fullVol}`);
  assert.ok(mesh.tris.length > 12, "hole walls add triangles");
});

test("boolean union and intersect behave correctly", async () => {
  const e = await createParametricEngine();
  const a = e.box(20, 20, 20);
  const b = e.translate(e.box(20, 20, 20), { x: 10, y: 0, z: 0 });
  const u = e.meshFromHandle(e.add(a, b), "union");
  assert.equal(u.watertight, true);
  assert.ok(u.volumeMm3 > e.meshFromHandle(e.box(20, 20, 20)).volumeMm3);

  const i = e.meshFromHandle(e.intersect(a, b), "intersect");
  assert.equal(i.watertight, true);
  const single = e.meshFromHandle(e.box(20, 20, 20)).volumeMm3;
  assert.ok(i.volumeMm3 < single, "intersect volume < single cube");
});

test("transforms (translate/rotate/scale/mirror) succeed and stay watertight", async () => {
  const e = await createParametricEngine();
  const base = e.box(10, 10, 10);
  const t = e.meshFromHandle(e.translate(base, { x: 5, y: -3, z: 2 }), "t");
  assert.equal(t.watertight, true);
  const r = e.meshFromHandle(e.rotate(base, 0, Math.PI / 4, 0), "r");
  assert.equal(r.watertight, true);
  const s = e.meshFromHandle(e.scale(base, { x: 2, y: 1, z: 1 }), "s");
  assert.equal(s.watertight, true);
  const m = e.meshFromHandle(e.mirror(base, { x: 1, y: 0, z: 0 }), "m");
  assert.equal(m.watertight, true);
});

test("meshFromHandle round-trips positions/tris contract", async () => {
  const e = await createParametricEngine();
  const mesh = e.meshFromHandle(e.box(8, 8, 8), "x");
  assert.ok(mesh.positions.length % 3 === 0);
  for (const t of mesh.tris) {
    assert.ok(t.a >= 0 && t.b >= 0 && t.c >= 0);
    assert.ok(t.a < mesh.positions.length / 3);
    assert.ok(t.b < mesh.positions.length / 3);
    assert.ok(t.c < mesh.positions.length / 3);
  }
});

// ---------------------------------------------------------------------------
// S2-003 parametric tool — sandbox + execution tests
// ---------------------------------------------------------------------------

test("validateParametricScript rejects forbidden tokens", () => {
  assert.equal(validateParametricScript("").ok, false);
  assert.ok(validateParametricScript("box(1,2,3)").ok);
  assert.ok(!validateParametricScript("process.exit()").ok);
  assert.ok(!validateParametricScript("require('fs')").ok);
  assert.ok(!validateParametricScript("import('x')").ok);
  assert.ok(!validateParametricScript("fetch('http://x')").ok);
  assert.ok(!validateParametricScript("eval('1')").ok);
});

test("runParametric executes a valid script and returns mesh stats", async () => {
  const r = await runParametric({
    script: "let b = box(20, 24, 10); let h = cylinder(4, 40, 48); return subtract(b, h);",
    object_name: "demo",
    export_format: "none",
  });
  assert.equal(r.ok, true);
  assert.equal(r.object, "demo");
  assert.equal(r.watertight, true);
  assert.ok(r.vertices > 0);
  assert.ok(r.triangles > 0);
  assert.ok(r.volume_mm3 > 0);
  assert.equal(r.stl_base64, null);
});

test("runParametric rejects sandboxed scripts cleanly", async () => {
  await assert.rejects(
    () => runParametric({ script: "return process.exit(1)" }),
    /sandboxed|may not contain/,
  );
});

test("runParametric requires the script to return a handle", async () => {
  await assert.rejects(() => runParametric({ script: "return 42" }), /manifold handle/);
});

test("runParametric with export_format stl returns base64 payload", async () => {
  const r = await runParametric({
    script: "return box(10, 10, 10)",
    export_format: "stl",
    object_name: "cube10",
  });
  assert.equal(r.ok, true);
  assert.ok(typeof r.stl_base64 === "string" && r.stl_base64.length > 0);
  // Decode: binary STL header must carry the name
  const buf = Buffer.from(r.stl_base64, "base64");
  assert.ok(buf.length >= 84);
  const triCount = buf.readUInt32LE(80);
  assert.equal(triCount, r.triangles);
});

// ---------------------------------------------------------------------------
// S2-002 STEP export helper — graceful failure (No OCCT on this runtime)
// ---------------------------------------------------------------------------

test("meshBounds computes bbox and centroid", () => {
  const mesh = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], tris: [] };
  const b = meshBounds(mesh);
  assert.equal(b.x, 10);
  assert.equal(b.y, 10);
  assert.equal(b.z, 0);
  assert.equal(b.cx, 5);
  assert.equal(b.cy, 5);
});

test("exportStep fails gracefully (fallback stl) when OCCT unavailable", async () => {
  await tryInitReplicad(); // warms cache; may fail silently
  const mesh = { positions: [0, 0, 0, 10, 0, 0, 0, 0, 10], tris: [{ a: 0, b: 1, c: 2 }] };
  const res = await exportStep(mesh, "tmp-out/model.step", { name: "model" });
  // Either OCCT worked (unlikely here) or graceful fallback:
  assert.ok(res.ok === true || (res.ok === false && res.fallback === "stl"));
  assert.equal(res.engine ?? "replicad", "replicad");
});
