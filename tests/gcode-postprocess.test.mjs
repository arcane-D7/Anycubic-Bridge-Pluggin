// S8-005 unit tests for the kinematics-aware postprocessor
// (scripts/gcode-postprocessor.mjs) — pure functions, no I/O, no slicer.

import test from "node:test";
import assert from "node:assert/strict";

import {
  POSTPROCESSOR_VERSION,
  resolveKinematics,
  fkToJointTargets,
  emitLine,
  postprocess,
  validateEmittedProgram,
} from "../scripts/gcode-postprocessor.mjs";

/** §5-style Kobra S1 (cartesian) machine profile. */
const CARTESIAN_PROFILE = {
  id: "prof-cartesian",
  machine_type: "<MACHINE_TYPE>",
  kinematics: "cartesian",
  joints: [
    { id: "X", type: "linear", min: 0, max: 220 },
    { id: "Y", type: "linear", min: 0, max: 220 },
    { id: "Z", type: "linear", min: 0, max: 250 },
  ],
  controller_dialect: {
    fw_family: "anycubic",
    gcode_whitelist: ["G0", "G1", "G92", "M104", "M109", "M114"],
    max_extrude_rate_mm3_s: null,
  },
  build_volume: { x: 220, y: 220, z: 250 },
};

/** §5-style rotary profile (turntable C + linear Z). */
const ROTARY_PROFILE = {
  id: "prof-rotary",
  machine_type: "<MACHINE_TYPE>",
  kinematics: "rotary",
  joints: [
    { id: "C", type: "rotary", min: -360, max: 360, coupling: "turntable" },
    { id: "Z", type: "linear", min: 0, max: 100 },
  ],
  controller_dialect: {
    fw_family: "experimental",
    gcode_whitelist: ["G0", "G1", "G92"],
    max_extrude_rate_mm3_s: null,
  },
  build_volume: { x: 220, y: 220, z: 250 },
};

const IR = {
  version: "1.0",
  mode: "standard",
  dialect: "anycubic",
  profile_fingerprint: "fp-1",
  build_volume: { x: 220, y: 220, z: 250 },
  segments: [
    {
      mode: "standard",
      kind: "WALL",
      layer: 0,
      chain_id: "WALL#0#1",
      pose: {
        from: { x: 10, y: 10, z: 0.2 },
        to: { x: 20, y: 10, z: 0.2 },
      },
      orientation: [1, 0, 0],
      flow: { q_mm3_s: 2.7, e_mm: 0.374 },
    },
    {
      mode: "standard",
      kind: "INFILL",
      layer: 0,
      chain_id: "INFILL#0#2",
      pose: {
        from: { x: 20, y: 10, z: 0.2 },
        to: { x: 20, y: 30, z: 0.2 },
      },
      orientation: [0, 1, 0],
      flow: { q_mm3_s: 2.7, e_mm: 0.9 },
    },
    {
      mode: "standard",
      kind: "TRAVEL",
      layer: 0,
      chain_id: "TRAVEL#0#3",
      pose: {
        from: { x: 20, y: 30, z: 0.2 },
        to: { x: 10, y: 30, z: 1.2 },
      },
      orientation: [0, 0, 1],
      flow: null,
    },
  ],
};

test("resolveKinematics: cartesian default + explicit rotary", () => {
  const cart = resolveKinematics({});
  assert.equal(cart.kinematics, "cartesian");
  assert.deepEqual(cart.joints, []);

  const rot = resolveKinematics(ROTARY_PROFILE);
  assert.equal(rot.kinematics, "rotary");
  assert.ok(rot.joints.some((j) => j.id === "C"));
});

test("resolveKinematics: unknown kinematics FAILS CLOSED (never guessed)", () => {
  assert.throws(
    () => resolveKinematics({ kinematics: "delta" }),
    (e) => e.code === "UNSUPPORTED_KINEMATICS" && /no over-claim/.test(e.message),
  );
  assert.throws(() => resolveKinematics({ kinematics: "robotic" }), /R7\/S4/);
});

test("fkToJointTargets: cartesian FK is identity X/Y/Z", () => {
  const kin = resolveKinematics(CARTESIAN_PROFILE);
  const { from, to } = fkToJointTargets(
    { pose: { from: { x: 1, y: 2, z: 0.2 }, to: { x: 3, y: 4, z: 0.2 } } },
    kin,
  );
  assert.deepEqual(from, { x: 1, y: 2, z: 0.2 });
  assert.deepEqual(to, { x: 3, y: 4, z: 0.2 });
});

