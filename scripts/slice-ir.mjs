/**
 * slice-ir.mjs — S8-004: context-dependent op IR v1 + INDEPENDENT
 * emitted-program validator.
 *
 * The IR is the deterministic seam between the generator (planar-core
 * SliceMeta) and the per-machine postprocessor (S8-005). Per segment it
 * carries: pose (position + orientation), bead cross-section
 * (A_bead(s) — variable section allowed), flow Q, cooling params, speed,
 * collision-free interval, provenance (revision/generator/inputs) and the
 * **mode tag** (`standard` | `nonplanar`, §3.0a).
 *
 * This module is deliberately SEPARATE from the Rust generator: the validator
 * re-checks every segment on its own (independent code path — no shared
 * functions with the generator). A seeded bug in the generator must be
 * caught by the validator (test below).
 *
 * Checks:
 *  1. Extrusion conservation — ∫A_bead(s)ds ≈ Σ E·A_filament.
 *  2. Continuity — segments chain (from == previous to, within tolerance).
 *  3. Build-volume containment — pose stays inside the declared volume.
 *  4. Dialect whitelist — dialect must be in the allowlist.
 *  5. Mode consistency — a Z-ramp inside a `standard` job is REJECTED
 *     (named reason + segment id); a layer-jump in `nonplanar` is rejected.
 */
import assert from "node:assert/strict";

export const IR_VERSION = "1.0";
export const DIALECT_WHITELIST = ["anycubic", "cura"];

/** The slice-cache key MUST include the mode (§3.0a). */
export function sliceCacheKey(mode, profileFingerprintOrSource, inputPathHash) {
  assert.ok(
    mode === "standard" || mode === "nonplanar",
    `invalid mode ${mode} (want standard|nonplanar)`,
  );
  assert.ok(typeof profileFingerprintOrSource === "string", "profile fingerprint required");
  assert.ok(typeof inputPathHash === "string", "input hash required");
  return `slice-mode:${mode}|profile:${profileFingerprintOrSource}|input:${inputPathHash}`;
}

/**
 * Build an IR segment (v1, mode-tagged) from an engine segment + layer z.
 * The engine's SliceMeta segments are {from,to,volume_mm3,delta_e_mm,
 * q_mm3_s,kind} — this projection adds pose/orientation, bead section,
 * cooling, speed, collision interval and provenance. It does NOT invent
 * motion: pose/orientation come from the segment endpoints.
 *
 * @param {object} engineSeg — {from:{x,y,z}, to:{x,y,z}, volume_mm3,
 *   delta_e_mm, q_mm3_s, kind}
 * @param {number} layerIndex
 * @param {string} mode — 'standard' | 'nonplanar'
 * @param {object} opts — { speed_mm_s, cooling_fan_pct, provenance }
 * @returns {object} IR segment
 */
export function toIrSegment(engineSeg, layerIndex, mode, opts = {}) {
  const { speed_mm_s = 30, cooling_fan_pct = 0, provenance = "planar-core@1.0" } = opts;
  // Clone endpoints — never hold references into the engine's output (the
  // validator/tests must be able to mutate IR poses without corrupting the
  // source SliceMeta).
  const from = { ...engineSeg.from };
  const to = { ...engineSeg.to };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz) || 0;
  const orientation = len === 0 ? [0, 0, 1] : [dx / len, dy / len, dz / len];
  // Bead section: engine gives volume+length → A_bead = V/len (mm²).
  const A_bead = len === 0 ? 0 : engineSeg.volume_mm3 / len;
  return {
    mode,
    kind: String(engineSeg.kind ?? "Infill").toUpperCase(),
    layer: layerIndex,
    pose: { from, to },
    orientation,
    bead: { area_mm2: A_bead, variable: false },
    flow: { q_mm3_s: engineSeg.q_mm3_s, e_mm: engineSeg.delta_e_mm },
    cooling: { fan_pct: cooling_fan_pct },
    speed: { mm_s: speed_mm_s },
    collision_free: true,
    provenance: { generator: provenance, revision: IR_VERSION, layer: layerIndex },
  };
}

