import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.4-004 arrange core — `state/arrange-core.ts` headless tests.
 *
 * AC-1: Arrange produces a deterministic layout via the server tool; objects
 *       re-committed (the bridge lane re-commits transforms; here we assert
 *       the pure layout is deterministic, inside the plate, gap-respecting
 *       and block-centered).
 * AC-2: Overflow triggers a collision/overflow toast (the lane returns
 *       warnings for oversized objects | block); per-object place-on-plate
 *       centers X/Y + drops minZ to 0.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "arrange-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

/** Snapshot with bounds in mm + optional transform (mesh offset semantics). */
function obj(name, opts = {}) {
  const min = opts.min ?? [-10, -10, 0];
  const max = opts.max ?? [10, 10, 20];
  return {
    name,
    bounds: { min, max },
    transform: opts.transform,
  };
}

test("arrange-core: place-on-plate centers X and sits Y (minY=0) on the plate", async () => {
  const core = await corePromise;
  // Mesh bounds -30..10 (center -10), minY -5 (buries 5 mm if y=0), minZ -6.
  const o = obj("part", { min: [-30, -5, -6], max: [10, 15, 4] });
  const t = core.centerOnPlateTransform(o);
  assert.equal(t.x, 10); // -cx * 1 = -(-10) = 10
  assert.equal(t.y, 5); // -minY = -(-5) = 5 → world bottom = 5 + (-5) = 0
  assert.equal(t.z, 1); // -cz = -(-1) = 1 → world center Z = 1 + (-1) = 0
});

test("arrange-core: place-on-plate respects scale", async () => {
  const core = await corePromise;
  const o = obj("part", {
    min: [-10, -10, 0],
    max: [10, 10, 10],
    transform: { x: 40, y: 20, z: 4, sx: 2, sy: 3, sz: 4, rx: 0, ry: 0, rz: 0 },
  });
  const t = core.centerOnPlateTransform(o);
  assert.equal(t.x, 0); // center 0 * 2 → offset 0
  assert.equal(t.y, 30); // -minY * sy = -(-10)*3 = 30 → world bottom 30 + (-10)*3 = 0
  assert.equal(t.z, -20); // -cz * sz = -(5)*4 = -20 → world center Z = 0
  assert.equal(t.sx, 2);
  assert.equal(t.sy, 3);
  assert.equal(t.sz, 4);
  // rotation preserved
  assert.equal(t.rx, 0);
});

test("arrange-core: deterministic layout packs all objects inside the plate", async () => {
  const core = await corePromise;
  const objects = [obj("a"), obj("b"), obj("c"), obj("d")];
  const r1 = core.arrangeTransforms(objects, { plateW: 220, plateD: 220, gap: 2 });
  const r2 = core.arrangeTransforms(objects, { plateW: 220, plateD: 220, gap: 2 });
  // Deterministic across runs
  assert.deepEqual(r1.placed, r2.placed);
  assert.equal(r1.warnings.length, 0);
  assert.equal(r1.placed.length, 4);
  // All placements within plate footprint (-110..110)
  for (const p of r1.placed) {
    assert.ok(p.x - p.w / 2 >= -110 - 1e-6, `${p.name} left edge`);
    assert.ok(p.x + p.w / 2 <= 110 + 1e-6, `${p.name} right edge`);
    assert.ok(p.z - p.h / 2 >= -110 - 1e-6, `${p.name} front edge`);
    assert.ok(p.z + p.h / 2 <= 110 + 1e-6, `${p.name} back edge`);
  }
});

test("arrange-core: arrange preserves mesh-offset semantics (X = grid - center)", async () => {
  const core = await corePromise;
  // Asymmetric mesh: center at (5, -3) in local XY — the returned transform
  // must place the WORLD center on the grid point.
  const objects = [obj("asym", { min: [0, -8, 0], max: [10, 2, 10] })];
  const { transforms, placed } = core.arrangeTransforms(objects, { center: false });
  const p = placed[0];
  assert.ok(p); // placed at x = w/2 (+gap unless next shelf)
  const t = transforms.get("asym");
  assert.ok(t);
  // world center X = t.x + 5 must equal p.x
  assert.ok(Math.abs(t.x + 5 - p.x) < 1e-6);
  // arrange packs along X/Z (the plate plane) — object stays flat on Y...
  // world center Z = t.z + 5 (bounds center in local Z) must equal p.z
  assert.ok(Math.abs(t.z + 5 - p.z) < 1e-6);
  // ...and its world minY = t.y + (-8) = 0 → rests on the plate top (Y=0).
  assert.ok(Math.abs(t.y - 8) < 1e-6);
});

test("arrange-core: oversized object emits overflow warning and stays placed", async () => {
  const core = await corePromise;
  const big = obj("big", { min: [-200, -200, 0], max: [200, 200, 50] });
  const r = core.arrangeTransforms([big], { plateW: 220, plateD: 220, center: false });
  assert.ok(
    r.warnings.some((w) => w.includes("does not fit")),
    r.warnings.join(" | "),
  );
  // still placed (on-row fallback)
  assert.equal(r.placed.length, 1);
  assert.ok(r.transforms.has("big"));
});

test("arrange-core: degenerate footprint skipped with warning", async () => {
  const core = await corePromise;
  const flat = obj("flat", { min: [0, 0, 0], max: [0, 10, 10] });
  const r = core.arrangeTransforms([flat], { plateW: 220, plateD: 220, center: false });
  assert.ok(r.warnings.some((w) => w.includes("skipped")));
  assert.equal(r.placed.length, 0);
  assert.equal(r.transforms.size, 0);
});

test("arrange-core: block centered on origin when center:true (default)", async () => {
  const core = await corePromise;
  const objects = [obj("a"), obj("b")];
  const r = core.arrangeTransforms(objects, { center: true });
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of r.placed) {
    minX = Math.min(minX, p.x - p.w / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
    minZ = Math.min(minZ, p.z - p.h / 2);
    maxZ = Math.max(maxZ, p.z + p.h / 2);
  }
  assert.ok(Math.abs((minX + maxX) / 2) < 1e-6, "block centered on X");
  assert.ok(Math.abs((minZ + maxZ) / 2) < 1e-6, "block centered on Z");
});

test("arrange-core: empty object list yields empty result without warnings", async () => {
  const core = await corePromise;
  const r = core.arrangeTransforms([], { plateW: 100, plateD: 100 });
  assert.equal(r.placed.length, 0);
  assert.equal(r.transforms.size, 0);
  assert.equal(r.warnings.length, 0);
});
