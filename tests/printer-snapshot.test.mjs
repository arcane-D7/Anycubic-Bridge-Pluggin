/**
 * S9.9-001/002/003 — printer snapshot schema, path map + polling helpers.
 *
 * Follows the repo convention (arrange-core.test.mjs): imports are DYNAMIC
 * with a cache-busting `?key=` query so Node 24 type-strips the `.ts` files
 * headless. Helpers under test are pure cores (path-map, device-core) — the
 * zustand store itself is exercised through its pure decision helpers only.
 * Fixtures are synthetic; no real device/account values.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-path-map.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}
async function loadDeviceCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-device-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();
const deviceCorePromise = loadDeviceCore();

/* ------------------------------------------------------------------ */
/* S9.9-001: schema                                                    */
/* ------------------------------------------------------------------ */

test("snapshot: empty is fully agnostic (nullable + versioned)", async () => {
  const { emptySnapshot } = await corePromise;
  const s = emptySnapshot("printer-1");
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.printerId, "printer-1");
  assert.equal(s.capturedAt, null);
  assert.equal(s.identity.machineType, null);
  assert.equal(s.identity.nozzleDiameterMm, null);
  assert.equal(s.identity.buildVolume, null);
  assert.equal(s.temps.nozzle.currentC, null);
  assert.equal(s.temps.chamber.targetC, null);
  assert.equal(s.fans.partCoolingPct, null);
  assert.equal(s.print.state, "unknown");
  assert.equal(s.ace.boxes.length, 0);
  assert.equal(s.ace.totalSlots, 0);
  assert.equal(s.motion, null);
  assert.equal(s.ai, null);
  assert.equal(s.lights, null);
  assert.equal(s.peripherals.hasCamera, false);
  assert.equal(s.storage.kind, "unknown");
  assert.deepEqual(s.capabilities, {});
  assert.deepEqual(s.raw, {});
});

/* ------------------------------------------------------------------ */
/* S9.9-002: path map                                                  */
/* ------------------------------------------------------------------ */

test("path map: sentinel -1 → null and enums are named", async () => {
  const { mapPrinterPayload, emptySnapshot } = await corePromise;
  const raw = {
    machine_type: "kobra-s1",
    firmware_version: "v1.0.0",
    tempature: { nozzle_temp: -1, bed_temp: 60, nozzle_target: 220 },
    fan: { part_cooling_fan_speed: -1 },
    print: { status: "idle", speed_mode: 1 },
    abstract_print_state: "idle",
  };
  const snap = mapPrinterPayload("printer-1", raw);
  assert.equal(snap.identity.machineType, "kobra-s1");
  assert.equal(snap.temps.nozzle.currentC, null); // -1 → null
  assert.equal(snap.temps.bed.currentC, 60);
  assert.equal(snap.temps.nozzle.targetC, 220);
  assert.equal(snap.fans.partCoolingPct, null); // -1 → null
  assert.equal(snap.print.state, "idle");
  assert.equal(snap.print.speedMode, "silent");
});

test("path map: ACE slots decode with sentinels + edit origin", async () => {
  const { mapPrinterPayload } = await corePromise;
  const raw = {
    print: { status: "idle", speed_mode: 2 },
    ace: {
      boxes: [
        {
          model_id: 40002,
          slots: [
            {
              property: 3,
              type: "PLA",
              sku: "S1",
              color: "#4fa8dc",
              consumables_percent: 87,
              edit_status: 0,
            },
            {
              property: 3,
              type: "PETG",
              sku: "S2",
              color: "#8cc63f",
              consumables_percent: 63,
              edit_status: 1,
            },
            {
              property: 3,
              type: "PLA",
              sku: "S3",
              color: "#f2b705",
              consumables_percent: 42,
              edit_status: 0,
            },
            {
              property: 0,
              type: null,
              sku: null,
              color: null,
              consumables_percent: -1,
              edit_status: 0,
            },
          ],
        },
      ],
    },
  };
  const snap = mapPrinterPayload("printer-1", raw);
  assert.equal(snap.ace.boxes.length, 1);
  assert.equal(snap.ace.boxes[0].modelId, 40002);
  const slots = snap.ace.boxes[0].slots;
  assert.equal(slots.length, 4);
  assert.equal(slots[0].material, "PLA");
  assert.equal(slots[0].color, "#4fa8dc");
  assert.equal(slots[0].remainingPct, 87);
  assert.equal(slots[0].editOrigin, "rfid");
  assert.equal(slots[1].material, "PETG");
  assert.equal(slots[1].color, "#8cc63f");
  assert.equal(slots[1].editOrigin, "manual");
  assert.equal(slots[2].remainingPct, 42);
  assert.equal(slots[3].remainingPct, null); // -1 sentinel
  assert.equal(snap.ace.totalSlots, 4);
});

test("path map: unknown payload → raw mirror + synthetic ACE slots", async () => {
  const { mapPrinterPayload } = await corePromise;
  const raw = { some_unknown_key: "kept", nested: { deep: 42 }, print: { status: "paused" } };
  const snap = mapPrinterPayload("printer-1", raw);
  assert.equal(snap.print.state, "paused");
  assert.equal(snap.raw.some_unknown_key, "kept");
  assert.equal(snap.raw.nested.deep, 42);
  // Empty/absent ACE → zero boxes, zero slots (agnostic).
  assert.equal(snap.ace.boxes.length, 0);
  assert.equal(snap.ace.totalSlots, 0);
});

