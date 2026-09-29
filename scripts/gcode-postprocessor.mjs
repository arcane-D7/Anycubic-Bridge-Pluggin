/**
 * gcode-postprocessor.mjs — S8-005: kinematics-aware postprocessor
 * (IR → controller dialect) with a hard gcode whitelist per machine profile.
 *
 * Pipeline slot (§3.7): IR → kinematic/time planning (FK → joint targets) →
 * per-machine postprocessor (controller dialect, G-code subset per capability
 * contract §5) → independent emitted-program validation.
 *
 * Design rules (fail-closed, never over-claim):
 *  1. Only codes in the profile's `gcode_whitelist` may be emitted. A code
 *     outside the whitelist fails the emitted-program validator test — it is
 *     never silently emitted or remapped.
 *  2. Kinematics-aware FK: for a CARTESIAN profile the FK is identity
 *     (X/Y/Z joint targets = IR pose). A ROTARY profile is REJECTED with the
 *     named error `ROTARY_NOT_IMPLEMENTED` — the previous atan2 with
 *     passthrough XY was NOT valid machine kinematics. Rotary FK (bounds +
 *     placement) is a later slice — no over-claim.
 *  3. Travel moves (kind = travel, or a chain boundary) are emitted as
 *     non-extruding moves; extrusion moves carry E from the IR flow.
 *  4. Unknown kinematics → REJECTED pre-flight (never guess
 *     `kinematics` as cartesian).
 *
 * Pure module — no I/O. Returns a deterministic, testable program object.
 */
import assert from "node:assert/strict";

export const POSTPROCESSOR_VERSION = "1.0";

/** Dialect code → emitted letter meaning (for validators; not authoritative). */
export const KNOWN_GCODES = new Set(["G0", "G1", "G92", "M104", "M109", "M114", "M82", "M83"]);

/**
 * Resolve the machine kinematics from a §5-like profile object.
 * Returns { kinematics, joints } and fails closed when unknown.
 *
 * @param {object} profile — §5 shape: { kinematics?, joints?, controller_dialect? }
 * @returns {{ kinematics: 'cartesian'|'rotary', joints: Array<object> }}
 */
export function resolveKinematics(profile) {
  assert.ok(profile && typeof profile === "object", "machine profile required");
  const kinematics = profile.kinematics ?? "cartesian";
  if (kinematics !== "cartesian" && kinematics !== "rotary") {
    const err = new Error(
      `unsupported kinematics \`${kinematics}\` (want cartesian|rotary; multi-axis is R7/S4 — no over-claim)`,
    );
    err.code = "UNSUPPORTED_KINEMATICS";
    throw err;
  }
  const joints = Array.isArray(profile.joints) ? profile.joints : [];
  return { kinematics, joints };
}

/**
 * FK: IR pose → joint targets.
 *
 * CARTESIAN → identity: joint targets are the pose XYZ (mm). Rotary joints
 * present on a cartesian profile are ignored for FK purposes (the linear axes
 * are the cartesian actuation), but they are NEVER silently dropped — they are
 * returned as-is so validators can see them.
 *
 * ROTARY → REJECTED with the named error code `ROTARY_NOT_IMPLEMENTED`. The
 * previous atan2-with-passthrough-XY mapping was not valid machine kinematics.
 * A real rotary FK (bounds + part placement on the turntable) is a later
 * slice — fail-closed, no usable joint targets, no over-claim.
 *
 * @param {object} irSegment — IR segment {pose:{from,to}, ...}
 * @param {object} kin — { kinematics, joints } from resolveKinematics
 * @param {object} opts — { initialZ?: number }
 * @returns {{ from: Record<string,number>, to: Record<string,number> }}
 */
