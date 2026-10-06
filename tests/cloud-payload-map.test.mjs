import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.13-002/003 — CLOUD payload adapter (`cloudPayloadToMcp`) + the shared
 * mapper (`mapPrinterPayload`): the loopback cloud-bridge returns raw
 * Anycubic cloud API shapes (`/v2/printer/info` etc.); the editor re-keys
 * them into the MCP-flat grammar before normalization, so the Device panel
 * consumes the SAME `PrinterSnapshot` schema for LAN and cloud printers.
 *
 * AC: identity/temps/print/ACE/capabilities map from cloud keys
 * (`version.firmware_version`, `parameter.curr_nozzle_temp`,
 * `is_printing`, `multi_color_box.*`, `features[]`); unknown keys fall
 * through as raw; all fixtures are synthetic (rule §6).
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCloud() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "cloud.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

async function loadMapper() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-path-map.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const cloudPromise = loadCloud();
const mapperPromise = loadMapper();

// Synthetic cloud payload (fictitious values — never real account data).
function makeCloudPayload() {
  return {
    base: { firmware_version: "9.9.9" },
    version: { firmware_version: "9.9.9" },
    machine_type: 20025,
    machine_data: { name: "Test Kobra X1", size_x: 250, size_y: 250, size_z: 260 },
    nozzle_diameter: 0.4,
    is_printing: 1,
    parameter: {
      curr_nozzle_temp: 210,
      target_nozzle_temp: 0,
      curr_hotbed_temp: 60,
      progress: 42,
    },
    multi_color_box: {
      id: 0,
      model_id: 40002,
      temp: 35,
      humidity: 29,
      loaded_slot: -1,
      auto_feed: 0,
      target_nozzle_temp: 0,
      drying_status: { status: 0, duration: 0, remain_time: 0, target_temp: 0 },
      slots: [
        {
          index: 0,
          type: "PLA",
          sku: "AHLSMW-101",
          color: [239, 240, 241],
          consumables_percent: 58,
          status: 5,
        },
      ],
    },
    features: [{ name: "auto_leveling_support", value: true }],
  };
}

test("cloudPayloadToMcp: flat maps identity/temps/print/caps (no literal IPs)", async () => {
  const { cloudPayloadToMcp } = await cloudPromise;
  const flat = cloudPayloadToMcp(makeCloudPayload());
  assert.equal(flat["firmware_version"], "9.9.9");
  assert.equal(flat["machine_type"], 20025);
  assert.equal(flat["nozzle_diameter_mm"], 0.4);
  assert.equal(flat["print_state"], "printing");
  assert.equal(flat["nozzle_temp"], 210);
  assert.equal(flat["bed_temp"], 60);
  assert.equal(flat["progress"], 42);
  // capability fold: features[] → {name: value}
  assert.deepEqual(flat["features"], { auto_leveling_support: true });
});

test("cloudPayloadToMcp: nested dot-paths reach the mapper", async () => {
  const { cloudPayloadToMcp } = await cloudPromise;
  const { mapPrinterPayload } = await mapperPromise;
  const snap = mapPrinterPayload("cloud-688972", cloudPayloadToMcp(makeCloudPayload()));
  assert.equal(snap.identity.machineType, 20025);
  assert.equal(snap.identity.firmwareVersion, "9.9.9");
  assert.equal(snap.identity.nozzleDiameterMm, 0.4);
  assert.deepEqual(snap.identity.buildVolume, { x: 250, y: 250, z: 260 });
  assert.equal(snap.temps.nozzle.currentC, 210);
  assert.equal(snap.temps.bed.currentC, 60);
  assert.equal(snap.print.state, "printing");
  assert.equal(snap.print.progressPct, 42);
  assert.deepEqual(snap.capabilities, { auto_leveling_support: true });
});

test("cloudPayloadToMcp: ACE box + slots normalized from multi_color_box", async () => {
  const { cloudPayloadToMcp } = await cloudPromise;
  const { mapPrinterPayload } = await mapperPromise;
  const snap = mapPrinterPayload("cloud-688972", cloudPayloadToMcp(makeCloudPayload()));
  assert.equal(snap.ace.boxes.length, 1);
  const box = snap.ace.boxes[0];
  assert.equal(box.index, 0);
  assert.equal(box.ambientTempC, 35);
  assert.equal(box.humidityPct, 29);
  assert.equal(box.slots.length, 1);
  assert.equal(box.slots[0].sku, "AHLSMW-101");
  assert.equal(box.slots[0].remainingPct, 58);
});

test("cloudFetchSnapshot kind defaults to printer_info (read-only safe)", async () => {
  const { defaultKind } = await loadCloud();
  assert.equal(defaultKind, "printer_info");
});
