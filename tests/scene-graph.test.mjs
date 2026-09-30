import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const corePath = pathToFileURL(require.resolve("../apps/editor/src/state/scene-core.ts"));
const sceneCore = await import(corePath.href);

/** Build a minimal SceneObjectSnapshot-shaped fixture for graph tests. */
function makeObject(name, overrides = {}) {
  return {
    name,
    vertices: 8,
    triangles: 12,
    bounds: {
      min: [0, 0, 0],
      max: [10, 10, 10],
    },
    sizeMm: [10, 10, 10],
    volumeMm3: 1000,
    surfaceAreaMm2: 600,
    watertight: true,
    visible: true,
    locked: false,
    ...overrides,
  };
}

const EMPTY = { objects: [], selectedNames: [], anchorName: null };

test("hydrate replaces the graph and clears selection", () => {
  const a = makeObject("a");
  const out = sceneCore.reduceSceneGraph(EMPTY, { kind: "hydrate", object: a });
  assert.deepEqual(
    out.state.objects.map((o) => o.name),
    ["a"],
  );
  assert.deepEqual(out.state.selectedNames, []);
  assert.equal(out.pipeline, null);
});

test("select replaces the multi-set and sets anchor", () => {
  const a = makeObject("a");
  const b = makeObject("b");
  let s = sceneCore.reduceSceneGraph(EMPTY, { kind: "hydrate", object: a }).state;
  s = sceneCore.reduceSceneGraph(s, { kind: "add", object: a }).state;
  s = sceneCore.reduceSceneGraph(s, { kind: "add", object: b }).state;
  const sel = sceneCore.reduceSceneGraph(s, { kind: "select", name: "b" });
  assert.deepEqual(sel.state.selectedNames, ["b"]);
  assert.equal(sel.state.anchorName, "b");
});

test("multiSelectToggle adds/removes membership (shift-click)", () => {
  const a = makeObject("a");
  const b = makeObject("b");
  let s = sceneCore.reduceSceneGraph(EMPTY, { kind: "select", name: "a" }).state;
  s = { ...s, objects: [a, b] };
  let out = sceneCore.reduceSceneGraph(s, { kind: "multiSelectToggle", name: "b" });
  assert.deepEqual(out.state.selectedNames, ["a", "b"]);
  out = sceneCore.reduceSceneGraph(out.state, { kind: "multiSelectToggle", name: "a" });
  assert.deepEqual(out.state.selectedNames, ["b"]);
});

test("add appends, selects the object, emits add mutation", () => {
  const a = makeObject("a");
  const out = sceneCore.reduceSceneGraph(EMPTY, { kind: "add", object: a });
  assert.deepEqual(
    out.state.objects.map((o) => o.name),
    ["a"],
  );
  assert.deepEqual(out.state.selectedNames, ["a"]);
  assert.equal(out.state.anchorName, "a");
  assert.deepEqual(out.mutation, { kind: "add", object: a });
});

test("remove filters, clears selection membership, emits modal pipeline", () => {
  const a = makeObject("a");
  const b = makeObject("b");
  let s = { ...EMPTY, objects: [a, b], selectedNames: ["a", "b"], anchorName: "a" };
  const out = sceneCore.reduceSceneGraph(s, { kind: "remove", name: "a" });
  assert.deepEqual(
    out.state.objects.map((o) => o.name),
    ["b"],
  );
  assert.deepEqual(out.state.selectedNames, ["b"]);
  assert.deepEqual(out.pipeline?.steps, ["begin", "update", "commit"]);
  assert.deepEqual(out.mutation, { kind: "remove", name: "a" });
});

test("remove missing name is a no-op", () => {
  const a = makeObject("a");
  const s = { ...EMPTY, objects: [a] };
  const out = sceneCore.reduceSceneGraph(s, { kind: "remove", name: "zzz" });
  assert.equal(out.state, s);
  assert.equal(out.pipeline, null);
});

test("rename remaps the name across objects and selection", () => {
  const a = makeObject("a");
  const s = { ...EMPTY, objects: [a], selectedNames: ["a"], anchorName: "a" };
  const out = sceneCore.reduceSceneGraph(s, { kind: "rename", from: "a", to: "b" });
  assert.deepEqual(
    out.state.objects.map((o) => o.name),
    ["b"],
  );
  assert.deepEqual(out.state.selectedNames, ["b"]);
  assert.equal(out.state.anchorName, "b");
  assert.equal(out.pipeline, null);
});

test("rename to an existing name is rejected", () => {
  const a = makeObject("a");
  const b = makeObject("b");
  const s = { ...EMPTY, objects: [a, b], selectedNames: ["a"] };
  const out = sceneCore.reduceSceneGraph(s, { kind: "rename", from: "a", to: "b" });
  assert.equal(out.state, s);
});

test("duplicate deep-copies geometry and selects the copy via modal pipeline", () => {
  const a = makeObject("a", {
    geometry: {
      positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 0, 1]),
      indices: new Uint32Array([0]),
    },
  });
  const s = { ...EMPTY, objects: [a] };
  const out = sceneCore.reduceSceneGraph(s, { kind: "duplicate", name: "a" });
  assert.equal(out.state.objects.length, 2);
  assert.equal(out.state.objects[1]?.name, "a-copy");
  assert.deepEqual(out.state.selectedNames, ["a-copy"]);
  assert.deepEqual(out.pipeline?.steps, ["begin", "update", "commit"]);
  assert.equal(out.mutation?.kind, "add");
  // geometry must be deep-copied (fresh arrays, same values)
  const copy = out.state.objects[1];
  assert.notEqual(copy?.geometry?.positions, a.geometry.positions);
  assert.deepEqual(copy?.geometry?.indices, a.geometry.indices);
});

test("toggleVisible / toggleLock flip per-object flags", () => {
  const a = makeObject("a", { visible: true, locked: false });
  const s = { ...EMPTY, objects: [a] };
  let out = sceneCore.reduceSceneGraph(s, { kind: "toggleVisible", name: "a" });
  assert.equal(out.state.objects[0]?.visible, false);
  out = sceneCore.reduceSceneGraph(out.state, { kind: "toggleLock", name: "a" });
  assert.equal(out.state.objects[0]?.locked, true);
});

test("setTransform updates only the target transform", () => {
  const a = makeObject("a");
  const b = makeObject("b", { transform: { x: 1, y: 2, z: 3 } });
  const s = { ...EMPTY, objects: [a, b] };
  const out = sceneCore.reduceSceneGraph(s, {
    kind: "setTransform",
    name: "b",
    transform: { x: 10, y: -2, z: 0 },
  });
  assert.deepEqual(out.state.objects[0]?.transform, undefined);
  assert.deepEqual(out.state.objects[1]?.transform, { x: 10, y: -2, z: 0 });
});

test("selectWith helper primed set: replace vs toggle", () => {
  const a = makeObject("a");
  const b = makeObject("b");
  const s = { ...EMPTY, objects: [a, b], selectedNames: ["a"], anchorName: "a" };
  const rep = sceneCore.selectWith(s, "b", "replace");
  assert.deepEqual(rep.selectedNames, ["b"]);
  const tog = sceneCore.selectWith(s, "b", "toggle");
  assert.deepEqual(tog.selectedNames, ["a", "b"]);
});
