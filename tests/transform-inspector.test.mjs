import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const insp = await import(
  pathToFileURL(path.join(root, "apps", "editor", "src", "state", "transform-inspector.ts")).href
);

/**
 * S9.3-002 — Numeric transform inspector core (headless).
 *
 * Pins the pure helpers the TransformInspector panel uses: value parsing,
 * absolute/relative resolution, reset, dirty detection (AC-3), non-uniform
 * scale warning, and the snapshot→store round-trip through the mock bridge.
 */

const T = {
  x: 10,
  y: 20,
  z: 30,
  rx: 0,
  ry: 0,
  rz: 0,
  sx: 1,
  sy: 1,
  sz: 1,
};

test("parseAxisValue: valid numbers, empty → 0, invalid → null", () => {
  assert.equal(insp.parseAxisValue("12.5"), 12.5);
  assert.equal(insp.parseAxisValue("  -3 "), -3);
  assert.equal(insp.parseAxisValue(""), 0);
  assert.equal(insp.parseAxisValue("12,5"), null);
  assert.equal(insp.parseAxisValue("abc"), null);
  assert.equal(insp.parseAxisValue("Infinity"), null);
  assert.equal(insp.parseAxisValue("NaN"), null);
});

test("axisValue: reads per-kind fields", () => {
  const t = { ...T, rx: 45, sy: 2 };
  assert.equal(insp.axisValue("position", "x", t), 10);
  assert.equal(insp.axisValue("rotation", "y", t), 0);
  assert.equal(insp.axisValue("rotation", "x", t), 45);
  assert.equal(insp.axisValue("scale", "y", t), 2);
  assert.equal(insp.axisValue("scale", "z", t), 1);
});

test("withAxisValue: replaces exactly one axis", () => {
  const out = insp.withAxisValue("position", "z", 99, T);
  assert.deepEqual(out, { ...T, z: 99 });

  const rot = insp.withAxisValue("rotation", "x", 90, T);
  assert.equal(rot.rx, 90);
  assert.equal(rot.ry, 0);
  assert.equal(rot.rz, 0);
  // Position unchanged.
  assert.equal(rot.x, 10);

  const sc = insp.withAxisValue("scale", "x", 2, T);
  assert.deepEqual(sc, { ...T, sx: 2 });
});

test("normalizeTransform: defaults missing slots", () => {
  const full = insp.normalizeTransform(T);
  assert.equal(full.rx, 0);
  assert.equal(full.sx, 1);

  const minimal = insp.normalizeTransform({ x: 5, sx: 3 });
  assert.equal(minimal.y, 0);
  assert.equal(minimal.rx, 0);
  assert.equal(minimal.sy, 1);
  assert.equal(minimal.sz, 1);

  const empty = insp.normalizeTransform(undefined);
  assert.equal(empty.x, 0);
  assert.equal(empty.sx, 1);
});

test("dirtyKinds (AC-3): detects per-kind diffs, null when equal", () => {
  const draft = { ...T };
  assert.equal(insp.dirtyKinds(T, draft), null);

  draft.x = 11;
  assert.deepEqual(insp.dirtyKinds(T, draft), ["position"]);

  draft.x = 10;
  draft.rz = 5;
  assert.deepEqual(insp.dirtyKinds(T, draft), ["rotation"]);

  draft.rz = 0;
  draft.sx = 1.5;
  assert.deepEqual(insp.dirtyKinds(T, draft), ["scale"]);

  const multi = { ...T, y: 1, ry: 2, sz: 0.5 };
  assert.deepEqual(insp.dirtyKinds(T, multi), ["position", "rotation", "scale"]);
});

test("isResized / isNonUniformScale: warning trigger", () => {
  assert.equal(insp.isResized(T), false);
  assert.equal(insp.isResized({ ...T, sx: 2 }), true);
  assert.equal(insp.isNonUniformScale(T), false);
  assert.equal(insp.isNonUniformScale({ ...T, sx: 2, sy: 2, sz: 2 }), false); // uniform
  assert.equal(insp.isNonUniformScale({ ...T, sx: 2, sy: 1, sz: 2 }), true);
  assert.equal(insp.isNonUniformScale({ ...T, sx: 2 }), true);
});

