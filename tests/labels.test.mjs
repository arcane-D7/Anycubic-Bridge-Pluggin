import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

/**
 * S9.8-002 (G45) — viewport object label chips: headless core.
 *
 * The chips are a 2D overlay OUTSIDE the canvas; all the deterministic math
 * lives in `viewport/labels-core.ts` (pure, three-free) so it runs under
 * `node --test` without a DOM or three runtime:
 *
 *   - statusOf: watertight / non-watertight / locked precedence.
 *   - chipLabel: "name · note".
 *   - ndcToViewport: NDC (-1..1) → CSS pixels with the y-flip.
 *   - clampChip: keeps the chip anchored inside the overlay (margin).
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "viewport", "labels-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("statusOf: watertight / non-watertight / locked precedence", async () => {
  const core = await corePromise;
  assert.equal(core.statusOf(true, false), "watertight");
  assert.equal(core.statusOf(false, false), "non-watertight");
  // Locked wins over watertight flags.
  assert.equal(core.statusOf(false, true), "locked");
  assert.equal(core.statusOf(true, true), "locked");
});

test("chipLabel: name + status note (mono secondary)", async () => {
  const core = await corePromise;
  assert.equal(core.chipLabel("Marble", "watertight"), "Marble · watertight");
  assert.equal(core.chipLabel("Cone", "non-watertight"), "Cone · needs repair");
  assert.equal(core.chipLabel("LockedClip", "locked"), "LockedClip · locked");
});

test("ndcToViewport: y-flip and scale", async () => {
  const core = await corePromise;
  // NDC center = exact middle of the overlay.
  const c = core.ndcToViewport(0, 0, 800, 600);
  assert.deepEqual(c, { x: 400, y: 300 });
  // NDC top-left (-1, +1) = CSS top-left (0, 0).
  const tl = core.ndcToViewport(-1, 1, 800, 600);
  assert.deepEqual(tl, { x: 0, y: 0 });
  // NDC bottom-right (+1, -1) = CSS bottom-right (800, 600).
  const br = core.ndcToViewport(1, -1, 800, 600);
  assert.deepEqual(br, { x: 800, y: 600 });
});

test("clampChip: keeps the anchor inside the overlay with margin", async () => {
  const core = await corePromise;
  const vp = { width: 800, height: 600 };
  // Already inside — unchanged.
  assert.deepEqual(core.clampChip(400, 300, vp, 4), { x: 400, y: 300 });
  // Overshoot right/bottom -> clamped to margin edge.
  const near = core.clampChip(800, 600, vp, 4);
  assert.equal(near.x, 800 - 4);
  assert.equal(near.y, 600 - 4);
  // Negative -> clamped to margin.
  const neg = core.clampChip(-12, -3, vp, 4);
  assert.equal(neg.x, 4);
  assert.equal(neg.y, 4);
});

test("clampChip: zero/negative margin and tiny viewport never go negative", async () => {
  const core = await corePromise;
  // margin 0 -> clamp to edges exactly.
  assert.deepEqual(core.clampChip(999, -50, { width: 100, height: 100 }, 0), {
    x: 100,
    y: 0,
  });
  // Negative margin is treated as 0.
  assert.deepEqual(core.clampChip(-10, -10, { width: 50, height: 50 }, -2), { x: 0, y: 0 });
});

test("ndcToViewport + clampChip compose: chip stays visible near edges", async () => {
  const core = await corePromise;
  const vp = { width: 400, height: 300 };
  // NDC point near bottom-right corner.
  const px = core.ndcToViewport(0.96, -0.96, vp.width, vp.height);
  const clamped = core.clampChip(px.x, px.y, vp, 8);
  assert.ok(clamped.x <= vp.width - 8 + 1e-6);
  assert.ok(clamped.y <= vp.height - 8 + 1e-6);
  assert.ok(clamped.x >= 8 - 1e-6);
  assert.ok(clamped.y >= 8 - 1e-6);
});
