// S8-004 unit tests for the op-IR + independent emitted-program validator.
// Pure functions — no I/O, no slicer, no Rust needed.

import test from "node:test";
import assert from "node:assert/strict";

import {
  IR_VERSION,
  DIALECT_WHITELIST,
  sliceCacheKey,
  toIrSegment,
  toIrDocument,
  validateIr,
  journalRejection,
} from "../scripts/slice-ir.mjs";

const CUBE_META = {
  version: "1.0",
  dialect: "anycubic",
  mode: "standard",
  profile_fingerprint: "f0a10c6050c985e3",
  build_volume: { x: 220, y: 220, z: 250 },
  layers: [
    {
      index: 0,
      z: 0.2,
      segments: [
        {
          from: { x: 0.225, y: 0.225, z: 0.2 },
          to: { x: 19.775, y: 0.225, z: 0.2 },
          volume_mm3: 1.7595,
          delta_e_mm: 0.7315,
          q_mm3_s: 2.7,
          kind: "Wall",
        },
      ],
    },
  ],
};

// Filament cross-section: 1.75mm dia.
const A_FIL = Math.PI * (1.75 / 2) ** 2;

test("sliceCacheKey includes the slicing_mode (mode switch invalidates)", () => {
  const standard = sliceCacheKey("standard", "fp-abc", "in-1");
  const nonplanar = sliceCacheKey("nonplanar", "fp-abc", "in-1");
  assert.notEqual(standard, nonplanar, "mode must be part of the key");
  assert.ok(standard.startsWith("slice-mode:standard|"));
  assert.ok(nonplanar.startsWith("slice-mode:nonplanar|"));
  assert.throws(() => sliceCacheKey("weird", "fp", "in"), /invalid mode/);
});

test("toIrSegment projects pose/orientation/bead/flow/cooling/speed/provenance", () => {
  const seg = {
    from: { x: 0, y: 0, z: 0.2 },
    to: { x: 10, y: 0, z: 0.2 },
    volume_mm3: 0.9,
    delta_e_mm: 0.374,
    q_mm3_s: 2.7,
    kind: "Wall",
  };
  const ir = toIrSegment(seg, 3, "standard", {
    speed_mm_s: 40,
    cooling_fan_pct: 80,
  });
  assert.equal(ir.mode, "standard");
  assert.equal(ir.kind, "WALL");
  assert.equal(ir.layer, 3);
  assert.deepEqual(ir.pose.from, { x: 0, y: 0, z: 0.2 });
  // orientation = unit vector along x
  assert.ok(Math.abs(ir.orientation[0] - 1) < 1e-9);
  // A_bead = volume / length = 0.9 / 10
  assert.ok(Math.abs(ir.bead.area_mm2 - 0.09) < 1e-12);
  assert.equal(ir.flow.q_mm3_s, 2.7);
  assert.equal(ir.flow.e_mm, 0.374);
  assert.equal(ir.cooling.fan_pct, 80);
  assert.equal(ir.speed.mm_s, 40);
  assert.equal(ir.collision_free, true);
  assert.equal(ir.provenance.generator, "planar-core@1.0");
});

test("toIrDocument projects a mode-tagged IR document v1", () => {
  const ir = toIrDocument(CUBE_META);
  assert.equal(ir.version, IR_VERSION);
  assert.equal(ir.mode, "standard");
  assert.equal(ir.dialect, "anycubic");
  assert.equal(ir.segments.length, 1);
  assert.equal(ir.segments[0].mode, "standard");
  assert.equal(ir.segments[0].layer, 0);
});

test("independent validator: clean standard IR passes", () => {
  const ir = toIrDocument(CUBE_META);
  const { pass, errors } = validateIr(ir);
  assert.ok(pass, `expected pass, got ${JSON.stringify(errors)}`);
  assert.equal(errors.length, 0);
});

test("independent validator: Z-ramp in standard is REJECTED (seeded bug)", () => {
  // The generator emits a Z-ramp (dz=1) but tags it `standard` — the bug.
  const ir = toIrDocument(CUBE_META);
  ir.segments[0] = {
    ...ir.segments[0],
    pose: {
      from: { x: 0, y: 0, z: 0.2 },
      to: { x: 10, y: 0, z: 1.2 }, // Z varies!
    },
  };
  const { pass, errors } = validateIr(ir);
  assert.equal(pass, false);
  const zRamp = errors.find((e) => e.code === "Z_RAMP_IN_STANDARD");
  assert.ok(zRamp, `must reject Z-ramp, got ${JSON.stringify(errors)}`);
  assert.match(zRamp.reason, /Z-ramp.*standard/);
  assert.ok(zRamp.segmentId.startsWith("WALL#0#"), "segment id must be present");
  assert.equal(zRamp.layer, 0);
});

