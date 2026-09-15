import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  centerOnPlateGeometry,
  meshToBinaryStl,
  fetchMesh,
  importMesh,
  runCenterOnPlate,
} from "../scripts/cad-center-tool.mjs";

// ---------------------------------------------------------------------------
// Center-on-plate tool unit tests (mock HTTP, real math)
// ---------------------------------------------------------------------------

const URL = "http://127.0.0.1:41234";
const TOKEN = "a".repeat(32);

function makeBox(w, h, d, x = 0, y = 0, z = 0) {
  const positions = [];
  const tris = [];
  // 8 corners
  const corners = [
    [x, y, z],
    [x + w, y, z],
    [x + w, y + h, z],
    [x, y + h, z],
    [x, y, z + d],
    [x + w, y, z + d],
    [x + w, y + h, z + d],
    [x, y + h, z + d],
  ];
  for (const c of corners) positions.push(...c);
  // 6 faces, 12 tris (winding order arbitrary for this test)
  const F = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 3, 7, 4],
  ];
  for (const [a, b, c, d2] of F) {
    tris.push({ a, b, c });
    tris.push({ a, b: c, c: d2 });
  }
  return { positions, tris };
}

test("centerOnPlateGeometry centers XY and floors Z at 0", () => {
  // box of 20x10x4 centered at (0,0,-2): bbox X -10..10, Y -5..5, Z -4..0
  const box = makeBox(20, 10, 4, -10, -5, -4);
  const r = centerOnPlateGeometry(box.positions);
  assert.ok(Math.abs(r.dx) < 1e-9); // already X-centered
  assert.ok(Math.abs(r.dy) < 1e-9); // already Y-centered
  assert.equal(r.dz, 4); // raise Z by 4 so min Z -> 0
  const m = { positions: r.positions, tris: box.tris };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  assert.ok(Math.abs(minX - (-10)) < 1e-6);
  assert.ok(Math.abs(maxX - 10) < 1e-6);
  assert.ok(Math.abs(minY - (-5)) < 1e-6);
  assert.ok(Math.abs(maxY - 5) < 1e-6);
  assert.ok(Math.abs(minZ - 0) < 1e-6); // sits on the plate
  assert.ok(Math.abs(maxZ - 4) < 1e-6);
});

test("centerOnPlateGeometry recenters an off-origin box", () => {
  // box at x=15,y=35,z=8.5 (like the doser bench part)
  const box = makeBox(72, 21.6, 10.1, 15, 25, 8.5);
  const r = centerOnPlateGeometry(box.positions);
  const m = { positions: r.positions, tris: box.tris };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  assert.ok(Math.abs(minX - (-36)) < 1e-6); // centered on X: x center 51 -> -36..36
  assert.ok(Math.abs(maxX - 36) < 1e-6);
  assert.ok(Math.abs(minY - (-10.8)) < 1e-6); // centered on Y: y center 35.8 -> -10.8..10.8
  assert.ok(Math.abs(maxY - 10.8) < 1e-6);
  assert.ok(Math.abs(minZ - 0) < 1e-6); // floor at 0
  assert.ok(Math.abs(maxZ - 10.1) < 1e-6);
});

test("meshToBinaryStl produces a well-formed binary STL", () => {
  const mesh = makeBox(10, 10, 10, -5, -5, -5);
  const buf = meshToBinaryStl(mesh, "centered.stl");
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.length, 84 + mesh.tris.length * 50);
  assert.equal(buf.readUInt32LE(80), mesh.tris.length);
  assert.match(buf.subarray(0, 12).toString("latin1"), /centered/);
  assert.equal(buf.readUInt16LE(buf.length - 2), 0);
});

test("fetchMesh reads a mesh from the CAD HTTP API", async () => {
  const fakeMesh = makeBox(5, 5, 5);
  mock.method(globalThis, "fetch", async (url, opts) => {
    assert.match(String(url), /\/mesh\/foo$/);
    assert.equal(opts.headers["X-Cad-Token"], TOKEN);
    return {
      ok: true,
      json: async () => ({ ok: true, positions: fakeMesh.positions, tris: fakeMesh.tris }),
    };
  });
  const mesh = await fetchMesh(URL, TOKEN, "foo");
  assert.equal(mesh.tris.length, 12);
  assert.equal(mesh.positions.length, 8 * 3);
  mock.restoreAll();
});

test("fetchMesh throws on missing object", async () => {
  mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  await assert.rejects(() => fetchMesh(URL, TOKEN, "nope"), /not found/);
  mock.restoreAll();
});

test("importMesh posts binary STL base64 and returns revision", async () => {
  const mesh = makeBox(5, 5, 5);
  mock.method(globalThis, "fetch", async (url, opts) => {
    assert.equal(String(url), `${URL}/api/import`);
    assert.equal(opts.method, "POST");
    const body = JSON.parse(opts.body);
    assert.equal(body.name, "result");
    assert.equal(body.format, "stl");
    const bytes = Buffer.from(body.data_base64, "base64");
    assert.equal(bytes.readUInt32LE(80), mesh.tris.length);
    return { ok: true, json: async () => ({ ok: true, revision: 7 }) };
  });
  const data = await importMesh(URL, TOKEN, "result", mesh);
  assert.equal(data.revision, 7);
  mock.restoreAll();
});

test("runCenterOnPlate end-to-end: fetch -> center -> re-import", async () => {
  const mesh = makeBox(20, 10, 4, -10, -5, -4);
  let seenImport = null;
  mock.method(globalThis, "fetch", async (url, opts) => {
    if (String(url).includes("/mesh/part")) {
      return {
        ok: true,
        json: async () => ({ ok: true, positions: mesh.positions, tris: mesh.tris }),
      };
    }
    if (String(url).endsWith("/api/import")) {
      seenImport = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ok: true, revision: 11 }) };
    }
    throw new Error(`unexpected url ${url}`);
  });
  const result = await runCenterOnPlate({ url: URL, token: TOKEN, name: "part" });
  assert.equal(result.ok, true);
  assert.equal(result.object, "part");
  assert.equal(result.revision, 11);
  assert.ok(Math.abs(result.shifted.x) < 1e-9);
  assert.ok(Math.abs(result.shifted.y) < 1e-9);
  assert.equal(result.shifted.z, 4);
  assert.equal(result.after.min.z, 0);
  assert.equal(result.after.center.x, 0);
  assert.equal(result.after.center.y, 0);
  assert.ok(seenImport, "import payload captured");
  assert.equal(seenImport.name, "part");
  mock.restoreAll();
});
