/**
 * slicer-cli.mjs — thin wrapper around the Anycubic Slicer Next native CLI.
 *
 * The installed AnycubicSlicerNext.exe (v2.0.0.3) exposes a complete CLI:
 *   --slice <0-all|i-plate>, --export-3mf <file>, --export-settings <json>,
 *   --export-slicedata <dir>, --load-settings "a.json;b.json",
 *   --load-filaments, --load-filament-ids "1,2", --outputdir, --pipe,
 *   --scale/--rotate/--matrix/--arrange/--orient, --info, --min-save,
 *   --datadir, --debug <0-5> ...
 *
 * KNOWN BUG (workaround implemented): when --export-3mf AND --outputdir are
 * both provided, the slicer CONCATENATES outputdir to the 3MF value as if
 * relative, producing outputdir/outputdir/file.3mf (exit -13). Verified
 * fix: run with cwd = destination folder and pass --export-3mf <name>
 * relative, NO --outputdir.
 *
 * This module exposes pure, testable functions (argument building, preset
 * resolution, compatibility inspection) plus a runSlicer that spawns the
 * binary with cwd controlled and captures stdout/stderr with a hard cap.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Canonical probe used by the bundle (also honors ANYCUBIC_SLICER_EXE). */
export function discoverSlicerExecutable() {
  const candidates = [
    process.env.ANYCUBIC_SLICER_EXE,
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "AnycubicSlicerNext",
      "AnycubicSlicerNext.exe",
    ),
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Anycubic Slicer Next",
      "AnycubicSlicerNext.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Programs",
      "AnycubicSlicerNext",
      "AnycubicSlicerNext.exe",
    ),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Profiler root under the slicer installation. */
export function profileRootsFor(slicerExe) {
  if (!slicerExe) return [];
  const base = path.join(path.dirname(slicerExe), "resources", "profiles", "Anycubic");
  return ["machine", "process", "filament"]
    .map((kind) => path.join(base, kind))
    .filter((dir) => existsSync(dir));
}

/** Resolve the closest preset for a machine family + table by matching the
 *  file basename against `match` (case-insensitive substring). Falls back to
 *  the first profile if no explicit match is found. */
export function resolvePreset(profilesDir, match) {
  const dir = path.resolve(profilesDir);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort();
  if (!files.length) return null;
  const wanted = (match ?? "").toLowerCase().trim();
  const hit = files.find((name) => name.toLowerCase().includes(wanted));
  return path.join(dir, hit ?? files[0]);
}

/** Pick machine + process presets for a requested printer (defaults to
 *  Anycubic Kobra S1 0.4). Returns {machine, process, filament}. */
export function resolvePresets({ slicerExe, machine = "", process = "", filament = "" } = {}) {
  if (!slicerExe) return {};
  const roots = profileRootsFor(slicerExe);
  const machineDir = path.join(
    path.dirname(slicerExe),
    "resources",
    "profiles",
    "Anycubic",
    "machine",
  );
  const processDir = path.join(
    path.dirname(slicerExe),
    "resources",
    "profiles",
    "Anycubic",
    "process",
  );
  const filamentDir = path.join(
    path.dirname(slicerExe),
    "resources",
    "profiles",
    "Anycubic",
    "filament",
  );
  const machineFile = machineType(machine);
  const machinePath =
    resolvePreset(machineDir, machineFile || "Kobra S1 0.4") ??
    (roots[0] ? resolvePreset(machineDir, "") : null);
  // Derive the process-family match from the machine actually selected, so the
  // process preset is guaranteed compatible with the printer (a mismatched
  // family — e.g. Kobra 3 Max process on a Kobra S1 — aborts with
  // "process not compatible with printer", exit -17).
  const processMatch = process || presetFamilyFrom(machinePath);
  return {
    machine: machinePath,
    process:
      resolvePreset(processDir, processMatch) ?? (roots[0] ? resolvePreset(processDir, "") : null),
    filament: filament && resolvePreset(filamentDir, filament),
  };
}

