import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corePath = path.join(root, "apps", "editor", "src", "viewport", "context-gesture-core.ts");
const core = await import(pathToFileURL(require.resolve(corePath)).href);

test("right click opens a menu when movement stays below threshold", () => {
  const started = core.beginRightGesture(1, 40, 50);
  const moved = core.moveRightGesture(started, 1, 43, 53);
  assert.deepEqual(core.consumeRightGestureMenu(moved), { openMenu: true, next: null });
});

test("right drag beyond threshold suppresses the menu", () => {
  const started = core.beginRightGesture(2, 40, 50);
  const moved = core.moveRightGesture(started, 2, 46, 50);
  assert.deepEqual(core.consumeRightGestureMenu(moved), { openMenu: false, next: null });
});

test("unrelated pointers and short movement do not change the gesture", () => {
  const started = core.beginRightGesture(2, 40, 50);
  assert.equal(core.moveRightGesture(started, 3, 100, 100), started);
  assert.equal(core.moveRightGesture(started, 2, 45, 50), started);
});

test("pointer cancellation and capture loss suppress a later menu", () => {
  const started = core.beginRightGesture(2, 40, 50);
  const cancelled = core.cancelRightGesture(started);
  assert.deepEqual(core.consumeRightGestureMenu(cancelled), { openMenu: false, next: null });
});

test("context menu opens without a recorded pointer gesture when no drag was observed", () => {
  assert.deepEqual(core.consumeRightGestureMenu(null), { openMenu: true, next: null });
});

test("a drag remains latched even if the pointer returns to its origin", () => {
  const started = core.beginRightGesture(2, 40, 50);
  const dragged = core.moveRightGesture(started, 2, 48, 50);
  const returned = core.moveRightGesture(dragged, 2, 40, 50);
  assert.equal(returned.suppressMenu, true);
});
