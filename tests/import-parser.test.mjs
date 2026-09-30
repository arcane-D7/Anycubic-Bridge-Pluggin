// S9.2-001 unit tests — model import parser (STL binary/ASCII + 3MF) and the
// object CRUD mutation lane behind the frozen snapshot shape. Pure functions
// only (no React, no three.js, no zustand) — imported directly under Node's
// native TS support.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importUrl = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "import.ts"));
const mockUrl = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));

const importer = await import(importUrl.href);
const mock = await import(mockUrl.href);

// ---------------------------------------------------------------- STL help ---
function generateBinaryStl(triangles) {
  const triCount = triangles.length;
  const size = 84 + triCount * 50;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  // header: zeroed
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (const tri of triangles) {
    dv.setFloat32(o, tri.n[0], true);
    dv.setFloat32(o + 4, tri.n[1], true);
    dv.setFloat32(o + 8, tri.n[2], true);
    o += 12;
    for (const v of tri.v) {
      dv.setFloat32(o, v[0], true);
      dv.setFloat32(o + 4, v[1], true);
      dv.setFloat32(o + 8, v[2], true);
      o += 12;
    }
  }
  return buf;
}

function simpleTriangles() {
  return [
    {
      n: [0, 0, -1],
      v: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
    },
    {
      n: [0, 0, -1],
      v: [
        [0, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
    },
  ];
}

test("parseStl binary: real buffers, bounds, per-triangle repack", () => {
  const buf = generateBinaryStl(simpleTriangles());
  const out = importer.parseStl(buf, "plate.stl");
  assert.equal(out.kind, "stl");
  assert.equal(out.name, "plate.stl");
  assert.equal(out.triangleCount, 2);
  assert.equal(out.vertexCount, 6); // 2 triangles × 3 real vertices
  assert.equal(out.positions.length, 18);
  assert.equal(out.indices.length, 6);
  assert.deepEqual(Array.from(out.indices), [0, 1, 2, 3, 4, 5]);
  const bounds = out.bounds;
  assert.ok(bounds.min[0] <= 0.01 && bounds.max[0] >= 9.99);
  assert.ok(bounds.max[1] >= 9.99);
  assert.ok(bounds.max[2] <= 0.01);
});

test("parseStl ascii: same shape, declared normals kept", () => {
  const ascii = `solid plate
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 10 10 0
  endloop
endfacet
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 10 10 0
    vertex 0 10 0
  endloop
endfacet
endsolid plate
`;
  const out = importer.parseStl(new TextEncoder().encode(ascii).buffer, "plate-ascii.stl");
  assert.equal(out.kind, "stl");
  assert.equal(out.triangleCount, 2);
  assert.equal(out.vertexCount, 6);
  assert.equal(out.normals[0], 0);
  assert.equal(out.normals[2], -1);
});

test("parseStl rejects garbage and empty", () => {
  assert.throws(
    () => importer.parseStl(new ArrayBuffer(0), "x.stl"),
    (err) => {
      assert.equal(err.code, "STL_EMPTY");
      return true;
    },
  );
  assert.throws(
    () => importer.parseStl(new ArrayBuffer(10), "tiny.stl"),
    (err) => {
      assert.equal(err.code, "STL_EMPTY");
      return true;
    },
  );
  const garbage = new ArrayBuffer(100);
  new Uint8Array(garbage).fill(0xab);
  assert.throws(
    () => importer.parseStl(garbage, "garbage.stl"),
    (err) => {
      return err && typeof err.code === "string";
    },
  );
});

test("isWatertight false for open fan, true for closed cube", () => {
  // open fan: 2 coplanar triangles not sharing an edge pair boundary
  const fanPos = new Float32Array([
    0,
    0,
    0,
    10,
    0,
    0,
    10,
    10,
    0, //
    0,
    0,
    0,
    10,
    10,
    0,
    0,
    10,
    0,
  ]);
  assert.equal(importer.isWatertight(fanPos, new Uint32Array([0, 1, 2, 3, 4, 5])), false);

  // closed unit cube (12 triangles, indexed, Z-up): every edge shared twice
  const H = 10;
  const verts = [
    [0, 0, 0],
    [H, 0, 0],
    [H, H, 0],
    [0, H, 0], // bottom (y=0)
    [0, 0, H],
    [H, 0, H],
    [H, H, H],
    [0, H, H], // top (y=H)
  ];
  const cubeTris = [
    [0, 2, 1],
    [0, 3, 2], // bottom
    [4, 5, 6],
    [4, 6, 7], // top
    [0, 1, 5],
    [0, 5, 4], // front (z=0)
    [1, 2, 6],
    [1, 6, 5], // right (x=H)
    [2, 3, 7],
    [2, 7, 6], // back (z=H)
    [3, 0, 4],
    [3, 4, 7], // left (x=0)
  ];
  const cubePos = new Float32Array(verts.flat());
  const cubeIdx = new Uint32Array(cubeTris.flat());
  assert.equal(importer.isWatertight(cubePos, cubeIdx), true);

  // remove one triangle → open boundary → not watertight
  const missing = cubeTris.slice(0, 11);
  const missIdx = new Uint32Array(missing.flat());
  assert.equal(importer.isWatertight(cubePos, missIdx), false);
});

test("toImportedObject mirrors ObjectMeshInfo fields from buffers", () => {
  const buf = generateBinaryStl(simpleTriangles());
  const out = importer.parseStl(buf, "plate.stl");
  const info = importer.toImportedObject(out);
  assert.equal(info.name, "plate.stl");
  assert.equal(info.vertices, 6);
  assert.equal(info.triangles, 2);
  assert.equal(info.sizeMm[0], 10);
  assert.equal(info.sizeMm[1], 10);
  assert.equal(info.watertight, false); // per-triangle repack never merges
});

test("parseThreemf extracts vertices/triangles from a minimal 3MF (deflated zip)", () => {
  // Build a raw-deflected ZIP: local header + EOCD with central directory,
  // containing one `3D/3dmodel.model` part with a tiny unit cube.
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    `  <resources>\n` +
    `    <object id="1" type="model">\n` +
    `      <mesh>\n` +
    `        <vertices>\n` +
    `          <vertex x="0" y="0" z="0"/>\n` +
    `          <vertex x="10" y="0" z="0"/>\n` +
    `          <vertex x="10" y="10" z="0"/>\n` +
    `          <vertex x="0" y="10" z="0"/>\n` +
    `        </vertices>\n` +
    `        <triangles>\n` +
    `          <triangle v1="0" v2="1" v3="2"/>\n` +
    `          <triangle v1="0" v2="2" v3="3"/>\n` +
    `        </triangles>\n` +
    `      </mesh>\n` +
    `    </object>\n` +
    `  </resources>\n` +
    `  <build>\n` +
    `    <item objectid="1"/>\n` +
    `  </build>\n` +
    `</model>\n`;

  const data = compressed(modelXml);
  const zip = buildZip([{ name: "3D/3dmodel.model", data }]);
  const out = importer.parseThreemf(zip, "unit-cube.3mf");
  assert.equal(out.kind, "3mf");
  assert.equal(out.triangleCount, 2);
  assert.equal(out.vertexCount, 4);
  assert.equal(out.name, "unit-cube.3mf");
  const bounds = out.bounds;
  assert.ok(bounds.max[0] <= 10.01 && bounds.max[1] <= 10.01);
  assert.ok(bounds.min[0] >= -0.01);
});

test("parseThreemf rejects non-mm units and empty containers", () => {
  const modelXml = `<model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n</model>\n`;
  const data = compressed(modelXml);
  const zip = buildZip([{ name: "3D/model.model", data }]);
  assert.throws(
    () => importer.parseThreemf(zip, "inch.3mf"),
    (err) => {
      assert.equal(err.code, "THREEMF_UNIT");
      return true;
    },
  );
  const emptyZip = buildZip([]);
  assert.throws(
    () => importer.parseThreemf(emptyZip, "empty.3mf"),
    (err) => {
      assert.equal(err.code, "THREEMF_EMPTY");
      return true;
    },
  );
});

// ------------------------------------------------------- Fake ZIP builder ---
function compressed(xml) {
  return new Uint8Array(deflateRawSync(new TextEncoder().encode(xml)));
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameB = new TextEncoder().encode(name);
    const crc = crc32(data);
    // local header
    const lh = 30 + nameB.length;
    const local = new ArrayBuffer(lh);
    const dv = new DataView(local);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 8, true); // compression method: raw deflate
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0x21, true); // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    dv.setUint16(28, 0, true); // extra len
    new Uint8Array(local).set(nameB, 30);
    chunks.push(local, data);
    centrals.push({ name: nameB, crc, compSize: data.length, offset });
    offset += lh + data.length;
  }
  const centralStart = offset;
  const centralChunks = [];
  for (const { name, crc, compSize, offset: off } of centrals) {
    const ch = 46 + name.length;
    const cb = new ArrayBuffer(ch);
    const dv = new DataView(cb);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true); // flags
    dv.setUint16(10, 8, true); // compression method: raw deflate
    dv.setUint16(12, 0, true); // mod time
    dv.setUint16(14, 0x21, true); // mod date
    dv.setUint32(16, crc, true);
    dv.setUint32(20, compSize, true);
    dv.setUint32(24, compSize, true);
    dv.setUint16(28, name.length, true);
    dv.setUint16(30, 0, true); // extra len
    dv.setUint16(32, 0, true); // comment len
    dv.setUint16(34, 0, true); // disk number start
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, off, true);
    new Uint8Array(cb).set(name, 46);
    centralChunks.push(cb);
  }
  const centralSize = centralChunks.reduce((a, c) => a + c.byteLength, 0);
  const eocd = new ArrayBuffer(22);
  const dv = new DataView(eocd);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, entries.length, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, centralStart, true);
  const all = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const c of chunks) {
    all.set(new Uint8Array(c), pos);
    pos += c.byteLength;
  }
  for (const c of centralChunks) {
    all.set(new Uint8Array(c), pos);
    pos += c.byteLength;
  }
  all.set(new Uint8Array(eocd), pos);
  return all.buffer;
}