/** "Anycubic Kobra S1 0.4 nozzle.json" -> "Kobra S1 0.4" (family + nozzle). */
function presetFamilyFrom(machineFile) {
  if (!machineFile) return "Kobra S1 0.4";
  const base = path.basename(String(machineFile), ".json").replace(/^Anycubic\s+/i, "");
  // Family = everything up to the nozzle dimension ("Kobra S1", "Kobra 3 Max V2",
  // "Kobra X"); if no nozzle is present, keep the whole basename.
  const fam = (base.match(/^Kobra.*?(?=\s+0\.\d+)/i)?.[0] ?? base).trim();
  const nozzle = base.match(/0\.\d+/)?.[0] ?? "";
  return `${fam} ${nozzle}`.trim();
}

function machineType(value) {
  const v = String(value ?? "")
    .toLowerCase()
    .trim();
  if (!v) return "";
  // Preserve the nozzle dimension when the caller names it (e.g. "Kobra S1 0.4"),
  // so preset matching targets that nozzle instead of the family-first file
  // (which would otherwise pick the 0.25 Kobra S1 and fail "process not
  // compatible with printer", exit -17).
  const nozzle = v.match(/0\.\d+/)?.[0];
  const known = [
    "kobra s1",
    "kobra 4 max",
    "kobra 4",
    "kobra 3 max",
    "kobra 3",
    "kobra 2 max",
    "kobra 2",
    "kobra 1 max",
    "kobra 1",
    "kobra x",
  ];
  const family = known.find((k) => v.includes(k));
  if (family) return nozzle ? `${family} ${nozzle}` : family;
  return v;
}

/** Convert a `settings` object into --load-settings/--load-filaments chunks. */
export function buildLoadArgs({ machine, process, filament }) {
  const loads = [];
  if (machine) loads.push(`load-settings`);
  if (process) loads.push(`load-settings`, process);
  if (filament) loads.push(`load-filaments`, filament);
  return loads;
}

/**
 * Build the full argv for one CLI slice+export invocation, given a resolved
 * preset set and outputDirs. Computes the final 3MF name from basename of
 * the requested target (if provided) or `output.gcode.3mf`.
 *
 * cwd (the directory the process will run in) determines where the 3MF is
 * written, so the CLI can be invoked with cwd=outputRoot and a RELATIVE
 * --export-3mf name — defeating the outputdir-append bug.
 */
export function buildSliceArgs({
  slicerExe,
  inputFile,
  presets = {},
  outputRoot,
  target3mf,
  slice = 0,
  type,
}) {
  const machine = presets.machine ?? "";
  const process = presets.process ?? "";
  const filament = presets.filament ?? "";
  const args = [];
  if (machine) args.push("--load-settings", machine);
  if (process) args.push("--load-settings", process);
  if (filament) args.push("--load-filaments", filament);
  if (slice !== void 0) args.push("--slice", String(slice));
  const outName = target3mf ? path.basename(target3mf) : "output.gcode.3mf";
  args.push("--export-3mf", outName, "--min-save");
  if (type === "gcode") args.push("--export-gcode"); // not a real flag; kept for forward-compat docs
  args.push(inputFile);
  return { args, cwd: outputRoot };
}

/**
 * Analyze a sliced G-code for multi-material behavior. Extracts the toolhead
 * change lines (`T0/T1/...`), counts wall-layer per extruder, and reports
 * purge/flush evidence. Pure — reads a string, no I/O.
 */
export function analyzeMultimaterialGcode(gcode) {
  const lines = String(gcode ?? "").split(/\r?\n/);
  const toolChanges = [];
  const flushStart = [];
  const flushEnd = [];
  const purgeLines = [];
  let sawWipeStart = 0;
  let sawWipeEnd = 0;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (/^T\d+/.test(trimmed)) toolChanges.push({ line: i, tool: trimmed.match(/^T(\d+)/)?.[1] });
    if (trimmed.includes("FLUSH_START")) flushStart.push(i);
    if (trimmed.includes("FLUSH_END")) flushEnd.push(i);
    if (trimmed.includes("PURGE LINE")) purgeLines.push(i);
    if (trimmed.includes("WIPE_START")) sawWipeStart++;
    if (trimmed.includes("WIPE_END")) sawWipeEnd++;
  });
  const uniqueTools = [...new Set(toolChanges.map((t) => t.tool))].sort();
  return {
    line_count: lines.length,
    tool_changes: toolChanges.length,
    unique_tools: uniqueTools,
    flush_start: flushStart.length,
    flush_end: flushEnd.length,
    purge_lines: purgeLines.length,
    wipe_start: sawWipeStart,
    wipe_end: sawWipeEnd,
    // A color-change (flush) is only "real" when the tool actually switched.
    // Zero-flush should STILL switch tools but with no purge between them.
    real_tool_switches: toolChanges.filter(
      (t, idx) => idx > 0 && t.tool !== toolChanges[idx - 1]?.tool,
    ).length,
  };
}

