import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.6-003 — object placement metrics core.
 *
 * AC: columns render real values, update on transform, sortable where
 * sensible. The pure core derives center (world = transform + bounds-center
 * * scale), footprint (scaled X/Y AABB), volume (mm³ with AABB fallback)
 * and provides deterministic column comparators for the tree sort.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(rel, key) {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", rel));
  return import(`${url.href}?key=${Date.now() + key}`);
}

const metricsPromise = loadModule("state/object-metrics.ts", 1);

function baseObject(overrides = {}) {
  return {
    name: "cube",
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
    ...overrides,
  };
}

test("object-metrics: center is world = transform + bounds-center * scale", async () => {
  const m = await metricsPromise;
  // bounds center of [0,0,0]-[10,10,20] = (5,5,10). transform (0,0,0) → (5,5,10).
  const atOrigin = m.placementMetrics(baseObject());
  assert.deepEqual(atOrigin.center, [5, 5, 10]);
  // moved transform → world center follows
  const moved = m.placementMetrics(
    baseObject({ transform: { x: 100, y: -50, z: 25, sx: 2, sy: 2, sz: 2 } }),
  );
  assert.deepEqual(moved.center, [100 + 5 * 2, -50 + 5 * 2, 25 + 10 * 2]);
});

test("object-metrics: footprint derives from scaled X/Y AABB", async () => {
  const m = await metricsPromise;
  const f = m.placementMetrics(baseObject()).footprint;
  assert.deepEqual(f, { w: 10, d: 10 });
  const scaled = m.placementMetrics(
    baseObject({ transform: { x: 0, y: 0, z: 0, sx: 3, sy: 0.5 } }),
  );
  assert.deepEqual(scaled.footprint, { w: 30, d: 5 });
});

test("object-metrics: degenerate footprint is null", async () => {
  const m = await metricsPromise;
  // zero breadth on X → degenerate
  const degenerate = m.placementMetrics(
    baseObject({ bounds: { min: [0, 0, 0], max: [0, 10, 20] } }),
  );
  assert.equal(degenerate.footprint, null);
  assert.equal(degenerate.footprintArea, 0);
});

test("object-metrics: volume falls back to AABB when volumeMm3 is 0", async () => {
  const m = await metricsPromise;
  const zero = m.placementMetrics(baseObject({ volumeMm3: 0 }));
  // AABB = 10*10*20 = 2000
  assert.equal(zero.volumeMm3, 2000);
  // positive volume wins
  assert.equal(m.placementMetrics(baseObject({ volumeMm3: 500 })).volumeMm3, 500);
});

test("object-metrics: comparePlacement sorts deterministically", async () => {
  const m = await metricsPromise;
  const a = baseObject({ name: "bravo", transform: { x: 10, y: 0, z: 0 } });
  const b = baseObject({ name: "alpha", transform: { x: -5, y: 2, z: 0 } });
  const c = baseObject({ name: "charlie", transform: { x: 0, y: 9, z: 0 }, volumeMm3: 9000 });
  // name
  assert.ok(m.comparePlacement(a, b, "name") > 0);
  assert.ok(m.comparePlacement(b, a, "name") < 0);
  // x center: a=15 (10+5), b=0 (−5+5)
  assert.ok(m.comparePlacement(b, a, "x") < 0);
  // y center: a=5, b=7 → a first? a(5) < b(7) → -1
  assert.ok(m.comparePlacement(a, b, "y") < 0);
  // volume
  assert.ok(m.comparePlacement(b, c, "volume") < 0);
  assert.ok(m.comparePlacement(c, b, "volume") > 0);
});
