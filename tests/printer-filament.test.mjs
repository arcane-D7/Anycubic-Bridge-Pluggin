/**
 * S9.9-005 — filament/ACE thresholds + state mapping (pure core).
 *
 * Follows the repo convention: DYNAMIC import with a cache-busting `?key=`
 * so Node 24 type-strips the `.ts` headless. No React/zustand/three. The
 * helpers here power the Filament tab AND the status bar toasts (S9.9-006),
 * so the thresholds are single-source tested here.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-filament-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

/* ------------------------------------------------------------------ */
/* Ring thresholds (single source, also used by S9.9-006 toasts)       */
/* ------------------------------------------------------------------ */

test("ring: thresholds at 50/15", async () => {
  const { RING_WARN_PCT, RING_CRIT_PCT, ringToneFor, ringClassFor } = await corePromise;
  assert.equal(RING_WARN_PCT, 50);
  assert.equal(RING_CRIT_PCT, 15);
  // ok bucket
  assert.equal(ringToneFor(100), "ok");
  assert.equal(ringToneFor(50), "ok");
  // warn bucket (amber)
  assert.equal(ringToneFor(49), "warn");
  assert.equal(ringToneFor(15), "warn");
  // crit bucket (red)
  assert.equal(ringToneFor(14.9), "crit");
  assert.equal(ringToneFor(0), "crit");
  // na bucket
  assert.equal(ringToneFor(null), "na");
  assert.equal(ringToneFor(Number.NaN), "na");
  // class suffix
  assert.equal(ringClassFor(49), " device-ring-warn");
  assert.equal(ringClassFor(14), " device-ring-crit");
  assert.equal(ringClassFor(80), " device-ring-ok");
  assert.equal(ringClassFor(null), "");
});

test("isLowFilament: empty slots are not low", async () => {
  const { isLowFilament } = await corePromise;
  assert.equal(isLowFilament({ state: "empty", remainingPct: 0 }), false);
  assert.equal(isLowFilament({ state: "identified", remainingPct: 49 }), true);
  assert.equal(isLowFilament({ state: "identified", remainingPct: 14 }), true);
  assert.equal(isLowFilament({ state: "identified", remainingPct: 80 }), false);
  assert.equal(isLowFilament({ state: "identifying", remainingPct: null }), false);
});

/* ------------------------------------------------------------------ */
/* slot selection (lowest remaining)                                   */
/* ------------------------------------------------------------------ */

function slot(index, state, pct, extra = {}) {
  return {
    index,
    state,
    material: null,
    sku: null,
    color: null,
    remainingPct: pct,
    editOrigin: "rfid",
    recommendedTempsC: { nozzle: null, bed: null },
    ...extra,
  };
}

function box(index, slots, boxExtra = {}) {
  return {
    index,
    modelId: null,
    slots,
    ambientTempC: null,
    humidityPct: null,
    drying: { active: false, targetTempC: null, remainingSeconds: null },
    autoFeed: false,
    loadedSlotIndex: null,
    ...boxExtra,
  };
}

test("selectLowestFilamentPct: picks min across boxes, skips empty/null", async () => {
  const { selectLowestFilamentPct } = await corePromise;
  const boxes = [
    box(0, [slot(0, "empty", 87), slot(1, "identified", 12), slot(2, "identified", 42)]),
    box(1, [slot(0, "identified", null), slot(1, "identified", 63)]),
  ];
  const { pct, slot: s } = selectLowestFilamentPct(boxes);
  assert.equal(pct, 12);
  assert.equal(s?.index, 1);
});

test("selectLowestFilamentPct: all empty/null → null", async () => {
  const { selectLowestFilamentPct } = await corePromise;
  const boxes = [box(0, [slot(0, "empty", null), slot(1, "identifying", null)])];
  const { pct, slot: s } = selectLowestFilamentPct(boxes);
  assert.equal(pct, null);
  assert.equal(s, null);
});

/* ------------------------------------------------------------------ */
/* dryer state machine                                                 */
/* ------------------------------------------------------------------ */

test("dryerPhaseFor: absent/off/heating/drying/done", async () => {
  const { dryerPhaseFor } = await corePromise;
  // no drying field → absent
  const noDryer = box(0, []);
  delete noDryer.drying; // simulate an AceBox without dryer capability
  assert.equal(dryerPhaseFor(noDryer), "absent");
  // drying present, inactive → off
  assert.equal(
    dryerPhaseFor(
      box(0, [], { drying: { active: false, targetTempC: null, remainingSeconds: null } }),
    ),
    "off",
  );
  // active + remaining > 0 → drying
  assert.equal(
    dryerPhaseFor(
      box(0, [], { drying: { active: true, targetTempC: 55, remainingSeconds: 1200 } }),
    ),
    "drying",
  );
  // active + remaining 0 → done
  assert.equal(
    dryerPhaseFor(box(0, [], { drying: { active: true, targetTempC: 55, remainingSeconds: 0 } })),
    "done",
  );
  // active + no countdown → heating
  assert.equal(
    dryerPhaseFor(
      box(0, [], { drying: { active: true, targetTempC: 55, remainingSeconds: null } }),
    ),
    "heating",
  );
});

/* ------------------------------------------------------------------ */
/* loaded slot + origin badge + material label                         */
/* ------------------------------------------------------------------ */

test("isLoadedSlot: matches loadedSlotIndex", async () => {
  const { isLoadedSlot } = await corePromise;
  const b = box(0, [], { loadedSlotIndex: 2 });
  assert.equal(isLoadedSlot(b, 2), true);
  assert.equal(isLoadedSlot(b, 0), false);
  const n = box(0, [], { loadedSlotIndex: null });
  assert.equal(isLoadedSlot(n, 0), false);
});

test("editOriginKey: rfid/manual → i18n keys", async () => {
  const { editOriginKey } = await corePromise;
  assert.equal(editOriginKey("rfid"), "device.fil.origin.rfid");
  assert.equal(editOriginKey("manual"), "device.fil.origin.manual");
});

test("materialLabel: uses material, falls back sensibly", async () => {
  const { materialLabel } = await corePromise;
  assert.equal(materialLabel(slot(0, "identified", 50, { material: "PLA" })), "PLA");
  assert.equal(materialLabel(slot(0, "identified", 50, { material: null })), "identified");
  assert.equal(materialLabel(slot(0, "empty", null)), "");
});

/* ------------------------------------------------------------------ */
/* box summary                                                         */
/* ------------------------------------------------------------------ */

test("boxSummary: counts boxes + loaded", async () => {
  const { boxSummary } = await corePromise;
  const boxes = [
    box(0, [slot(0, "identified", 60)], { loadedSlotIndex: 0 }),
    box(1, [slot(0, "empty", null)], { loadedSlotIndex: null }),
  ];
  const s = boxSummary(boxes);
  assert.equal(s.boxCount, 2);
  assert.equal(s.loadedCount, 1);
});
