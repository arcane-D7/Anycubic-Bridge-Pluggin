import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(ROOT, "apps/editor/src/state/live-overlay-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const VOLUME = { widthMm: 220, depthMm: 220, heightMm: 260 };

function slot(overrides) {
  return {
    index: overrides?.index ?? 0,
    state: overrides?.state ?? "identified",
    material: overrides?.material ?? null,
    sku: null,
    color: overrides?.color ?? null,
    remainingPct: 80,
    editOrigin: "manual",
    stateCode: null,
    recommendedTempsC: { nozzle: null, bed: null },
  };
}

function box(overrides) {
  return {
    index: overrides?.index ?? 0,
    modelId: null,
    slots: overrides?.slots ?? [],
    ambientTempC: null,
    humidityPct: null,
    drying: { active: false, targetTempC: null, remainingSeconds: null },
    autoFeed: false,
    loadedSlotIndex: overrides?.loadedSlotIndex ?? null,
  };
}

test("live overlay: toolhead world maps motion with Z mirror + clamp", async () => {
  const { toolheadWorld, LIVE_UPDATE_MS } = await loadCore();
  // motion (0, 0, 0) → plate center, at build surface.
  const center = toolheadWorld({ xMm: 0, yMm: 0, zMm: 0 }, VOLUME);
  assert.ok(center.x === 0);
  assert.ok(center.y === 0);
  assert.ok(center.z === 0); // clamp may yield -0; SameValueZero treats -0 === 0

  // motion z positive (toward back) maps to world -z; clamped to half-depth.
  const back = toolheadWorld({ xMm: 500, yMm: 40, zMm: 500 }, VOLUME);
  assert.ok(back.x === 110);
  assert.ok(back.y === 40);
  assert.ok(back.z === -110);

  assert.equal(LIVE_UPDATE_MS, 250); // AC: ≤4 Hz
});

test("live overlay: toolhead null when motion/volume incomplete", async () => {
  const { toolheadWorld } = await loadCore();
  assert.equal(toolheadWorld(null, VOLUME), null);
  assert.equal(toolheadWorld({ xMm: 1, yMm: 2, zMm: 3 }, null), null);
  assert.equal(toolheadWorld({ xMm: null, yMm: 2, zMm: 3 }, VOLUME), null);
  assert.equal(
    toolheadWorld({ xMm: 1, yMm: 2, zMm: 3 }, { widthMm: 0, depthMm: 220, heightMm: 260 }),
    null,
  );
});

test("live overlay: nozzle color from loaded slot, neutral otherwise", async () => {
  const { nozzleColor, NOZZLE_NEUTRAL_HEX } = await loadCore();
  // loaded slot 1 has a color → wins.
  const withLoaded = [
    box({
      loadedSlotIndex: 1,
      slots: [slot({ index: 0, color: "#111111" }), slot({ index: 1, color: "#ffdd00" })],
    }),
  ];
  assert.equal(nozzleColor(withLoaded), "#ffdd00");

  // loaded slot empty → neutral.
  const emptyLoaded = [box({ loadedSlotIndex: 0, slots: [slot({ index: 0, state: "empty" })] })];
  assert.equal(nozzleColor(emptyLoaded), NOZZLE_NEUTRAL_HEX);

  // no boxes → neutral.
  assert.equal(nozzleColor([]), NOZZLE_NEUTRAL_HEX);
});

test("live overlay: throttle ≤ 4 Hz", async () => {
  const { shouldUpdateLive, LIVE_UPDATE_MS } = await loadCore();
  assert.equal(shouldUpdateLive(0, LIVE_UPDATE_MS - 1), false);
  assert.equal(shouldUpdateLive(0, LIVE_UPDATE_MS), true);
  assert.equal(shouldUpdateLive(100, LIVE_UPDATE_MS + 150), true);
});

test("live overlay: layer bar fraction from layers then pct", async () => {
  const { layerBarFraction } = await loadCore();
  // 2/120 → 3/120 = 0.025
  const fromLayers = layerBarFraction({ currLayer: 2, totalLayers: 120, progressPct: 30 });
  assert.ok(Math.abs(fromLayers - 3 / 120) < 1e-6);
  // pct fallback when layers missing.
  assert.ok(
    Math.abs(
      (layerBarFraction({ currLayer: null, totalLayers: null, progressPct: 50 }) ?? 0) - 0.5,
    ) < 1e-9,
  );
  // clamp.
  assert.equal(layerBarFraction({ currLayer: 999, totalLayers: 10, progressPct: 100 }), 1);
  assert.equal(layerBarFraction(null), null);
});

test("live overlay: spray pct/layer text", async () => {
  const { sprayPct, sprayLayerText } = await loadCore();
  const progress = { currLayer: 11, totalLayers: 120, progressPct: 9 };
  assert.equal(sprayPct(progress), 9);
  assert.equal(sprayLayerText(progress), "12/120");
  assert.equal(sprayLayerText({ currLayer: null, totalLayers: null, progressPct: null }), null);
});
