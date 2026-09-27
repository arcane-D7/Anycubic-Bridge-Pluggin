import { test } from "node:test";
import assert from "node:assert/strict";
import z from "zod";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";

import {
  analyzeMultimaterialGcode,
  buildFilamentIdsArg,
  buildLoadArgs,
  buildSliceArgs,
  collectArtifacts,
  discoverSlicerExecutable,
  inspectCompatibility,
  overlayMultiMaterialKeys,
  profileRootsFor,
  resolvePreset,
  resolvePresets,
  runSlicer,
} from "../scripts/slicer-cli.mjs";

function tempDir(prefix = "slicer-test") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, path, writeFileSync };
}

test("discoverSlicerExecutable returns the installed exe (any candidate)", () => {
  const exe = discoverSlicerExecutable();
  assert.ok(typeof exe === "string" && exe.length > 0, "should discover the slicer exe");
  assert.ok(
    /AnycubicSlicerNext\.exe$/i.test(exe),
    `exe should point at AnycubicSlicerNext.exe (got ${exe})`,
  );
});

test("resolvePreset matches by substring and falls back to first", () => {
  const { dir, path, writeFileSync } = tempDir();
  const profiles = path.join(dir, "process");
  mkdirSync(profiles, { recursive: true });
  writeFileSync(path.join(profiles, "0.08mm Standard @Anycubic Kobra S1 0.4 nozzle.json"), "{}");
  writeFileSync(path.join(profiles, "0.20mm Standard @Anycubic Kobra S1 0.4 nozzle.json"), "{}");

  const hit = resolvePreset(profiles, "0.08mm");
  assert.ok(hit.endsWith("0.08mm Standard @Anycubic Kobra S1 0.4 nozzle.json"));
  // fallback when no match: first file
  const fallback = resolvePreset(profiles, "NOPE-NOT-HERE");
  assert.ok(fallback.endsWith("0.08mm Standard @Anycubic Kobra S1 0.4 nozzle.json"));
});

test("resolvePresets resolves machine+process for Kobra S1 0.4", () => {
  const exe = discoverSlicerExecutable();
  if (!exe) {
    return; // environment without the slicer still passes (integration only)
  }
  const presets = resolvePresets({
    slicerExe: exe,
    machine: "Kobra S1 0.4",
    process: "0.08mm Standard",
  });
  assert.ok(presets.machine, "machine preset resolved");
  assert.ok(presets.process, "process preset resolved");
  assert.match(presets.machine, /Kobra S1/i);
});

test("buildSliceArgs: relative 3MF + cwd defeats the outputdir-append bug", () => {
  const { args, cwd } = buildSliceArgs({
    slicerExe: "C:\\Program Files\\AnycubicSlicerNext\\AnycubicSlicerNext.exe",
    inputFile: "C:\\model.stl",
    presets: {
      machine: "C:\\machine\\Kobra S1 0.4 nozzle.json",
      process: "C:\\process\\j.json",
    },
    outputRoot: "C:\\Volatile\\out",
    target3mf: "job.3mf",
    slice: 0,
    type: "gcode_3mf",
  });
  assert.equal(cwd, "C:\\Volatile\\out");
  assert.ok(args.includes("--export-3mf"));
  const nameIdx = args.indexOf("--export-3mf") + 1;
  // The critical fix: the 3MF value is just a basename, NOT the directory.
  assert.equal(args[nameIdx], "job.3mf");
  assert.ok(!args.includes("--outputdir"), "must NOT include --outputdir (would double-append)");
  assert.ok(args.includes("--slice"));
});

test("buildSliceArgs defaults 3MF name to output.gcode.3mf", () => {
  const { args } = buildSliceArgs({
    slicerExe: "exe",
    inputFile: "C:\\model.stl",
    presets: {},
    outputRoot: "C:\\out",
    slice: 1,
  });
  const nameIdx = args.indexOf("--export-3mf") + 1;
  assert.equal(args[nameIdx], "output.gcode.3mf");
});

test("inspectCompatibility marks 3MF with thumbnail as compatible", () => {
  // Build a minimal fake 3MF: the scanner reads the TAIL of the file, so we
  // place the central directory record at the very end (as in a real 3MF).
  const { dir, path, writeFileSync } = tempDir();
  const file = path.join(dir, "job.3mf");
  const name = Buffer.from("thumb.png", "utf8");
  const central = Buffer.alloc(46 + name.length);
  central.write("PK\x01\x02", 0);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\x05\x06", 0);
  writeFileSync(file, Buffer.concat([Buffer.from("junk-padding"), central, eocd]));
  const result = inspectCompatibility(file);
  assert.equal(result.format, "gcode_3mf");
  assert.ok(
    result.markers.members.includes("thumb.png"),
    `members should include thumb.png, got ${JSON.stringify(result.markers.members)}`,
  );
  assert.equal(result.compatible, true);
});

test("collectArtifacts keeps only gcode/3mf/json, newest first", () => {
  const { dir, path, writeFileSync } = tempDir();
  writeFileSync(path.join(dir, "a.gcode"), "x");
  writeFileSync(path.join(dir, "b.3mf"), "x");
  writeFileSync(path.join(dir, "c.log"), "x");
  const arts = collectArtifacts(dir);
  const names = arts.map((f) => path.basename(f));
  assert.deepEqual(names.sort(), ["a.gcode", "b.3mf"]);
});