test("fkToJointTargets: rotary FK is REJECTED (ROTARY_NOT_IMPLEMENTED)", () => {
  const kin = resolveKinematics(ROTARY_PROFILE);
  assert.throws(
    () =>
      fkToJointTargets(
        {
          pose: {
            from: { x: 10, y: 0, z: 5 },
            to: { x: 0, y: 10, z: 5 },
          },
        },
        kin,
      ),
    (e) => e.code === "ROTARY_NOT_IMPLEMENTED" && /not valid machine kinematics/.test(e.message),
  );
});

test("emitLine: builds ordered gcode with whitelist enforcement", () => {
  const whitelist = ["G1"];
  assert.equal(
    emitLine("G1", { X: 10, Y: 20, Z: 0.2, E: 0.374, F: 30 }, whitelist),
    "G1 X10 Y20 Z0.2 E0.374 F30",
  );
  // A code outside the whitelist → null.
  assert.equal(emitLine("G0", { X: 10 }, whitelist), null);
  assert.equal(emitLine("G1", { X: 1 }, ["G92"]), null);
});

test("postprocess: emits only whitelisted codes + cartesian FK targets", () => {
  const { lines, errors, program } = postprocess(IR, CARTESIAN_PROFILE, {
    feed_mm_s: 40,
    travel_feed_mm_s: 150,
    placement_mm: { x: 0, y: 0, z: 0 },
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(program.kinematics, "cartesian");
  assert.equal(lines.length, 6);
  assert.equal(lines[2], "G0 X10 Y10 Z0.2 F150");
  assert.equal(lines[3], "G1 X20 Y10 Z0.2 E0.374 F40");
  assert.equal(lines[4], "G1 X20 Y30 Z0.2 E0.9 F40");
  assert.equal(lines[5], "G0 X10 Y30 Z1.2 F150");
});

test("postprocess: rotary profile is REJECTED with no usable partial output", () => {
  const rotaryIr = {
    ...IR,
    dialect: "experimental",
    segments: [
      {
        ...IR.segments[0],
        pose: {
          from: { x: 10, y: 0, z: 5 },
          to: { x: 0, y: 10, z: 5 },
        },
      },
    ],
  };
  const { lines, errors, program } = postprocess(rotaryIr, ROTARY_PROFILE);
  assert.deepEqual(lines, []);
  assert.ok(errors.some((e) => e.code === "ROTARY_NOT_IMPLEMENTED"));
  assert.equal(program.kinematics, "rotary");
  assert.equal(program.rejected, true);
  assert.deepEqual(program.lines, []);
});

test("postprocess: segment with G-code outside whitelist FAILS (AC-1)", () => {
  // Whitelist WITHOUT G1 → any extruding move must be rejected.
  const badProfile = {
    ...CARTESIAN_PROFILE,
    controller_dialect: {
      ...CARTESIAN_PROFILE.controller_dialect,
      gcode_whitelist: ["G0", "G92"], // G1 omitted
    },
  };
  const bad = postprocess(IR, badProfile, { placement_mm: { x: 0, y: 0, z: 0 } });
  assert.ok(bad.errors.some((e) => e.code === "GCODE_NOT_WHITELISTED"));
  assert.deepEqual(bad.lines, []);
  assert.equal(bad.program.rejected, true);
  assert.deepEqual(bad.program.lines, []);
});

test("postprocess: missing whitelist fails closed with NO_WHITELIST", () => {
  const { errors, program } = postprocess(
    IR,
    { kinematics: "cartesian", id: "no-wl" },
    {
      placement_mm: { x: 0, y: 0, z: 0 },
    },
  );
  assert.ok(errors.some((e) => e.code === "NO_WHITELIST"));
  assert.equal(program.whitelist, null);
});

test("validateEmittedProgram: valid program passes with its expectedProfile", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } });
  const ok = validateEmittedProgram(good.program, CARTESIAN_PROFILE);
  assert.equal(ok.pass, true, JSON.stringify(ok.errors));
  assert.equal(ok.errors.length, 0);
});

test("validateEmittedProgram: missing expectedProfile is REJECTED (PROFILE_REQUIRED)", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  for (const noProfile of [undefined, null]) {
    const v = validateEmittedProgram(good, noProfile);
    assert.equal(v.pass, false);
    assert.ok(v.errors.some((e) => e.code === "PROFILE_REQUIRED"));
  }
});