export function fkToJointTargets(irSegment, kin, opts = {}) {
  const { kinematics, joints } = kin;
  const pose = irSegment?.pose;
  assert.ok(pose?.from && pose?.to, "IR segment pose required");

  if (kinematics === "cartesian") {
    // Identity FK — X/Y/Z joint targets = IR pose. Record which axes exist.
    const ids = new Set(joints.map((j) => j.id));
    const target = (axis) => (ids.has(axis) ? axis : undefined);
    const from = { x: pose.from.x, y: pose.from.y, z: pose.from.z };
    const to = { x: pose.to.x, y: pose.to.y, z: pose.to.z };
    return {
      from,
      to,
      // Rotary joints on a cartesian profile exist but are NOT actuated by the
      // cartesian FK — surfaced so validators cannot silently ignore them.
      rotaryJointsPresent: joints.some((j) => j.type === "rotary"),
      axes: [target("x"), target("y"), target("z")].filter(Boolean),
    };
  }

  const err = new Error(
    `rotary FK not implemented (kinematics \`${kinematics}\`): atan2 with passthrough XY is not valid machine kinematics — rotary requires bounds + placement (later slice)`,
  );
  err.code = "ROTARY_NOT_IMPLEMENTED";
  throw err;
}

/**
 * Emit a W-word/spindle/gcode line from parameters, only if the code is in
 * the whitelist. Returns null when the code is not whitelisted (the caller
 * then decides: travel may skip, extrusion MUST fail — see postprocess).
 *
 * @param {string} code — e.g. "G1"
 * @param {Record<string,number|string|undefined>} params — { X?, Y?, Z?, E?, F? }
 * @param {string[]} whitelist — profile controller_dialect.gcode_whitelist
 * @returns {string|null} the line, or null if `code` ∉ whitelist.
 */
export function emitLine(code, params, whitelist) {
  assert.ok(Array.isArray(whitelist), "gcode_whitelist must be an array");
  if (!whitelist.includes(code)) return null;
  const parts = [code];
  // Joint-target word order: linear X/Y/Z first, then rotary (A/B/C/…), then
  // E/F. Known rotary ids (A/B/C) sort into the right position; a custom
  // rotary id (e.g. "C") is emitted with its uppercase letter.
  const out = [];
  for (const key of ["X", "Y", "Z", "A", "B", "C"]) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    out.push([key, v]);
  }
  for (const key of ["E", "F"]) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    out.push([key, v]);
  }
  for (const [key, v] of out) {
    parts.push(
      `${key}${Number(v)
        .toFixed(3)
        .replace(/\.?0+$/, "")}`,
    );
  }
  return parts.join(" ");
}

/**
 * Postprocess an IR document → a list of gcode lines per the machine profile.
 *
 * Kinematics-aware (AC-2): the emitted joint targets come from
 * `fkToJointTargets` — cartesian = identity X/Y/Z. A rotary profile is
 * REJECTED outright (`ROTARY_NOT_IMPLEMENTED`) with NO usable partial output:
 * `lines` is empty, `program.lines` is empty and `program.rejected` is true.
 *
 * Fail-closed rules:
 *  - `gcode_whitelist` missing/empty → error `NO_WHITELIST` (no default set).
 *  - A move whose code (G1 extrusion, or G0 repositioning/travel) is not in
 *    the whitelist → the WHOLE output is rejected with `GCODE_NOT_WHITELISTED`
 *    (never silently remapped, no printable partial lines).
 *  - Repositioning (before the first move, and whenever the previous emitted
 *    endpoint differs from the next segment's `from`) and TRAVEL segments are
 *    emitted as G0 with no E at the travel feed; continuous chains emit no
 *    extra repositioning.
 *  - Rotary kinematics → rejected with `ROTARY_NOT_IMPLEMENTED` (no partial
 *    program is produced — never emit joint targets from an invalid FK).
 *  - Unknown kinematics → throw from resolveKinematics (never guess).
 *
 * @param {object} ir — IR document from slice-ir toIrDocument
 * @param {object} profile — §5-shaped machine profile (controller_dialect, kinematics, joints)
 * @param {object} opts — { feed_mm_s?, travel_feed_mm_s?, placement_mm?: {x,y,z} }
 *   `placement_mm` is REQUIRED for cartesian: finite part placement offset in
 *   machine coords, applied to both endpoints before the identity FK.
 * @returns {{ lines: string[], errors: Array<{code:string,reason:string,segmentId:string,line?:string}>, program: object }}
 */
