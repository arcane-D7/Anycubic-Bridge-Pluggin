// S7-006 AC-4 E2E: import fixture → transform → export → import again;
// geometric identity asserted within declared tolerance.
//
// 1. import: STL fixture (binary) → mesh data (positions + triangles)
// 2. transform: rotate around Z
// 3. export: 3MF via scripts/write-3mf.mjs (read/write path, AC-2)
// 4. import again: re-read the 3MF
// 5. assert geometric identity (bbox within 1e-4, vertex+tri counts exact)
//
// Also validates AC-3: STEP export is labeled conversion-only + deprecated
// bbox-cuboid (no silent success).

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { read3mf } from "../../scripts/read-3mf.mjs";
import { write3mf, build3mf, composeZip } from "../../scripts/write-3mf.mjs";
import { exportStep } from "../../scripts/cad-step-export.mjs";

// --- tiny binary STL reader (mirrors the rust io::parse_binary_stl) ---------
function parseBinaryStl(buf) {
  if (buf.length < 84) throw new Error("truncated STL header");
  const count = buf.readUInt32LE(80);
  const positions = [];
  const triangles = [];
  let off = 84;
  for (let t = 0; t < count; t++) {
    off += 12; // skip normal
    const base = t * 3;
    for (let k = 0; k < 3; k++) {
      positions.push(buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8));
      off += 12;
    }
    triangles.push([base, base + 1, base + 2]);
    off += 2; // attribute
  }
  return { positions, triangles };
}

function boundsOf(pts) {
  const xs = pts.filter((_, i) => i % 3 === 0);
  const ys = pts.filter((_, i) => i % 3 === 1);
  const zs = pts.filter((_, i) => i % 3 === 2);
  return [
    Math.min(...xs),
    Math.min(...ys),
    Math.min(...zs),
    Math.max(...xs),
    Math.max(...ys),
    Math.max(...zs),
  ];
}

test("3MF writer produces a reader-compatible archive (R0 read-only → read/write)", () => {
  const meshes = [
    {
      name: "tri",
      positions: [0, 0, 0, 3.7, 0, 0, 0, 2.2, 0, 1, 1, 4.5],
      triangles: [
        [0, 1, 2],
        [0, 2, 3],
        [1, 2, 3],
      ],
    },
  ];
  const buf = composeZip(build3mf(meshes));
  const tmp = join(tmpdir(), `s7-006-3mf-${process.pid}.3mf`);
  writeFileSync(tmp, buf);
  try {
    const files = read3mf(tmp);
    const model = files.find((f) => f.name === "3D/3dmodel.model");
    assert.ok(model, "model member present");
    const text = model.data.toString("utf8");
    assert.match(text, /<model/, "model root");
    assert.match(text, /<object id="1"/, "object present");
    assert.match(text, /<vertex x="3.7"/, "vertex present");
    assert.match(text, /<triangle v1="0"/, "triangle present");
    assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02])), "central dir present");
  } finally {
    unlinkSync(tmp);
  }
});

test("write3mf is deterministic (same geometry → byte-identical file)", () => {
  const meshes = [
    {
      name: "a",
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
      triangles: [[0, 1, 2]],
    },
  ];
  const out = join(tmpdir(), `s7-006-w-${process.pid}.3mf`);
  const out2 = join(tmpdir(), `s7-006-w2-${process.pid}.3mf`);
  const r = write3mf(out, meshes);
  write3mf(out2, meshes);
  try {
    assert.equal(r.ok, true);
    assert.ok(r.bytes > 0);
    assert.deepEqual(readFileSync(out), readFileSync(out2), "byte-identical");
    assert.equal(read3mf(out).length, 3, "3 members (types, rels, model)");
  } finally {
    unlinkSync(out);
    unlinkSync(out2);
  }
});

test("E2E: import STL → transform → export 3MF → import again (geometric identity)", () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cube-20mm.stl");
  const { positions, triangles } = parseBinaryStl(readFileSync(fixture));
  assert.ok(triangles.length > 0, "STL fixture has triangles");

  // Transform: rotate +Z 90°: (x,y,z) → (−y,x,z).
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y] = [positions[i], positions[i + 1]];
    positions[i] = -y;
    positions[i + 1] = x;
  }

  // Export 3MF.
  const out = join(tmpdir(), `s7-006-e2e-${process.pid}.3mf`);
  write3mf(out, [{ name: "rotated-cube", positions, triangles }]);

  // Import again (read the 3MF model XML).
  try {
    const model = read3mf(out)
      .find((f) => f.name === "3D/3dmodel.model")
      .data.toString("utf8");
    const rePoints = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)];
    const reTris = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)];
    assert.ok(rePoints.length > 0 && reTris.length > 0, "3MF has geometry");

    const b0 = boundsOf(positions);
    const b1 = boundsOf(rePoints.flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]));
    for (let i = 0; i < 6; i++) {
      assert.ok(Math.abs(b0[i] - b1[i]) < 1e-4, `bbox drift axis ${i}: ${b0[i]} vs ${b1[i]}`);
    }
    assert.equal(rePoints.length, positions.length / 3, "vertex count preserved");
    assert.equal(reTris.length, triangles.length, "triangle count preserved");
  } finally {
    unlinkSync(out);
  }
});

test("STEP/IGES conversion-only: bbox-cuboid path labeled + deprecated (never silent)", async () => {
  // The bbox-cuboid STEP path is the degraded (conversion-only) surface; it
  // must be labeled + carry the deprecation note — never silent.
  const res = await exportStep(
    { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], tris: [{ a: 0, b: 1, c: 2 }] },
    "tmp-out/s7-006.step",
    { name: "s7-006-model" },
  );
  if (res.ok) {
    // Real OCCT (rare on Node 24) OR bbox-cuboid — either way it must be
    // labeled conversion_only (this code path only ever produces the
    // bbox-cuboid surrogate as generic mesh→STEP).
    assert.equal(res.conversion_only, true, "STEP export must be labeled conversion-only");
    assert.ok(res.deprecation_note, "bbox-cuboid path carries the deprecation note");
    assert.match(res.fidelity_budget ?? "", /bbox/i, "fidelity budget documents the degradation");
  } else {
    assert.equal(res.fallback, "stl", "degrades to STL, never silent");
    assert.match(res.error ?? "", /bbox|STL|OCCT/i, "labels the degraded path");
  }
});