test("validateEmittedProgram: invalid expectedProfile is REJECTED (INVALID_PROFILE)", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;

  const noWl = {
    ...CARTESIAN_PROFILE,
    controller_dialect: { ...CARTESIAN_PROFILE.controller_dialect, gcode_whitelist: [] },
  };
  const a = validateEmittedProgram(good, noWl);
  assert.equal(a.pass, false);
  assert.ok(a.errors.some((e) => e.code === "INVALID_PROFILE" && /gcode_whitelist/.test(e.reason)));

  const zeroVolume = { ...CARTESIAN_PROFILE, build_volume: { x: 0, y: 220, z: 250 } };
  const b = validateEmittedProgram(good, zeroVolume);
  assert.equal(b.pass, false);
  assert.ok(b.errors.some((e) => e.code === "INVALID_PROFILE" && /build_volume/.test(e.reason)));

  const badJoints = {
    ...CARTESIAN_PROFILE,
    joints: [{ id: "X", type: "linear", min: 220, max: 0 }],
  };
  const c = validateEmittedProgram(good, badJoints);
  assert.equal(c.pass, false);
  assert.ok(c.errors.some((e) => e.code === "INVALID_PROFILE" && /linear joint/.test(e.reason)));
});

test("validateEmittedProgram: rejected program is REJECTED (PROGRAM_REJECTED)", () => {
  // postprocess without placement_mm → program.rejected === true.
  const rejected = postprocess(IR, CARTESIAN_PROFILE).program;
  assert.equal(rejected.rejected, true);
  const v = validateEmittedProgram(rejected, CARTESIAN_PROFILE);
  assert.equal(v.pass, false);
  assert.ok(v.errors.some((e) => e.code === "PROGRAM_REJECTED"));
});

test("validateEmittedProgram: empty-motion program is REJECTED (EMPTY_MOTION)", () => {
  const v = validateEmittedProgram(
    { lines: ["; postprocess v1.0", "; dialect: anycubic"] },
    CARTESIAN_PROFILE,
  );
  assert.equal(v.pass, false);
  assert.ok(v.errors.some((e) => e.code === "EMPTY_MOTION"));
});

test("validateEmittedProgram: tampered program.whitelist is IGNORED — inserted M106 still rejected", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  // Attacker mutates program.whitelist to bless M106 — the validator derives
  // its whitelist ONLY from expectedProfile, never program.whitelist.
  const tampered = {
    ...good,
    whitelist: [...good.whitelist, "M106"],
    lines: [...good.lines, "M106"],
  };
  const v = validateEmittedProgram(tampered, CARTESIAN_PROFILE);
  assert.equal(v.pass, false);
  assert.ok(v.errors.some((e) => e.code === "GCODE_NOT_WHITELISTED" && e.line === "M106"));
});

test("validateEmittedProgram: whitelisted mode-changing word FAILS CLOSED (GCODE_NOT_SUPPORTED)", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  // G92 IS whitelisted but this generator NEVER emits it — its presence means
  // tampering/unsupported emitter → fail-closed (no general G-code interpreter).
  const tampered = { ...good, lines: [...good.lines, "G92 E0"] };
  const v = validateEmittedProgram(tampered, CARTESIAN_PROFILE);
  assert.equal(v.pass, false);
  assert.ok(v.errors.some((e) => e.code === "GCODE_NOT_SUPPORTED" && e.line === "G92 E0"));
});

test("validateEmittedProgram: tampered G1 X beyond build volume is REJECTED (OUT_OF_VOLUME)", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  const tampered = { ...good, lines: [...good.lines, "G1 X400 Y10 Z0.2 E0.1 F30"] };
  const v = validateEmittedProgram(tampered, CARTESIAN_PROFILE);
  assert.equal(v.pass, false);
  assert.ok(v.errors.some((e) => e.code === "OUT_OF_VOLUME" && /X400|400/.test(e.reason)));
});

test("validateEmittedProgram: endpoint beyond stricter joint limits is REJECTED (JOINT_LIMIT)", () => {
  // Program generated against CARTESIAN_PROFILE (X=20 in volume) but validated
  // against a profile with a tighter X joint — derived limits must reject it.
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  const tight = {
    ...CARTESIAN_PROFILE,
    joints: [
      { id: "X", type: "linear", min: 0, max: 15 },
      { id: "Y", type: "linear", min: 0, max: 220 },
      { id: "Z", type: "linear", min: 0, max: 250 },
    ],
  };
  const v = validateEmittedProgram(good, tight);
  assert.equal(v.pass, false);
  assert.ok(v.errors.some((e) => e.code === "JOINT_LIMIT"));
});

