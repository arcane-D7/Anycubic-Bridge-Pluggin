import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.4-005 status bar core — `state/statusbar-core.ts` headless tests.
 *
 * AC: status bar shows selected coords (mono), current plate dims, revision +
 * dirty chip (`● N unsaved`). The pure derivations (formatting + AABB +
 * unsaved count) are asserted here.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "statusbar-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

function obj(name, min, max, transform) {
  return { name, bounds: { min, max }, transform };
}

test("statusbar-core: formatCoords rounds to 1 decimal, mono layout", async () => {
  const core = await corePromise;
  const out = core.formatCoords({ x: 12.34, y: -4.06, z: 0.55 });
  assert.equal(out, "x 12.3  y -4.1  z 0.6");
});

test("statusbar-core: positionOf returns identity 0 when transform absent", async () => {
  const core = await corePromise;
  assert.deepEqual(core.positionOf({}), { x: 0, y: 0, z: 0 });
  assert.deepEqual(core.positionOf({ transform: { x: 9, y: -2, z: 5 } }), {
    x: 9,
    y: -2,
    z: 5,
  });
});

test("statusbar-core: plateBounds aggregates scene-space AABB of objects", async () => {
  const core = await corePromise;
  const objects = [
    obj("a", [-10, -10, 0], [10, 10, 20], { x: 30, y: 0, z: 0 }),
    obj("b", [0, -5, -4], [8, 5, 6], { x: -5, y: 0, z: 10 }),
  ];
  const b = core.plateBounds(objects);
  assert.ok(b);
  assert.equal(b.minX, -5); // a: 30-10=20, 30+10=40; b: -5+0=-5, -5+8=3
  assert.equal(b.maxX, 40);
  assert.equal(b.maxY, 10);
  assert.equal(b.minZ, 0); // a min 0; b min -4+10=6 → min across = 0
  assert.equal(b.maxZ, 20);
});

test("statusbar-core: plateBounds null on empty set", async () => {
  const core = await corePromise;
  assert.equal(core.plateBounds([]), null);
});

test("statusbar-core: formatPlateDims builds WxDxH mm label", async () => {
  const core = await corePromise;
  const b = { minX: -10, maxX: 30, minY: -5, maxY: 5, minZ: 0, maxZ: 40 };
  assert.equal(core.formatPlateDims(b), "40 × 10 × 40 mm");
});

test("statusbar-core: unsavedCount = draft-observerdirty when a draft exists", async () => {
  const core = await corePromise;
  const objects = [obj("cone", [0, 0, 0], [1, 1, 1], null)];
  assert.equal(core.unsavedCount(false, [objects[0]], "cone", objects), 1);
  assert.equal(core.unsavedCount(false, [objects[0]], "cube", objects), 0);
});

test("statusbar-core: unsavedCount counts objects when plate flagged dirty", async () => {
  const core = await corePromise;
  const objects = [obj("a", [0, 0, 0], [1, 1, 1], null), obj("b", [0, 0, 0], [1, 1, 1], null)];
  assert.equal(core.unsavedCount(true, objects, null, objects), 2);
  assert.equal(core.unsavedCount(false, objects, null, objects), 0);
});