/** Per-object filament IDs from `--load-filament-ids` (1-based, e.g. "1,2,3,1"). */
export function buildFilamentIdsArg(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return "";
  return ids
    .map((v) => {
      const n = Number.parseInt(String(v), 10);
      if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error(`Invalid filament id: ${v}`);
      return String(n);
    })
    .join(",");
}

/**
 * Load the base system process preset JSON and overlay a set of known
 * multi-material keys (wall roles, flush volumes/vector, priming, wipe tower).
 * Returns a plain object ready to JSON.stringify into a user-profile preset.
 * Never mutates the system file.
 */
export function overlayMultiMaterialKeys(processJson, mmKeys = {}) {
  const base = typeof processJson === "string" ? JSON.parse(processJson) : { ...processJson };
  const overrides = {
    // Role -> extruder mapping (Bambu-style process keys).
    wall_filament: mmKeys.outer_wall ?? "0",
    sparse_infill_filament: mmKeys.infill ?? "0",
    solid_infill_filament: mmKeys.solid_infill ?? "0",
    support_filament: mmKeys.support ?? "0",
    support_interface_filament: mmKeys.support_interface ?? "0",
    // Modern .3MF role keys (accepted by --export-settings, proven above).
    outer_wall_filament_id: mmKeys.outer_wall ?? "0",
    inner_wall_filament_id: mmKeys.inner_wall ?? "0",
    top_surface_filament_id: mmKeys.top_surface ?? "0",
    bottom_surface_filament_id: mmKeys.bottom_surface ?? "0",
    sparse_infill_filament_id: mmKeys.infill ?? "0",
    internal_solid_filament_id: mmKeys.solid_infill ?? "0",
    // Flush control — ZERO to leave contamination (marble effect).
    flush_into_infill: mmKeys.flush_into_infill ?? "0",
    flush_into_objects: mmKeys.flush_into_objects ?? "0",
    flush_into_support: mmKeys.flush_into_support ?? "0",
    flush_multiplier: mmKeys.flush_multiplier ?? "0",
    printer_flush_multiplier: mmKeys.printer_flush_multiplier ?? "0",
    filament_minimal_purge_on_wipe_tower: mmKeys.minimal_purge ?? "15",
    wiping_volumes_extruders: Array(10).fill("0"),
    flush_volumes_matrix: Array.isArray(mmKeys.flush_volumes_matrix)
      ? mmKeys.flush_volumes_matrix.map((v) => String(v)).slice(0, 16)
      : Array(16).fill("0"),
    flush_volumes_vector: Array.isArray(mmKeys.flush_volumes_vector)
      ? mmKeys.flush_volumes_vector.map((v) => String(v)).slice(0, 8)
      : Array(8).fill("0"),
    // Prime tower (off by default; turning it on changes flush destinations).
    enable_prime_tower: mmKeys.enable_prime_tower ?? "0",
    prime_tower_x: mmKeys.prime_tower_x ?? "15",
    prime_tower_y: mmKeys.prime_tower_y ?? "220",
    prime_tower_width: mmKeys.prime_tower_width ?? "30",
    prime_tower_brim_width: mmKeys.prime_tower_brim_width ?? "5",
    prime_volume: mmKeys.prime_volume ?? "30",
  };
  // Classic single-value options only present when the caller wants them.
  const classic = {
    bed_adhesion: mmKeys.bed_adhesion,
    support_type: mmKeys.support_type,
    sparse_infill_density: mmKeys.sparse_infill_density,
    print_sequence: mmKeys.print_sequence,
    detect_thin_wall: mmKeys.detect_thin_wall,
  };
  for (const [key, val] of Object.entries(classic)) {
    if (val === undefined || val === null || val === "") continue;
    if (key === "bed_adhesion") {
      // bed_adhesion is a composite: brim / skirt / raft + widths.
      const v = String(val);
      if (v === "none") { overrides.brim_type = "no_brim"; overrides.skirt_loops = "0"; overrides.raft_layers = "0"; }
      else if (v === "brim") { overrides.brim_type = "brim"; overrides.brim_width = mmKeys.brim_width ?? "5"; overrides.raft_layers = "0"; }
      else if (v === "skirt") { overrides.brim_type = "no_brim"; overrides.skirt_loops = "2"; overrides.raft_layers = "0"; }
      else if (v === "raft") { overrides.brim_type = "no_brim"; overrides.skirt_loops = "0"; overrides.raft_layers = "1"; }
    } else {
      overrides[key] = String(val);
    }
  }
  return { ...base, ...overrides };
}