test("validateEmittedProgram: NaN/Infinity/duplicate/malformed words are REJECTED (MALFORMED_WORD)", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  for (const bad of [
    "G1 XNaN Y10 Z0.2 E0.1 F30",
    "G1 X10 YInfinity Z0.2 E0.1 F30",
    "G1 X10 X20 Y10 Z0.2 E0.1 F30", // duplicate X
    "G1 X10 Y10 Z", // missing value
    "G1 X10 Y10 Z0.2 Eabc F30", // non-numeric value
  ]) {
    const v = validateEmittedProgram({ ...good, lines: [...good.lines, bad] }, CARTESIAN_PROFILE);
    assert.equal(v.pass, false, bad);
    assert.ok(
      v.errors.some((e) => e.code === "MALFORMED_WORD" && e.line === bad),
      bad,
    );
  }
});

test("validateEmittedProgram: motion line without XYZ axis words is REJECTED (MALFORMED_WORD)", () => {
  const good = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  const v = validateEmittedProgram(
    { ...good, lines: [...good.lines, "G1 X10 Y10 E0.1 F30"] }, // no Z
    CARTESIAN_PROFILE,
  );
  assert.equal(v.pass, false);
  assert.ok(v.errors.some((e) => e.code === "MALFORMED_WORD" && /`Z` axis word/.test(e.reason)));
});

test("postprocess: missing placement_mm is REJECTED (PLACEMENT_REQUIRED, no output)", () => {
  const { lines, errors, program } = postprocess(IR, CARTESIAN_PROFILE);
  assert.deepEqual(lines, []);
  assert.ok(errors.some((e) => e.code === "PLACEMENT_REQUIRED"));
  assert.equal(program.rejected, true);
  assert.deepEqual(program.lines, []);
});

test("postprocess: nonfinite placement_mm is REJECTED (PLACEMENT_REQUIRED, no output)", () => {
  for (const bad of [
    { x: Number.NaN, y: 0, z: 0 },
    { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
    { x: 0, y: 0, z: undefined },
    null,
  ]) {
    const { lines, errors, program } = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: bad });
    assert.deepEqual(lines, []);
    assert.ok(errors.some((e) => e.code === "PLACEMENT_REQUIRED"));
    assert.equal(program.rejected, true);
  }
});

test("postprocess: placement_mm translates BOTH endpoints before identity FK", () => {
  const { lines, errors } = postprocess(IR, CARTESIAN_PROFILE, {
    feed_mm_s: 40,
    travel_feed_mm_s: 150,
    placement_mm: { x: 100, y: 50, z: 10 },
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(lines[2], "G0 X110 Y60 Z10.2 F150");
  assert.equal(lines[3], "G1 X120 Y60 Z10.2 E0.374 F40");
  assert.equal(lines[4], "G1 X120 Y80 Z10.2 E0.9 F40");
  assert.equal(lines[5], "G0 X110 Y80 Z11.2 F150");
});

test("postprocess: missing or non-positive build_volume is REJECTED (INVALID_BUILD_VOLUME)", () => {
  const noVolume = { ...CARTESIAN_PROFILE, build_volume: undefined };
  const a = postprocess(IR, noVolume, { placement_mm: { x: 0, y: 0, z: 0 } });
  assert.deepEqual(a.lines, []);
  assert.ok(a.errors.some((e) => e.code === "INVALID_BUILD_VOLUME"));
  assert.equal(a.program.rejected, true);

  const zeroVolume = { ...CARTESIAN_PROFILE, build_volume: { x: 0, y: 220, z: 250 } };
  const b = postprocess(IR, zeroVolume, { placement_mm: { x: 0, y: 0, z: 0 } });
  assert.deepEqual(b.lines, []);
  assert.ok(b.errors.some((e) => e.code === "INVALID_BUILD_VOLUME"));
  assert.equal(b.program.rejected, true);
});

test("postprocess: empty ir.segments is REJECTED (EMPTY_PATH)", () => {
  const { lines, errors, program } = postprocess({ ...IR, segments: [] }, CARTESIAN_PROFILE, {
    placement_mm: { x: 0, y: 0, z: 0 },
  });
  assert.deepEqual(lines, []);
  assert.ok(errors.some((e) => e.code === "EMPTY_PATH"));
  assert.equal(program.rejected, true);
});

test("postprocess: negative part-local endpoints PASS with a positive placement", () => {
  const localIr = {
    ...IR,
    segments: [
      {
        ...IR.segments[0],
        pose: { from: { x: -5, y: -5, z: -0.1 }, to: { x: 5, y: 5, z: 0 } },
      },
    ],
  };
  const { lines, errors, program } = postprocess(localIr, CARTESIAN_PROFILE, {
    placement_mm: { x: 10, y: 10, z: 0.2 },
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(lines.length, 4);
  assert.equal(lines[2], "G0 X5 Y5 Z0.1 F120");
  assert.equal(lines[3], "G1 X15 Y15 Z0.2 E0.374 F30");
});

test("postprocess: placed endpoints outside the build volume FAIL (OUT_OF_VOLUME)", () => {
  const negPlacement = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: -50, y: 0, z: 0 } });
  assert.deepEqual(negPlacement.lines, []);
  assert.ok(negPlacement.errors.some((e) => e.code === "OUT_OF_VOLUME"));
  assert.equal(negPlacement.program.rejected, true);

  const bigPlacement = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 210, y: 0, z: 0 } });
  assert.deepEqual(bigPlacement.lines, []);
  assert.ok(bigPlacement.errors.some((e) => e.code === "OUT_OF_VOLUME"));
  assert.equal(bigPlacement.program.rejected, true);
});

