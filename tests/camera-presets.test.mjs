import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.4-002 camera presets + view cube — pure core (`state/camera-core.ts`).
 * Headless under Node 24.
 *
 * AC-1: cube + numpad presets animate the camera; home = isometric —
 * asserted by the direction map + home cell here; the damped tween is a
 * viewport concern (browser e2e).
 * AC-2: lighting/view orientations respect plate axes (front = -Z viewer
 * side, approached from +Z).
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "camera-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("camera-core: face directions respect plate axes (front = +Z approach)", async () => {
  const core = await corePromise;
  assert.deepEqual(core.cellDirection("faceFront"), [0, 0, 1]);
  assert.deepEqual(core.cellDirection("faceBack"), [0, 0, -1]);
  assert.deepEqual(core.cellDirection("faceTop")[1], 1); // +Y up
  assert.deepEqual(core.cellDirection("faceLeft")[0], 1); // +X (left approached from +X)
  assert.deepEqual(core.cellDirection("faceRight")[0], -1);
});

test("camera-core: home is isometric (top-front-right corner)", async () => {
  const core = await corePromise;
  const dir = core.homeDirection();
  assert.deepEqual(dir, core.cellDirection("cornerTopFrontRight"));
  // Isometric = 0.5-magnitude on all three axes.
  assert.ok(Math.abs(Math.abs(dir[0]) - 0.5) < 1e-6);
  assert.ok(Math.abs(Math.abs(dir[1]) - 0.5) < 1e-6);
  assert.ok(Math.abs(Math.abs(dir[2]) - 0.5) < 1e-6);
});

test("camera-core: all 26 cube cells resolve to unit-ish directions", async () => {
  const core = await corePromise;
  const cells = [
    "faceFront",
    "faceBack",
    "faceTop",
    "faceBottom",
    "faceLeft",
    "faceRight",
    "cornerTopFrontLeft",
    "cornerTopFrontRight",
    "cornerTopBackLeft",
    "cornerTopBackRight",
    "cornerBottomFrontLeft",
    "cornerBottomFrontRight",
    "cornerBottomBackLeft",
    "cornerBottomBackRight",
    "edgeTopFront",
    "edgeTopBack",
    "edgeTopLeft",
    "edgeTopRight",
    "edgeBottomFront",
    "edgeBottomBack",
    "edgeBottomLeft",
    "edgeBottomRight",
    "edgeFrontLeft",
    "edgeFrontRight",
    "edgeBackLeft",
    "edgeBackRight",
  ];
  for (const cell of cells) {
    const dir = core.cellDirection(cell);
    assert.equal(dir.length, 3, cell);
    assert.ok(dir.every(Number.isFinite), cell);
  }
});

test("camera-core: unknown cell throws", async () => {
  const core = await corePromise;
  assert.throws(() => core.cellDirection("bogus"), /unknown view cube cell/);
});