test("path map: capabilities are boolean-only, features → map", async () => {
  const { capabilitiesFrom, mapPrinterPayload } = await corePromise;
  const caps = capabilitiesFrom({ chamber: false, multiColorBox: true, camera: 1, name: "x" });
  assert.deepEqual(caps, { chamber: false, multiColorBox: true });
  const snap = mapPrinterPayload("p", { features: { chamber: false, multi_color: true, ai: 0 } });
  assert.deepEqual(snap.capabilities, { chamber: false, multi_color: true });
});

test("helpers: toNumberOrNull / speedModeFrom / editOriginFrom / filamentStateFrom", async () => {
  const { toNumberOrNull, speedModeFrom, editOriginFrom, filamentStateFrom } = await corePromise;
  assert.equal(toNumberOrNull(-1), null);
  assert.equal(toNumberOrNull(0), 0);
  assert.equal(toNumberOrNull(42), 42);
  assert.equal(toNumberOrNull("7"), null); // numeric strings are not coerced
  assert.equal(toNumberOrNull(Number.NaN), null);
  assert.equal(speedModeFrom(1), "silent");
  assert.equal(speedModeFrom(2), "standard");
  assert.equal(speedModeFrom(3), "sport");
  assert.equal(speedModeFrom(99), null);
  assert.equal(editOriginFrom(0), "rfid");
  assert.equal(editOriginFrom(1), "manual");
  assert.equal(editOriginFrom(99), "rfid");
  assert.equal(filamentStateFrom(0), "empty");
  assert.equal(filamentStateFrom(1), "unknown");
  assert.equal(filamentStateFrom(2), "identifying");
  assert.equal(filamentStateFrom(3), "identified");
  assert.equal(filamentStateFrom(4), "identified");
  assert.equal(filamentStateFrom(99), "unknown");
});

test("path map: AceSlot/AceBox defaults stay safe on sparse raw", async () => {
  const { aceSlotFrom, aceBoxFrom } = await corePromise;
  const slot = aceSlotFrom({}, 2);
  assert.equal(slot.index, 2);
  assert.equal(slot.state, "unknown");
  assert.equal(slot.material, null);
  assert.equal(slot.color, null);
  assert.equal(slot.remainingPct, null);
  assert.equal(slot.editOrigin, "rfid");
  assert.equal(slot.stateCode, null);
  assert.equal(slot.recommendedTempsC.nozzle, null);
  const box = aceBoxFrom({}, 0);
  assert.equal(box.index, 0);
  assert.equal(box.modelId, null);
  assert.equal(box.slots.length, 4); // synthesized
  assert.equal(box.autoFeed, false);
});

/* ------------------------------------------------------------------ */
/* S9.9-003: polling helpers (pure core — no zustand in tests)         */
/* ------------------------------------------------------------------ */

test("polling: modeFromState maps print states", async () => {
  const { modeFromState } = await deviceCorePromise;
  assert.equal(modeFromState("idle"), "idle");
  assert.equal(modeFromState("printing"), "printing");
  assert.equal(modeFromState("paused"), "printing");
  assert.equal(modeFromState("unknown"), "idle");
  assert.equal(modeFromState("error"), "idle");
  assert.equal(modeFromState("offline"), "idle");
});

test("polling: interval + staleness matrix (HA-validated)", async () => {
  const { intervalFor, staleThresholdFor } = await deviceCorePromise;
  assert.equal(intervalFor("printing", false), 2000);
  assert.equal(intervalFor("printing", true), 60000);
  assert.equal(intervalFor("idle", false), 15000);
  assert.equal(intervalFor("idle", true), 60000);
  assert.equal(staleThresholdFor("printing", false), 6000);
  assert.equal(staleThresholdFor("idle", false), 45000);
  assert.equal(staleThresholdFor("printing", true), 180000);
});

test("polling: OFFLINE_AFTER_FAILURES is 3", async () => {
  const { OFFLINE_AFTER_FAILURES } = await deviceCorePromise;
  assert.equal(OFFLINE_AFTER_FAILURES, 3);
});

test("polling: diffSnapshot reports changed groups only", async () => {
  const { diffSnapshot } = await deviceCorePromise;
  const { mapPrinterPayload } = await corePromise;
  const base = mapPrinterPayload("p", {
    tempature: { nozzle_temp: 210 },
    print: { status: "idle" },
  });
  const same = mapPrinterPayload("p", {
    tempature: { nozzle_temp: 210 },
    print: { status: "idle" },
  });
  assert.deepEqual(diffSnapshot(base, same), []);
  const hotter = mapPrinterPayload("p", {
    tempature: { nozzle_temp: 218 },
    print: { status: "idle" },
  });
  const d1 = diffSnapshot(base, hotter);
  assert.ok(d1.includes("temps.nozzle.currentC"));
  const aceA = mapPrinterPayload("p", {
    ace: { boxes: [{ model_id: 1, slot_property: [1, 0, 0, 0] }] },
  });
  const aceB = mapPrinterPayload("p", { ace: { boxes: [] } });
  assert.deepEqual(diffSnapshot(aceA, aceB), ["ace"]);
  assert.deepEqual(diffSnapshot(base, null), ["*"]);
  assert.deepEqual(diffSnapshot(null, null), []);
});