test("postprocess: nonfinite pose endpoint is REJECTED (INVALID_POSE)", () => {
  const nanIr = {
    ...IR,
    segments: [
      {
        ...IR.segments[0],
        pose: { from: { x: Number.NaN, y: 10, z: 0.2 }, to: { x: 20, y: 10, z: 0.2 } },
      },
    ],
  };
  const { lines, errors, program } = postprocess(nanIr, CARTESIAN_PROFILE, {
    placement_mm: { x: 0, y: 0, z: 0 },
  });
  assert.deepEqual(lines, []);
  assert.ok(errors.some((e) => e.code === "INVALID_POSE"));
  assert.equal(program.rejected, true);
});

test("postprocess: stricter linear joint bounds REJECT in-volume endpoints (JOINT_LIMIT)", () => {
  const tight = {
    ...CARTESIAN_PROFILE,
    joints: [
      { id: "X", type: "linear", min: 0, max: 15 },
      { id: "Y", type: "linear", min: 0, max: 220 },
      { id: "Z", type: "linear", min: 0, max: 250 },
    ],
  };
  const { lines, errors, program } = postprocess(IR, tight, { placement_mm: { x: 0, y: 0, z: 0 } });
  assert.deepEqual(lines, []);
  assert.ok(errors.some((e) => e.code === "JOINT_LIMIT"));
  assert.equal(program.rejected, true);
});

test("postprocess: invalid declared linear joint bounds are REJECTED (JOINT_LIMIT)", () => {
  const badBounds = {
    ...CARTESIAN_PROFILE,
    joints: [{ id: "X", type: "linear", min: 220, max: 0 }],
  };
  const { lines, errors, program } = postprocess(IR, badBounds, {
    placement_mm: { x: 0, y: 0, z: 0 },
  });
  assert.deepEqual(lines, []);
  assert.ok(errors.some((e) => e.code === "JOINT_LIMIT"));
  assert.equal(program.rejected, true);
});

test("postprocess: disconnected paths emit one repositioning G0 per path start (no E on travel)", () => {
  const disconnected = {
    ...IR,
    segments: [
      { ...IR.segments[0] },
      {
        ...IR.segments[1],
        chain_id: "WALL#0#2",
        pose: { from: { x: 10, y: 30, z: 0.2 }, to: { x: 20, y: 30, z: 0.2 } },
      },
    ],
  };
  const { lines, errors, program } = postprocess(disconnected, CARTESIAN_PROFILE, {
    feed_mm_s: 40,
    travel_feed_mm_s: 150,
    placement_mm: { x: 0, y: 0, z: 0 },
  });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(program.rejected, undefined);
  assert.deepEqual(lines.slice(2), [
    "G0 X10 Y10 Z0.2 F150",
    "G1 X20 Y10 Z0.2 E0.374 F40",
    "G0 X10 Y30 Z0.2 F150",
    "G1 X20 Y30 Z0.2 E0.9 F40",
  ]);
  for (const g0 of lines.filter((l) => l.startsWith("G0 "))) {
    assert.ok(!g0.split(" ").some((w) => w.startsWith("E")), `travel carries no E: ${g0}`);
  }
});

test("program is deterministic + header version", () => {
  const a = postprocess(IR, CARTESIAN_PROFILE, { placement_mm: { x: 0, y: 0, z: 0 } }).program;
  const b = postprocess(JSON.parse(JSON.stringify(IR)), CARTESIAN_PROFILE, {
    placement_mm: { x: 0, y: 0, z: 0 },
  }).program;
  assert.equal(JSON.stringify(a.lines), JSON.stringify(b.lines));
  assert.ok(a.lines[0].startsWith("; postprocess v"));
  assert.match(a.lines[0], new RegExp(`v${POSTPROCESSOR_VERSION}$`));
});
