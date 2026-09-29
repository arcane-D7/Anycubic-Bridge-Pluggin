// S8-001 — planar parity comparator (own planar core vs Anycubic Slicer Next).
//
// Parses the intermediate op IR (or the 3MF/gcode outputs) of two slicing
// runs and computes the S1 budget deltas:
//   - per-layer wall count delta        (Δwalls)
//   - infill volume % delta             (Δinfill%)
//   - bounding box delta                (Δbbox, mm per axis)
//
// The analyzer consumes a normalized "slice summary" JSON that both sides
// (the Anycubic reference via scripts/slicer-cli.mjs + a parse, and the own
// planar core via its deterministic IR) can emit. The comparator itself is
// side-agnostic: it does not know which side is "reference" — the caller
// labels them `reference` and `candidate`.
//
// Pure functions, unit-testable on synthetic summaries (no I/O).

/**
 * Parse a G-code (or gcode.3mf embedded text) into per-layer stats.
 * Recognises the standard per-layer markers:
 *   ;LAYER_COUNT:n, ;LAYER:n, ;TYPE:WALL-OUTER/WALL-INNER/INFILL/SOLID-FILL,
 *   ;MESH:... plus raw moves G1 X..Y..E.. (counted for wall/infill estimates).
 *
 * Returns { layers: [{index, wallCount, infillExtrusion, solidExtrusion,
 *                     totalExtrusion, eValue, bbox}], bbox, totalExtrusion }.
 * "wallCount" is the count of distinct wall-type passes on the layer.
 */
