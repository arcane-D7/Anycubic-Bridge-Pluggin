import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "viewport", "transform-core.ts"),
);
const core = await import(coreUrl.href);

test("applyTransform: identity when transform absent", () => {
  const p = core.applyTransform(undefined);
  assert.deepEqual(p.position, [0, 0, 0]);
  assert.deepEqual(p.rotation, [0, 0, 0]);
  assert.deepEqual(p.scale, [1, 1, 1]);
});

test("applyTransform: position passthrough, euler deg -> rad, default scale 1", () => {
  const p = core.applyTransform({ x: 14, y: 0, z: 14, rz: 90 });
  assert.deepEqual(p.position, [14, 0, 14]);
  // 90 deg -> PI/2; rx/ry unset -> 0
  assert.ok(Math.abs(p.rotation[2] - Math.PI / 2) < 1e-9, "rz 90deg -> PI/2 rad");
  assert.equal(p.rotation[0], 0);
  assert.deepEqual(p.scale, [1, 1, 1]);
});

test("normalizeTransform: fills defaults for missing slots", () => {
  const n = core.normalizeTransform({ x: 1 });
  assert.equal(n.rx, 0);
  assert.equal(n.sx, 1);
  assert.equal(n.sz, 1);
});

test("normalizeTransform: undefined -> identity", () => {
  const n = core.normalizeTransform(undefined);
  assert.deepEqual(n, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
});

test("isOverlayPanel: inside a panel rect is TRUE (pointer isolation)", () => {
  const rects = [{ x: 100, y: 100, width: 200, height: 60 }];
  assert.equal(core.isOverlayPanel(150, 120, rects), true);
});

test("isOverlayPanel: outside all rects is FALSE", () => {
  const rects = [{ x: 100, y: 100, width: 200, height: 60 }];
  assert.equal(core.isOverlayPanel(50, 50, rects), false);
});

test("isOverlayPanel: empty rect list always false", () => {
  assert.equal(core.isOverlayPanel(0, 0, []), false);
});

// ---- AC-2: gizmo drags commit REAL transform values through the bridge ----
// The S7-004 mock lane `mutateObject({kind:"setTransform"})` is the snapshot
// writer the gizmo's onObjectChange/pointer-up flow drives.

// ---- S9.10-001: settle on plate (lay-on-plate, Y-up) -----------------------

test("settleOnPlateTransform: lifts a mesh whose bounds dip below 0 so its world minY = 0", () => {
  // Sphere: local bounds -13..13 in Y, previous transform y=0 → 13 mm buried.
  const t = core.settleOnPlateTransform({
    bounds: { min: [-13, -13, -13] },
    transform: { x: 8, y: 0, z: -18 },
  });
  assert.equal(t.x, 8);
  assert.equal(t.y, 13); // -minY = -(-13) = 13
  assert.equal(t.z, -18);
});

test("settleOnPlateTransform: respects scale (world bottom = y + minY*sy)", () => {
  const t = core.settleOnPlateTransform({
    bounds: { min: [-5, -5, 0] },
    transform: { x: 0, y: 0, z: 0, sy: 2 },
  });
  const n = core.normalizeTransform(t);
  // world bottom = y + minY * sy = 10 + (-5)*2 = 0
  assert.equal(n.y, 10);
  assert.equal(n.sy, 2);
});

test("settleOnPlateTransform: already resting mesh is unchanged (y stays 0)", () => {
  const t = core.settleOnPlateTransform({
    bounds: { min: [0, 0, 0] },
    transform: { x: 14, y: 0, z: 14 },
  });
  assert.equal(t.y, 0);
  // `-0` trap: y must be exactly 0, not -0
  assert.ok(Object.is(t.y, 0));
});

test("clampBedY: raises draft y when it would sink below the plate", () => {
  // Sphere local minY = -13; dropping y to -20 → world bottom = -20 + (-13) = -33 < 0.
  const before = { x: 0, y: -20, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
  const after = core.clampBedY(before, -13);
  assert.equal(after.y, 13); // -minY = 13 → world bottom = 13 + (-13) = 0
  assert.equal(after.x, 0);
  assert.equal(after.z, 0);
});

test("clampBedY: hovering above the plate passes through unchanged", () => {
  const draft = { x: 5, y: 20, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
  const after = core.clampBedY(draft, -13);
  assert.equal(after, draft); // same identity: no clamp needed
});

test("clampBedY: honors scale (bed floor = -minY * sy)", () => {
  const draft = { x: 0, y: -10, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 2, sz: 1 };
  const after = core.clampBedY(draft, -5);
  // bed floor = -(-5)*2 = 10 → y=-10 clamped to 10
  assert.equal(after.y, 10);
});

test("bridge lane: setTransform persists real transform into the snapshot", async () => {
  // Fresh module instance (unique URL per run) so scene objects are pristine.
  const freshUrl = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  freshUrl.searchParams.set("a1", String(Date.now()));
  const mock = await import(freshUrl.href);
  const bridge = await mock.fetchSceneSnapshot();
  const before = bridge.objects;
  assert.ok(before.length >= 1, "mock scene has objects");
  const name = before[0].name;

  /** @type {{ ok: true; objects: Array<{ name: string; transform?: Record<string, unknown> }> }} */
  const committed = await bridge.mutateObject({
    kind: "setTransform",
    name,
    transform: { x: 20, y: 5, z: -8, rx: 0, ry: 45, rz: 90, sx: 1, sy: 2, sz: 1 },
  });
  assert.equal(committed.ok, true);
  // The mutation response re-reads the authoritative store: real values there.
  const updated = committed.objects.find((o) => o.name === name);
  assert.equal(updated?.transform?.x, 20);
  assert.equal(updated?.transform?.ry, 45);
  assert.equal(updated?.transform?.sz, 1);
});

test("bridge lane: setTransform on unknown object is rejected (noop)", async () => {
  // Reuse the same fresh module instance as the previous test via a cache key.
  const freshUrl = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  freshUrl.searchParams.set("a2", String(Date.now()));
  const mock = await import(freshUrl.href);
  const bridge = await mock.fetchSceneSnapshot();
  const res = await bridge.mutateObject({
    kind: "setTransform",
    name: "does-not-exist",
    transform: { x: 9, y: 9, z: 9 },
  });
  assert.equal(res?.ok, false);
  assert.match(res?.error ?? "", /unknown object/);
});