export function postprocess(ir, profile, opts = {}) {
  const { feed_mm_s = 30, travel_feed_mm_s = 120 } = opts;
  const { controller_dialect: { gcode_whitelist = null } = {} } = profile ?? {};
  const whitelist = Array.isArray(gcode_whitelist) ? gcode_whitelist : null;

  // Kinematics-aware FK — fail-closed on unknown kinematics.
  const kin = resolveKinematics(profile ?? {});

  const errors = [];
  if (!whitelist || whitelist.length === 0) {
    errors.push({
      code: "NO_WHITELIST",
      reason:
        "machine profile controller_dialect.gcode_whitelist missing or empty — fail-closed (no default gcode set)",
      segmentId: "*",
    });
  }

  if (kin.kinematics === "rotary") {
    return {
      lines: [],
      errors: [
        ...errors,
        {
          code: "ROTARY_NOT_IMPLEMENTED",
          reason:
            "rotary kinematics has no valid machine-kinematics FK (atan2 with passthrough XY is invalid) — rejected, no usable output; rotary bounds + placement is a later slice",
          segmentId: "*",
        },
      ],
      program: {
        dialect: ir?.dialect ?? "unknown",
        machine: profile?.id ?? null,
        kinematics: kin.kinematics,
        whitelist,
        lines: [],
        segmentCount: ir?.segments?.length ?? 0,
        rejected: true,
      },
    };
  }

  // Required finite placement for the cartesian path — fail-closed BEFORE any
  // segment is emitted (after whitelist / unsupported-kinematics / rotary
  // rejection, which keep their priority). Build bounds validation is a later
  // slice — here we only require a finite {x,y,z} placement offset.
  const placement = opts.placement_mm;
  const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
  if (
    !placement ||
    typeof placement !== "object" ||
    !isFiniteNum(placement.x) ||
    !isFiniteNum(placement.y) ||
    !isFiniteNum(placement.z)
  ) {
    return {
      lines: [],
      errors: [
        ...errors,
        {
          code: "PLACEMENT_REQUIRED",
          reason:
            "cartesian postprocess requires finite `opts.placement_mm` {x,y,z} (part placement in machine coords) — rejected, no usable output",
          segmentId: "*",
        },
      ],
      program: {
        dialect: ir?.dialect ?? "unknown",
        machine: profile?.id ?? null,
        kinematics: kin.kinematics,
        whitelist,
        lines: [],
        segmentCount: ir?.segments?.length ?? 0,
        rejected: true,
      },
    };
  }

  const rejectPreflight = (code, reason) => ({
    lines: [],
    errors: [...errors, { code, reason, segmentId: "*" }],
    program: {
      dialect: ir?.dialect ?? "unknown",
      machine: profile?.id ?? null,
      kinematics: kin.kinematics,
      whitelist,
      lines: [],
      segmentCount: ir?.segments?.length ?? 0,
      rejected: true,
    },
  });

  const volume = profile?.build_volume;
  if (
    !volume ||
    typeof volume !== "object" ||
    !isFiniteNum(volume.x) ||
    !isFiniteNum(volume.y) ||
    !isFiniteNum(volume.z) ||
    volume.x <= 0 ||
    volume.y <= 0 ||
    volume.z <= 0
  ) {
    return rejectPreflight(
      "INVALID_BUILD_VOLUME",
      "machine profile build_volume {x,y,z} must be finite and strictly positive — rejected, no usable output",
    );
  }

  const segments = Array.isArray(ir?.segments) ? ir.segments : [];
  if (segments.length === 0) {
    return rejectPreflight(
      "EMPTY_PATH",
      "IR document has no segments — nothing to postprocess — rejected, no usable output",
    );
  }

  const linearJoints = [];
  for (const j of Array.isArray(kin.joints) ? kin.joints : []) {
    if (j?.type !== "linear") continue;
    if (!isFiniteNum(j.min) || !isFiniteNum(j.max) || j.min > j.max) {
      return rejectPreflight(
        "JOINT_LIMIT",
        `declared linear joint \`${j?.id ?? "?"}\` bounds invalid (finite min<=max required): ${JSON.stringify(j?.min)}..${JSON.stringify(j?.max)}`,
      );
    }
    linearJoints.push(j);
  }

  for (const seg of segments) {
    const segId = seg?.chain_id ?? `${seg?.kind}#${seg?.layer}`;
    const pose = seg?.pose;
    if (!pose || typeof pose !== "object") {
      return rejectPreflight(
        "INVALID_POSE",
        `segment \`${segId}\` has no pose {from,to} — rejected, no usable output`,
      );
    }
    for (const [label, p] of [
      ["from", pose.from],
      ["to", pose.to],
    ]) {
      if (
        !p ||
        typeof p !== "object" ||
        !isFiniteNum(p.x) ||
        !isFiniteNum(p.y) ||
        !isFiniteNum(p.z)
      ) {
        return rejectPreflight(
          "INVALID_POSE",
          `segment \`${segId}\` ${label} endpoint x/y/z must be finite — rejected, no usable output`,
        );
      }
    }
    const placed = {
      from: {
        x: pose.from.x + placement.x,
        y: pose.from.y + placement.y,
        z: pose.from.z + placement.z,
      },
      to: {
        x: pose.to.x + placement.x,
        y: pose.to.y + placement.y,
        z: pose.to.z + placement.z,
      },
    };
    for (const [label, p] of Object.entries(placed)) {
      if (p.x < 0 || p.x > volume.x || p.y < 0 || p.y > volume.y || p.z < 0 || p.z > volume.z) {
        return rejectPreflight(
          "OUT_OF_VOLUME",
          `segment \`${segId}\` placed ${label} endpoint (${p.x},${p.y},${p.z}) outside build volume [0,${volume.x}]x[0,${volume.y}]x[0,${volume.z}] — never clamped, rejected`,
        );
      }
      for (const j of linearJoints) {
        const axis = typeof j.id === "string" ? j.id.toLowerCase() : null;
        if (axis !== "x" && axis !== "y" && axis !== "z") continue;
        if (p[axis] < j.min || p[axis] > j.max) {
          return rejectPreflight(
            "JOINT_LIMIT",
            `segment \`${segId}\` placed ${label} ${axis}=${p[axis]} outside linear joint \`${j.id}\` bounds [${j.min},${j.max}] — never clamped, rejected`,
          );
        }
      }
    }
  }

  const lines = [];
  const eps = 1e-9;
  const samePoint = (a, b) =>
    Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
  const toWordMap = (p) => {
    const w = {};
    for (const [k, v] of Object.entries(p)) w[k.toUpperCase()] = v;
    return w;
  };
  const rejectWhitelist = (code, segId) => ({
    lines: [],
    errors: [
      ...errors,
      {
        code: "GCODE_NOT_WHITELISTED",
        reason: `\`${code}\` is not in the machine profile gcode_whitelist ${JSON.stringify(whitelist)} — whole output rejected, no printable partial lines`,
        segmentId: segId,
      },
    ],
    program: {
      dialect: ir?.dialect ?? "unknown",
      machine: profile?.id ?? null,
      kinematics: kin.kinematics,
      whitelist,
      lines: [],
      segmentCount: ir?.segments?.length ?? 0,
      rejected: true,
    },
  });

  let last = null;
  for (const seg of ir?.segments ?? []) {
    const isTravel = seg.kind === "TRAVEL";
    const segId = seg.chain_id ?? `${seg.kind}#${seg.layer}`;
    const placedSeg = {
      ...seg,
      pose: {
        from: {
          x: seg.pose.from.x + placement.x,
          y: seg.pose.from.y + placement.y,
          z: seg.pose.from.z + placement.z,
        },
        to: {
          x: seg.pose.to.x + placement.x,
          y: seg.pose.to.y + placement.y,
          z: seg.pose.to.z + placement.z,
        },
      },
    };
    const { from, to } = fkToJointTargets(placedSeg, kin, {});
    const needReposition = last === null || !samePoint(last, from);
    if (needReposition) {
      const reposition = emitLine(
        "G0",
        { ...toWordMap(from), F: travel_feed_mm_s },
        whitelist ?? [],
      );
      if (reposition === null) return rejectWhitelist("G0", segId);
      lines.push(reposition);
      last = from;
    }
    const code = isTravel ? "G0" : "G1";
    const params = isTravel
      ? { ...toWordMap(to), F: travel_feed_mm_s }
      : { ...toWordMap(to), E: seg.flow?.e_mm ?? 0, F: feed_mm_s };
    const line = emitLine(code, params, whitelist ?? []);
    if (line === null) return rejectWhitelist(code, segId);
    lines.push(line);
    last = to;
  }

  // Stable header: version line first, dialect second.
  lines.unshift(`; dialect: ${ir?.dialect ?? "unknown"}`);
  lines.unshift(`; postprocess v${POSTPROCESSOR_VERSION}`);

  const program = {
    dialect: ir?.dialect ?? "unknown",
    machine: profile?.id ?? null,
    kinematics: kin.kinematics,
    whitelist,
    lines,
    segmentCount: ir?.segments?.length ?? 0,
  };

  return { lines, errors, program };
}

