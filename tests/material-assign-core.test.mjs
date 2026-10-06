import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(ROOT, "apps/editor/src/state/material-assign-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

/** Build an AceSlot fixture (agnostic fake — never real printer values). */
function slot(overrides) {
  return {
    index: overrides.index ?? 0,
    state: overrides.state ?? "identified",
    material: overrides.material ?? null,
    sku: null,
    color: overrides.color ?? null,
    remainingPct: overrides.remainingPct ?? 80,
    editOrigin: "manual",
    stateCode: null,
    recommendedTempsC: { nozzle: null, bed: null },
  };
}

function box(overrides) {
  return {
    index: overrides.index ?? 0,
    modelId: null,
    slots: overrides.slots ?? [],
    ambientTempC: null,
    humidityPct: null,
    drying: { active: false, targetTempC: null, remainingSeconds: null },
    autoFeed: false,
    loadedSlotIndex: overrides.loadedSlotIndex ?? null,
  };
}

const PRESETS = [
  { id: "catalog-pla", material: "PLA", color: "#4fa8dc" },
  { id: "catalog-petg", material: "PETG", color: "#8cc63f" },
];

test("material assign: neutral placeholder when nothing resolves", async () => {
  const { NEUTRAL_FILAMENT_HEX, resolveFilamentColor } = await loadCore();
  const res = resolveFilamentColor({
    boxes: [],
    filamentId: undefined,
    materialLabel: undefined,
    presets: PRESETS,
  });
  assert.equal(res.source, "neutral");
  assert.equal(res.color, NEUTRAL_FILAMENT_HEX);
  assert.equal(res.material, null);
});

test("material assign: preset fallback by filament id (no ACE)", async () => {
  const { resolveFilamentColor } = await loadCore();
  const res = resolveFilamentColor({
    boxes: [],
    filamentId: "catalog-petg",
    materialLabel: undefined,
    presets: PRESETS,
  });
  assert.equal(res.source, "preset");
  assert.equal(res.color, "#8cc63f");
  assert.equal(res.material, "PETG");
});

test("material assign: preset fallback by material label (no ACE)", async () => {
  const { resolveFilamentColor } = await loadCore();
  const res = resolveFilamentColor({
    boxes: [],
    filamentId: undefined,
    materialLabel: "pla",
    presets: PRESETS,
  });
  assert.equal(res.source, "preset");
  assert.equal(res.color, "#4fa8dc");
});

test("material assign: ACE slot wins over preset (same material)", async () => {
  const { resolveFilamentColor } = await loadCore();
  const boxes = [
    box({
      loadedSlotIndex: 0,
      slots: [slot({ index: 0, material: "PLA", color: "#ff3366" })],
    }),
  ];
  const res = resolveFilamentColor({
    boxes,
    filamentId: "catalog-pla",
    materialLabel: undefined,
    presets: PRESETS,
  });
  assert.equal(res.source, "ace");
  assert.equal(res.color, "#ff3366");
  assert.equal(res.material, "PLA");
});

test("material assign: ACE loaded slot fallback when material unknown", async () => {
  const { resolveFilamentColor } = await loadCore();
  const boxes = [
    box({
      loadedSlotIndex: 1,
      slots: [
        slot({ index: 0, material: "PLA", color: "#4fa8dc" }),
        slot({ index: 1, material: "ABS", color: "#00ff00" }),
      ],
    }),
  ];
  const res = resolveFilamentColor({
    boxes,
    filamentId: "catalog-pla",
    materialLabel: undefined,
    presets: PRESETS,
  });
  // No exact PLA slot (index 0 is PLA? it is — but loaded is index 1);
  // the mapper falls back to the loaded slot.
  assert.equal(res.source, "ace");
  assert.equal(res.color, "#00ff00");
});

test("material assign: empty/identifying slots never drive color", async () => {
  const { resolveFilamentColor } = await loadCore();
  const boxes = [
    box({
      loadedSlotIndex: 0,
      slots: [slot({ index: 0, state: "empty" }), slot({ index: 1, state: "identifying" })],
    }),
  ];
  const res = resolveFilamentColor({
    boxes,
    filamentId: undefined,
    materialLabel: undefined,
    presets: PRESETS,
  });
  assert.equal(res.source, "neutral");
});

test("material assign: class mapping", async () => {
  const { materialClassFor } = await loadCore();
  assert.equal(materialClassFor({ color: "#fff", source: "preset", material: "PLA" }), "matte");
  assert.equal(materialClassFor({ color: "#fff", source: "preset", material: "PETG" }), "smooth");
  assert.equal(materialClassFor({ color: "#fff", source: "preset", material: "TPU" }), "flex");
  assert.equal(
    materialClassFor({ color: "#fff", source: "preset", material: "MARBLE" }),
    "textured",
  );
  assert.equal(materialClassFor({ color: "#fff", source: "neutral", material: null }), "matte");
});
