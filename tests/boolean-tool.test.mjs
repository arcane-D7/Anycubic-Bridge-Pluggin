/**
 * S9.7-001/004 — Boolean tool unit tests.
 *
 * Covers the pure toolbar-core helpers (`booleanProvenance`, `BOOLEAN_OPS`,
 * `booleanOpLabel`) + the S9.7-001 bridge boolean lane (via a FRESH mock
 * instance — `mock.ts` has module-level mutable state, so each test file gets
 * a unique URL to a brand-new module).
 *
 * Fixtures are deliberately fictitious (AGENTS.md §6): names like `box-a` /
 * `box-b` and synthetic bounds — never real geometry values or device data.
 */

import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fresh module instance per `tag` so module-level mock state is isolated. */
function mockUrl(tag) {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  url.searchParams.set(tag, String(Date.now()));
  return url;
}

async function freshBridge(tag) {
  const mock = await import(mockUrl(tag).href);
  const bridge = await mock.fetchSceneSnapshot();
  // Seed two watertight objects through the CRUD lane (deterministic fixture).
  await bridge.mutateObject({
    kind: "add",
    object: {
      name: "box-a",
      vertices: 24,
      triangles: 12,
      bounds: { min: [0, 0, 0], max: [10, 10, 5] },
      sizeMm: [10, 10, 5],
      volumeMm3: 500,
      surfaceAreaMm2: 300,
      watertight: true,
      geometry: {
        positions: new Float32Array(24 * 3),
        normals: new Float32Array(24 * 3),
        indices: new Uint32Array(36),
      },
      visible: true,
      locked: false,
    },
  });
  await bridge.mutateObject({
    kind: "add",
    object: {
      name: "box-b",
      vertices: 24,
      triangles: 12,
      bounds: { min: [2, 2, 0], max: [12, 12, 8] },
      sizeMm: [10, 10, 8],
      volumeMm3: 800,
      surfaceAreaMm2: 360,
      watertight: true,
      geometry: {
        positions: new Float32Array(24 * 3),
        normals: new Float32Array(24 * 3),
        indices: new Uint32Array(36),
      },
      visible: true,
      locked: false,
    },
  });
  return { mock, bridge };
}

// --- pure toolbar-core helpers --------------------------------------------

const coreUrl = () =>
  pathToFileURL(path.join(root, "apps", "editor", "src", "state", "toolbar-core.ts")).href;

test("boolean tool: ops are the three canonical CSG ops", async (t) => {
  const core = await import(`${coreUrl()}?key=${t.name}`);
  assert.deepEqual(core.BOOLEAN_OPS, ["add", "subtract", "intersect"]);
  assert.equal(core.booleanOpLabel("add"), "Union");
  assert.equal(core.booleanOpLabel("subtract"), "Subtract");
  assert.equal(core.booleanOpLabel("intersect"), "Intersect");
});

test("boolean tool: provenance note carries op + A∩B (AC-2)", async (t) => {
  const core = await import(`${coreUrl()}?key=${t.name}`);
  assert.equal(core.booleanProvenance("add", "box-a", "box-b"), "+bool union box-a∩box-b");
  assert.equal(core.booleanProvenance("subtract", "box-a", "box-b"), "+bool subtract box-a∩box-b");
  assert.equal(
    core.booleanProvenance("intersect", "box-a", "box-b"),
    "+bool intersect box-a∩box-b",
  );
});

test("boolean tool: toolbar flag toggles independently (arm state)", async (t) => {
  const core = await import(`${coreUrl()}?key=${t.name}`);
  const base = { snap: true, grid: true, booleanTool: false };
  assert.deepEqual(core.DEFAULT_TOOLBAR_FLAGS, base);
  const armed = core.toggleToolbarFlag(base, "booleanTool");
  assert.equal(armed.booleanTool, true);
  assert.equal(armed.snap, true, "snap untouched");
  const disarmed = core.toggleToolbarFlag(armed, "booleanTool");
  assert.equal(disarmed.booleanTool, false);
});

