/**
 * S9.10-004 — print readiness guard unit tests (no network).
 *
 * The approval card must derive from the LIVE ACE snapshot. This core
 * decides whether a job may be sent: no ACE → pass (local spool unknown,
 * honest pass-through); ACE present → need at least one identified/manual
 * slot with remainingPct >= PRINT_MIN_REMAIN_PCT.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-print-guard-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}
const corePromise = loadCore();

/* ------------------------------------------------------------------ */
/* Boxes / slot fixtures (agnostic — never real printer data).         */
/* ------------------------------------------------------------------ */

function slot(index, { state = "identified", remainingPct = 80, color = "#4fa8dc" } = {}) {
  return {
    index,
    state,
    remainingPct,
    color,
    material: "PLA",
    sku: null,
    editOrigin: "rfid",
    stateCode: null,
    recommendedTempsC: { nozzle: null, bed: null },
  };
}

function box(index, slots, { loadedSlotIndex = null, autoFeed = false } = {}) {
  return {
    index,
    modelId: null,
    slots,
    ambientTempC: 25,
    humidityPct: 40,
    drying: { active: false, targetTempC: null, remainingSeconds: null },
    autoFeed,
    loadedSlotIndex,
  };
}

function snap(boxes) {
  return { ace: { boxes, totalSlots: boxes.reduce((n, b) => n + b.slots.length, 0) } };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("guard: no ACE → ready (local spool honest pass-through)", async () => {
  const { printReady } = await corePromise;
  const r = printReady([]);
  assert.equal(r.ready, true);
  if (r.ready) assert.equal(r.reason, null);
});

test("guard: at least one identified slot ≥ min → ready", async () => {
  const { printReady, PRINT_MIN_REMAIN_PCT } = await corePromise;
  const r = printReady([box(0, [slot(0, { remainingPct: PRINT_MIN_REMAIN_PCT + 5 })])]);
  assert.equal(r.ready, true);
});

test("guard: all slots empty → blocked", async () => {
  const { printReady } = await corePromise;
  const r = printReady([
    box(0, [
      slot(0, { state: "empty", remainingPct: null }),
      slot(1, { state: "empty", remainingPct: null }),
    ]),
  ]);
  assert.equal(r.ready, false);
  if (!r.ready) assert.match(r.reason, /no loaded filament/);
});

test("guard: only low (< min) identified → blocked", async () => {
  const { printReady, PRINT_MIN_REMAIN_PCT } = await corePromise;
  const r = printReady([box(0, [slot(0, { remainingPct: PRINT_MIN_REMAIN_PCT - 3 })])]);
  assert.equal(r.ready, false);
  if (!r.ready) {
    assert.match(r.reason, /below/);
    assert.match(r.reason, new RegExp(`${PRINT_MIN_REMAIN_PCT}% minimum`));
  }
});

test("guard: identifying slots are not usable", async () => {
  const { printReady } = await corePromise;
  const r = printReady([box(0, [slot(0, { state: "identifying", remainingPct: null })])]);
  assert.equal(r.ready, false);
});

test("guard: low-but-above-min yields ready with warn reason only", async () => {
  const { printReady, PRINT_WARN_REMAIN_PCT } = await corePromise;
  const r = printReady([box(0, [slot(0, { remainingPct: PRINT_WARN_REMAIN_PCT - 1 })])]);
  assert.equal(r.ready, true);
  if (r.ready) assert.match(String(r.reason), /below/);
});
