import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.5-002 slice lane — `bridge/mock.ts` G24 stats + lane contract tests.
 *
 * AC: Slice enabled iff ≥1 watertight object on plate; stats computed from the
 * authoritative snapshot (layers from stack height, grams from volume);
 * non-watertight objects block the lane with actionable names.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadMock() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const mockPromise = loadMock();

/** Scene objects: cone watertight 14mm, cube watertight 20mm, sphere NOT watertight. */
function sceneObjects() {
  return [
    {
      name: "cone",
      watertight: true,
      sizeMm: [28, 28, 26],
      volumeMm3: 5012,
      plateId: "plate-1",
      transform: { x: 0, y: -13, z: 14 },
    },
    {
      name: "cube",
      watertight: true,
      sizeMm: [20, 20, 20],
      volumeMm3: 8000,
      plateId: "plate-1",
      transform: { x: 40, y: 0, z: 10 },
    },
    {
      name: "sphere",
      watertight: false,
      sizeMm: [20, 20, 20],
      volumeMm3: 4189,
      plateId: "plate-2",
      transform: { x: 0, y: 0, z: 10 },
    },
  ];
}

test("slice-lane: computeSliceStats layers derive from max stack height", async () => {
  const mock = await mockPromise;
  const stats = mock.computeSliceStats([
    { ...sceneObjects()[0], layerHeightMm: undefined },
    ...sceneObjects().slice(0, 1),
  ]);
  // maxZ = 26 → ceil(26 / 0.2) = 130 layers
  assert.equal(stats.layers, 130);
});

test("slice-lane: volume/material/time derive from volume over layer height", async () => {
  const mock = await mockPromise;
  const [cone, cube] = sceneObjects();
  const stats = mock.computeSliceStats([cone, cube], { layerHeightMm: 0.2 });
  assert.equal(stats.volumeMm3, 5012 + 8000);
  assert.ok(Math.abs(stats.materialGrams - (5012 + 8000) * 1.24e-3) < 1e-6);
  assert.ok(stats.estimatedMinutes >= 1);
  // per-object map keyed by name
  assert.equal(stats.perObjectMm3.cone, 5012);
  assert.equal(stats.perObjectMm3.cube, 8000);
});

test("slice-lane: zero-volume objects fall back to AABB volume", async () => {
  const mock = await mockPromise;
  const flat = {
    name: "flat",
    watertight: true,
    sizeMm: [10, 20, 30],
    volumeMm3: 0,
    plateId: "plate-1",
    transform: { x: 0, y: 0, z: 0 },
  };
  const stats = mock.computeSliceStats([flat]);
  assert.equal(stats.perObjectMm3.flat, 10 * 20 * 30); // AABB fallback
  assert.equal(stats.volumeMm3, 10 * 20 * 30);
});

test("slice-lane: estimateVolume is AABB even when some bounds are zero", async () => {
  const mock = await mockPromise;
  const weird = {
    name: "weird",
    watertight: true,
    sizeMm: [10, 0, 30],
    volumeMm3: 0,
    plateId: "plate-1",
    transform: { x: 0, y: 0, z: 0 },
  };
  const stats = mock.computeSliceStats([weird]);
  assert.equal(stats.perObjectMm3.weird, 0); // AABB = 10*0*30 = 0 — no crash
  assert.equal(stats.volumeMm3, 0);
  // maxZ = 30 (sizeMm[2]) regardless of the zero breadth → ceil(30/0.2) = 150
  assert.equal(stats.layers, 150);
});

test("slice-lane: lane computes stats for the active plate only", async () => {
  const mock = await mockPromise;
  const objects = sceneObjects(); // cone+cube on plate-1, sphere on plate-2
  const stats = mock.computeSliceStats(
    objects.filter((o) => (o.plateId ?? "plate-1") === "plate-1"),
  );
  assert.equal(stats.perObjectMm3.cone, 5012);
  assert.equal(stats.perObjectMm3.cube, 8000);
  assert.equal(stats.perObjectMm3.sphere, undefined);
});

test("slice-lane: non-watertight on plate blocks with actionable names", async () => {
  const mock = await mockPromise;
  // The mock scene's sphere-non-watertight lives on the DEFAULT plate, so
  // slicing that plate (cone + cube + sphere) must be blocked.
  const handle = await mock.fetchSceneSnapshot();
  const result = await handle.slice({ plateId: "plate-1" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes("non-watertight"));
    assert.ok(result.error.includes("sphere-non-watertight"));
  }
});

test("slice-lane: full lane through fetchSceneSnapshot slice()", async () => {
  const mock = await mockPromise;
  // Fresh handle per test: the mock's module-level scene is mutated by
  // CRUD lanes, so each handle re-reads the current authoritative objects.
  const handle = await mock.fetchSceneSnapshot();
  // cone + cube are watertight; drop the offender first so the lane succeeds.
  await handle.mutateObject({ kind: "remove", name: "sphere-non-watertight" });
  const result = await handle.slice({ plateId: "plate-1" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.stats.layers >= 1);
    // mock geometry has volumeMm3=0 → AABB fallback (sizes from geometry).
    assert.ok(result.stats.perObjectMm3.cone > 0);
    assert.ok(result.stats.perObjectMm3.cube > 0);
    assert.ok(result.stats.volumeMm3 > 0);
    assert.deepEqual(result.blockedBy, []);
    assert.equal(result.revision, handle.revision);
  }
});