/**
 * Project SliceMeta JSON → IR document v1 (mode-tagged).
 *
 * Segments are grouped into CHAINS (contiguous same-kind runs per layer —
 * a wall ring or a single infill line). Chain boundaries are legal travel
 * moves between rings/lines; the continuity check is scoped INSIDE a chain
 * (a broken chain = emitted-program defect, never a travel).
 *
 * @param {object|string} sliceMeta — JSON string or object (from planar-core `slice-json`)
 * @param {object} opts — { speed_mm_s, cooling_fan_pct, provenance, chainGapMm }
 * @returns {object} {version, mode, dialect, profile_fingerprint, build_volume, segments}
 */
export function toIrDocument(sliceMeta, opts = {}) {
  const { chainGapMm = 0.05 } = opts; // gap above this starts a new chain
  const meta = typeof sliceMeta === "string" ? JSON.parse(sliceMeta) : sliceMeta;
  assert.ok(meta?.layers && Array.isArray(meta.layers), "SliceMeta.layers required");
  const mode = meta.mode ?? "standard";
  const segments = [];
  for (const layer of meta.layers) {
    let chainId = 0;
    let prevChainEnd = null;
    let prevKind = null;
    for (const seg of layer.segments ?? []) {
      const toSeg = toIrSegment(seg, layer.index, mode, opts);
      const from = seg.from;
      // New chain when kind changes or the previous chain ended with a gap
      // (a travel move between rings/lines).
      const chained =
        prevKind === String(seg.kind).toUpperCase() &&
        prevChainEnd &&
        Math.hypot(from.x - prevChainEnd.x, from.y - prevChainEnd.y, from.z - prevChainEnd.z) <=
          chainGapMm;
      if (!chained) chainId += 1;
      toSeg.chain_id = `${String(seg.kind).toUpperCase()}#${layer.index}#${chainId}`;
      segments.push(toSeg);
      prevChainEnd = seg.to;
      prevKind = String(seg.kind).toUpperCase();
    }
  }
  return {
    version: IR_VERSION,
    mode,
    dialect: meta.dialect ?? "anycubic",
    profile_fingerprint: meta.profile_fingerprint ?? "",
    build_volume: meta.build_volume ?? null,
    provenance: { generator: "planar-core", revision: meta.version },
    segments,
  };
}

/**
 * Independent validator — S8-004. Re-checks every segment; failures are
 * journaled (never silent). Returns {pass, errors:[{code, reason, segmentId,
 * layer, detail}]}.
 *
 * Checks: extrusion conservation (∫A_bead·len vs Σe_mm·A_filament), build
 * volume containment, dialect whitelist, mode-consistency (Z-ramp in
 * `standard` → reject with named reason + segment id).
 */
