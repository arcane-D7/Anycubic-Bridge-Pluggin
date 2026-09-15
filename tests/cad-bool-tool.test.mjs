import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  meshToBinaryStl,
  fetchMesh,
  importMesh,
  runBoolean,
} from "../scripts/cad-bool-tool.mjs";
import { makeBox, makeCylinder } from "../scripts/cad-csg-engine.mjs";

// ---------------------------------------------------------------------------
// S1-002 cad-bool-tool.mjs adapter unit tests (mock HTTP, real engine)
// ---------------------------------------------------------------------------

const URL = "http://127.0.0.1:41234";
const TOKEN = "a".repeat(32);

test("meshToBinaryStl produces a well-formed binary STL", () => {
  const mesh = makeBox(10, 10, 10);
  const buf = meshToBinaryStl(mesh, "box.stl");
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.length, 84 + mesh.tris.length * 50);
  assert.equal(buf.readUInt32LE(80), mesh.tris.length);
  // header carries the name
  assert.match(buf.subarray(0, 8).toString("latin1"), /box/);
  // first vertex readable floats, attribute byte count 0
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
  assert.equal(mesh.positions.length, 24 * 3);
  mock.restoreAll();
});

test("fetchMesh throws on missing object", async () => {
  mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  await assert.rejects(() => fetchMesh(URL, TOKEN, "nope"), /not found/);
  mock.restoreAll();
});

test("importMesh posts binary STL base64 and returns revision", async () => {
  const mesh = makeCylinder(5, 10, 32);
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

test("runBoolean runs a boolean against a live workspace (mocked HTTP)", async () => {
  const box = makeBox(20, 20, 20);
  const cyl = makeCylinder(4, 30, 32);
  const store = new Map([
    ["box", { positions: box.positions, tris: box.tris }],
    ["cyl", { positions: cyl.positions, tris: cyl.tris }],
  ]);
  mock.method(globalThis, "fetch", async (url, opts) => {
    const u = String(url);
    if (u.includes("/mesh/")) {
      const name = decodeURIComponent(u.split("/mesh/")[1]);
      return { ok: true, json: async () => ({ ok: true, ...store.get(name) }) };
    }
    if (u.endsWith("/api/import")) {
      const body = JSON.parse(opts.body);
      const bytes = Buffer.from(body.data_base64, "base64");
      store.set(body.name, { tris: bytes.readUInt32LE(80) });
      return { ok: true, json: async () => ({ ok: true, revision: 1 }) };
    }
    throw new Error(`unexpected url ${u}`);
  });
  const result = await runBoolean({
    url: URL,
    token: TOKEN,
    name_a: "box",
    name_b: "cyl",
    op: "subtract",
    result_name: "holed",
  });
  assert.equal(result.ok, true);
  assert.equal(result.object, "holed");
  assert.equal(result.watertight, true);
  assert.equal(result.op, "subtract");
  assert.ok(result.vertices > 10);
  assert.ok(result.triangles >= 12);
  assert.ok(store.has("holed"), "imported result stored");
  mock.restoreAll();
});

test("runBoolean requires url and token", async () => {
  await assert.rejects(() => runBoolean({ name_a: "a", name_b: "b", op: "add" }), /url and token/);
});

test("runBoolean resolves the result object into the workspace", async () => {
  const box = makeBox(10, 10, 10);
  const cyl = makeCylinder(3, 20, 32);
  mock.method(globalThis, "fetch", async (url, opts) => {
    const u = String(url);
    if (u.includes("/mesh/")) {
      const name = decodeURIComponent(u.split("/mesh/")[1]);
      const mesh = name === "a" ? box : cyl;
      return { ok: true, json: async () => ({ ok: true, positions: mesh.positions, tris: mesh.tris }) };
    }
    if (u.endsWith("/api/import")) {
      return { ok: true, json: async () => ({ ok: true, revision: 3 }) };
    }
    throw new Error(`unexpected url ${u}`);
  });
  const result = await runBoolean({
    url: URL,
    token: TOKEN,
    name_a: "a",
    name_b: "b",
    op: "add",
    result_name: "combo",
  });
  assert.equal(result.object, "combo");
  assert.equal(result.revision, 3);
  assert.equal(result.watertight, true);
  mock.restoreAll();
});
