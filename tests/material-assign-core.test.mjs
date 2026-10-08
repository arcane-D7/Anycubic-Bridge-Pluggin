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

test("material assign: loaded PLA does not recolor an explicitly assigned PETG object", async () => {
  const { resolveFilamentColor } = await loadCore();
  const boxes = [
    box({
      loadedSlotIndex: 0,
      slots: [slot({ index: 0, material: "PLA", color: "#ff3366" })],
    }),
  ];
  const res = resolveFilamentColor({
    boxes,
    filamentId: "catalog-petg",
    materialLabel: "PETG",
    presets: PRESETS,
  });
  assert.equal(res.source, "preset");
  assert.equal(res.color, "#8cc63f");
  assert.equal(res.material, "PETG");
});

test("material assign: two same-polymer project assignments keep distinct preset colors", async () => {
  const { resolveFilamentColor } = await loadCore();
  const boxes = [
    box({
      slots: [
        slot({ index: 0, material: "PLA", color: "#ff3366" }),
        slot({ index: 1, material: "PLA", color: "#00ff00" }),
      ],
    }),
  ];
  const first = resolveFilamentColor({
    boxes,
    filamentId: "project-pla-blue",
    materialLabel: "PLA",
    presets: [{ id: "project-pla-blue", material: "PLA", color: "#4fa8dc" }],
  });
  const second = resolveFilamentColor({
    boxes,
    filamentId: "project-pla-green",
    materialLabel: "PLA",
    presets: [{ id: "project-pla-green", material: "PLA", color: "#00aa55" }],
  });
  assert.equal(first.color, "#4fa8dc");
  assert.equal(second.color, "#00aa55");
  assert.equal(first.source, "preset");
  assert.equal(second.source, "preset");
});

test("material assign: unknown explicit project material stays neutral instead of borrowing another PLA preset", async () => {
  const { NEUTRAL_FILAMENT_HEX, resolveFilamentColor } = await loadCore();
  const res = resolveFilamentColor({
    boxes: [],
    filamentId: "project-pla-violet",
    materialLabel: "PLA",
    presets: PRESETS,
  });
  assert.equal(res.source, "neutral");
  assert.equal(res.color, NEUTRAL_FILAMENT_HEX);
});

test("material assign: stale or offline binding remains diagnostic and uses project color", async () => {
  const { resolveFilamentColor } = await loadCore();
  const binding = {
    printerId: "printer-a",
    toolId: "tool-0",
    boxId: 0,
    slotIndex: 0,
    revision: 1,
  };
  const boxes = [box({ slots: [slot({ material: "PLA", color: "#ff3366" })] })];
  const args = {
    boxes,
    filamentId: "catalog-pla",
    materialLabel: "PLA",
    presets: PRESETS,
    binding,
    printerId: "printer-a",
  };
  const stale = resolveFilamentColor({ ...args, snapshotStatus: "stale" });
  const offline = resolveFilamentColor({ ...args, snapshotStatus: "offline" });
  assert.equal(stale.color, "#4fa8dc");
  assert.equal(stale.bindingStatus, "stale");
  assert.equal(offline.color, "#4fa8dc");
  assert.equal(offline.bindingStatus, "offline");
});

test("material assign: shared surface projection keeps object identity and binding diagnostic", async () => {
  const { materialBindingDiagnostics } = await loadCore();
  const rows = materialBindingDiagnostics({
    objects: [
      {
        name: "part",
        objectId: "stable-part",
        vertices: 3,
        triangles: 1,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        sizeMm: [1, 1, 1],
        volumeMm3: 1,
        surfaceAreaMm2: 1,
        watertight: true,
        visible: true,
        locked: false,
        filamentId: "catalog-petg",
        materialBinding: {
          printerId: "printer-a",
          toolId: "tool-0",
          boxId: 0,
          slotIndex: 0,
          revision: 1,
        },
      },
    ],
    globalFilamentId: "catalog-pla",
    boxes: [],
    printerId: "printer-a",
    snapshotStatus: "offline",
    presets: PRESETS,
  });
  assert.equal(rows[0].objectId, "stable-part");
  assert.equal(rows[0].match.color, "#8cc63f");
  assert.equal(rows[0].match.bindingStatus, "offline");
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