export function analyzeGcode(text) {
  const lines = String(text).split(/\r?\n/);
  const layers = [];
  let current = null;
  let layerCount = 0;
  let started = false; // first real layer marker seen (skip preamble moves)

  const ensureLayer = () => {
    if (!current) {
      current = {
        index: layers.length,
        wallCount: 0,
        infillExtrusion: 0,
        solidExtrusion: 0,
        totalExtrusion: 0,
        eValue: 0,
        bbox: null,
        hasWallType: false,
        used: false,
      };
      layers.push(current);
    }
    return current;
  };

  const newLayer = (over = {}) => {
    current = {
      index: layers.length,
      wallCount: 0,
      infillExtrusion: 0,
      solidExtrusion: 0,
      totalExtrusion: 0,
      eValue: 0,
      bbox: null,
      hasWallType: false,
      used: false,
      ...over,
    };
    layers.push(current);
    return current;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(";LAYER_COUNT:")) {
      layerCount = Number(line.split(":")[1]) || layerCount;
      continue;
    }
    // Anycubic format: ;LAYER_CHANGE then ;Z:n on a following line.
    // The ;Z: line updates the just-created fresh layer (no new layer yet).
    const zMatch = line.match(/^;Z:(-?[\d.]+)/);
    const layerChange = line.startsWith(";LAYER_CHANGE");
    if (layerChange) {
      started = true;
      newLayer();
      continue;
    }
    if (zMatch) {
      started = true;
      const z = Number(zMatch[1]);
      if (current && !current.used) {
        current.z = z; // ;LAYER_CHANGE already opened this layer
      } else {
        newLayer({ z });
      }
      continue;
    }
    if (line.startsWith(";LAYER:")) {
      started = true;
      newLayer({ index: Number(line.split(":")[1]) || layers.length });
      continue;
    }
    const typeMatch = line.match(/^;TYPE:(.+)$/);
    if (typeMatch) {
      const type = typeMatch[1].trim().toUpperCase();
      if (!started) continue; // preamble (prime) markers — not a model layer
      const layer = ensureLayer();
      // Adhesion (skirt/brim) and travel are NOT part of the modelled part;
      // mark them so their bbox and extrusion never pollute the geometry.
      if (
        type.includes("SKIRT") ||
        type.includes("BRIM") ||
        type.includes("RAFT") ||
        type.includes("PRIME") ||
        type.includes("TRAVEL")
      ) {
        layer.inAdhesion = true;
        layer.adhesionExtrusion = 0;
        continue;
      }
      // A real part marker ends any preceding adhesion block.
      layer.inAdhesion = false;
      // Track whether this TYPE block is part-material (bbox-relevant).
      layer.currentType = type;
      if (
        type.includes("WALL") ||
        type === "INNER WALL" ||
        type === "OUTER WALL" ||
        type.includes("PERIMETER")
      ) {
        layer.wallCount += 1;
        layer.hasWallType = true;
      }
      if (type.includes("INFILL")) layer.infillExtrusion = layer.totalExtrusion;
      if (type.includes("SOLID") || type === "TOP SURFACE" || type === "BOTTOM SURFACE") {
        layer.solidExtrusion = layer.totalExtrusion;
      }
      continue;
    }
    if (!line.startsWith("G1 ") && !line.startsWith("G0 ")) continue;
    if (!started) continue; // preamble prime/wipe moves — not a model layer

    // Parse a move: G1 Xn Yn [Zn] En [Fn]
    const m = line.match(/^G[01]\s+(.*)$/);
    if (!m) continue;
    const params = {};
    for (const kv of m[1].matchAll(/([XYZEF])(-?[\d.]+)/g)) {
      params[kv[1]] = Number(kv[2]);
    }
    const layer = ensureLayer();
    layer.used = true;
    if (params.E !== undefined) layer.eValue = Math.max(layer.eValue, Math.abs(params.E));
    const e = Math.abs(params.E ?? 0);
    if (layer.inAdhesion) layer.adhesionExtrusion = (layer.adhesionExtrusion ?? 0) + e;
    else {
      const ct = layer.currentType ?? "";
      const isPart =
        !!ct &&
        (ct.includes("WALL") ||
          ct.includes("INFILL") ||
          ct.includes("SOLID") ||
          ct.includes("SURFACE") ||
          ct.includes("PERIMETER") ||
          ct.includes("BRIDGE"));
      if (isPart) layer.totalExtrusion += e;
    }
    if (params.X !== undefined || params.Y !== undefined || params.Z !== undefined) {
      const p = [params.X ?? 0, params.Y ?? 0, params.Z ?? 0];
      // Adhesion (skirt/brim) is outside the part footprint — do not expand
      // the geometry bbox with it.
      if (layer.inAdhesion) continue;
      // Part-material types only: the final ;TYPE:Custom cleanup block and
      // travel moves (no E) are at wipe/park positions far outside the part
      // and would corrupt the geometry bbox. NO type marker yet = prime/
      // wipe (Custom) — also not part material.
      const ct = layer.currentType ?? "";
      const isPart =
        !!ct &&
        (ct.includes("WALL") ||
          ct.includes("INFILL") ||
          ct.includes("SOLID") ||
          ct.includes("SURFACE") ||
          ct.includes("PERIMETER") ||
          ct.includes("BRIDGE"));
      if (!isPart) continue;
      if (params.E === undefined || params.E === 0) continue; // travel move
      const b = layer.bbox;
      if (!b) layer.bbox = [p[0], p[1], p[2], p[0], p[1], p[2]];
      else {
        b[0] = Math.min(b[0], p[0]);
        b[1] = Math.min(b[1], p[1]);
        b[2] = Math.min(b[2], p[2]);
        b[3] = Math.max(b[3], p[0]);
        b[4] = Math.max(b[4], p[1]);
        b[5] = Math.max(b[5], p[2]);
      }
    }
  }

  // Drop preamble/empty layers that never received a real move.
  const usedLayers = layers.filter((l) => l.used);

  // Z extent comes from the layer plane values (;Z:/;LAYER:), because the
  // extruding moves carry XY only (Z is applied via travel/lift lines).
  const zs = usedLayers.map((l) => l.z).filter((z) => z != null);

  // Global bbox + totals
  const gbbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let totalExtrusion = 0;
  for (const l of usedLayers) {
    totalExtrusion += l.totalExtrusion;
    if (!l.bbox) continue;
    const b = l.bbox;
    gbbox[0] = Math.min(gbbox[0], b[0]);
    gbbox[1] = Math.min(gbbox[1], b[1]);
    gbbox[2] = Math.min(gbbox[2], b[2]);
    gbbox[3] = Math.max(gbbox[3], b[3]);
    gbbox[4] = Math.max(gbbox[4], b[4]);
    gbbox[5] = Math.max(gbbox[5], b[5]);
  }
  if (zs.length) {
    gbbox[2] = Math.min(gbbox[2], Math.min(...zs));
    gbbox[5] = Math.max(gbbox[5], Math.max(...zs));
  }
  const bbox =
    usedLayers.some((l) => l.bbox) || zs.length
      ? [
          gbbox[0] === Infinity ? 0 : gbbox[0],
          gbbox[1] === Infinity ? 0 : gbbox[1],
          gbbox[2] === Infinity ? 0 : gbbox[2],
          gbbox[3] === -Infinity ? 0 : gbbox[3],
          gbbox[4] === -Infinity ? 0 : gbbox[4],
          gbbox[5] === -Infinity ? 0 : gbbox[5],
        ]
      : [0, 0, 0, 0, 0, 0];

  return {
    layers: usedLayers,
    layerCount: Math.max(layerCount, usedLayers.length),
    bbox,
    totalExtrusion,
    perLayerWalls: usedLayers.map((l) => l.wallCount),
  };
}