// --- bridge boolean lane (S9.7-001/004) -----------------------------------

test("boolean lane: union produces a new watertight object with provenance", async (t) => {
  const { mock, bridge } = await freshBridge(t.name);
  const res = await bridge.boolean({ name_a: "box-a", name_b: "box-b", op: "add" });
  assert.equal(res.ok, true);
  assert.equal(res.watertight, true);
  assert.equal(res.op, "add");
  assert.equal(res.object, "box-a-bool");
  const snap = res.objectSnapshot;
  assert.equal(snap.name, "box-a-bool");
  assert.equal(snap.watertight, true);
  assert.equal(snap.provenance, "+bool union box-a∩box-b");
  // Mesh stats follow the union heuristic (verts sum, tris sum + 12).
  assert.equal(snap.vertices, 48);
  assert.equal(snap.triangles, 36);
  // Bounds = A∪B over both sources.
  assert.deepEqual(Array.from(snap.bounds.min), [0, 0, 0]);
  assert.deepEqual(Array.from(snap.bounds.max), [12, 12, 8]);
  // Sources stay (kept by default) — AC-2 hidden-or-kept.
  const list = (await mock.fetchSceneSnapshot()).objects;
  assert.equal(
    list.some((o) => o.name === "box-a"),
    true,
  );
  assert.equal(
    list.some((o) => o.name === "box-b"),
    true,
  );
  assert.equal(
    list.some((o) => o.name === "box-a-bool"),
    true,
  );
});

test("boolean lane: subtract/intersect normalize op + distinct results", async (t) => {
  const { bridge } = await freshBridge(t.name);
  const sub = await bridge.boolean({ name_a: "box-a", name_b: "box-b", op: "subtract" });
  assert.equal(sub.ok, true);
  assert.equal(sub.op, "subtract");
  assert.equal(sub.objectSnapshot.provenance, "+bool subtract box-a∩box-b");
  assert.equal(sub.objectSnapshot.triangles, 36);
  const inter = await bridge.boolean({ name_a: "box-a", name_b: "box-b", op: "intersect" });
  assert.equal(inter.ok, true);
  assert.equal(inter.op, "intersect");
  assert.equal(inter.objectSnapshot.name, "box-a-bool-2", "dedupes result names");
});

test("boolean lane: hide_sources hides A and B post-commit (AC-2)", async (t) => {
  const { mock, bridge } = await freshBridge(t.name);
  const res = await bridge.boolean({
    name_a: "box-a",
    name_b: "box-b",
    op: "add",
    hide_sources: true,
  });
  assert.equal(res.ok, true);
  const list = (await mock.fetchSceneSnapshot()).objects;
  const a = list.find((o) => o.name === "box-a");
  const b = list.find((o) => o.name === "box-b");
  assert.equal(a.visible, false, "object A hidden post-commit");
  assert.equal(b.visible, false, "object B hidden post-commit");
});

test("boolean lane: rejects unknown / same / non-watertight sources", async (t) => {
  const { bridge } = await freshBridge(t.name);
  const unknown = await bridge.boolean({ name_a: "ghost", name_b: "box-b", op: "add" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown object/);
  const same = await bridge.boolean({ name_a: "box-a", name_b: "box-a", op: "add" });
  assert.equal(same.ok, false);
  assert.match(same.error, /distinct/);
  // make box-b non-watertight
  await bridge.mutateObject({
    kind: "add",
    object: {
      name: "open-shell",
      vertices: 6,
      triangles: 2,
      bounds: { min: [0, 0, 0], max: [5, 5, 5] },
      sizeMm: [5, 5, 5],
      volumeMm3: 1,
      surfaceAreaMm2: 2,
      watertight: false,
      visible: true,
      locked: false,
    },
  });
  const nonWatertight = await bridge.boolean({
    name_a: "box-a",
    name_b: "open-shell",
    op: "add",
  });
  assert.equal(nonWatertight.ok, false);
  assert.match(nonWatertight.error, /watertight/);
});
