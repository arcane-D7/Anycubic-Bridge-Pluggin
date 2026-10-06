import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(ROOT, "apps/editor/src/state/plate-upgrade-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

test("plate upgrade: all flags default OFF (base viewport unchanged)", async () => {
  const { DEFAULT_PLATE_UPGRADES } = await loadCore();
  assert.deepEqual(DEFAULT_PLATE_UPGRADES, {
    pei: false,
    quadrants: false,
    hotend: false,
    zColumn: false,
  });
});

test("plate upgrade: toggle flips one flag only, identity changes on set", async () => {
  const { togglePlateUpgrade, DEFAULT_PLATE_UPGRADES } = await loadCore();
  const next = togglePlateUpgrade(DEFAULT_PLATE_UPGRADES, "pei");
  assert.equal(next.pei, true);
  assert.equal(next.quadrants, false);
  assert.equal(next.hotend, false);
  assert.equal(next.zColumn, false);
  // Toggle again reverts.
  const reverted = togglePlateUpgrade(next, "pei");
  assert.equal(reverted.pei, false);
});

test("plate upgrade: isPlateUpgradeKey bounds", async () => {
  const { isPlateUpgradeKey, PLATE_UPGRADE_KEYS } = await loadCore();
  for (const key of PLATE_UPGRADE_KEYS) {
    assert.equal(isPlateUpgradeKey(key), true);
  }
  assert.equal(isPlateUpgradeKey("foot"), false);
  assert.equal(isPlateUpgradeKey(undefined), false);
  assert.equal(isPlateUpgradeKey("pei "), false);
});

test("plate upgrade: quadrant crosshair returns 2 segments (4 vertices)", async () => {
  const { quadrantCrosshairPositions } = await loadCore();
  const pos = quadrantCrosshairPositions(220, 220);
  assert.equal(pos.length, 12);
  // X line spans the full width at z=0 (vertices 0 and 3).
  assert.deepEqual([pos[0], pos[3]], [-110, 110]);
  assert.equal(pos[1], 0.12);
  assert.equal(pos[5], 0);
  // Z line spans the full depth at x=0 (vertices 2 and 5 of the array).
  assert.equal(pos[6], 0);
  assert.equal(pos[7], 0.12);
  assert.deepEqual([pos[8], pos[11]], [-110, 110]);
});

test("plate upgrade: quadrant crosshair empty for malformed footprint", async () => {
  const { quadrantCrosshairPositions } = await loadCore();
  assert.deepEqual(quadrantCrosshairPositions(0, 220), []);
  assert.deepEqual(quadrantCrosshairPositions(NaN, 220), []);
  assert.deepEqual(quadrantCrosshairPositions(-5, 220), []);
});

test("plate upgrade: z column marks parity (2 vertices per tick, 10 ticks for 200mm/20)", async () => {
  const { zColumnMarks } = await loadCore();
  const marks = zColumnMarks(200);
  // everyMm default 20 → ticks at 20..200 → 10 ticks → 20 vertices.
  assert.equal(marks.length, 20 * 3);
  // First tick at y=20, segments centered at x=0.
  assert.deepEqual([marks[0], marks[3]], [-4, 4]);
  assert.equal(marks[1], 20);
});

test("plate upgrade: z column marks empty for malformed height", async () => {
  const { zColumnMarks } = await loadCore();
  assert.deepEqual(zColumnMarks(0), []);
  assert.deepEqual(zColumnMarks(-1), []);
  assert.deepEqual(zColumnMarks(NaN), []);
});
