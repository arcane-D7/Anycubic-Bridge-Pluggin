import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Dynamic import with cache-busting, matching the repo test convention.
async function loadCore() {
  const url = pathToFileURL(
    path.join(ROOT, "apps", "editor", "src", "state", "printer-status-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("printer-status-core exposes S9.9-006 thresholds", async () => {
  const core = await corePromise;
  assert.equal(core.STATUS_FILAMENT_LOW_PCT, 15);
  assert.equal(core.STATUS_FILAMENT_CRIT_PCT, 5);
});

test("filamentAlertFor returns none/low/crit at thresholds", async () => {
  const core = await corePromise;
  assert.equal(core.filamentAlertFor(null), "none");
  assert.equal(core.filamentAlertFor(80), "none");
  assert.equal(core.filamentAlertFor(15), "none");
  assert.equal(core.filamentAlertFor(14), "low");
  assert.equal(core.filamentAlertFor(5), "low");
  assert.equal(core.filamentAlertFor(4.9), "crit");
  assert.equal(core.filamentAlertFor(0), "crit");
});

test("formatters render and clamp", async () => {
  const core = await corePromise;
  assert.equal(core.formatTempC(218), "218");
  assert.equal(core.formatTempC(null), "—");
  assert.equal(core.formatTempProbe({ currentC: 218, targetC: 220 }), "218/220");
  assert.equal(core.formatTempProbe({ currentC: null, targetC: 220 }), "—/220");
  assert.equal(core.formatLayerPart(12, 120), "12/120");
  assert.equal(core.formatLayerPart(null, 120), "0/120");
  assert.equal(core.formatLayerPart(null, null), null);
  assert.equal(core.formatPct(42), "42%");
  assert.equal(core.formatPct(null), null);
  assert.equal(core.formatClock(83), "1:23");
  assert.equal(core.formatClock(null), null);
});

test("lowestFilamentPct picks minimum across boxes", async () => {
  const core = await corePromise;
  const boxes = [
    {
      index: 0,
      slots: [
        { state: "identified", remainingPct: 80 },
        { state: "identified", remainingPct: 12 },
      ],
      drying: null,
      autoFeed: true,
      loadedSlotIndex: 0,
    },
    {
      index: 1,
      slots: [{ state: "empty", remainingPct: null }],
      drying: null,
      autoFeed: false,
      loadedSlotIndex: null,
    },
  ];
  assert.equal(core.lowestFilamentPct(boxes), 12);
  assert.equal(core.lowestFilamentPct([]), null);
});

test("loadedSlotNumber is 1-based and null on none", async () => {
  const core = await corePromise;
  assert.equal(core.loadedSlotNumber([]), null);
  const boxes = [
    { loadedSlotIndex: 2, slots: [] },
    { loadedSlotIndex: null, slots: [] },
  ];
  assert.equal(core.loadedSlotNumber(boxes), 3);
  const none = [{ loadedSlotIndex: null, slots: [] }];
  assert.equal(core.loadedSlotNumber(none), null);
});

test("isAceErrorCode windows 129..135", async () => {
  const core = await corePromise;
  assert.equal(core.isAceErrorCode(128), false);
  assert.equal(core.isAceErrorCode(129), true);
  assert.equal(core.isAceErrorCode(133), true);
  assert.equal(core.isAceErrorCode(135), true);
  assert.equal(core.isAceErrorCode(136), false);
  assert.equal(core.isAceErrorCode(null), false);
});

test("aceErrorCode finds first error slot", async () => {
  const core = await corePromise;
  assert.equal(core.aceErrorCode([]), null);
  const boxes = [
    {
      slots: [
        { state: "empty", stateCode: null },
        { state: "identified", stateCode: 133 },
      ],
    },
  ];
  assert.equal(core.aceErrorCode(boxes), 133);
  const clean = [{ slots: [{ state: "identified", stateCode: 0 }] }];
  assert.equal(core.aceErrorCode(clean), null);
});

test("tempOutsideWindow boundaries are exclusive", async () => {
  const core = await corePromise;
  const rec = { min: 200, max: 220 };
  assert.equal(core.tempOutsideWindow(200, rec), false);
  assert.equal(core.tempOutsideWindow(210, rec), false);
  assert.equal(core.tempOutsideWindow(220, rec), false);
  assert.equal(core.tempOutsideWindow(199, rec), true);
  assert.equal(core.tempOutsideWindow(221, rec), true);
  assert.equal(core.tempOutsideWindow(218, null), false);
});
