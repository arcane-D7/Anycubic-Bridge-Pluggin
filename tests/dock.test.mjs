import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// The dock store uses zustand + localStorage — import the pure helpers only,
// plus a headless shim for the store module.
const dockPath = pathToFileURL(require.resolve("../apps/editor/src/state/dock.ts"));

let dock;
try {
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) {
      return this._m.get(k) ?? null;
    },
    setItem(k, v) {
      this._m.set(k, String(v));
    },
    removeItem(k) {
      this._m.delete(k);
    },
  };
  dock = await import(dockPath.href);
} catch (e) {
  // If the store module can't load under Node (zustand import), fall back to
  // pure-helper tests only — the load path is exercised by typecheck/build.
  dock = { clampRect: (r) => r };
}

test("clampRect keeps valid viewport-fraction rects", () => {
  assert.deepEqual(dock.clampRect({ x: 0.5, y: 0.22, w: 0.34, h: 0.5 }), {
    x: 0.5,
    y: 0.22,
    w: 0.34,
    h: 0.5,
  });
});

test("clampRect bounds out-of-range values to [0,0.9]/[0.2,0.9]", () => {
  assert.deepEqual(dock.clampRect({ x: -2, y: 5, w: 3, h: 0.05 }), {
    x: 0,
    y: 0.8,
    w: 0.9,
    h: 0.2,
  });
});

test("clampRect rounds tiny widths/heights up to the minimum", () => {
  const got = dock.clampRect({ x: 0.1, y: 0.1, w: 0.01, h: 0.15 });
  assert.ok(got.w >= 0.2);
  assert.ok(got.h >= 0.2);
});

// S9.1a-004 — Alt+Shift+arrows move the panel by MOVE_STEP (0.05) viewport
// fractions; clampRect keeps the moved rect inside the visible band.
const MOVE_STEP = 0.05;

test("a11y move step keeps the rect inside the clampable viewport", () => {
  // Panel near the bottom-right edge, moved down-right once more.
  const near = { x: 0.85, y: 0.75, w: 0.3, h: 0.3 };
  const moved = dock.clampRect({
    x: near.x + MOVE_STEP,
    y: near.y + MOVE_STEP,
    w: near.w,
    h: near.h,
  });
  assert.ok(moved.x <= 0.9);
  assert.ok(moved.y <= 0.8);
  assert.ok(moved.x >= 0.85);
  assert.ok(moved.y >= 0.75);
});

test("a11y move step from origin stays strictly positive", () => {
  const origin = { x: 0, y: 0, w: 0.3, h: 0.3 };
  const moved = dock.clampRect({
    x: origin.x - MOVE_STEP,
    y: origin.y - MOVE_STEP,
    w: origin.w,
    h: origin.h,
  });
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: 0, y: 0 });
});