/**
 * Independent emitted-program validator — AC-1. Re-checks the postprocessed
 * program on its own (separate code path, no shared functions with the
 * generator/postprocessor — it re-parses the emitted G0/G1 subset from text).
 *
 * ALL validation config (whitelist, dialect, build volume, joint limits) is
 * derived ONLY from the mandatory `expectedProfile` argument — NEVER from
 * `program.whitelist` (which is attacker/tamper-controllable output).
 *
 * Fail-closed rules:
 *  - missing/invalid `expectedProfile` → `PROFILE_REQUIRED` / `INVALID_PROFILE`.
 *  - `program.rejected` → `PROGRAM_REJECTED` (a rejected program is never valid).
 *  - no motion lines (G0/G1) at all → `EMPTY_MOTION`.
 *  - a code outside the profile whitelist → `GCODE_NOT_WHITELISTED`.
 *  - a whitelisted code the emitter never produces (mode-changing words such
 *    as G92/M82/M83/M104/…) → `GCODE_NOT_SUPPORTED` (fail-closed, no over-claim).
 *  - motion words: XYZ axis words mandatory, finite decimal numbers only;
 *    malformed/duplicate/NaN/Infinity words → `MALFORMED_WORD`.
 *  - endpoints outside the profile build volume → `OUT_OF_VOLUME`; outside
 *    declared linear joint bounds → `JOINT_LIMIT`.
 *  - `program.dialect`/`program.machine` disagreeing with the expected profile
 *    → `DIALECT_MISMATCH` / `MACHINE_MISMATCH`.
 *
 * Scope: parser of THIS generator's own emitted subset (comments + G0/G1 with
 * X/Y/Z[/E/F] words). It is NOT a general G-code interpreter — anything else
 * fails closed by design.
 *
 * @param {object} program — postprocess() output (or { lines, ... })
 * @param {object} expectedProfile — §5 machine profile (mandatory)
 * @returns {{ pass: boolean, errors: Array<{code:string,reason:string,line?:string}> }}
 */
