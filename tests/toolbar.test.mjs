import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.4-001 floating viewport toolbar — pure core behavior
 * (`state/toolbar-core.ts`). Headless under Node 24.
 *
 * AC-1: tools drive gizmo mode + view — the ToolMode store is already
 * covered by shortcuts.test.mjs (Q/W/E/R); here the toolbar flags + view
 * preset map asserted.
 * AC-2: snap + grid toggles (state only in 9.4) — toggle semantics asserted.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "toolbar-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("toolbar-core: default flags are snap+grid on, boolean tool off (9.4 state / 9.7 arm)", async () => {
  const core = await corePromise;
  assert.deepEqual(core.DEFAULT_TOOLBAR_FLAGS, {
    snap: true,
    grid: true,
    booleanTool: false,
  });
});

test("toolbar-core: toggleFlag flips one flag and preserves the others", async () => {
  const core = await corePromise;
  const off = core.toggleToolbarFlag({ snap: true, grid: true, booleanTool: false }, "snap");
  assert.deepEqual(off, { snap: false, grid: true, booleanTool: false });
  const back = core.toggleToolbarFlag(off, "snap");
  assert.deepEqual(back, { snap: true, grid: true, booleanTool: false });
  const gridOff = core.toggleToolbarFlag({ snap: true, grid: true, booleanTool: false }, "grid");
  assert.deepEqual(gridOff, { snap: true, grid: false, booleanTool: false });
  const armed = core.toggleToolbarFlag(
    { snap: true, grid: true, booleanTool: false },
    "booleanTool",
  );
  assert.deepEqual(armed, { snap: true, grid: true, booleanTool: true });
});

test("toolbar-core: toggle is immutable (identity changes only when set)", async () => {
  const core = await corePromise;
  const flags = { snap: true, grid: true, booleanTool: false };
  const next = core.toggleToolbarFlag(flags, "snap");
  assert.notEqual(next, flags); // fresh object
  assert.equal(flags.snap, true); // original untouched
  assert.equal(flags.booleanTool, false); // untouched too
});

test("toolbar-core: view preset map + keys (iso/top/front/right + numpad)", async () => {
  const core = await corePromise;
  assert.deepEqual(Object.keys(core.VIEW_PRESETS).sort(), ["front", "iso", "right", "top"]);
  assert.equal(core.VIEW_PRESET_KEYS["1"], "iso");
  assert.equal(core.VIEW_PRESET_KEYS["2"], "top");
  assert.equal(core.VIEW_PRESET_KEYS["3"], "front");
  assert.equal(core.VIEW_PRESET_KEYS["4"], "right");
  assert.equal(core.VIEW_PRESET_KEYS["Home"], "iso");
});

test("toolbar-core: isViewPreset accepts known names, rejects others", async () => {
  const core = await corePromise;
  for (const p of ["iso", "top", "front", "right"]) {
    assert.equal(core.isViewPreset(p), true, p);
  }
  assert.equal(core.isViewPreset("bottom"), false);
  assert.equal(core.isViewPreset(""), false);
  assert.equal(core.isViewPreset(null), false);
  assert.equal(core.isViewPreset(42), false);
});
