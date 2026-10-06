import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure core loaded with a cache-buster so repeated runs never import a stale
 * module (same pattern as every headless core test in this repo).
 */
async function loadCore() {
  const url = pathToFileURL(path.join(ROOT, "apps/editor/src/state/view-mode-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

test("view mode: default mode is mesh", async () => {
  const { DEFAULT_VIEW_MODE, VIEW_MODES } = await loadCore();
  assert.equal(DEFAULT_VIEW_MODE, "mesh");
  assert.deepEqual(VIEW_MODES, ["mesh", "slicer", "live"]);
});

test("view mode: isViewMode accepts only the three modes", async () => {
  const { isViewMode } = await loadCore();
  assert.equal(isViewMode("mesh"), true);
  assert.equal(isViewMode("slicer"), true);
  assert.equal(isViewMode("live"), true);
  assert.equal(isViewMode("wireframe"), false);
  assert.equal(isViewMode(undefined), false);
  assert.equal(isViewMode(null), false);
});

test("view mode: parseViewMode falls back to default on garbage", async () => {
  const { parseViewMode, DEFAULT_VIEW_MODE } = await loadCore();
  assert.equal(parseViewMode("live"), "live");
  assert.equal(parseViewMode("mesh"), "mesh");
  assert.equal(parseViewMode("wireframe"), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(42), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(undefined), DEFAULT_VIEW_MODE);
});

test("view mode: effective mode is identity when live reachable / non-live", async () => {
  const { effectiveViewMode } = await loadCore();
  // mesh / slicer are local renders — never gated.
  assert.equal(effectiveViewMode("mesh", false), "mesh");
  assert.equal(effectiveViewMode("slicer", false), "slicer");
  assert.equal(effectiveViewMode("mesh", true), "mesh");
  // live reachable → live.
  assert.equal(effectiveViewMode("live", true), "live");
});

test("view mode: live without reachable printer falls back to slicer", async () => {
  const { effectiveViewMode } = await loadCore();
  assert.equal(effectiveViewMode("live", false), "slicer");
});

test("view mode: isLiveFallback only when live was downgraded", async () => {
  const { isLiveFallback } = await loadCore();
  assert.equal(isLiveFallback("live", false), true);
  assert.equal(isLiveFallback("live", true), false);
  assert.equal(isLiveFallback("slicer", false), false);
  assert.equal(isLiveFallback("mesh", true), false);
});

test("view mode: storage key is stable + machine-agnostic", async () => {
  const { VIEW_MODE_STORAGE_KEY } = await loadCore();
  assert.equal(VIEW_MODE_STORAGE_KEY, "anycubic:view-mode:v1");
});