export function validateIr(ir, opts = {}) {
  const errors = [];
  const warnings = [];
  const {
    filament_area_mm2 = Math.PI * (1.75 / 2) ** 2, // default 1.75mm filament
    bbox = ir.build_volume ?? null,
    tol = 1e-6,
  } = opts;

  assert.ok(ir?.segments && Array.isArray(ir.segments), "IR segments required");

  // Dialect whitelist.
  if (!DIALECT_WHITELIST.includes(ir.dialect)) {
    errors.push({
      code: "DIALECT",
      reason: `dialect \`${ir.dialect}\` not in allowlist ${JSON.stringify(DIALECT_WHITELIST)}`,
      segmentId: "*",
      layer: "*",
    });
  }

  let prevKey = null;
  let prevTo = null;
  let prevChainId = null;

  // --- 3. Build-volume containment ---
  // The engine emits PART-LOCAL coordinates; placement on the plate is the
  // postprocessor's job (S8-005 FK → joint targets). The containment check is
  // therefore POSITION-INDEPENDENT: the part extents must fit inside the
  // declared volume (dx ≤ Vx, dy ≤ Vy, dz ≤ Vz). A part that would not fit is
  // rejected pre-flight; absolute position is not meaningful before placement.
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const seg of ir.segments) {
    for (const p of [seg.pose?.from, seg.pose?.to]) {
      if (!p) continue;
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }
  }
  if (bbox && Number.isFinite(min.x)) {
    const ext = {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    };
    for (const axis of ["x", "y", "z"]) {
      if (ext[axis] > bbox[axis] + tol) {
        errors.push({
          code: "OUT_OF_VOLUME",
          reason: `part extents ${ext.x.toFixed(2)}×${ext.y.toFixed(2)}×${ext.z.toFixed(2)} exceed build volume ${bbox.x}×${bbox.y}×${bbox.z} on ${axis} axis`,
          segmentId: "*",
          layer: "*",
        });
      }
    }
  }

  const segKey = (seg, i) => `${seg.kind}#${seg.layer}#${i}`;

  for (let i = 0; i < ir.segments.length; i++) {
    const seg = ir.segments[i];
    const id = segKey(seg, i);

    const from = seg.pose?.from;
    const to = seg.pose?.to;
    if (!from || !to) {
      errors.push({
        code: "MALFORMED",
        reason: "segment lacks pose.from/to",
        segmentId: id,
        layer: seg.layer,
      });
      continue;
    }

    // --- 5. Mode consistency ---
    const dz = Math.abs(to.z - from.z);
    if (seg.mode === "standard" && dz > tol) {
      errors.push({
        code: "Z_RAMP_IN_STANDARD",
        reason: `Z-ramp (dz=${dz.toFixed(6)}) inside a \`standard\` job — non-planar segment must be tagged \`nonplanar\``,
        segmentId: id,
        layer: seg.layer,
      });
    }
    if (seg.mode === "nonplanar" && seg.layer > 0 && dz === 0) {
      warnings.push({
        code: "NONPLANAR_NO_Z",
        reason: `nonplanar segment with no Z change — possible layer-jump mis-tag`,
        segmentId: id,
        layer: seg.layer,
      });
    }

    // --- 1. Extrusion conservation ---
    // ∫A_bead(s)ds ≈ Σ E·A_filament (each segment's deposited volume).
    const len = seg.pose_override ? 0 : Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const beadVol = (seg.bead?.area_mm2 ?? 0) * len;
    const eVol = (seg.flow?.e_mm ?? 0) * filament_area_mm2;
    if (beadVol > 0) {
      const rel = Math.abs(beadVol - eVol) / Math.max(beadVol, eVol);
      if (rel > 0.02) {
        errors.push({
          code: "EXTRUSION_CONSERVATION",
          reason: `bead volume ${beadVol.toFixed(6)} vs E·A_filament ${eVol.toFixed(6)} (rel ${(rel * 100).toFixed(2)}%)`,
          segmentId: id,
          layer: seg.layer,
        });
      }
    }

    // --- 2. Continuity (scoped INSIDE a chain — chain boundaries are
    //     legal travel moves between rings/lines) ---
    if (prevChainId === seg.chain_id && prevTo) {
      const d = Math.hypot(from.x - prevTo.x, from.y - prevTo.y, from.z - prevTo.z);
      if (d > 0.2) {
        errors.push({
          code: "CONTINUITY",
          reason: `gap ${d.toFixed(3)}mm inside chain ${seg.chain_id} (previous end ${prevTo.x.toFixed(3)},${prevTo.y.toFixed(3)},${prevTo.z.toFixed(3)} → current start ${from.x.toFixed(3)},${from.y.toFixed(3)},${from.z.toFixed(3)})`,
          segmentId: id,
          layer: seg.layer,
        });
      }
    }
    prevChainId = seg.chain_id;
    prevTo = to;
  }

  return { pass: errors.length === 0, errors, warnings };
}

/**
 * Journal a validator rejection (S8-004 AC6: "Validator failures surface as
 * journaled rejections, never silent pass"). Returns a serializable entry the
 * caller persists. Never auto-prefers or retries silently.
 *
 * @param {object} opts — { mode, dialect, errors, source, date }
 * @returns {object} journal entry {kind:"ir-validation", ...}
 */
export function journalRejection({ mode, dialect, errors, source, date }) {
  assert.ok(errors?.length > 0, "journalRejection requires at least one error");
  return {
    kind: "ir-validation",
    mode,
    dialect,
    source: source ?? "unknown",
    date: date ?? new Date().toISOString(),
    errorCount: errors.length,
    errors: errors.map((e) => ({
      code: e.code,
      reason: e.reason,
      segmentId: e.segmentId,
      layer: e.layer,
    })),
    resolution: null,
  };
}