test("independent validator: extrusion conservation violation is caught", () => {
  const ir = toIrDocument(CUBE_META);
  // Corrupt E so conservation breaks (bead volume 1.7595 vs E·A_fil).
  ir.segments[0].flow.e_mm = null; // force eVol = 0
  // re-set to an inconsistent value:
  ir.segments[0].flow.e_mm = ir.segments[0].bead.area_mm2 * 10; // len=19.55 → way off
  const { pass, errors } = validateIr(ir);
  assert.equal(pass, false);
  assert.ok(errors.some((e) => e.code === "EXTRUSION_CONSERVATION"));
});

test("independent validator: part extents beyond build volume rejected", () => {
  // Part-local coordinates are fine (placement is S8-005's job), but the
  // part EXTENTS must fit inside the declared build volume.
  const ir = toIrDocument(CUBE_META);
  // Stretch a segment so the part bbox exceeds 220³.
  ir.segments[0].pose.to.x = 500;
  const { pass, errors } = validateIr(ir);
  assert.equal(pass, false);
  assert.ok(errors.some((e) => e.code === "OUT_OF_VOLUME"));
});

test("independent validator: off-origin part still fits (placement-agnostic)", () => {
  const ir = toIrDocument(CUBE_META);
  // shift to the plate corner — still within volume extents
  ir.segments.forEach((s) => {
    s.pose.from.x += 100;
    s.pose.to.x += 100;
  });
  const { pass, errors } = validateIr(ir);
  assert.ok(pass, `placement-agnostic part must pass: ${JSON.stringify(errors)}`);
});

test("independent validator: unsupported dialect rejected with whitelist", () => {
  const ir = toIrDocument(CUBE_META);
  ir.dialect = "prusa"; // not in DIALECT_WHITELIST
  const { pass, errors } = validateIr(ir);
  assert.equal(pass, false);
  const d = errors.find((e) => e.code === "DIALECT");
  assert.ok(d);
  assert.ok(errors.some((e) => e.reason.includes("prusa")));
  assert.deepEqual(DIALECT_WHITELIST, ["anycubic", "cura"]);
});

test("independent validator: nonplanar segment with no Z is a mode-consistency warning", () => {
  const ir = toIrDocument(CUBE_META);
  // layer 1 nonplanar with no Z change → layer-jump mis-tag warning
  ir.segments[0] = { ...ir.segments[0], layer: 1, mode: "nonplanar" };
  const { pass, warnings } = validateIr(ir);
  assert.ok(pass, "nonplanar layer jump is a warning, not a fail");
  assert.ok(warnings.some((w) => w.code === "NONPLANAR_NO_Z"));
});

test("independent validator: continuity break inside a chain is caught", () => {
  const ir = toIrDocument(CUBE_META);
  // A second segment that breaks the chain mid-wall-run (same chain_id but a
  // >0.2mm gap from the previous segment's end).
  const broken = toIrSegment(
    {
      from: { x: 50, y: 50, z: 0.2 },
      to: { x: 60, y: 50, z: 0.2 },
      volume_mm3: 0.9,
      delta_e_mm: 0.374,
      q_mm3_s: 2.7,
      kind: "Wall",
    },
    0,
    "standard",
  );
  // Claim it belongs to the SAME chain as the engine's wall run → the
  // 50mm gap from the chain end (19.775,0.225) is a defect, not a travel.
  broken.chain_id = ir.segments[ir.segments.length - 1].chain_id;
  ir.segments.push(broken);
  const { pass, errors } = validateIr(ir);
  assert.equal(pass, false);
  assert.ok(errors.some((e) => e.code === "CONTINUITY"));
});

test("IR document is deterministic: same input → byte-identical output", () => {
  const a = JSON.stringify(toIrDocument(CUBE_META));
  const b = JSON.stringify(toIrDocument(JSON.parse(JSON.stringify(CUBE_META))));
  assert.equal(a, b, "identical inputs must produce identical IR bytes");
});

test("validator failures surface as journaled rejections, never silent", () => {
  const ir = toIrDocument(CUBE_META);
  ir.segments[0] = {
    ...ir.segments[0],
    pose: { from: { x: 0, y: 0, z: 0.2 }, to: { x: 10, y: 0, z: 1.2 } }, // Z-ramp
  };
  const { pass, errors } = validateIr(ir);
  assert.equal(pass, false);
  const zRampErr = errors.find((e) => e.code === "Z_RAMP_IN_STANDARD");
  assert.ok(zRampErr, `expected a Z-ramp rejection, got ${JSON.stringify(errors)}`);
  const journal = journalRejection({
    mode: "standard",
    dialect: "anycubic",
    errors,
    source: "slice-json@eng",
    date: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(journal.kind, "ir-validation");
  assert.equal(journal.mode, "standard");
  assert.ok(journal.errorCount >= 1);
  assert.ok(journal.errors.some((e) => e.code === "Z_RAMP_IN_STANDARD"));
  assert.equal(journal.resolution, null); // never silently resolved
  assert.throws(
    () => journalRejection({ mode: "standard", dialect: "x", errors: [] }),
    /at least one/,
  );
});