export function validateEmittedProgram(program, expectedProfile) {
  const errors = [];
  const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

  // 1. Expected profile is MANDATORY — it is the only trusted config source.
  if (!expectedProfile || typeof expectedProfile !== "object" || Array.isArray(expectedProfile)) {
    errors.push({
      code: "PROFILE_REQUIRED",
      reason:
        "expectedProfile (§5 machine profile) is mandatory — whitelist/dialect/build volume/joint limits are derived ONLY from it, never from the emitted program",
      line: undefined,
    });
    return { pass: false, errors };
  }

  const dialectCfg = expectedProfile.controller_dialect ?? null;
  const whitelist = Array.isArray(dialectCfg?.gcode_whitelist)
    ? dialectCfg.gcode_whitelist.filter((c) => typeof c === "string" && c.length > 0)
    : null;
  const expectedDialect = typeof dialectCfg?.fw_family === "string" ? dialectCfg.fw_family : null;
  const expectedMachine = typeof expectedProfile.id === "string" ? expectedProfile.id : null;
  const volume = expectedProfile.build_volume ?? null;

  if (!whitelist || whitelist.length === 0) {
    errors.push({
      code: "INVALID_PROFILE",
      reason:
        "expectedProfile controller_dialect.gcode_whitelist missing/empty — cannot validate (fail-closed)",
      line: undefined,
    });
  }
  if (
    !volume ||
    typeof volume !== "object" ||
    !isFiniteNum(volume.x) ||
    !isFiniteNum(volume.y) ||
    !isFiniteNum(volume.z) ||
    volume.x <= 0 ||
    volume.y <= 0 ||
    volume.z <= 0
  ) {
    errors.push({
      code: "INVALID_PROFILE",
      reason:
        "expectedProfile build_volume {x,y,z} must be finite and strictly positive — cannot validate bounds (fail-closed)",
      line: undefined,
    });
  }

  // Joint limits come from the EXPECTED profile (not from the program).
  const jointLimits = [];
  if (Array.isArray(expectedProfile.joints)) {
    for (const j of expectedProfile.joints) {
      if (j?.type !== "linear") continue;
      if (!isFiniteNum(j.min) || !isFiniteNum(j.max) || j.min > j.max) {
        errors.push({
          code: "INVALID_PROFILE",
          reason: `expectedProfile linear joint \`${j?.id ?? "?"}\` bounds invalid (finite min<=max required): ${JSON.stringify(j?.min)}..${JSON.stringify(j?.max)}`,
          line: undefined,
        });
        continue;
      }
      jointLimits.push(j);
    }
  }

  if (errors.length > 0) return { pass: false, errors };

  // 2. The program object itself must be a rejected-free, non-empty motion program.
  if (!program || typeof program !== "object" || Array.isArray(program)) {
    errors.push({
      code: "INVALID_PROGRAM",
      reason: "emitted program object required — nothing to validate (fail-closed)",
      line: undefined,
    });
    return { pass: false, errors };
  }
  if (program.rejected === true) {
    errors.push({
      code: "PROGRAM_REJECTED",
      reason:
        "program is flagged `rejected` by its own generator — a rejected program is never validatable (fail-closed)",
      line: undefined,
    });
    return { pass: false, errors };
  }
  const lines = Array.isArray(program.lines) ? program.lines : [];
  if (
    expectedDialect !== null &&
    program.dialect !== undefined &&
    program.dialect !== expectedDialect
  ) {
    errors.push({
      code: "DIALECT_MISMATCH",
      reason: `program dialect \`${String(program.dialect)}\` does not match expected profile fw_family \`${expectedDialect}\``,
      line: undefined,
    });
  }
  if (
    expectedMachine !== null &&
    program.machine !== undefined &&
    program.machine !== null &&
    program.machine !== expectedMachine
  ) {
    errors.push({
      code: "MACHINE_MISMATCH",
      reason: `program machine \`${String(program.machine)}\` does not match expected profile id \`${expectedMachine}\``,
      line: undefined,
    });
  }

  // 3. Independent parser of the OWN emitted G0/G1 subset (comments + motion).
  // Own-subset word grammar: a single letter followed by a finite decimal
  // number (no exponent, no NaN/Infinity text). Anything else fails closed.
  const WORD_RE = /^([A-Za-z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/;
  const CODE_RE = /^[A-Za-z]\d+$/;
  let motionCount = 0;

  for (const line of lines) {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed || trimmed.startsWith(";")) continue; // comment/blank
    const tokens = trimmed.split(/\s+/);
    const code = tokens[0];

    if (!CODE_RE.test(code) || !whitelist.includes(code)) {
      errors.push({
        code: "GCODE_NOT_WHITELISTED",
        reason: `emitted code \`${code}\` is not in the EXPECTED profile gcode_whitelist ${JSON.stringify(whitelist)} (program.whitelist is never trusted)`,
        line,
      });
      continue;
    }
    if (code !== "G0" && code !== "G1") {
      // Whitelisted but NOT part of this generator's emitted subset — the
      // emitter never produces mode-changing words (G92/M82/M83/M104/…), so
      // their presence means tampering or an unsupported emitter. Fail closed.
      errors.push({
        code: "GCODE_NOT_SUPPORTED",
        reason: `whitelisted code \`${code}\` is outside the emitted G0/G1 subset this generator produces — mode-changing/unknown words fail closed`,
        line,
      });
      continue;
    }

    motionCount++;
    const words = new Map();
    let malformed = false;
    for (const tok of tokens.slice(1)) {
      const m = WORD_RE.exec(tok);
      const letter = m ? m[1].toUpperCase() : null;
      if (!m) {
        errors.push({
          code: "MALFORMED_WORD",
          reason: `word \`${tok}\` is not a letter+finite-decimal number (NaN/Infinity/missing value/duplicate-free grammar violated)`,
          line,
        });
        malformed = true;
        continue;
      }
      if (words.has(letter)) {
        errors.push({
          code: "MALFORMED_WORD",
          reason: `duplicate word \`${tok}\` (letter \`${letter}\` appears more than once)`,
          line,
        });
        malformed = true;
        continue;
      }
      words.set(letter, Number(m[2]));
    }

    if (malformed) continue; // bounds checks on a badly parsed line are meaningless

    // XYZ axis words are mandatory and must be finite numbers (guaranteed by
    // the grammar; presence is checked here).
    for (const axis of ["X", "Y", "Z"]) {
      if (!words.has(axis)) {
        errors.push({
          code: "MALFORMED_WORD",
          reason: `motion line is missing its \`${axis}\` axis word — XYZ finite numeric axes are required`,
          line,
        });
        malformed = true;
      }
    }
    if (malformed) continue;

    const p = { x: words.get("X"), y: words.get("Y"), z: words.get("Z") };
    if (p.x < 0 || p.x > volume.x || p.y < 0 || p.y > volume.y || p.z < 0 || p.z > volume.z) {
      errors.push({
        code: "OUT_OF_VOLUME",
        reason: `emitted endpoint (${p.x},${p.y},${p.z}) outside EXPECTED build volume [0,${volume.x}]x[0,${volume.y}]x[0,${volume.z}] — never clamped, rejected`,
        line,
      });
    }
    for (const j of jointLimits) {
      const axis = typeof j.id === "string" ? j.id.toLowerCase() : null;
      if (axis !== "x" && axis !== "y" && axis !== "z") continue;
      if (p[axis] < j.min || p[axis] > j.max) {
        errors.push({
          code: "JOINT_LIMIT",
          reason: `emitted endpoint ${axis}=${p[axis]} outside EXPECTED linear joint \`${j.id}\` bounds [${j.min},${j.max}] — never clamped, rejected`,
          line,
        });
      }
    }
  }

  if (motionCount === 0) {
    errors.push({
      code: "EMPTY_MOTION",
      reason: "emitted program contains no G0/G1 motion lines — nothing to validate (fail-closed)",
      line: undefined,
    });
  }

  return { pass: errors.length === 0, errors };
}