// ----------------------------------------------- CRUD lane via live mock -----
test("mock snapshot keeps frozen shape + adds geometry + graph flags", async () => {
  const handle = await mock.fetchSceneSnapshot();
  assert.equal(handle.ok, true);
  assert.equal(handle.revision, 7);
  assert.ok(Array.isArray(handle.groups));
  assert.ok(handle.objects.length >= 3);
  const cone = handle.objects.find((o) => o.name === "cone");
  assert.ok(cone);
  assert.ok(cone.geometry);
  assert.equal(cone.geometry.positions.length / 3, cone.vertices);
  assert.equal(cone.geometry.indices.length / 3, cone.triangles);
  assert.equal(cone.watertight, true);
  assert.equal(typeof cone.visible, "boolean");
  assert.equal(typeof cone.locked, "boolean");
});

test("mock CRUD lane: add/toggle/rename/remove with authoritative objects", async () => {
  const handle = await mock.fetchSceneSnapshot();
  const before = handle.objects.length;

  // add
  const added = await handle.mutateObject({
    kind: "add",
    object: {
      name: "imported-bracket",
      vertices: 6,
      triangles: 2,
      bounds: { min: [0, 0, 0], max: [5, 5, 5] },
      sizeMm: [5, 5, 5],
      volumeMm3: 0,
      surfaceAreaMm2: 0,
      watertight: true,
      geometry: {
        positions: new Float32Array(18).map((_, i) => i),
        normals: new Float32Array(18),
        indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      },
      visible: true,
      locked: false,
    },
  });
  assert.equal(added.ok, true);
  if (added.ok) assert.equal(added.objects.length, before + 1);

  // toggle visible
  const toggled = await handle.mutateObject({ kind: "toggleVisible", name: "imported-bracket" });
  assert.equal(toggled.ok, true);
  if (toggled.ok) {
    assert.equal(toggled.objects.find((o) => o.name === "imported-bracket")?.visible, false);
  }

  // rename
  const renamed = await handle.mutateObject({
    kind: "rename",
    from: "imported-bracket",
    to: "bracket",
  });
  assert.equal(renamed.ok, true);
  if (renamed.ok) assert.ok(renamed.objects.find((o) => o.name === "bracket"));

  // remove
  const removed = await handle.mutateObject({ kind: "remove", name: "bracket" });
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.objects.length, before);

  // unknown object errors
  const bad = await handle.mutateObject({ kind: "remove", name: "nope" });
  assert.equal(bad.ok, false);
});

test("mock CRUD lane: duplicate is deep-copied and inserted", async () => {
  const handle = await mock.fetchSceneSnapshot();
  const before = handle.objects.length;
  const dup = await handle.mutateObject({ kind: "duplicate", name: "cube" });
  assert.equal(dup.ok, true);
  if (dup.ok) {
    const copy = dup.objects.find((o) => o.name === "cube-copy");
    assert.ok(copy);
    assert.equal(copy.triangles, dup.objects.find((o) => o.name === "cube")?.triangles);
    assert.equal(dup.objects.length, before + 1);
  }
});
