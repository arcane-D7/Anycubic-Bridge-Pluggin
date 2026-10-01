import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.7-002 snapping controller — pure core behavior
 * (`viewport/transform-core.ts` snap helpers + `snapDraft`). Headless under
 * Node 24 (transform-core is dependency-free — no React/three).
 *
 * AC-1: grid/vertex snaps apply during gizmo drags; snap target shown in a
 * tooltip/readout.
 * AC-2: snap toggle + step configurable from toolbar/inspector; snapped
 * motion deterministic.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "viewport", "transform-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("snap: snapValue rounds to the step (deterministic, JS half-up ties)", async () => {
  const core = await corePromise;
  assert.equal(core.snapValue(12, 5), 10);
  assert.equal(core.snapValue(13.1, 5), 15);
  assert.equal(core.snapValue(17.5, 5), 20); // .5 rounds up (Math.round)
  assert.equal(core.snapValue(-7, 5), -5);
  assert.equal(core.snapValue(12, 0), 12); // invalid step → passthrough
  assert.equal(core.snapValue(Number.NaN, 5), Number.NaN);
});

test("snap: snapStepFor derives from plate when toolbar step unset", async () => {
  const core = await corePromise;
  assert.equal(core.snapStepFor(0, { widthMm: 253, depthMm: 220 }), 5);
  assert.equal(core.snapStepFor(0, undefined), 5);
  assert.equal(core.snapStepFor(10, { widthMm: 253, depthMm: 220 }), 10);
});

test("snap: snapStepFor floor-step derivation is deterministic", async () => {
  const core = await corePromise;
  // 253 / 48 = 5.27 → floor(5.27/5)*5 = 5; 480/48=10 → floor(10/5)*5=10.
  assert.equal(core.snapStepFor(0, { widthMm: 253, depthMm: 220 }), 5);
  assert.equal(core.snapStepFor(0, { widthMm: 480, depthMm: 480 }), 10);
  assert.equal(core.snapStepFor(0, { widthMm: 20, depthMm: 20 }), 5); // min clamp
});

test("snap: snapRotationDeg snaps to 15° steps", async () => {
  const core = await corePromise;
  assert.equal(core.snapRotationDeg(7, 15), 0);
  assert.equal(core.snapRotationDeg(22, 15), 15);
  assert.equal(core.snapRotationDeg(30, 15), 30);
  assert.equal(core.snapRotationDeg(47, 15), 45);
});

test("snap: snapDraft snaps move axes to the step and reports the first target", async () => {
  const core = await corePromise;
  const { transform, target } = core.snapDraft(
    { x: 12.4, y: 0.4, z: -3.2, rx: 0, ry: 0, rz: 0 },
    { snap: true, stepMm: 5 },
  );
  assert.deepEqual(transform, { x: 10, y: 0, z: -5, rx: 0, ry: 0, rz: 0 });
  assert.deepEqual(target, { axis: "X", value: 10, kind: "move" });
});

test("snap: snapDraft keeps identity + target when no snap needed", async () => {
  const core = await corePromise;
  const draft = { x: 10, y: 0, z: -5, rx: 0, ry: 0, rz: 0 };
  const { transform, target } = core.snapDraft(draft, { snap: true, stepMm: 5 });
  assert.deepEqual(transform, draft);
  assert.equal(target, null);
});

test("snap: snapDraft respects the snap toggle (AC-2)", async () => {
  const core = await corePromise;
  const draft = { x: 12.7, y: 0.4, z: -3.2, rx: 0, ry: 0, rz: 0 };
  const { transform, target } = core.snapDraft(draft, { snap: false, stepMm: 5 });
  assert.deepEqual(transform, draft);
  assert.equal(target, null);
});

test("snap: snapDraft snaps rotations to 15°", async () => {
  const core = await corePromise;
  const { transform, target } = core.snapDraft(
    { x: 0, y: 0, z: 0, rx: 0, ry: 22, rz: 0 },
    { snap: true, stepMm: 5 },
  );
  assert.equal(transform.ry, 15);
  assert.deepEqual(target, { axis: "Y", value: 15, kind: "rotate" });
});

test("snap: rotation snap takes precedence when move axes already aligned", async () => {
  const core = await corePromise;
  const { transform, target } = core.snapDraft(
    { x: 10, y: 0, z: -5, rx: 0, ry: 22, rz: 0 },
    { snap: true, stepMm: 5 },
  );
  assert.equal(transform.ry, 15);
  assert.equal(target?.kind, "rotate");
});
