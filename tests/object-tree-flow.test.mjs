import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sceneCore = await import(
  pathToFileURL(path.join(root, "apps", "editor", "src", "state", "scene-core.ts")).href
);
const mock = await import(
  pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts")).href
);

/**
 * S9.2-004 — ObjectTree flow contract (headless).
 *
 * The tree component chains: store CRUD (pure reducer, scene-core) → bridge
 * persistence (mock mutateObject). This test pins the EXACT sequence the
 * component runs so a regression in either lane surfaces without mounting
 * React/R3F:
 *   - row visibility toggle  → toggleVisible (store + mock)
 *   - row lock toggle        → toggleLock
 *   - double-click rename    → rename (store) + mock rename
 *   - context-menu duplicate → duplicate (store pipeline + mock duplicate)
 *   - context-menu delete    → remove (store pipeline + mock remove)
 */

function makeObject(name, overrides = {}) {
  return {
    name,
    vertices: 8,
    triangles: 12,
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    sizeMm: [10, 10, 10],
    volumeMm3: 1000,
    surfaceAreaMm2: 600,
    watertight: true,
    visible: true,
    locked: false,
    ...overrides,
  };
}

const GRAPH = { objects: [], selectedNames: [], anchorName: null };

test("visibility toggle: store + mock agree", async () => {
  const start = { ...GRAPH, objects: [makeObject("cone-a")] };
  const s1 = sceneCore.reduceSceneGraph(start, { kind: "toggleVisible", name: "cone-a" });
  assert.equal(s1.state.objects[0]?.visible, false);

  const handle = await mock.fetchSceneSnapshot();
  const res = await handle.mutateObject({ kind: "toggleVisible", name: "cone" });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.objects.find((o) => o.name === "cone")?.visible, false);
});

test("lock toggle: store + mock agree", async () => {
  const start = { ...GRAPH, objects: [makeObject("cube-a")] };
  const s1 = sceneCore.reduceSceneGraph(start, { kind: "toggleLock", name: "cube-a" });
  assert.equal(s1.state.objects[0]?.locked, true);

  const handle = await mock.fetchSceneSnapshot();
  const res = await handle.mutateObject({ kind: "toggleLock", name: "cube" });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.objects.find((o) => o.name === "cube")?.locked, true);
});

test("rename: store renames + selects new name; mock persists", async () => {
  const start = {
    ...GRAPH,
    objects: [makeObject("sphere-a")],
    selectedNames: ["sphere-a"],
    anchorName: "sphere-a",
  };
  const s1 = sceneCore.reduceSceneGraph(start, { kind: "rename", from: "sphere-a", to: "ball" });
  assert.equal(s1.state.objects[0]?.name, "ball");
  assert.deepEqual(s1.state.selectedNames, ["ball"]);

  const handle = await mock.fetchSceneSnapshot();
  const res = await handle.mutateObject({
    kind: "rename",
    from: "sphere-non-watertight",
    to: "ball",
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(res.objects.find((o) => o.name === "ball"));
});

test("duplicate: store emits begin→update→commit pipeline + selects copy; mock persists", async () => {
  const a = makeObject("dup-me", {
    geometry: {
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 0]),
    },
  });
  const start = { ...GRAPH, objects: [a] };
  const s1 = sceneCore.reduceSceneGraph(start, { kind: "duplicate", name: "dup-me" });
  assert.deepEqual(s1.pipeline?.steps, ["begin", "update", "commit"]);
  assert.equal(s1.state.objects.length, 2);
  assert.deepEqual(s1.state.selectedNames, ["dup-me-copy"]);

  const handle = await mock.fetchSceneSnapshot();
  const res = await handle.mutateObject({ kind: "duplicate", name: "cube" });
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(res.objects.find((o) => o.name === "cube-copy"));
});

test("delete: store removes + clears anchor; mock persists", async () => {
  const start = {
    ...GRAPH,
    objects: [makeObject("delete-me"), makeObject("kept")],
    selectedNames: ["delete-me"],
    anchorName: "delete-me",
  };
  const s1 = sceneCore.reduceSceneGraph(start, { kind: "remove", name: "delete-me" });
  assert.deepEqual(s1.pipeline?.steps, ["begin", "update", "commit"]);
  assert.equal(s1.state.objects.length, 1);
  assert.equal(s1.state.anchorName, null);
  assert.deepEqual(s1.state.selectedNames, []);
  assert.equal(s1.mutation?.kind, "remove");

  const handle = await mock.fetchSceneSnapshot();
  const before = handle.objects.length;
  const res = await handle.mutateObject({ kind: "remove", name: "cone" });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.objects.length, before - 1);
});