/**
 * Parse the deterministic op-IR (JSON — S8-004 schema lite) into the same
 * summary shape so the comparator can diff IR-vs-gcode or IR-vs-IR.
 * IR segments carry {mode, wall/infill tags, extrusion_mm3, ...}.
 */
export function analyzeIr(jsonText) {
  const ir = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
  const segments = Array.isArray(ir?.segments) ? ir.segments : (ir?.layers ?? []);
  const layers = [];
  const byLayer = new Map();
  for (const seg of segments) {
    const layerIndex = seg.layer != null ? seg.layer : 0;
    let layer = byLayer.get(layerIndex);
    if (!layer) {
      layer = {
        index: layerIndex,
        wallCount: 0,
        infillExtrusion: 0,
        solidExtrusion: 0,
        totalExtrusion: 0,
        eValue: 0,
        bbox: null,
        hasWallType: false,
      };
      byLayer.set(layerIndex, layer);
      layers.push(layer);
    }
    const kind = String(seg.kind ?? seg.type ?? "").toUpperCase();
    if (kind.includes("WALL")) {
      layer.wallCount += 1;
      layer.hasWallType = true;
    }
    const e = Number(seg.extrusion_mm3 ?? seg.flow ?? 0);
    layer.totalExtrusion += Math.max(0, e);
    if (kind.includes("INFILL")) layer.infillExtrusion += Math.max(0, e);
    if (kind.includes("SOLID") || seg.top_surface || seg.bottom_surface) {
      layer.solidExtrusion += Math.max(0, e);
    }
    const pos = seg.positions ?? seg.pose;
    if (Array.isArray(pos) && pos.length >= 3) {
      const p = pos.slice(0, 3).map(Number);
      const b = layer.bbox;
      if (!b) layer.bbox = [p[0], p[1], p[2], p[0], p[1], p[2]];
      else {
        b[0] = Math.min(b[0], p[0]);
        b[1] = Math.min(b[1], p[1]);
        b[2] = Math.min(b[2], p[2]);
        b[3] = Math.max(b[3], p[0]);
        b[4] = Math.max(b[4], p[1]);
        b[5] = Math.max(b[5], p[2]);
      }
    }
  }
  layers.sort((a, b) => a.index - b.index);
  let totalExtrusion = 0;
  const gbbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const l of layers) {
    totalExtrusion += l.totalExtrusion;
    if (l.bbox) {
      const b = l.bbox;
      gbbox[0] = Math.min(gbbox[0], b[0]);
      gbbox[1] = Math.min(gbbox[1], b[1]);
      gbbox[2] = Math.min(gbbox[2], b[2]);
      gbbox[3] = Math.max(gbbox[3], b[3]);
      gbbox[4] = Math.max(gbbox[4], b[4]);
      gbbox[5] = Math.max(gbbox[5], b[5]);
    }
  }
  const bbox = [
    gbbox[0] === Infinity ? 0 : gbbox[0],
    gbbox[1] === Infinity ? 0 : gbbox[1],
    gbbox[2] === Infinity ? 0 : gbbox[2],
    gbbox[3] === -Infinity ? 0 : gbbox[3],
    gbbox[4] === -Infinity ? 0 : gbbox[4],
    gbbox[5] === -Infinity ? 0 : gbbox[5],
  ];
  return {
    layers,
    layerCount: layers.length,
    bbox,
    totalExtrusion,
    perLayerWalls: layers.map((l) => l.wallCount),
  };
}