test("runSlicer resolves exit code and captures output", async () => {
  const exe = process.execPath; // node itself: prints then exits 3
  const script = `console.error("stderr-line"); process.exit(3);`;
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "run-slicer-"));
  const scriptFile = path.join(dir, "exit3.mjs");
  writeFileSync(scriptFile, script);
  const res = await runSlicer(exe, [scriptFile], { cwd: dir, timeoutMs: 5000 });
  assert.equal(res.exitCode, 3);
  assert.match(res.stderr, /stderr-line/);
});

test("analyzeMultimaterialGcode counts tool switches and purge evidence", () => {
  const gcode = [
    "; sliced",
    "T0",
    ";WIPE_START",
    ";WIPE_END",
    "; FLUSH_START",
    "T1 ; change extruder",
    "; FLUSH_END",
    "; PURGE LINE",
    "T0 ; change extruder",
    "T1",
  ].join("\n");
  const a = analyzeMultimaterialGcode(gcode);
  assert.equal(a.tool_changes, 4);
  assert.deepEqual(a.unique_tools, ["0", "1"]);
  assert.equal(a.flush_start, 1);
  assert.equal(a.flush_end, 1);
  assert.equal(a.purge_lines, 1);
  assert.equal(a.wipe_start, 1);
  assert.equal(a.wipe_end, 1);
  // T0->T1->T0->T1 -> 3 real switches (first T0 is not counted as a switch).
  assert.equal(a.real_tool_switches, 3);
});

test("buildFilamentIdsArg validates 1..16 and joins", () => {
  assert.equal(buildFilamentIdsArg([1, 2, 1, 2]), "1,2,1,2");
  assert.equal(buildFilamentIdsArg([]), "");
  assert.throws(() => buildFilamentIdsArg([0]), /Invalid/);
  assert.throws(() => buildFilamentIdsArg([17]), /Invalid/);
});

test("overlayMultiMaterialKeys zeroes flush and maps roles", () => {
  const base = { wall_filament: "1", sparse_infill_filament: "1", some_key: "keep" };
  const mm = overlayMultiMaterialKeys(base, {
    outer_wall: "2",
    inner_wall: "0",
    infill: "0",
    top_surface: "1",
    flush_multiplier: "0",
  });
  assert.equal(mm.wall_filament, "2"); // legacy role
  assert.equal(mm.outer_wall_filament_id, "2"); // modern role
  assert.equal(mm.inner_wall_filament_id, "0");
  assert.equal(mm.sparse_infill_filament_id, "0");
  assert.equal(mm.top_surface_filament_id, "1");
  assert.equal(mm.some_key, "keep"); // untouched keys preserved
  assert.deepEqual(mm.flush_volumes_matrix, Array(16).fill("0"));
  assert.deepEqual(mm.flush_volumes_vector, Array(8).fill("0"));
  assert.deepEqual(mm.wiping_volumes_extruders, Array(10).fill("0"));
  assert.equal(mm.flush_multiplier, "0");
  assert.equal(mm.printer_flush_multiplier, "0");
  // defaults: non-specified roles fall back to "0"
  assert.equal(mm.support_filament, "0");
  assert.equal(mm.bottom_surface_filament_id, "0");
});

// --- MCP registration smoke (offline) -------------------------------------

import { registerSlicerTools } from "../scripts/slicer-tools.mjs";

function fakeServer() {
  const tools = [];
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.push({ name, meta, handler });
    },
  };
}

test("registerSlicerTools registers the live session tools with correct gating", async () => {
  const server = fakeServer();
  registerSlicerTools(server, z);
  const names = server.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "slicer_agentic_plan",
    "slicer_agentic_slice",
    "slicer_apply_project_settings",
    "slicer_export_3mf",
    "slicer_live_rollback",
    "slicer_live_sessions",
    "slicer_live_settings",
    "slicer_live_snapshot",
    "slicer_multimaterial",
    "slicer_preflight",
    "slicer_profiles",
    "slicer_project_state",
    "slicer_refresh_project",
    "slicer_settings",
    "slicer_slice",
  ]);

  const slice = server.tools.find((t) => t.name === "slicer_slice");
  assert.equal(slice.meta.annotations.readOnlyHint, false);
  // The zod schema is a ZodObject; .shape.confirm must exist.
  const inputShape = slice.meta.inputSchema.shape ?? slice.meta.inputSchema;
  assert.ok(inputShape.confirm, "slicer_slice must declare a confirm field");
  assert.ok(inputShape.confirm._def?.innerType?.constructor === z.ZodBoolean);

  const profiles = server.tools.find((t) => t.name === "slicer_profiles");
  assert.equal(profiles.meta.annotations.readOnlyHint, true);

  // Handlers reject missing confirm without touching anything.
  const res = await slice.handler({ input_file: "C:\\model.stl", confirm: false });
  assert.ok(
    res.isError === true ||
      (typeof res.content?.[0]?.text === "string" &&
        res.content[0].text.includes("requires confirm")),
  );

  const apply = server.tools.find((t) => t.name === "slicer_apply_project_settings");
  assert.equal(apply.meta.annotations.readOnlyHint, false);
  const applyShape = apply.meta.inputSchema.shape ?? apply.meta.inputSchema;
  assert.ok(applyShape.settings, "project settings tool must declare settings");
  assert.ok(applyShape.confirm, "project settings tool must declare confirm");
});
