#!/usr/bin/env node
// S8-001 S1 parity runner (`pnpm run slices`).
//
// Executes the fixed 3-part planar corpus against the Anycubic Slicer Next
// reference and compares it with the own planar core candidate:
//
//   reference = Anycubic Slicer Next CLI (scripts/slicer-cli.mjs) sliced to
//               gcode/3MF, normalized to a summary by compare-planar-runs.mjs.
//   candidate = own planar core IR (S8-002/004) or its preprocessed gcode.
//
// Behaviour:
//  - Slicer present AND candidate available -> run + compare, journal result.
//  - Slicer absent -> SKIP-with-journal (exit 0, loud SKIP; never false-green).
//
// Output journal: docs/evidence/s1-parity-results-<date>.json

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { comparePlanarRuns, analyzeGcode, analyzeIr } from "./compare-planar-runs.mjs";
import {
  discoverSlicerExecutable,
  runSlicer,
  resolvePresets,
  buildSliceArgs,
} from "./slicer-cli.mjs";
import { read3mf } from "./read-3mf.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(root, "tests", "fixtures");
const EVIDENCE = join(root, "docs", "evidence");
const POC = join(root, "poc-output");
const date = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");

// The fixed 3-part corpus
const CORPUS = [
  { name: "cube", file: "cube-20mm.stl", bbox: [0, 0, 0, 20, 20, 20] },
  { name: "cylinder", file: "cylinder-20x25.stl", bbox: [0, 0, 0, 20, 20, 25] },
  { name: "bracket", file: "bracket.stl", bbox: [0, 0, 0, 60, 30, 8] },
];

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Reference slice via slicer-cli (Anycubic Slicer Next). Async. */
async function referenceSlice(slicerExe, inputFile) {
  const presets = resolvePresets({
    slicerExe,
    machine: "Kobra S1 0.4",
    // Pin the same process the budget declares (0.20 mm Standard @ Kobra S1
    // 0.4). resolvePreset substring-matches the FIRST file in alphabetical
    // order, so a short "0.20mm Standard" hits a Kobra 1 file (1 < S, exit
    // -17 "process not compatible") and "0.20mm Standard @Anycubic Kobra S1
    // 0.4" would hit the 0.08mm S1 0.4 file (alphabetically first). Use the
    // full filename (minus extension) to hit exactly the declared preset; a
    // missing file falls back to the family-correct preset.
    process: "0.20mm Standard @Anycubic Kobra S1 0.4 nozzle",
  });
  const outDir = join(POC, "s1-ref-" + nowStamp());
  mkdirSync(outDir, { recursive: true });
  const { args, cwd } = buildSliceArgs({
    slicerExe,
    inputFile,
    presets,
    outputRoot: outDir,
    target3mf: "ref.gcode.3mf",
    slice: 0,
  });
  const res = await runSlicer(slicerExe, args, { cwd, timeoutMs: 240000 });
  if (!res || res.exitCode !== 0) {
    console.log(`[slices]   slicer exit=${res?.exitCode} ${(res?.stderr ?? "").slice(0, 200)}`);
  }
  // Slicer writes ref.gcode.3mf (ZIP with gcode inside); parse the gcode.
  const zip = join(cwd, "ref.gcode.3mf");
  if (existsSync(zip)) {
    const files = read3mf(zip);
    const gcode = files.find((f) => f.name.endsWith(".gcode"));
    if (gcode?.data) {
      const summary = analyzeGcode(gcode.data.toString("utf8"));
      writeFileSync(join(EVIDENCE, `s1-ref-${date()}.json`), JSON.stringify(summary, null, 2));
      return summary;
    }
  }
  return null;
}

/**
 * Candidate slice — the own planar core. Invokes the `slice-json` binary
 * (crates/planar-core) on the fixture STL + a pinned process profile, parses
 * the deterministic SliceMeta IR, and builds a summary in the SAME units the
 * comparator expects:
 *   - per-layer wall count = len(layer.per_loop_wall) (loops, not segments)
 *   - totalExtrusion = sum of segment delta_e_mm (filament-length units, the
 *     same unit analyzeGcode sums for reference gcode E)
 *   - bbox = extents over segment endpoints
 * This keeps comparePlanarRuns unchanged (no wall-count segment-vs-loop bug).
 */
const CORE_PROFILE = {
  dialect: "anycubic",
  mode: "standard",
  layer_height_mm: 0.2,
  wall_loops: 2,
  infill_pattern: "Grid",
  infill_density_pct: 15.0,
  top_bottom_layers: 4,
  brim_mskirt: null,
  line_width_mm: 0.45,
  nozzle_diameter_mm: 0.4,
  filament: { diameter_mm: 1.75 },
  build_volume: { x: 220, y: 220, z: 250 },
};

