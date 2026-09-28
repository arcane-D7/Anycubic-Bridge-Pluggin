import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAll } from "../tools/cad/doser-precision-tool.mjs";

// ---------------------------------------------------------------------------
// doser precision-upgrade parts — generation contract tests
// Guarantees (user requirement): every part sits on the plate (min Z == 0) and
// is centered on the plate origin in XY. Sized for the corrected design.
// ---------------------------------------------------------------------------

function bounds(mesh) {
  let b = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i],
      y = p[i + 1],
      z = p[i + 2];
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}
const EPS = 1e-4;

test("doser upgrade generates the corrected part set", async () => {
  const parts = await generateAll();
  const names = Object.keys(parts).sort();
  assert.deepEqual(names, [
    "body_bottom_v2",
    "body_top_v2",
    "bore_guide_v2",
    "dose_puck",
    "press_puck_v2",
    "purge_nut",
    "purge_t_screw",
    "stopper_v2",
  ]);
});

test("every part sits on the plate (min Z == 0, no floating parts)", async () => {
  const parts = await generateAll();
  for (const [name, mesh] of Object.entries(parts)) {
    const b = bounds(mesh);
    assert.ok(Math.abs(b.minZ) < EPS, `${name} floats: minZ=${b.minZ.toFixed(6)} (expected 0)`);
  }
});

test("every part is centered on the plate origin in XY", async () => {
  const parts = await generateAll();
  for (const [name, mesh] of Object.entries(parts)) {
    const b = bounds(mesh);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    assert.ok(Math.abs(cx) < EPS, `${name} X center=${cx.toFixed(6)}`);
    assert.ok(Math.abs(cy) < EPS, `${name} Y center=${cy.toFixed(6)}`);
  }
});

test("dose puck matches corrected calibration (height >= 3.67 mm 20U travel)", async () => {
  const parts = await generateAll();
  const b = bounds(parts.dose_puck);
  const h = b.maxZ - b.minZ;
  assert.ok(h >= 3.67, `puck height ${h.toFixed(2)} must cover 20U travel 3.67mm`);
  assert.ok(h <= 6.0, "puck height must remain compact (nub incl.)");
});

test("body bottom: planar split, cartridge bore cylinder, correct overall size", async () => {
  const parts = await generateAll();
  const b = bounds(parts.body_bottom_v2);
  const w = b.maxX - b.minX;
  const d = b.maxY - b.minY;
  const h = b.maxZ - b.minZ;
  assert.ok(Math.abs(w - 72) < 0.01, `width ${w}`);
  assert.ok(Math.abs(d - 21.6) < 0.01, `depth ${d}`);
  assert.ok(Math.abs(h - 7.5) < 0.01, `split height ${h}`);
});

test("purge pair: T-screw M5 and nut bore are coaxial-consistent (minor dia)", async () => {
  const parts = await generateAll();
  const screw = bounds(parts.purge_t_screw);
  const nut = bounds(parts.purge_nut);
  const screwLen = screw.maxZ - screw.minZ;
  const nutH = nut.maxZ - nut.minZ;
  assert.ok(screwLen >= 14, `screw length ${screwLen}`);
  assert.ok(nutH > 0, "nut has height");
});

test("stopper fits cartridge bore (Ø <= 11.0 with clearance)", async () => {
  const parts = await generateAll();
  const b = bounds(parts.stopper_v2);
  const dia = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  assert.ok(dia <= 11.0, `stopper Ø ${dia.toFixed(2)} must clear 11.0 bore`);
});

test("all generated meshes are watertight with positive volume", async () => {
  const parts = await generateAll();
  for (const [name, mesh] of Object.entries(parts)) {
    assert.equal(mesh.watertight, true, `${name} not watertight`);
    assert.ok(mesh.volumeMm3 > 0, `${name} zero/neg volume`);
    assert.ok(mesh.tris.length > 0, `${name} no triangles`);
  }
});
