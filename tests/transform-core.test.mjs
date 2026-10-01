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
