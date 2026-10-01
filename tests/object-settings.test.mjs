import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.6-002 — Per-object print settings + filament assignment.
 *
 * AC: object override toggle works; reset-to-parent restores; slice honors
 * per-object values. The reducer forks/clears per-object settings; the store
 * exposes setObjectSettings; the mock mutation lane persists it; the slice
 * estimator derives per-object layers from a forked layer height.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(rel, key) {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", rel));
  return import(`${url.href}?key=${Date.now() + key}`);
}

const sceneCorePromise = loadModule("state/scene-core.ts", 1);
const mockPromise = loadModule("bridge/mock.ts", 2);

function baseObject(name) {
  return {
    name,
    vertices: 8,
    triangles: 12,
    bounds: { min: [0, 0, 0], max: [10, 10, 20] },
    sizeMm: [10, 10, 20],
    volumeMm3: 1000,
    surfaceAreaMm2: 800,
    watertight: true,
    visible: true,
    locked: false,
    transform: { x: 0, y: 0, z: 0 },
  };
}

test("scene-core: setObjectSettings forks per-object settings", async () => {
  const core = await sceneCorePromise;
  const state = { objects: [baseObject("cube")], selectedNames: [], anchorName: null };
  const out = core.reduceSceneGraph(state, {
    kind: "setObjectSettings",
    name: "cube",
    settings: { layerHeightMm: 0.08, infillDensityPct: 40 },
  });
  assert.equal(out.state.objects[0].printSettings?.layerHeightMm, 0.08);
  assert.equal(out.state.objects[0].printSettings?.infillDensityPct, 40);
  // only the forked subset is stored (Partial)
  assert.equal(out.state.objects[0].printSettings?.wallLoops, undefined);
  assert.equal(out.state.objects[0].filamentId, undefined);
});

test("scene-core: setObjectSettings assigns filament per object", async () => {
  const core = await sceneCorePromise;
  const state = { objects: [baseObject("cube")], selectedNames: [], anchorName: null };
  const out = core.reduceSceneGraph(state, {
    kind: "setObjectSettings",
    name: "cube",
    settings: { layerHeightMm: 0.2 },
    filamentId: "catalog-pla-basico-precisao",
  });
  assert.equal(out.state.objects[0].filamentId, "catalog-pla-basico-precisao");
  assert.equal(out.state.objects[0].printSettings?.layerHeightMm, 0.2);
});

test("scene-core: setObjectSettings with no settings clears fork (reset-to-parent)", async () => {
  const core = await sceneCorePromise;
  const forked = {
    ...baseObject("cube"),
    printSettings: { layerHeightMm: 0.08 },
    filamentId: "catalog-pla-basico-precisao",
  };
  const out = core.reduceSceneGraph(
    { objects: [forked], selectedNames: [], anchorName: null },
    { kind: "setObjectSettings", name: "cube" },
  );
  assert.equal(out.state.objects[0].printSettings, undefined);
  assert.equal(out.state.objects[0].filamentId, undefined);
});

test("scene-core: setObjectSettings unknown name is a no-op", async () => {
  const core = await sceneCorePromise;
  const state = { objects: [baseObject("cube")], selectedNames: [], anchorName: null };
  const out = core.reduceSceneGraph(state, {
    kind: "setObjectSettings",
    name: "ghost",
    settings: { layerHeightMm: 0.08 },
  });
  // no object gains the fork — deep-equal to the original objects
  assert.deepEqual(out.state.objects, state.objects);
});

test("bridge mock: setObjectSettings persists fork + filament, reset clears", async () => {
  const mock = await mockPromise;
  const snap = await mock.fetchSceneSnapshot();
  assert.ok(snap.ok);
  const before = snap.objects[0];
  const res = await snap.mutateObject({
    kind: "setObjectSettings",
    name: before.name,
    settings: { layerHeightMm: 0.08 },
    filamentId: "catalog-pla-basico-precisao",
  });
  assert.ok(res.ok);
  const forked = res.objects.find((o) => o.name === before.name);
  assert.equal(forked.printSettings?.layerHeightMm, 0.08);
  assert.equal(forked.filamentId, "catalog-pla-basico-precisao");
  // reset-to-parent
  const reset = await snap.mutateObject({ kind: "setObjectSettings", name: before.name });
  assert.ok(reset.ok);
  const cleared = reset.objects.find((o) => o.name === before.name);
  assert.equal(cleared.printSettings, undefined);
  assert.equal(cleared.filamentId, undefined);
});

test("bridge mock: setObjectSettings unknown object rejects", async () => {
  const mock = await mockPromise;
  const snap = await mock.fetchSceneSnapshot();
  const res = await snap.mutateObject({
    kind: "setObjectSettings",
    name: "definitely-not-there",
    settings: { layerHeightMm: 0.08 },
  });
  assert.equal(res.ok, false);
});

test("slice-lane: per-object layer height increases total layers", async () => {
  const mock = await mockPromise;
  // 20mm tall object: global 0.2 → 100 layers; forked 0.08 → 250 layers.
  const coarse = { ...baseObject("coarse"), sizeMm: [10, 10, 20], volumeMm3: 1000 };
  const fine = {
    ...baseObject("fine"),
    sizeMm: [10, 10, 20],
    volumeMm3: 1000,
    printSettings: { layerHeightMm: 0.08 },
  };
  const stats = mock.computeSliceStats([coarse, fine], { layerHeightMm: 0.2 });
  assert.equal(stats.layers, 250); // max(ceil(20/0.2)=100, ceil(20/0.08)=250)
  const statsAllGlobal = mock.computeSliceStats([coarse], { layerHeightMm: 0.2 });
  assert.equal(statsAllGlobal.layers, 100);
});