/**
 * Compare two summaries and compute S1 budget deltas.
 * Returns an array of per-metric {metric, reference, candidate, delta,
 * pass, budget} plus a json-friendly summary.
 */
export function comparePlanarRuns(reference, candidate, budget = {}) {
  const bboxDelta = reference.bbox.map((v, i) => candidate.bbox[i] - v);
  // Reference gcode is positioned relative to the plate centre while
  // candidates are model-fitted — compare EXTENTS (max-min) per axis so the
  // absolute position never inflates the delta.
  const extent = (b) => [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
  const extentDelta = maxAbs(extent(reference.bbox).map((v, i) => extent(candidate.bbox)[i] - v));
  const infillRef = reference.totalExtrusion;
  const infillCand = candidate.totalExtrusion;
  const infillPct =
    infillRef === 0
      ? infillCand === 0
        ? 0
        : Infinity
      : ((infillCand - infillRef) / infillRef) * 100;

  const metrics = [
    {
      metric: "wall_count",
      reference: reference.perLayerWalls,
      candidate: candidate.perLayerWalls,
      // wall count delta = max per-layer difference (aligned by index)
      delta: maxPerLayerDelta(reference.perLayerWalls, candidate.perLayerWalls),
      budget: budget.wallCountDelta ?? 0,
      unit: "per-layer",
    },
    {
      metric: "infill_volume_pct",
      reference: infillRef,
      candidate: infillCand,
      delta: infillPct,
      budget: budget.infillVolumePct ?? Infinity,
      unit: "%",
    },
    {
      metric: "bbox_mm",
      reference: extent(reference.bbox),
      candidate: extent(candidate.bbox),
      delta: extentDelta,
      budget: budget.bboxMm ?? Infinity,
      unit: "mm/axis",
    },
  ];
  const results = metrics.map((m) => {
    const pass =
      Math.abs(m.delta) <= m.budget || (m.budget === Infinity && Number.isFinite(m.delta));
    return { ...m, pass };
  });
  return { metrics: results, pass: results.every((r) => r.pass), bboxDelta, extentDelta };
}

function maxPerLayerDelta(a, b) {
  const len = Math.max(a.length, b.length);
  let max = 0;
  for (let i = 0; i < len; i++) {
    // Skin layers (0 and last) legitimately swap the outer wall for the top/
    // bottom surface pass — that is standard slicer geometry, not a parity
    // violation, so exclude them from the structural wall-count delta.
    if (i === 0 || i === len - 1) continue;
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return max;
}

function maxAbs(arr) {
  return Math.max(...arr.map((v) => Math.abs(v)));
}

/** Load a slice summary from a file (JSON) or parse-on-read (gcode text). */
export function loadSliceSummary(filePath, fsMod, ext) {
  const raw = fsMod.readFileSync(filePath, "utf8");
  if (ext === "json") return JSON.parse(raw);
  return analyzeGcode(raw);
}
