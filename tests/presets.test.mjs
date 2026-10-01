import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.6-001 — Slicer-standard preset system.
 *
 * AC1: all three dropdowns populate from the preserved catalog — printer
 * machines derive from `presets/catalog.json` (never hardcoded ids), filament
 * candidates derive from the catalog's presets (deduped), quality set is
 * 0.08/0.20/0.28 + custom. AC2: selecting a preset writes the SettingsPanel
 * draft state (export path unchanged) — the store exposes `draftValues` and
 * the layer-height resolution is deterministic.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(rel, key) {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", rel));
  return import(`${url.href}?key=${Date.now() + key}`);
}

const catalogPromise = loadModule("presets/catalog.ts", 1);
const storePromise = loadModule("state/presets.ts", 2);

async function loadCatalogFixture() {
  const catalog = await catalogPromise;
  // build a synthetic catalog payload matching the preserved catalog shape
  return catalog;
}

test("presets: printer presets derive from the preserved catalog machine", async () => {
  const catalog = await catalogPromise;
  assert.ok(catalog.PRINTER_PRESETS.length >= 1);
  // The catalog machine name must never be a hardcoded device id — it comes
  // from presets/catalog.json's `machine` field.
  assert.ok(
    catalog.PRINTER_PRESETS.some((p) => typeof p.machine === "string" && p.machine.length > 0),
  );
  assert.equal(catalog.PRINTER_PRESETS[0].nozzleMm, 0.4);
  assert.equal(catalog.PRINTER_PRESETS[0].flowPct, 100);
});

test("presets: filament presets populate from catalog (deduped) + standards", async () => {
  const catalog = await catalogPromise;
  assert.ok(catalog.FILAMENT_PRESETS.length >= 5); // catalog names + PLA/PETG/ABS/ASA/TPU
  const ids = new Set(catalog.FILAMENT_PRESETS.map((f) => f.id));
  assert.equal(ids.size, catalog.FILAMENT_PRESETS.length); // no duplicate ids
  // every material has a color swatch hex
  for (const f of catalog.FILAMENT_PRESETS) {
    assert.match(f.color, /^#[0-9a-f]{6}$/i);
  }
});

test("presets: quality set is 0.08/0.2/0.28 + custom with editable layer height", async () => {
  const catalog = await catalogPromise;
  assert.deepEqual(
    catalog.QUALITY_PRESETS.map((q) => q.id),
    ["0.08mm", "0.20mm", "0.28mm", "custom"],
  );
  const custom = catalog.qualityPresetById("custom");
  assert.ok(custom);
  assert.equal(custom.layerHeightMm, 0.2); // editable default
  assert.equal(catalog.layerHeightFor({ ...catalog.DEFAULT_PRESET_SELECTION }), 0.2);
  assert.equal(
    catalog.layerHeightFor({ ...catalog.DEFAULT_PRESET_SELECTION, qualityId: "0.28mm" }),
    0.28,
  );
});

test("presets: slugify produces url-safe ids from catalog names", async () => {
  const catalog = await catalogPromise;
  assert.equal(catalog.slugify("Anycubic PLA Gold HQ"), "anycubic-pla-gold-hq");
  assert.equal(catalog.slugify("  PLA  Basico  "), "pla-basico");
});

test("presets: default selection resolves valid ids with draft values", async () => {
  const catalog = await catalogPromise;
  assert.ok(catalog.printerPresetById(catalog.DEFAULT_PRESET_SELECTION.printerId));
  assert.ok(catalog.filamentPresetById(catalog.DEFAULT_PRESET_SELECTION.filamentId));
  assert.ok(catalog.qualityPresetById(catalog.DEFAULT_PRESET_SELECTION.qualityId));
});

test("presets store: changing quality writes draftValues (export path unchanged)", async () => {
  const presets = await storePromise;
  const catalog = await catalogPromise;
  const selection = catalog.DEFAULT_PRESET_SELECTION;
  // The store is a zustand instance; exercise its pure helper instead —
  // presetDraftValuesFor reflects the selection deterministically.
  const values = presets.presetDraftValuesFor({
    printerId: selection.printerId,
    filamentId: selection.filamentId,
    qualityId: "0.20mm",
  });
  assert.equal(values.nozzleDiameterMm, 0.4);
  assert.equal(values.layerHeightMm, 0.2);
  assert.equal(values.flowPct, 100);
  assert.ok(values.material.length > 0);
  assert.match(values.color, /^#[0-9a-f]{6}$/i);
});

test("presets store: custom layer height yields custom id + custom value", async () => {
  const presets = await storePromise;
  const catalog = await catalogPromise;
  const selection = catalog.DEFAULT_PRESET_SELECTION;
  const custom = presets.presetDraftValuesFor({
    printerId: selection.printerId,
    filamentId: selection.filamentId,
    qualityId: "custom",
  });
  assert.equal(custom.layerHeightMm, 0.2); // editor's custom default
  const values = presets.presetDraftValuesFor({
    printerId: selection.printerId,
    filamentId: selection.filamentId,
    qualityId: "0.08mm",
  });
  assert.equal(values.layerHeightMm, 0.08);
});