test("prettyRotation / prettyScale: rounding", () => {
  assert.equal(insp.prettyRotation(45.0001), 45);
  assert.equal(insp.prettyRotation(45.005), 45.01);
  assert.equal(insp.prettyScale(1.0004), 1.0);
  assert.equal(insp.prettyScale(1.0005), 1.001);
});

test("absolute commit: resolveKind replaces the kind values", () => {
  const committed = { ...T, rx: 5, ry: 10, rz: 15 };
  const out = insp.resolveKind(committed, "position", { x: 100, y: 200, z: 300 }, false);
  assert.equal(out.x, 100);
  assert.equal(out.y, 200);
  assert.equal(out.z, 300);
  // Rotation untouched.
  assert.equal(out.rx, 5);

  const rot = insp.resolveKind(committed, "rotation", { x: 0, y: 0, z: 90 }, false);
  assert.equal(rot.rz, 90);
  assert.equal(rot.x, 10);

  const sc = insp.resolveKind(committed, "scale", { x: 2, y: 2, z: 2 }, false);
  assert.equal(sc.sx, 2);
  assert.equal(sc.sy, 2);
  assert.equal(sc.sz, 2);
});

test("relative commit: position/rotation add, scale multiplies", () => {
  const committed = { ...T, x: 10, y: 20, z: 30, sx: 2, sy: 3, sz: 4 };

  const pos = insp.resolveKind(committed, "position", { x: 5, y: -5, z: 0 }, true);
  assert.equal(pos.x, 15);
  assert.equal(pos.y, 15);
  assert.equal(pos.z, 30);

  const rot = insp.resolveKind(committed, "rotation", { x: 10, y: 0, z: 0 }, true);
  assert.equal(rot.rx, 10);

  const sc = insp.resolveKind(committed, "scale", { x: 2, y: 1, z: 0.5 }, true);
  assert.equal(sc.sx, 4);
  assert.equal(sc.sy, 3);
  assert.equal(sc.sz, 2);
});

test("reset: returns axis values to origin (0) or identity scale (1)", () => {
  const moved = { ...T, x: 44, ry: 33, sx: 2.5 };
  const p = insp.resetValue("position", "x", moved);
  assert.equal(p.x, 0);
  assert.equal(p.y, 20);

  const s = insp.resetValue("scale", "x", moved);
  assert.equal(s.sx, 1);
  assert.equal(s.sy, 1);
});

test("bridge round-trip: setTransform persists values the store can read back", async () => {
  const mock = await import(
    pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts")).href +
      `?inspector=${Date.now()}`
  );
  const handle = await mock.fetchSceneSnapshot();

  // Fresh instance: grab an object to test against.
  const target = handle.objects[0];
  assert.ok(target, "snapshot has at least one object");

  const res = await handle.mutateObject({
    kind: "setTransform",
    name: target.name,
    transform: { x: 7, y: 8, z: 9, rx: 15, ry: 30, rz: 45, sx: 2, sy: 2, sz: 2 },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const committed = res.objects.find((o) => o.name === target.name);
  assert.ok(committed);
  assert.equal(committed.transform?.x, 7);
  assert.equal(committed.transform?.y, 8);
  assert.equal(committed.transform?.z, 9);
  assert.equal(committed.transform?.rx, 15);
  assert.equal(committed.transform?.rz, 45);
  assert.equal(committed.transform?.sx, 2);

  // Unknown object → rejected (same contract as S9.3-001).
  const bad = await handle.mutateObject({
    kind: "setTransform",
    name: "does-not-exist",
    transform: { x: 1, y: 1, z: 1 },
  });
  assert.equal(bad.ok, false);
});