function candidateSlice(inputFile, ref = null) {
  // Real planar core invocation (S8-002): slice-json on the fixture.
  const profilePath = join(POC, "core-profile.json");
  writeFileSync(profilePath, JSON.stringify(CORE_PROFILE, null, 2));
  const stdin = spawnSync(
    cargoExe(),
    [
      "run",
      "-q",
      "-p",
      "planar-core",
      "--bin",
      "slice-json",
      "--manifest-path",
      join(root, "crates", "Cargo.toml"),
      "--",
      inputFile,
      profilePath,
    ],
    { encoding: "utf8", timeout: 240000, cwd: root },
  );
  if (stdin.status !== 0 || !stdin.stdout?.trim()) {
    console.log(
      `[slices] candidate FAILED (status=${stdin.status}): ${(stdin.stderr ?? "").slice(0, 300)}`,
    );
    return null;
  }
  const ir = JSON.parse(stdin.stdout.trim());
  if (!ir?.layers?.length) return null;
  const layers = ir.layers.map((ly) => {
    let infillExtrusion = 0;
    let totalExtrusion = 0;
    const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const seg of ly.segments) {
      const e = Number(seg.delta_e_mm ?? 0);
      totalExtrusion += e;
      if (
        String(seg.kind ?? "")
          .toUpperCase()
          .includes("INFILL")
      )
        infillExtrusion += e;
      for (const p of [seg.from, seg.to]) {
        bbox[0] = Math.min(bbox[0], p.x);
        bbox[1] = Math.min(bbox[1], p.y);
        bbox[2] = Math.min(bbox[2], p.z);
        bbox[3] = Math.max(bbox[3], p.x);
        bbox[4] = Math.max(bbox[4], p.y);
        bbox[5] = Math.max(bbox[5], p.z);
      }
    }
    return {
      index: Number(ly.index),
      z: Number(ly.z),
      wallCount: (ly.per_loop_wall ?? []).length,
      infillExtrusion: +infillExtrusion.toFixed(6),
      solidExtrusion: 0,
      totalExtrusion: +totalExtrusion.toFixed(6),
      eValue: 0,
      bbox,
      hasWallType: (ly.per_loop_wall ?? []).length > 0,
    };
  });
  const gbbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let totalExtrusion = 0;
  for (const l of layers) {
    totalExtrusion += l.totalExtrusion;
    const b = l.bbox;
    for (let i = 0; i < 6; i++) {
      if (i < 3) gbbox[i] = Math.min(gbbox[i], b[i]);
      else gbbox[i] = Math.max(gbbox[i], b[i]);
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

function cargoExe() {
  const homeBin = join(
    homedir(),
    ".cargo",
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  return process.env.CARGO || (existsSync(homeBin) ? homeBin : "cargo");
}

async function main() {
  const slicerExe = discoverSlicerExecutable();
  const hasCandidate = true; // planar core exists from this sprint
  if (!slicerExe) {
    // SKIP path — journal, never false-green
    const entry = {
      status: "SKIP",
      reason: "Anycubic Slicer Next not found (reference side unavailable)",
      date: new Date().toISOString(),
      corpus: CORPUS.map((c) => c.name),
    };
    const outPath = join(EVIDENCE, `s1-parity-skip-${date()}.json`);
    writeFileSync(outPath, JSON.stringify(entry, null, 2));
    console.log("[slices] SKIP — slicer not found; journal " + outPath);
    process.exit(0);
  }
  if (!hasCandidate) {
    const entry = {
      status: "SKIP",
      reason: "own planar core candidate not available yet",
      date: new Date().toISOString(),
    };
    const outPath = join(EVIDENCE, `s1-parity-skip-${date()}.json`);
    writeFileSync(outPath, JSON.stringify(entry, null, 2));
    console.log("[slices] SKIP — candidate unavailable; journal " + outPath);
    process.exit(0);
  }

  console.log("[slices] reference slicer: " + slicerExe);
  const results = [];
  let allPass = true;
  for (const part of CORPUS) {
    const inputPath = join(FIXTURES, part.file);
    const ref = await referenceSlice(slicerExe, inputPath);
    if (!ref) {
      console.log(`[slices] ${part.name}: reference slice FAILED (no output)`);
      results.push({
        part: part.name,
        status: "ERROR",
        detail: "reference slice produced no summary",
      });
      allPass = false;
      continue;
    }
    const cand = candidateSlice(inputPath, ref);
    if (!cand) {
      console.log(`[slices] ${part.name}: candidate slice FAILED (no IR)`);
      results.push({
        part: part.name,
        status: "ERROR",
        detail: "planar core candidate produced no summary",
      });
      allPass = false;
      continue;
    }
    const cmp = comparePlanarRuns(ref, cand, {
      wallCountDelta: 0,
      infillVolumePct: 15,
      bboxMm: 1.0,
    });
    results.push({
      part: part.name,
      status: cmp.pass ? "PASS" : "FAIL",
      metrics: cmp.metrics.map((m) => ({
        metric: m.metric,
        reference: m.reference,
        candidate: m.candidate,
        delta: m.delta,
        budget: m.budget,
        pass: m.pass,
        unit: m.unit,
      })),
      bboxDelta: cmp.bboxDelta,
    });
    if (!cmp.pass) allPass = false;
    console.log(
      `[slices] ${part.name}: ${cmp.pass ? "PASS" : "FAIL"} ` +
        `walls=±${cmp.metrics[0].delta} infill%=${cmp.metrics[1].delta.toFixed(2)} ` +
        `bbox=±${cmp.metrics[2].delta.toFixed(3)}mm`,
    );
  }
  const summary = {
    status: allPass ? "PASS" : "FAIL",
    date: new Date().toISOString(),
    slicer: slicerExe,
    results,
  };
  const outPath = join(EVIDENCE, `s1-parity-results-${date()}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`[slices] journal → ${outPath}`);
  process.exit(allPass ? 0 : 1);
}

main();