/** Spawn the slicer binary with a controlled cwd and capture output. */
export function runSlicer(executable, args, { cwd, timeoutMs = 6e5 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const cap = 64 * 1024;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Slicer exceeded the ${timeoutMs} ms timeout.`));
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** List artifact files (gcode/3mf/json) under a directory, newest first. */
export function collectArtifacts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .filter((file) => /\.(gcode|3mf|json)$/i.test(file))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
}

/** Extract the first embedded .gcode member of a sliced 3MF (empty string if none). */
export async function extractGcodeFrom3mf(file) {
  try {
    const { read3mf } = await import("./read-3mf.mjs");
    const members = read3mf(file);
    const gcode = members.find((m) => /\.gcode$/i.test(m.name));
    return gcode ? gcode.data.toString("utf8") : "";
  } catch {
    return "";
  }
}

/** Inspect a produced 3MF/GCcode for the firmware markers the printer needs
 *  (mirrors the bundle's inspectExportedCompatibility logic). */
export function inspectCompatibility(file) {
  const lower = file.toLowerCase();
  const is3mf = lower.endsWith(".3mf");
  const result = { file, format: is3mf ? "gcode_3mf" : "gcode", compatible: false, markers: {} };
  try {
    if (is3mf) {
      const size = statSync(file).size;
      const tailSize = Math.min(size, 65536);
      const tail = readFileSync(file, { start: Math.max(0, size - tailSize) });
      const members = tail
        .toString("latin1")
        .split("PK\u0001\u0002")
        .slice(1)
        .map((entry) => {
          // entry starts after the "PK\x01\x02" signature, so the fixed
          // header fields are shifted by 4 bytes relative to the ZIP spec.
          const nameLen = entry.charCodeAt(24) | (entry.charCodeAt(25) << 8);
          const extraLen = entry.charCodeAt(26) | (entry.charCodeAt(27) << 8);
          const commentLen = entry.charCodeAt(28) | (entry.charCodeAt(29) << 8);
          const localOffset = 42 + nameLen + extraLen + commentLen;
          return entry.slice(42, localOffset);
        })
        .filter(Boolean);
      result.markers = {
        has_thumbnail: members.some((name) => /png$/i.test(String(name))),
        has_sliced_gcode: members.some((name) => /Metadata\/.*\.gcode$/i.test(String(name))),
        member_count: members.length,
        members: members.slice(0, 40),
      };
    } else {
      const head = readFileSync(file, "utf8").slice(0, 8192);
      result.markers = {
        has_thumbnail: /THUMBNAIL_BLOCK|thumbnail begin/i.test(head),
        has_print_sequence: /print_sequence|by object|T(0|1|2|3) new|init_heat/i.test(head),
        has_model_instances: /model_instances: *[2-9]/.test(head),
      };
    }
    const m = result.markers;
    result.compatible = is3mf
      ? Boolean(m.has_sliced_gcode || m.has_thumbnail)
      : Boolean(m.has_thumbnail) &&
        (Boolean(m.has_print_sequence) || Boolean(m.has_model_instances));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
