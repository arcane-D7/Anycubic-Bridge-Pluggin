#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z as z2 } from "zod";

// src/config.ts
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var sourceDir = path.dirname(fileURLToPath(import.meta.url));
function resolvePluginRoot(dir) {
  const candidates = [path.resolve(dir, ".."), path.resolve(dir, "../..")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "scripts", "uia-bridge.ps1"))) return candidate;
  }
  return candidates[0] ?? dir;
}
var pluginRoot = resolvePluginRoot(sourceDir);
function splitRoots(value) {
  if (!value) return [];
  return value
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}
function firstExisting(paths) {
  return paths.find((candidate) => existsSync(candidate));
}
function discoverSlicerExecutable() {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const explicit = process.env.ANYCUBIC_SLICER_EXE;
  return firstExisting(
    [
      explicit,
      path.join(programFiles, "AnycubicSlicerNext", "AnycubicSlicerNext.exe"),
      path.join(programFiles, "Anycubic Slicer Next", "AnycubicSlicerNext.exe"),
      path.join(localAppData, "Programs", "AnycubicSlicerNext", "AnycubicSlicerNext.exe"),
    ].filter((value) => Boolean(value)),
  );
}
function loadConfig() {
  const userProfile = process.env.USERPROFILE ?? process.cwd();
  const documents = path.join(userProfile, "Documents");
  const slicerExe = discoverSlicerExecutable();
  const defaultOutputRoot = path.resolve(
    process.env.ANYCUBIC_CONTROL_OUTPUT_ROOT ?? path.join(documents, "Anycubic-Control-Exports"),
  );
  const envInputRoots = splitRoots(process.env.ANYCUBIC_CONTROL_ALLOWED_INPUT_ROOTS);
  const envOutputRoots = splitRoots(process.env.ANYCUBIC_CONTROL_ALLOWED_OUTPUT_ROOTS);
  const appData = process.env.APPDATA ?? "";
  const profileRoots = [
    slicerExe ? path.join(path.dirname(slicerExe), "resources", "profiles") : "",
    appData ? path.join(appData, "AnycubicSlicerNext") : "",
  ].filter((root) => root && existsSync(root));
  const pluginData = process.env.PLUGIN_DATA
    ? path.resolve(process.env.PLUGIN_DATA)
    : path.join(process.env.LOCALAPPDATA ?? pluginRoot, "AnycubicSlicerNextControl");
  return {
    pluginRoot,
    ...(slicerExe ? { slicerExe } : {}),
    allowedInputRoots:
      envInputRoots.length > 0
        ? envInputRoots
        : [
            pluginRoot,
            documents,
            path.join(userProfile, "Desktop"),
            path.join(userProfile, "Downloads"),
          ],
    allowedOutputRoots: envOutputRoots.length > 0 ? envOutputRoots : [defaultOutputRoot],
    defaultOutputRoot,
    profileRoots,
    auditLogPath: path.join(pluginData, "audit.jsonl"),
    maxInputBytes: Number(process.env.ANYCUBIC_CONTROL_MAX_INPUT_BYTES ?? 1073741824),
    sliceTimeoutMs: Number(process.env.ANYCUBIC_CONTROL_SLICE_TIMEOUT_MS ?? 6e5),
    ...(process.env.ANYCUBIC_ACCESS_CODE
      ? { printerAccessCode: process.env.ANYCUBIC_ACCESS_CODE }
      : {}),
    printerIps: (process.env.ANYCUBIC_PRINTER_IPS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    ...(process.env.ANYCUBIC_CLOUD_TOKEN
      ? { cloudAccessToken: process.env.ANYCUBIC_CLOUD_TOKEN }
      : {}),
    cloudRegion: process.env.ANYCUBIC_CLOUD_REGION === "cn" ? "cn" : "en",
    tokenDataDir: path.join(pluginData, "tokens"),
    tokenCryptScript: path.join(pluginRoot, "scripts", "token-crypt.ps1"),
    tokenWatcherScript: path.join(pluginRoot, "scripts", "token-watcher.ps1"),
  };
}

// src/jobs.ts
import { appendFile, mkdir as mkdir2 } from "node:fs/promises";
import path4 from "node:path";
import { randomUUID } from "node:crypto";

// src/cli.ts
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path2 from "node:path";
function addSetting(args, name, value) {
  if (value === void 0) return;
  if (typeof value === "boolean") {
    args.push(`--${name}=${value ? "1" : "0"}`);
    return;
  }
  args.push(`--${name}`, String(value));
}
function buildSliceArgs(request2, outputDirectory) {
  const args = [
    "--load-settings",
    [request2.machineProfile, request2.processProfile].join(";"),
    "--load-filaments",
    request2.filamentProfiles.join(";"),
    "--slice",
    String(request2.plate),
    "--outputdir",
    outputDirectory,
    "--arrange",
    request2.arrange ? "1" : "0",
    "--orient",
    request2.orient ? "1" : "0",
    "--debug",
    "2",
  ];
  const settings = request2.settings;
  addSetting(args, "layer-height", settings.layerHeightMm);
  addSetting(
    args,
    "sparse-infill-density",
    settings.infillDensityPercent === void 0 ? void 0 : `${settings.infillDensityPercent}%`,
  );
  addSetting(args, "wall-loops", settings.wallLoops);
  addSetting(args, "enable-support", settings.supports);
  addSetting(args, "sparse-infill-pattern", settings.infillPattern);
  addSetting(args, "outer-wall-speed", settings.outerWallSpeedMms);
  addSetting(args, "inner-wall-speed", settings.innerWallSpeedMms);
  addSetting(args, "sparse-infill-speed", settings.sparseInfillSpeedMms);
  addSetting(args, "internal-solid-infill-speed", settings.solidInfillSpeedMms);
  addSetting(args, "top-surface-speed", settings.topSurfaceSpeedMms);
  addSetting(args, "top-shell-layers", settings.topShellLayers);
  addSetting(args, "bottom-shell-layers", settings.bottomShellLayers);
  addSetting(args, "pressure-advance", settings.pressureAdvance);
  addSetting(args, "elefant-foot-compensation", settings.elephantFootCompensationMm);
  addSetting(args, "brim-width", settings.brimWidthMm);
  addSetting(args, "nozzle-temperature", settings.nozzleTemperatureC);
  addSetting(args, "hot-plate-temp", settings.bedTemperatureC);
  if (request2.outputFormat === "gcode_3mf" || request2.outputFormat === "both") {
    args.push("--export-3mf", "output.gcode.3mf", "--min-save");
  }
  args.push(request2.inputPath);
  return args;
}
function runSlicerProcess(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: path2.dirname(executable),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const limit = 64 * 1024;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < limit) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < limit) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Slicing exceeded the ${timeoutMs} ms timeout.`));
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
async function collectArtifacts(job) {
  const entries = await readdir(job.outputDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path2.join(job.outputDirectory, entry.name))
    .filter((file) => /\.(gcode|3mf|json)$/i.test(file))
    .sort();
}

// src/security.ts
import { mkdir, realpath, stat } from "node:fs/promises";
import path3 from "node:path";
function comparable(value) {
  return path3.resolve(value).toLocaleLowerCase("en-US");
}
function isWithin(candidate, root) {
  const child = comparable(candidate);
  const parent = comparable(root);
  const relative = path3.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path3.isAbsolute(relative));
}
function assertAllowed(candidate, roots, label) {
  if (!roots.some((root) => isWithin(candidate, root))) {
    throw new Error(`${label} is outside the configured allowlist.`);
  }
}
async function validateInputFile(rawPath, config2) {
  if (!path3.isAbsolute(rawPath)) throw new Error("Input path must be absolute.");
  const extension = path3.extname(rawPath).toLowerCase();
  if (extension !== ".stl" && extension !== ".3mf") {
    throw new Error("Only .stl and .3mf input files are supported.");
  }
  const canonical = await realpath(rawPath);
  assertAllowed(canonical, config2.allowedInputRoots, "Input file");
  const details = await stat(canonical);
  if (!details.isFile()) throw new Error("Input path is not a regular file.");
  if (details.size <= 0) throw new Error("Input file is empty.");
  if (details.size > config2.maxInputBytes)
    throw new Error("Input file exceeds the configured size limit.");
  return canonical;
}
async function validateGcodeFile(rawPath, config2) {
  if (!path3.isAbsolute(rawPath)) throw new Error("G-code path must be absolute.");
  const lower = rawPath.toLowerCase();
  if (!lower.endsWith(".gcode") && !lower.endsWith(".gco")) {
    throw new Error("Only .gcode and .gco files are supported for G-code inspection.");
  }
  const canonical = await realpath(rawPath);
  assertAllowed(canonical, config2.allowedInputRoots, "G-code file");
  const details = await stat(canonical);
  if (!details.isFile()) throw new Error("G-code path is not a regular file.");
  if (details.size <= 0) throw new Error("G-code file is empty.");
  if (details.size > config2.maxInputBytes)
    throw new Error("G-code file exceeds the configured size limit.");
  return canonical;
}
async function validateProfileFile(rawPath, config2) {
  if (!path3.isAbsolute(rawPath)) throw new Error("Profile path must be absolute.");
  if (path3.extname(rawPath).toLowerCase() !== ".json")
    throw new Error("Profile must be a .json file.");
  const canonical = await realpath(rawPath);
  assertAllowed(canonical, [...config2.profileRoots, ...config2.allowedInputRoots], "Profile file");
  const details = await stat(canonical);
  if (!details.isFile()) throw new Error("Profile path is not a regular file.");
  if (details.size > 10 * 1024 * 1024) throw new Error("Profile file exceeds the 10 MB limit.");
  return canonical;
}
function validateOutputRoot(rawPath, config2) {
  if (!path3.isAbsolute(rawPath)) throw new Error("Output directory must be absolute.");
  const resolved = path3.resolve(rawPath);
  assertAllowed(resolved, config2.allowedOutputRoots, "Output directory");
  return resolved;
}
async function createPrivateDirectory(directory) {
  await mkdir(directory, { recursive: false, mode: 448 });
}
function safePreview(args) {
  return args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ");
}

// src/jobs.ts
var JobStore = class {
  constructor(config2) {
    this.config = config2;
  }
  config;
  jobs = /* @__PURE__ */ new Map();
  prepare(request2) {
    const id = randomUUID();
    const outputDirectory = path4.join(request2.outputRoot, id);
    const createdAt = /* @__PURE__ */ new Date();
    const expiresAt = new Date(createdAt.getTime() + 15 * 6e4);
    const job = {
      id,
      status: "prepared",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      request: request2,
      args: buildSliceArgs(request2, outputDirectory),
      outputDirectory,
    };
    this.jobs.set(id, job);
    return job;
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job ID. Prepare a new slicing job.");
    if (job.status === "prepared" && Date.now() > Date.parse(job.expiresAt)) {
      job.status = "expired";
    }
    return job;
  }
  async run(id) {
    const job = this.get(id);
    if (job.status !== "prepared") throw new Error(`Job cannot run from status '${job.status}'.`);
    if (!this.config.slicerExe) throw new Error("Anycubic Slicer Next executable was not found.");
    await mkdir2(job.request.outputRoot, { recursive: true, mode: 448 });
    await createPrivateDirectory(job.outputDirectory);
    job.status = "running";
    await this.audit("slice_started", job);
    try {
      const result = await runSlicerProcess(
        this.config.slicerExe,
        job.args,
        this.config.sliceTimeoutMs,
      );
      job.exitCode = result.exitCode;
      job.artifacts = await collectArtifacts(job);
      if (result.exitCode !== 0) {
        throw new Error(
          `Slicer exited with code ${result.exitCode}: ${result.stderr.slice(0, 1e3)}`,
        );
      }
      if (job.artifacts.length === 0)
        throw new Error("Slicer completed without producing a supported artifact.");
      job.status = "completed";
      await this.audit("slice_completed", job);
      return job;
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      await this.audit("slice_failed", job);
      throw error;
    }
  }
  preview(job) {
    return `${this.config.slicerExe ?? "AnycubicSlicerNext.exe"} ${safePreview(job.args)}`;
  }
  async audit(event, job) {
    await mkdir2(path4.dirname(this.config.auditLogPath), { recursive: true, mode: 448 });
    const record = {
      timestamp: /* @__PURE__ */ new Date().toISOString(),
      event,
      job_id: job.id,
      status: job.status,
      input_name: path4.basename(job.request.inputPath),
      output_directory: job.outputDirectory,
      output_format: job.request.outputFormat,
      exit_code: job.exitCode,
      error: job.error,
    };
    await appendFile(
      this.config.auditLogPath,
      `${JSON.stringify(record)}
`,
      { encoding: "utf8", mode: 384 },
    );
  }
};

// src/profiles.ts
import { readdir as readdir2, readFile } from "node:fs/promises";
import path5 from "node:path";
function inferKind(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  if (normalized.includes("/machine/") || normalized.includes("/machine_model/")) return "machine";
  if (normalized.includes("/process/")) return "process";
  if (normalized.includes("/filament/")) return "filament";
  return void 0;
}
function inferSource(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  if (normalized.includes("/user/") || normalized.includes("/user\\")) return "user";
  if (normalized.includes("/system/") || normalized.includes("\\system\\")) return "system";
  if (normalized.includes("appdata/roaming/anycubicslicernext")) return "user";
  return "system";
}
async function walk(root, output, remaining) {
  if (remaining.count <= 0) return;
  const entries = await readdir2(root, { withFileTypes: true });
  for (const entry of entries) {
    if (remaining.count <= 0) return;
    const fullPath = path5.join(root, entry.name);
    if (entry.isDirectory()) {
      const dirName = entry.name.toLocaleLowerCase("en-US");
      if (dirName === "ota" || dirName.startsWith("backup")) continue;
      await walk(fullPath, output, remaining);
    } else if (entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".json")) {
      output.push(fullPath);
      remaining.count -= 1;
    }
  }
}
async function profileName(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (typeof parsed.name === "string" && parsed.name.trim()) return parsed.name.trim();
  } catch {}
  return path5.basename(filePath, ".json");
}
async function listProfiles(roots, kind, query, limit) {
  const loweredQuery = query?.toLocaleLowerCase("en-US");
  const profiles = [];
  for (const root of roots) {
    const candidates = [];
    const walkOpts = { count: 5e3 };
    await walk(root, candidates, walkOpts);
    const userCandidates = candidates.filter((c) => inferSource(c) === "user");
    const otherCandidates = candidates.filter((c) => inferSource(c) !== "user");
    const orderedCandidates = [...userCandidates, ...otherCandidates];
    for (const candidate of orderedCandidates) {
      const inferred = inferKind(candidate);
      if (!inferred || (kind !== "all" && kind !== inferred)) continue;
      const name = await profileName(candidate);
      if (loweredQuery && !name.toLocaleLowerCase("en-US").includes(loweredQuery)) continue;
      profiles.push({ kind: inferred, name, path: candidate, source: inferSource(candidate) });
    }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles.slice(0, limit);
}

// src/schemas.ts
import { z } from "zod";
var unknownRecord = z.record(z.string(), z.unknown());
var settingsSchema = z
  .object({
    layer_height_mm: z.number().min(0.05).max(1).optional(),
    infill_density_percent: z.number().min(0).max(100).optional(),
    wall_loops: z.number().int().min(1).max(20).optional(),
    supports: z.boolean().optional(),
    infill_pattern: z.enum(["grid", "gyroid", "honeycomb", "rectilinear"]).optional(),
    outer_wall_speed_mms: z.number().min(10).max(600).optional(),
    inner_wall_speed_mms: z.number().min(10).max(600).optional(),
    sparse_infill_speed_mms: z.number().min(10).max(600).optional(),
    solid_infill_speed_mms: z.number().min(10).max(600).optional(),
    top_surface_speed_mms: z.number().min(10).max(600).optional(),
    top_shell_layers: z.number().int().min(1).max(30).optional(),
    bottom_shell_layers: z.number().int().min(1).max(30).optional(),
    seam_position: z.enum(["aligned", "nearest", "back", "front", "random"]).optional(),
    pressure_advance: z.number().min(0).max(1).optional(),
    elephant_foot_compensation_mm: z.number().min(0).max(1).optional(),
    brim_width_mm: z.number().min(0).max(20).optional(),
    nozzle_temperature_c: z.number().min(150).max(300).optional(),
    bed_temperature_c: z.number().min(20).max(120).optional(),
  })
  .strict();
var inspectInputSchema = z.object({}).strict();
var listProfilesInputSchema = z
  .object({
    kind: z.enum(["machine", "process", "filament", "all"]).default("all"),
    query: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(1e3).default(50),
  })
  .strict();
var openSlicerInputSchema = z.object({}).strict();
var openModelInputSchema = z
  .object({
    input_path: z.string().min(1),
  })
  .strict();
var prepareJobInputSchema = z
  .object({
    input_path: z.string().min(1),
    machine_profile: z.string().min(1),
    process_profile: z.string().min(1),
    filament_profiles: z.array(z.string().min(1)).min(1).max(16),
    output_directory: z.string().min(1).optional(),
    output_format: z.enum(["gcode", "gcode_3mf", "both"]).default("both"),
    plate: z.number().int().min(0).max(64).default(0),
    arrange: z.boolean().default(true),
    orient: z.boolean().default(false),
    settings: settingsSchema.default({}),
  })
  .strict();
var runJobInputSchema = z
  .object({
    job_id: z.string().uuid(),
    confirmation: z.literal("RUN"),
  })
  .strict();
var getJobInputSchema = z
  .object({
    job_id: z.string().uuid(),
  })
  .strict();
var discoverPrintersInputSchema = z
  .object({
    timeout_ms: z.number().int().min(100).max(15e3).default(4e3),
    scan_ports: z.array(z.number().int().min(1).max(65535)).max(8).optional(),
  })
  .strict();
var printerStatusInputSchema = z
  .object({
    dev_id: z.string().min(1).max(64),
    dev_ip: z.string().min(1).max(64),
    access_code: z.string().min(1).max(64).optional(),
    // Kobra 3/4/S1/X LAN Mode uses the printer-reported MQTT broker, normally TLS 9883.
    mqtt_port: z.number().int().min(1).max(65535).default(9883),
    use_ssl_mqtt: z.boolean().default(true),
    timeout_ms: z.number().int().min(500).max(2e4).default(8e3),
  })
  .strict();
var sendToPrinterInputSchema = z
  .object({
    dev_id: z.string().min(1).max(64),
    dev_ip: z.string().min(1).max(64),
    access_code: z.string().min(1).max(64).optional(),
    local_file: z.string().min(1),
    remote_name: z.string().max(180).optional(),
    ftp_port: z.number().int().min(1).max(65535).default(990),
    use_ssl_ftp: z.boolean().default(true),
  })
  .strict();
var startPrintInputSchema = z
  .object({
    dev_id: z.string().min(1).max(64),
    dev_ip: z.string().min(1).max(64),
    access_code: z.string().min(1).max(64).optional(),
    task_name: z.string().min(1).max(180),
    file_remote_path: z.string().min(1).max(300),
    profile_name: z.string().max(180).optional(),
    bed_type: z.string().max(32).optional(),
    bed_leveling: z.boolean().default(true),
    flow_cali: z.boolean().default(false),
    vibration_cali: z.boolean().default(false),
    layer_inspect: z.boolean().default(true),
    record_timelapse: z.boolean().default(false),
    use_ams: z.boolean().default(false),
    mqtt_port: z.number().int().min(1).max(65535).default(8883),
    use_ssl_mqtt: z.boolean().default(true),
    timeout_ms: z.number().int().min(500).max(3e4).default(15e3),
  })
  .strict();
var cancelPrintInputSchema = z
  .object({
    dev_id: z.string().min(1).max(64),
    dev_ip: z.string().min(1).max(64),
    access_code: z.string().min(1).max(64).optional(),
    command: z
      .enum(["task_cancel", "task_pause", "task_resume", "print_stop"])
      .default("task_cancel"),
    mqtt_port: z.number().int().min(1).max(65535).default(8883),
    use_ssl_mqtt: z.boolean().default(true),
  })
  .strict();
var accountLoginInputSchema = z
  .object({
    access_token: z.string().min(1).max(2048).optional(),
    region: z.enum(["en", "cn"]).default("en"),
    timeout_ms: z.number().int().min(500).max(3e4).default(15e3),
  })
  .strict();
var accountDevicesInputSchema = z
  .object({
    region: z.enum(["en", "cn"]).default("en"),
    timeout_ms: z.number().int().min(500).max(3e4).default(15e3),
    /** Optional status filter: true = online only, false = offline only, undefined = all. */
    device_status: z.boolean().optional(),
  })
  .strict();
var accountFilesInputSchema = z
  .object({
    region: z.enum(["en", "cn"]).default("en"),
    timeout_ms: z.number().int().min(500).max(3e4).default(15e3),
    query: z.string().max(180).optional(),
  })
  .strict();
var accountCloudDiagnosticsInputSchema = z
  .object({
    kind: z.enum([
      "printers_status",
      "printer_status",
      "printer_info",
      "printer_tool",
      "printer_functions",
      "printer_all",
      "print_history",
      "print_history_detail",
      "project_info",
      "project_monitor",
      "work_project_error_list",
      "project_list",
      "gcode_info_fdm",
      "gcode_info",
      "cloud_file_info",
      "model_file_info",
      "multi_color_box_info",
      "video_thumbnail_list",
    ]),
    printer_id: z.number().int().min(1).optional(),
    project_id: z.number().int().min(1).optional(),
    task_id: z.number().int().min(1).optional(),
    file_id: z.number().int().min(1).optional(),
    gcode_id: z.number().int().min(1).optional(),
    device_id: z.string().min(1).max(256).optional(),
    model_id: z.number().int().min(1).optional(),
    type_function_id: z.number().int().min(1).optional(),
    page: z.number().int().min(1).max(1e3).default(1),
    print_status: z.number().int().min(0).max(100).optional(),
    region: z.enum(["en", "cn"]).default("en"),
    timeout_ms: z.number().int().min(500).max(3e4).default(15e3),
  })
  .strict();
var accountCloudDiagnosticsOutputSchema = z
  .object({
    ok: z.boolean(),
    diagnostic: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var accountFilesOutputSchema = z
  .object({
    ok: z.boolean(),
    count: z.number().int().optional(),
    files: z.array(unknownRecord).optional(),
    token: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var accountPrintInputSchema = z
  .object({
    printer_key: z.string().min(1).max(64),
    file_key: z.string().max(512).optional(),
    file_id: z.number().int().min(1).optional(),
    /** Cloud gcode id (gcode_id) shown in the account_files record. */
    gcode_id: z.number().int().min(1).optional(),
    /** Device delivery path accepted by the sendOrder validator (defaults to file_key). */
    filepath: z.string().max(2048).optional(),
    file_name: z.string().min(1).max(180),
    /** Enable the printer's AI inspection for this cloud job. */
    ai_detect: z.boolean().default(false),
    /** Enable camera timelapse for this cloud job. */
    camera_timelapse: z.boolean().default(false),
    region: z.enum(["en", "cn"]).default("en"),
    timeout_ms: z.number().int().min(500).max(3e4).default(15e3),
  })
  .strict();
var accountInfoOutputSchema = z
  .object({
    ok: z.boolean(),
    token: z.string().optional(),
    user_id: z.number().int().optional(),
    user_email: z.string().optional(),
    region: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var accountDevicesOutputSchema = z
  .object({
    ok: z.boolean(),
    count: z.number().int().optional(),
    devices: z.array(unknownRecord).optional(),
    token: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var accountPrintOutputSchema = z
  .object({
    ok: z.boolean(),
    order_id: z.number().int().optional(),
    task_id: z.string().optional(),
    printer_key: z.string().optional(),
    file_name: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var accountCaptureTokenInputSchema = z
  .object({
    mode: z.enum(["scan", "watch"]).default("scan"),
    max_seconds: z.number().int().min(5).max(600).default(90),
    region: z.enum(["en", "cn"]).default("en"),
  })
  .strict();
var sliceViaAppInputSchema = z
  .object({
    input_path: z.string().max(2048).optional(),
    slice_all: z.boolean().default(true),
    export_gcode: z.boolean().default(true),
    export_project: z.boolean().default(false),
    max_wait_ms: z.number().int().min(1e4).max(12e4).default(3e4),
  })
  .strict();
var sliceViaAppOutputSchema = z
  .object({
    ok: z.boolean(),
    exported: z.boolean().optional(),
    file_path: z.string().optional(),
    compatibility: unknownRecord.optional(),
    note: z.string().optional(),
    hint: z.string().optional(),
    next_steps: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .strict();
var accountTokenStatusInputSchema = z
  .object({
    include_token: z.boolean().default(false),
  })
  .strict();
var accountTokenStatusOutputSchema = z
  .object({
    ok: z.boolean(),
    stored: z.boolean(),
    sub: z.string().optional(),
    email: z.string().optional(),
    expires_at: z.string().optional(),
    captured_at: z.string().optional(),
    source: z.string().optional(),
    region: z.string().optional(),
    token: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var accountTokenClearedOutputSchema = z
  .object({
    ok: z.boolean(),
    cleared: z.boolean(),
    error: z.string().optional(),
  })
  .strict();
var inspectOutputSchema = z
  .object({
    ok: z.boolean(),
    installation: unknownRecord.optional(),
    ui_automation: unknownRecord.optional(),
    allowed_input_roots: z.array(z.string()).optional(),
    allowed_output_roots: z.array(z.string()).optional(),
    profile_roots: z.array(z.string()).optional(),
    capabilities: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var profilesOutputSchema = z
  .object({
    ok: z.boolean(),
    count: z.number().int().optional(),
    profiles: z.array(unknownRecord).optional(),
    error: z.string().optional(),
  })
  .strict();
var actionOutputSchema = z
  .object({
    ok: z.boolean(),
    status: z.string().optional(),
    executable: z.string().optional(),
    input_path: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var prepareOutputSchema = z
  .object({
    ok: z.boolean(),
    job_id: z.string().uuid().optional(),
    status: z.string().optional(),
    expires_at: z.string().optional(),
    output_directory: z.string().optional(),
    command_preview: z.string().optional(),
    confirmation_required: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var jobOutputSchema = z
  .object({
    ok: z.boolean(),
    job_id: z.string().uuid().optional(),
    status: z.string().optional(),
    created_at: z.string().optional(),
    expires_at: z.string().optional(),
    exit_code: z.number().optional(),
    output_directory: z.string().optional(),
    artifacts: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .strict();
var printersOutputSchema = z
  .object({
    ok: z.boolean(),
    printers: z.array(unknownRecord).optional(),
    count: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict();
var printerStatusOutputSchema = z
  .object({
    ok: z.boolean(),
    status: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var printerDiagnosticsOutputSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var printerCapabilityCatalogInputSchema = z.object({}).strict();
var printerCapabilityCatalogOutputSchema = z
  .object({
    ok: z.boolean(),
    catalog: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var printerLanCommandPreviewInputSchema = z
  .object({
    model_id: z.string().min(1).max(32).default("20025"),
    mqtt_device_id: z.string().min(1).max(80).optional(),
    command: z.enum([
      "pause_print",
      "resume_print",
      "stop_print",
      "update_print",
      "move_axis",
      "query_axis",
      "turn_off_motors",
      "set_temperature",
      "set_fan",
      "query_peripherals",
      "query_light",
      "control_light",
      "ace_get_info",
      "ace_dry",
      "ace_feed",
      "ace_set_slot",
      "ace_auto_feed",
    ]),
    task_id: z.string().max(180).optional(),
    settings: unknownRecord.optional(),
    axis: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    move_type: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    distance_mm: z.number().min(0).max(300).optional(),
    nozzle_temperature_c: z.number().min(0).max(350).optional(),
    bed_temperature_c: z.number().min(0).max(150).optional(),
    fan: z.enum(["part", "aux", "box"]).optional(),
    fan_speed_pct: z.number().min(0).max(100).optional(),
    light_type: z.number().int().min(0).max(32).optional(),
    light_status: z.union([z.literal(0), z.literal(1)]).optional(),
    brightness: z.number().int().min(0).max(100).optional(),
    box_id: z.number().int().min(0).max(32).optional(),
    slot_index: z.number().int().min(-1).max(15).optional(),
    feed_type: z.union([z.literal(1), z.literal(2)]).optional(),
    material_type: z.string().max(80).optional(),
    color: z.string().max(32).optional(),
    drying_duration: z.number().int().min(0).max(86400).optional(),
    drying_status: z.number().int().min(0).max(8).optional(),
    drying_target_temperature_c: z.number().min(0).max(100).optional(),
    auto_feed: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .strict();
var printerLanCommandPreviewOutputSchema = z
  .object({
    ok: z.boolean(),
    preview: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var slicerComponentInventoryInputSchema = z.object({}).strict();
var slicerComponentInventoryOutputSchema = z
  .object({
    ok: z.boolean(),
    inventory: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var printerMonitorInputSchema = printerStatusInputSchema
  .extend({
    samples: z.number().int().min(1).max(12).default(3),
    interval_ms: z.number().int().min(250).max(3e4).default(1e3),
  })
  .strict();
var printerMonitorOutputSchema = z
  .object({
    ok: z.boolean(),
    samples: z.array(unknownRecord).optional(),
    requested_samples: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict();
var auditGcodeRecoveryInputSchema = z
  .object({
    gcode_path: z.string().min(1),
    /** Slicer layer number or physical layer number to inspect. */
    start_layer: z.number().int().min(0).max(1e5).optional(),
  })
  .strict();
var auditGcodeRecoveryOutputSchema = z
  .object({
    ok: z.boolean(),
    audit: unknownRecord.optional(),
    error: z.string().optional(),
  })
  .strict();
var sendToPrinterOutputSchema = z
  .object({
    ok: z.boolean(),
    remote_path: z.string().optional(),
    bytes: z.number().int().optional(),
    md5: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var startPrintOutputSchema = z
  .object({
    ok: z.boolean(),
    task_name: z.string().optional(),
    dev_id: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var cancelPrintOutputSchema = z
  .object({
    ok: z.boolean(),
    command: z.string().optional(),
    dev_id: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var cadOpenInputSchema = z
  .object({
    /** Preload an existing STL/OBJ/3MF file (absolute path, allowed root). */
    input_path: z.string().min(1).optional(),
    /** Port to bind (0 = ephemeral). Default 0. */
    port: z.number().int().min(0).max(65535).optional(),
    /** Idle timeout in minutes when no HTTP activity; 0 = keep running. */
    idle_timeout_min: z.number().int().min(0).max(240).optional(),
    /** Open the default browser. Default true. */
    open_browser: z.boolean().default(true),
  })
  .strict();
var cadOpenOutputSchema = z
  .object({
    ok: z.boolean(),
    url: z.string().optional(),
    token: z.string().optional(),
    output_root: z.string().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
var cadCloseInputSchema = z
  .object({
    force: z.boolean().default(false),
  })
  .strict();
var cadCloseOutputSchema = z
  .object({
    ok: z.boolean(),
    stopped: z.boolean().optional(),
    error: z.string().optional(),
  })
  .strict();
var cadFacesInputSchema = z
  .object({
    /** Face-group name or explicit face ids to use for subsequent operations. */
    object: z.string().min(1),
    /** Explicit triangle indices (0-based, from the /mesh payload). */
    face_ids: z.array(z.number().int().min(0)).optional(),
    /** Auto-derive a planar region from one seed face (grow by angle). */
    grow_from_face: z.number().int().min(0).optional(),
    /** Max angle when growing (default 15 deg). */
    grow_angle_deg: z.number().min(1).max(180).optional(),
  })
  .strict();
var cadFacesOutputSchema = z
  .object({
    ok: z.boolean(),
    object: z.string().optional(),
    face_ids: z.array(z.number().int()).optional(),
    count: z.number().int().optional(),
    groups: z.array(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .strict();
var cadEditMeshInputSchema = z
  .object({
    object: z.string().min(1),
    /** extrude | bevel | inset | subdivide | sculpt | weld */
    op: z.enum(["extrude", "bevel", "inset", "subdivide", "sculpt", "weld"]),
    face_ids: z.array(z.number().int().min(0)).optional(),
    amount: z.number().optional(),
    smooth: z.boolean().optional(),
  })
  .strict();
var cadEditMeshOutputSchema = z
  .object({
    ok: z.boolean(),
    revision: z.number().int().optional(),
    vertices: z.number().int().optional(),
    triangles: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict();
var cadTextureInputSchema = z
  .object({
    object: z.string().min(1),
    /** [r, g, b] 0..255 */
    color: z.array(z.number().int().min(0).max(255)).length(3).optional(),
    texture_url: z.string().min(1).optional(),
    /** Relief height in mm when applying a displacement image. */
    relief_mm: z.number().min(0).max(50).optional(),
    /** Image payload (base64) for a per-face relief displacement. */
    image_base64: z.string().min(1).optional(),
    face_ids: z.array(z.number().int().min(0)).optional(),
  })
  .strict();
var cadTextureOutputSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
  })
  .strict();
var cadImageTo3dInputSchema = z
  .object({
    /** Image file path (allowed root) or base64 payload. */
    image_path: z.string().min(1).optional(),
    image_base64: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    width: z.number().int().min(8).max(256).optional(),
    height: z.number().int().min(8).max(256).optional(),
    depth_mm: z.number().min(0.5).max(100).optional(),
    base_mm: z.number().min(0).max(50).optional(),
  })
  .strict();
var cadImageTo3dOutputSchema = z
  .object({
    ok: z.boolean(),
    name: z.string().optional(),
    triangles: z.number().int().optional(),
    size_mm: z.record(z.string(), z.number()).optional(),
    error: z.string().optional(),
  })
  .strict();

// src/windows.ts
import { execFile, spawn as spawn2 } from "node:child_process";
import { stat as stat2 } from "node:fs/promises";
import path6 from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function isSlicerRunning(executable) {
  const imageName = path6.basename(executable);
  try {
    const { stdout } = await execFileAsync(
      "tasklist.exe",
      ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
      {
        windowsHide: true,
        timeout: 5e3,
      },
    );
    return stdout.toLocaleLowerCase("en-US").includes(imageName.toLocaleLowerCase("en-US"));
  } catch {
    return false;
  }
}
async function inspectExecutable(executable) {
  const details = await stat2(executable);
  const running = await isSlicerRunning(executable);
  return {
    installed: true,
    executable,
    size_bytes: details.size,
    running,
  };
}
async function launchSlicer(executable, inputPath) {
  const args = inputPath ? [inputPath] : [];
  const child = spawn2(executable, args, {
    cwd: path6.dirname(executable),
    detached: true,
    shell: false,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
}
async function inspectUia(pluginRoot3) {
  return runUiaBridge(pluginRoot3, ["-Action", "inspect"]);
}
var SAFE_CLICK_ALIASES = [
  "Preparar",
  "Prepare",
  "Fatiar Disco \xDAnico",
  "Fatiar todos",
  "Slice plate",
  "Slice all",
  "Salvar Projeto",
  "Save Project",
  "Exportar G-code",
  "Export G-code",
];
var SAFE_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Up",
  "Down",
  "Left",
  "Right",
  "Ctrl+S",
  "Ctrl+Shift+S",
  "Ctrl+O",
  "Ctrl+P",
  "F5",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];
async function runUiaBridge(pluginRoot3, args, extraEnv = {}) {
  const script = path6.join(pluginRoot3, "scripts", "uia-bridge.ps1");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        ...args,
      ],
      {
        windowsHide: true,
        timeout: 12e3,
        maxBuffer: 512 * 1024,
        env: { ...process.env, ...extraEnv },
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function uiaTree(pluginRoot3, maxDepth = 8, maxChildren = 200) {
  return runUiaBridge(pluginRoot3, [
    "-Action",
    "tree",
    "-MaxDepth",
    String(maxDepth),
    "-MaxChildren",
    String(maxChildren),
  ]);
}
async function uiaRead(pluginRoot3) {
  return runUiaBridge(pluginRoot3, ["-Action", "read"]);
}
async function uiaClick(pluginRoot3, name) {
  if (!SAFE_CLICK_ALIASES.includes(name)) {
    throw new Error(
      `Unsafe UIA click target: '${name}'. Allowed: ${SAFE_CLICK_ALIASES.join(", ")}`,
    );
  }
  return runUiaBridge(pluginRoot3, ["-Action", "click"], { UIA_BRIDGE_CLICK_NAME: name });
}
async function uiaType(pluginRoot3, text) {
  if (text.length > 500) throw new Error("UIA type text too long (max 500 characters).");
  if (!/^[\x20-\x7E]+$/.test(text)) throw new Error("Only printable ASCII text can be typed.");
  return runUiaBridge(pluginRoot3, ["-Action", "type", "-Text", text]);
}
async function uiaKey(pluginRoot3, key) {
  if (!SAFE_KEYS.includes(key)) {
    throw new Error(`Unsafe UIA key: '${key}'. Allowed: ${SAFE_KEYS.join(", ")}`);
  }
  return runUiaBridge(pluginRoot3, ["-Action", "key", "-Key", key]);
}

// src/printer.ts
import { connect } from "mqtt";
import { Client as FtpClient } from "basic-ftp";
import { createDecipheriv, createHash, randomBytes, randomUUID as randomUUID2 } from "node:crypto";
import { createConnection } from "node:net";
import { stat as stat3 } from "node:fs/promises";
import os from "node:os";
import path7 from "node:path";
function sanitizeAccessCode(code) {
  return code.trim().replace(/[^0-9a-zA-Z]/g, "");
}
function normalizeDevId(devId) {
  return devId.trim().toLocaleUpperCase("en-US");
}
function parseFtpFolder(folder) {
  return folder.endsWith("/") ? folder : `${folder}/`;
}
function createMqttClient(ip, devId, accessCode, port = 8883, useTls = true) {
  const protocol = useTls ? "mqtts" : "mqtt";
  const url = `${protocol}://${ip}:${port}`;
  try {
    return connect(url, {
      username: "bblp",
      password: sanitizeAccessCode(accessCode),
      clientId: `mcp_${process.pid}_${randomUUID2().slice(0, 8)}`,
      connectTimeout: 6e3,
      keepalive: 30,
      reconnectPeriod: 0,
      clean: true,
      rejectUnauthorized: false,
    });
  } catch {
    return void 0;
  }
}
var ANYCUBIC_LAN_PREFIX = "anycubic/anycubicCloud/v1";
var ANYCUBIC_INFO_PORT = 18910;
var ANYCUBIC_MQTT_PORT = 9883;
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function md5Hex(value) {
  return createHash("md5").update(value).digest("hex");
}
function anycubicLanSign(token, timestamp, nonce) {
  return md5Hex(`${md5Hex(token.slice(0, 16))}${timestamp}${nonce}`);
}
function randomAlphaNumeric(length2, upper = false) {
  const alphabet = upper
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length2);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
function parseMac(usn) {
  const match = String(usn ?? "").match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
  return match?.[0];
}
async function fetchLanJson(url, method, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`HTTP ${response.status} from ${method} ${new URL(url).pathname}`);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`invalid JSON from ${method} ${new URL(url).pathname}`);
    }
    const record = asRecord(parsed);
    if (!record) throw new Error(`unexpected response from ${method} ${new URL(url).pathname}`);
    return record;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchAnycubicLanInfo(ip, timeoutMs = 6e3) {
  return await fetchLanJson(`http://${ip}:${ANYCUBIC_INFO_PORT}/info`, "GET", timeoutMs);
}
function decryptLanCredentials(encryptedInfo, printerToken, localToken) {
  const key = Buffer.from(printerToken.slice(16, 32), "ascii");
  const iv = Buffer.alloc(16);
  Buffer.from(localToken, "ascii").copy(iv, 0, 0, 16);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedInfo, "base64")),
    decipher.final(),
  ]);
  const parsed = asRecord(JSON.parse(plaintext.toString("utf8")));
  if (!parsed) throw new Error("/ctrl decrypted payload was not an object");
  return parsed;
}
async function anycubicLanHandshake(ip, timeoutMs = 6e3) {
  const info = await fetchAnycubicLanInfo(ip, timeoutMs);
  if (String(info.ctrlType ?? "").toLowerCase() === "cloud") {
    throw new Error("Printer is in CLOUD mode; enable LAN Mode on the printer.");
  }
  const printerToken = typeof info.token === "string" ? info.token : "";
  const modelId = String(info.modelId ?? "");
  if (printerToken.length < 32 || !modelId) {
    throw new Error("Printer did not expose the signed LAN handshake fields (token/modelId).");
  }
  const ts = Date.now();
  const nonce = randomAlphaNumeric(6);
  const did = randomAlphaNumeric(32, true);
  const sign = anycubicLanSign(printerToken, ts, nonce);
  const ctrlUrl = new URL(info.ctrlInfoUrl ?? `http://${ip}:${ANYCUBIC_INFO_PORT}/ctrl`);
  ctrlUrl.search = new URLSearchParams({ ts: String(ts), nonce, sign, did }).toString();
  const ctrl = await fetchLanJson(ctrlUrl.toString(), "POST", timeoutMs);
  if (Number(ctrl.code) !== 200)
    throw new Error(`/ctrl failed: ${String(ctrl.message ?? "unknown error")}`);
  const data = asRecord(ctrl.data);
  const localToken = typeof data?.token === "string" ? data.token : "";
  const encryptedInfo = typeof data?.info === "string" ? data.info : "";
  if (!localToken || !encryptedInfo)
    throw new Error("/ctrl response did not contain encrypted credentials.");
  const credentials = decryptLanCredentials(encryptedInfo, printerToken, localToken);
  const broker = typeof credentials.broker === "string" ? new URL(credentials.broker) : void 0;
  const username = typeof credentials.username === "string" ? credentials.username : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";
  const deviceId = typeof credentials.deviceId === "string" ? credentials.deviceId : "";
  if (!broker || !username || !password || !deviceId) {
    throw new Error("/ctrl credentials were incomplete.");
  }
  const mac = parseMac(info.usn);
  return {
    brokerHost: broker.hostname || ip,
    brokerPort: Number(broker.port || ANYCUBIC_MQTT_PORT),
    username,
    password,
    deviceId,
    modelId,
    serial: String(info.cn ?? ""),
    ...(typeof info.modelName === "string" ? { modelName: info.modelName } : {}),
    ...(mac ? { mac } : {}),
    info,
  };
}
function numberAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return void 0;
}
function readPosition(value) {
  const record = asRecord(value);
  if (!record) return void 0;
  const x = numberAt(record.x ?? record.X ?? record.pos_x ?? record.position_x ?? record.current_x);
  const y = numberAt(record.y ?? record.Y ?? record.pos_y ?? record.position_y ?? record.current_y);
  const z3 = numberAt(
    record.z ?? record.Z ?? record.pos_z ?? record.position_z ?? record.current_z,
  );
  if (x === void 0 && y === void 0 && z3 === void 0) return void 0;
  return {
    ...(x === void 0 ? {} : { x }),
    ...(y === void 0 ? {} : { y }),
    ...(z3 === void 0 ? {} : { z: z3 }),
  };
}
function findPosition(value) {
  const record = asRecord(value);
  if (!record) return void 0;
  for (const key of [
    "position",
    "head_position",
    "current_position",
    "axis_position",
    "coordinate",
    "coordinates",
    "pos",
  ]) {
    const position = readPosition(record[key]);
    if (position) return position;
  }
  const direct = readPosition(record);
  if (direct) return direct;
  for (const child of Object.values(record)) {
    const nested = findPosition(child);
    if (nested) return nested;
  }
  return void 0;
}
function redactLanValue(value, key = "") {
  if (typeof value === "string") {
    if (/password|secret/i.test(key)) return "<redacted>";
    if (/([?&]s=)[^&]*/i.test(value)) return value.replace(/([?&]s=)[^&]*/gi, "$1<redacted>");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactLanValue(item, key));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([childKey, childValue]) => [
      childKey,
      redactLanValue(childValue, childKey),
    ]),
  );
}
function applyLanData(status, data, type) {
  const temp = asRecord(data.temp) ?? data;
  const project = asRecord(data.project) ?? asRecord(data.last_project) ?? data;
  const read = (keys) => keys.map((key) => data[key] ?? temp[key]).find((v) => v !== void 0);
  const bed = read(["curr_hotbed_temp", "bed_temper", "bed_temp"]);
  const nozzle = read(["curr_nozzle_temp", "nozzle_temper", "nozzle_temp"]);
  const bedTarget = read(["target_hotbed_temp", "bed_target_temper", "bed_target_temp"]);
  const nozzleTarget = read(["target_nozzle_temp", "nozzle_target_temper", "nozzle_target_temp"]);
  const bedValue = numberAt(bed);
  const nozzleValue = numberAt(nozzle);
  const bedTargetValue = numberAt(bedTarget);
  const nozzleTargetValue = numberAt(nozzleTarget);
  if (bedValue !== void 0) status.bed_temper = bedValue;
  if (nozzleValue !== void 0) status.nozzle_temper = nozzleValue;
  if (bedTargetValue !== void 0) status.bed_target_temper = bedTargetValue;
  if (nozzleTargetValue !== void 0) status.nozzle_target_temper = nozzleTargetValue;
  if (typeof data.state === "string") status.state = data.state;
  const deviceStatus = numberAt(data.device_status ?? data.deviceStatus);
  const readyStatus = numberAt(data.ready_status ?? data.readyStatus);
  const errorCode = numberAt(data.error_code ?? data.errorCode ?? data.reason_id);
  if (deviceStatus !== void 0) status.device_status = deviceStatus;
  if (readyStatus !== void 0) status.ready_status = readyStatus;
  if (errorCode !== void 0 && errorCode !== 200 && errorCode !== 0)
    status.latest_error_code = errorCode;
  const errorMessage = data.error_message ?? data.errorMessage ?? data.reason;
  if (typeof errorMessage === "string" && errorMessage.trim())
    status.latest_error_message = errorMessage;
  if (typeof project.state === "string") status.gcode_state = project.state;
  const progress = numberAt(project.progress);
  const currentLayer = numberAt(project.curr_layer ?? project.current_layer);
  const totalLayers = numberAt(project.total_layers);
  const remain = numberAt(project.remain_time);
  const printTime = numberAt(project.print_time);
  if (progress !== void 0) status.mc_percent = progress;
  if (currentLayer !== void 0) status.current_layer = currentLayer;
  if (totalLayers !== void 0) status.total_layers = totalLayers;
  if (remain !== void 0) status.remain_time_min = remain;
  if (printTime !== void 0) status.print_time_sec = printTime;
  if (typeof project.filename === "string") status.filename = project.filename;
  const chamber = numberAt(data.curr_chamber_temp ?? temp.curr_chamber_temp ?? temp.chamber_temp);
  if (chamber !== void 0) status.chamber_temper = chamber;
  const fanValues = {};
  for (const key of [
    "fan_speed_pct",
    "aux_fan_speed_pct",
    "box_fan_level",
    "fan_speed",
    "aux_fan_speed",
  ]) {
    const value = numberAt(data[key]);
    if (value !== void 0) fanValues[key] = value;
  }
  if (Object.keys(fanValues).length) status.fans = fanValues;
  if (Array.isArray(data.lights)) status.lights = data.lights;
  const fanSpeed = numberAt(data.fan_speed_pct);
  if (fanSpeed !== void 0) status.speed_lvl = fanSpeed;
  const position = findPosition(data);
  if (position) status.position = { ...(status.position ?? {}), ...position };
  if (type === "status" && typeof data.action === "string") status.state = data.action;
}
function parseLanReports(reports, credentials, requestedDevId) {
  const status = {
    online: true,
    protocol: "anycubic_lan",
    dev_id: requestedDevId || credentials.serial,
    ...(typeof credentials.info.ip === "string" ? { ip: credentials.info.ip } : {}),
    model_id: credentials.modelId,
    ...(credentials.modelName ? { model_name: credentials.modelName } : {}),
    serial: credentials.serial,
    mqtt_device_id: credentials.deviceId,
    ...(credentials.mac ? { mac: credentials.mac } : {}),
    reports: redactLanValue(reports),
  };
  for (const [type, data] of Object.entries(reports)) applyLanData(status, data, type);
  const info = reports.info;
  if (info) {
    const project = asRecord(info.project) ?? asRecord(info.last_project);
    if (typeof info.state === "string" && info.state === "free") status.state = "idle";
    if (typeof info.version === "string") status.raw = { firmware: info.version };
    if (project && typeof project.pause === "number")
      status.raw = { ...(status.raw ?? {}), pause: project.pause };
  }
  status.raw = {
    ...(status.raw ?? {}),
    handshake: { model_id: credentials.modelId, mqtt_device_id: credentials.deviceId },
  };
  return status;
}
async function queryAnycubicLanStatus(ip, devId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8e3;
  const credentials = await anycubicLanHandshake(ip, Math.min(timeoutMs, 6e3));
  const port = opts.mqtt_port ?? credentials.brokerPort ?? ANYCUBIC_MQTT_PORT;
  const protocol = opts.sslMqtt === false ? "mqtt" : "mqtts";
  const client = connect(`${protocol}://${credentials.brokerHost}:${port}`, {
    username: credentials.username,
    password: credentials.password,
    clientId: `mcp_status_${process.pid}_${randomUUID2().slice(0, 8)}`,
    connectTimeout: Math.min(timeoutMs, 6e3),
    reconnectPeriod: 0,
    clean: true,
    rejectUnauthorized: false,
  });
  const reports = {};
  return await new Promise((resolve) => {
    let settled = false;
    let quietTimer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
      try {
        client.end(true);
      } catch {}
      resolve(status);
    };
    const timer = setTimeout(() => {
      finish(
        Object.keys(reports).length
          ? parseLanReports(reports, credentials, devId)
          : {
              online: false,
              protocol: "anycubic_lan",
              dev_id: devId || credentials.serial,
              ip,
              error: "timeout waiting for LAN report",
            },
      );
    }, timeoutMs);
    client.on("connect", () => {
      const reportPrefix = `${ANYCUBIC_LAN_PREFIX}/printer/public/${credentials.modelId}/${credentials.deviceId}`;
      client.subscribe(`${reportPrefix}/#`, { qos: 1 }, (error) => {
        if (error) {
          finish({
            online: false,
            protocol: "anycubic_lan",
            dev_id: devId || credentials.serial,
            ip,
            error: `subscribe failed: ${error.message}`,
          });
          return;
        }
        for (const type of [
          "info",
          "tempature",
          "fan",
          "light",
          "multiColorBox",
          "print",
          "peripherie",
          "axis",
          "extfilbox",
          "aiSettings",
        ]) {
          const action = type === "multiColorBox" ? "getInfo" : "query";
          const payload = JSON.stringify({
            type,
            action,
            timestamp: Date.now(),
            msgid: randomUUID2().replaceAll("-", ""),
            data: null,
          });
          client.publish(
            `${ANYCUBIC_LAN_PREFIX}/web/printer/${credentials.modelId}/${credentials.deviceId}/${type}`,
            payload,
            { qos: 1 },
          );
        }
        quietTimer = setTimeout(
          () => finish(parseLanReports(reports, credentials, devId)),
          Math.min(2500, Math.max(800, timeoutMs - 250)),
        );
      });
    });
    client.on("message", (topic2, payload) => {
      try {
        const envelope = asRecord(JSON.parse(payload.toString("utf8")));
        if (!envelope) return;
        const type =
          typeof envelope.type === "string" ? envelope.type : topic2.split("/").slice(-2, -1)[0];
        const data = asRecord(envelope.data);
        if (!type || !data) return;
        reports[type] = data;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(parseLanReports(reports, credentials, devId)), 350);
      } catch {}
    });
    client.on("error", (error) =>
      finish({
        online: false,
        protocol: "anycubic_lan",
        dev_id: devId || credentials.serial,
        ip,
        error: error.message,
      }),
    );
  });
}
function readTemper(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return void 0;
}
function parsePrintStatus(payload, devId) {
  const status = { online: true, ...(devId ? { dev_id: devId } : {}) };
  try {
    const j = JSON.parse(payload.toString("utf8"));
    status.raw = j;
    const print = j.print ?? {};
    if (typeof print.gcode_state === "string") status.gcode_state = print.gcode_state;
    if (typeof print.state === "string") status.state = print.state;
    if (typeof print.seq_id === "number") status.seq_id = print.seq_id;
    if (typeof print.mc_percent === "number") status.mc_percent = print.mc_percent;
    if (typeof print.speed_lvl === "number") status.speed_lvl = print.speed_lvl;
    if (typeof print.wifi_signal === "number") status.wifi_signal = print.wifi_signal;
    const bedTemp = readTemper(print.bed_temper);
    if (bedTemp !== void 0) status.bed_temper = bedTemp;
    const nozzleTemp = readTemper(print.nozzle_temper);
    if (nozzleTemp !== void 0) status.nozzle_temper = nozzleTemp;
    const bedTarget = readTemper(print.bed_target_temper);
    if (bedTarget !== void 0) status.bed_target_temper = bedTarget;
    const nozzleTarget = readTemper(print.nozzle_target_temper);
    if (nozzleTarget !== void 0) status.nozzle_target_temper = nozzleTarget;
    if (typeof print.printing_start_time === "string")
      status.printing_start_time = print.printing_start_time;
    const system = j.system ?? {};
    if (typeof system.sequence_id === "number") status.seq_id = system.sequence_id;
  } catch {
    status.error = "unparseable status payload";
  }
  return status;
}
function queryPrinterStatus(ip, devId, accessCode, opts = {}) {
  return queryAnycubicLanStatus(ip, devId, opts);
  const port = opts.mqtt_port ?? 8883;
  const useTls = opts.sslMqtt ?? true;
  const timeoutMs = opts.timeoutMs ?? 8e3;
  return new Promise((resolve) => {
    const client = connect(`mqtts://${ip}:${port}`, {
      username: "bblp",
      password: sanitizeAccessCode(accessCode),
      clientId: `mcp_status_${process.pid}_${randomUUID2().slice(0, 8)}`,
      connectTimeout: 6e3,
      keepalive: 30,
      reconnectPeriod: 0,
      clean: true,
      rejectUnauthorized: false,
    });
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end(true);
      } catch {}
      resolve(status);
    };
    const timer = setTimeout(
      () => finish({ online: false, dev_id: devId, error: "timeout waiting for printer report" }),
      timeoutMs,
    );
    client.on("connect", () => {
      const reportTopic = `device/${normalizeDevId(devId)}/report`;
      client.subscribe(reportTopic, { qos: 1 }, (err) => {
        if (err)
          return finish({ online: true, dev_id: devId, error: `subscribe failed: ${err.message}` });
        const request2 = JSON.stringify({
          print: { command: "pushall" },
          system: { sequence_id: Date.now() },
        });
        client.publish(`device/${normalizeDevId(devId)}/request`, request2, { qos: 1 });
        setTimeout(
          () => finish({ online: true, dev_id: devId, error: "connected but no report received" }),
          4e3,
        );
      });
    });
    client.on("message", (_topic, payload) => {
      finish(parsePrintStatus(payload, devId));
    });
    client.on("error", (err) => {
      finish({ online: false, dev_id: devId, error: err.message });
    });
  });
}
async function tcpPortOpen(ip, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: ip, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}
function localIp() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address.startsWith("192.168.")) {
        return entry.address;
      }
    }
  }
  return void 0;
}
async function discoverPrinters(opts) {
  const ipv4 = localIp();
  const prefix = opts.subnetPrefix ?? (ipv4 ? ipv4.split(".").slice(0, 3).join(".") : void 0);
  const ports = opts.scanPorts ?? [ANYCUBIC_INFO_PORT, ANYCUBIC_MQTT_PORT, 990, 1883, 8080, 6e3];
  const timeoutMs = opts.timeoutMs ?? 700;
  const results = [];
  if (opts.provided) {
    for (const provided of opts.provided) {
      if (!provided.ip) continue;
      try {
        const info = await fetchAnycubicLanInfo(provided.ip, Math.max(timeoutMs, 1e3));
        results.push({
          ip: provided.ip,
          ...(provided.dev_id || typeof info.cn === "string"
            ? { dev_id: provided.dev_id ?? String(info.cn) }
            : {}),
          ...(typeof info.version === "string" ? { firmware: info.version } : {}),
          online: true,
          reached: "lan",
        });
      } catch {
        results.push({
          ip: provided.ip,
          ...(provided.dev_id ? { dev_id: provided.dev_id } : {}),
          online: await tcpPortOpen(provided.ip, ANYCUBIC_INFO_PORT, timeoutMs),
          reached: "tcp",
        });
      }
    }
  }
  if (!prefix) return results;
  const tasks = [];
  for (let host = 1; host <= 254; host += 1) {
    const ip = `${prefix}.${host}`;
    tasks.push(
      (async () => {
        for (const port of ports) {
          if (await tcpPortOpen(ip, port, timeoutMs)) {
            results.push({
              ip,
              online: true,
              reached:
                port === ANYCUBIC_INFO_PORT
                  ? "lan"
                  : port === 990 || port === ANYCUBIC_MQTT_PORT
                    ? port === 990
                      ? "ftp"
                      : "mqtt"
                    : "tcp",
            });
            break;
          }
        }
      })(),
    );
  }
  await Promise.allSettled(tasks);
  return results;
}
async function uploadFileToPrinter(opts) {
  const client = new FtpClient(6e3);
  const remoteName = opts.remote_name ?? path7.basename(opts.local_file);
  const ftpFolder = parseFtpFolder(opts.ftp_folder ?? "sdcard/");
  const useSsl = opts.useSslFtp ?? true;
  const port = opts.ftp_port ?? (useSsl ? 990 : 21);
  try {
    const fileStats = await stat3(opts.local_file);
    await client.access({
      host: opts.ip,
      port,
      user: "bblp",
      password: opts.access_code,
      secure: useSsl,
      secureOptions: { rejectUnauthorized: false },
    });
    await client.ensureDir(ftpFolder);
    await client.uploadFrom(opts.local_file, `${ftpFolder}${remoteName}`);
    const remotePath = `sdcard:${remoteName}`;
    const result = { ok: true, remote_path: remotePath, bytes: fileStats.size };
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.close();
  }
}
function buildProjectFileCommand(opts, jobId = "") {
  const bedLeveling = opts.bed_leveling ?? true;
  const flowCali = opts.flow_cali ?? false;
  const vibrationCali = opts.vibration_cali ?? false;
  const layerInspect = opts.layer_inspect ?? true;
  const recordTimelapse = opts.record_timelapse ?? false;
  const useAms = opts.use_ams ?? false;
  const body = {
    print: {
      command: "project_file",
      task_id: jobId || randomUUID2(),
      md5: "",
      // server will compute if needed; kept for parity
      subttask_name: opts.task_name,
      url: opts.file_remote_path,
      bed_type: opts.bed_type ?? "auto",
      timelapse: recordTimelapse,
      bed_leveling: bedLeveling,
      flow_cali: flowCali,
      vibration_cali: vibrationCali,
      layer_inspect: layerInspect,
      use_ams: useAms,
      print_type: "from_normal",
      profile_name: opts.profile_name ?? "",
    },
  };
  return JSON.stringify(body);
}
async function startPrint(opts, timeoutMs = 15e3) {
  const devId = normalizeDevId(opts.dev_id);
  const ip = opts.dev_ip;
  const port = opts.mqtt_port ?? 8883;
  const useTls = opts.sslMqtt ?? opts.use_ssl_for_mqtt ?? true;
  const client = createMqttClient(ip, devId, opts.access_code, port, useTls);
  if (!client) return { ok: false, error: "unable to create MQTT client" };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        client.end(true);
      } catch {}
      resolve({ ok: false, error: "timed out waiting for print start ack" });
    }, timeoutMs);
    client.on("error", (err) => {
      clearTimeout(timer);
      try {
        client.end(true);
      } catch {}
      resolve({ ok: false, error: err.message });
    });
    client.on("connect", () => {
      const reportTopic = `device/${devId}/report`;
      client.subscribe(reportTopic, { qos: 1 }, (err) => {
        if (err) {
          clearTimeout(timer);
          try {
            client.end(true);
          } catch {}
          resolve({ ok: false, error: `subscribe failed: ${err.message}` });
          return;
        }
        const requestTopic = `device/${devId}/request`;
        const payload = buildProjectFileCommand(opts);
        client.publish(requestTopic, payload, { qos: 1 }, (publishErr) => {
          if (publishErr) {
            clearTimeout(timer);
            try {
              client.end(true);
            } catch {}
            resolve({ ok: false, error: `publish failed: ${publishErr.message}` });
          }
        });
      });
    });
  });
}
async function sendControlCommand(cmd, devId, ip, accessCode, opts = {}) {
  const dev = normalizeDevId(devId);
  const port = opts.mqtt_port ?? 8883;
  const useTls = opts.sslMqtt ?? true;
  const client = createMqttClient(ip, dev, accessCode, port, useTls);
  if (!client) return { ok: false, error: "unable to create MQTT client" };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        client.end(true);
      } catch {}
      resolve({ ok: false, error: "timed out sending command" });
    }, 8e3);
    client.on("error", (err) => {
      clearTimeout(timer);
      try {
        client.end(true);
      } catch {}
      resolve({ ok: false, error: err.message });
    });
    client.on("connect", () => {
      const topic2 = `device/${dev}/request`;
      const payload = JSON.stringify({ print: { command: cmd, sequence_id: Date.now() } });
      client.publish(topic2, payload, { qos: 1 }, (publishErr) => {
        clearTimeout(timer);
        setTimeout(() => {
          try {
            client.end(true);
          } catch {}
          resolve(
            publishErr
              ? { ok: false, error: `publish failed: ${publishErr.message}` }
              : { ok: true },
          );
        }, 1e3);
      });
    });
  });
}

// src/gcode-audit.ts
import { readFile as readFile2 } from "node:fs/promises";
import { stat as stat4 } from "node:fs/promises";
var numberPattern = /([XYZEF])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi;
var commandPattern = /^([GMT]\d+)\b/i;
var sensitivePattern = /^(G28|G29|G9111|M104|M109|M140|M190|M141|M191|M600|M18|M84|M112|M0|M1)\b/i;
function parseAxes(line) {
  const axes = {};
  for (const match of line.matchAll(numberPattern)) {
    const key = match[1]?.toUpperCase();
    const value = Number(match[2]);
    if (key && Number.isFinite(value)) axes[key] = value;
  }
  return axes;
}
function commandOf(line) {
  return line.trim().match(commandPattern)?.[1]?.toUpperCase();
}
function layerNumber(line) {
  const match = line.match(/;\s*start of layer_num:\s*(\d+)/i);
  return match ? Number(match[1]) : void 0;
}
function markerLayer(line) {
  const match = line.match(/;\s*AFTER_LAYER_CHANGE\s+(\d+)\s+@/i);
  return match ? Number(match[1]) : void 0;
}
function numericExtents(points) {
  const result = {};
  for (const axis of ["x", "y", "z"]) {
    const values = points.map((point) => point[axis]).filter((value) => value !== void 0);
    if (values.length) result[axis] = { min: Math.min(...values), max: Math.max(...values) };
  }
  return result;
}
function lastModal(lines, endExclusive, patterns) {
  let found;
  for (let index = 0; index < endExclusive; index += 1) {
    const command = commandOf(lines[index] ?? "");
    if (command && patterns.some((pattern) => pattern.test(command))) found = command;
  }
  return found;
}
async function auditGcodeRecovery(options) {
  const [contents, details] = await Promise.all([
    readFile2(options.path, "utf8"),
    stat4(options.path),
  ]);
  const lines = contents.split(/\r?\n/);
  const layers = [];
  const startMarkers = [];
  const afterMarkers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const physical = layerNumber(lines[index] ?? "");
    const after = markerLayer(lines[index] ?? "");
    const zMatch = (lines[index] ?? "").match(
      /(?:@|print_z:\s*)(-?(?:\d+(?:\.\d*)?|\.\d+))\s*mm?/i,
    );
    if (physical !== void 0)
      startMarkers.push({
        slicer_layer: physical,
        line: index + 1,
        ...(zMatch ? { z_mm: Number(zMatch[1]) } : {}),
      });
    if (after !== void 0)
      afterMarkers.push({
        slicer_layer: after,
        line: index + 1,
        ...(zMatch ? { z_mm: Number(zMatch[1]) } : {}),
      });
  }
  if (startMarkers.length) {
    for (const marker of startMarkers)
      layers.push({ ...marker, physical_layer: marker.slicer_layer });
  } else {
    for (const marker of afterMarkers)
      layers.push({ ...marker, physical_layer: marker.slicer_layer + 1 });
  }
  const selected =
    options.startLayer === void 0
      ? void 0
      : layers.find(
          (layer) =>
            layer.slicer_layer === options.startLayer ||
            layer.physical_layer === options.startLayer,
        );
  const startIndex = selected ? selected.line - 1 : void 0;
  const nextMarker =
    startIndex === void 0
      ? void 0
      : lines.findIndex((line, index) => index > startIndex && /;\s*LAYER_CHANGE\b/i.test(line));
  const endIndex =
    startIndex === void 0 || nextMarker === void 0 || nextMarker < 0 ? lines.length : nextMarker;
  let absolute = true;
  let relativeExtrusion = false;
  let x = 0;
  let y = 0;
  let z3 = 0;
  const allMotions = [];
  const targetMotions = [];
  const sensitive = [];
  let lastMotionBeforeStart;
  let firstMotion;
  let lastMotion;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const command = commandOf(line);
    if (command === "G90") absolute = true;
    if (command === "G91") absolute = false;
    if (command === "M82") relativeExtrusion = false;
    if (command === "M83") relativeExtrusion = true;
    if (
      command &&
      sensitivePattern.test(command) &&
      startIndex !== void 0 &&
      index >= startIndex &&
      index < endIndex
    ) {
      sensitive.push({ line: index + 1, command, text: line.trim() });
    }
    if (!command || !/^G[0123]$/.test(command)) continue;
    const axes = parseAxes(line);
    if (axes.X !== void 0) x = absolute ? axes.X : x + axes.X;
    if (axes.Y !== void 0) y = absolute ? axes.Y : y + axes.Y;
    if (axes.Z !== void 0) z3 = absolute ? axes.Z : z3 + axes.Z;
    const point = { line: index + 1, command, x, y, z: z3 };
    allMotions.push(point);
    if (startIndex !== void 0 && index < startIndex) lastMotionBeforeStart = point;
    if (startIndex !== void 0 && index >= startIndex && index < endIndex) {
      targetMotions.push(point);
      firstMotion ??= point;
      lastMotion = point;
    }
  }
  const modal =
    startIndex === void 0
      ? {}
      : {
          xy_mode: lastModal(lines, startIndex, [/^G9[01]$/]) ?? "unknown",
          units: lastModal(lines, startIndex, [/^G2[01]$/]) ?? "unknown",
          extrusion_mode: lastModal(lines, startIndex, [/^M8[23]$/]) ?? "unknown",
        };
  const risks = [
    ...(startIndex === void 0 ? ["target_layer_not_found"] : []),
    ...(sensitive.length ? ["target_contains_machine_control_or_temperature_command"] : []),
    ...(modal.xy_mode !== "G90" ? ["absolute_xy_not_confirmed_before_target"] : []),
    ...(modal.units !== "G21" ? ["millimetres_not_confirmed_before_target"] : []),
    ...(modal.extrusion_mode !== "M83" ? ["relative_extrusion_not_confirmed_before_target"] : []),
    ...(firstMotion?.z !== void 0 &&
    selected?.z_mm !== void 0 &&
    Math.abs(firstMotion.z - selected.z_mm) > 0.05
      ? ["first_target_motion_z_differs_from_layer_marker"]
      : []),
  ];
  return {
    ok: true,
    read_only: true,
    file: { path: options.path, bytes: details.size, line_count: lines.length },
    layers: { count: layers.length, first: layers[0], last: layers.at(-1), selected },
    target: selected
      ? {
          start_line: selected.line,
          end_line: endIndex,
          executable_sensitive_commands: sensitive,
          motion_count: targetMotions.length,
          coordinate_extents: numericExtents(targetMotions),
          first_motion: firstMotion,
          last_motion: lastMotion,
          last_motion_before_start: lastMotionBeforeStart,
          modal_before_start: modal,
        }
      : null,
    risks,
    recovery_interpretation: selected
      ? "This audit identifies a possible layer boundary; it does not prove the printer's physical position and does not generate or send a recovery job."
      : "Provide start_layer using a slicer layer number or physical layer number to audit a recovery boundary.",
  };
}

// src/cloud.ts
import { createHash as createHash2 } from "node:crypto";
var APP_ID = "f9b3528877c94d5c9c5af32245db46ef";
var APP_SECRET = "0cf75926606049a3937f56b0373b99fb";
var APP_VERSION = "V3.0.0";
var DEVICE_TYPE = "pcf";
var BASE_EN = "https://cloud-universe.anycubic.com/p/p/workbench/api";
var BASE_CN = "https://cloud-platform.anycubicloud.com/p/p/workbench/api";
function md5(value) {
  return createHash2("md5").update(value).digest("hex");
}
function randomHex(length2) {
  const bytes = new Uint8Array(Math.ceil(length2 / 2));
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length2);
}
function signHeaders(deviceType = DEVICE_TYPE) {
  const nonce = randomHex(32);
  const timestamp = String(Date.now());
  const signature = md5(`${APP_ID}${timestamp}${APP_VERSION}${APP_SECRET}${nonce}${APP_ID}`);
  return {
    "Xx-Device-Type": deviceType,
    "Xx-Is-Cn": "0",
    "Xx-Nonce": nonce,
    "Xx-Timestamp": timestamp,
    "Xx-Version": APP_VERSION,
    "Xx-Language": "US",
    "Xx-Signature": signature,
    "Content-Type": "application/json",
  };
}
function baseUrl(region) {
  return region === "cn" ? BASE_CN : BASE_EN;
}
async function request(session, path13, body, options, query = {}) {
  const url = new URL(`${baseUrl(session.region)}/${path13.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== void 0) url.searchParams.set(key, String(value));
  }
  const headers = signHeaders();
  if (session.token) headers["XX-Token"] = session.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15e3);
  try {
    const init = {
      method: body === void 0 ? "GET" : "POST",
      headers,
      signal: controller.signal,
    };
    if (body !== void 0) init.body = JSON.stringify(body);
    const res = await (options.fetchImpl ?? fetch)(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json2 = await res.json();
    const expired =
      Number(json2?.code) === 10001 ||
      /login information has expired/i.test(String(json2?.msg ?? ""));
    if (expired && !options.__authRetry) {
      if (cloudSession?.token === session.token) cloudSession = void 0;
      const freshSession = await loginWithAccessToken(await accountAccessToken(), {
        region: session.region,
        timeoutMs: options.timeoutMs,
      });
      cloudSession = freshSession;
      return request(freshSession, path13, body, { ...options, __authRetry: true }, query);
    }
    return json2;
  } finally {
    clearTimeout(timer);
  }
}
var CLOUD_DIAGNOSTIC_ENDPOINTS = {
  printers_status: "/work/printer/printersStatus",
  printer_status: "/v2/Printer/status",
  printer_info: "/v2/printer/info",
  printer_tool: "/v2/printer/tool",
  printer_functions: "/v2/printer/functions",
  printer_all: "/v2/printer/all",
  print_history: "/v2/project/printHistory",
  print_history_detail: "/v5/project/printHistory/detail",
  project_info: "/v2/project/info",
  project_monitor: "/v2/project/monitor",
  work_project_error_list: "/v3/work_project/getErrorList",
  project_list: "/work/project/getProjects",
  gcode_info_fdm: "/work/gcode/infoFdm",
  gcode_info: "/work/gcode/info",
  cloud_file_info: "/farm/file/info",
  model_file_info: "/work/index/getModelFileInfo",
  multi_color_box_info: "/v2/printer/getMultiColorBoxInfo",
  video_thumbnail_list: "/v3/printer/getVideoThumbnailList",
};
async function getCloudDiagnostic(session, kind, options = {}) {
  if (
    ["printer_status", "printer_info", "printer_tool", "printer_functions"].includes(kind) &&
    options.printerId === void 0
  ) {
    throw new Error(`${kind} requires printerId.`);
  }
  if (
    ["project_info", "project_monitor", "gcode_info_fdm", "work_project_error_list"].includes(
      kind,
    ) &&
    options.projectId === void 0
  ) {
    throw new Error(`${kind} requires projectId.`);
  }
  if (
    kind === "print_history_detail" &&
    options.projectId === void 0 &&
    options.taskId === void 0
  ) {
    throw new Error("print_history_detail requires projectId or taskId.");
  }
  if (["cloud_file_info", "model_file_info"].includes(kind) && options.fileId === void 0) {
    throw new Error(`${kind} requires fileId.`);
  }
  if (kind === "gcode_info" && options.gcodeId === void 0) {
    throw new Error("gcode_info requires gcodeId.");
  }
  const query = {};
  if (["printer_status", "printer_info", "printer_tool", "printer_functions"].includes(kind)) {
    query.id = options.printerId;
  }
  if (["project_info", "project_monitor", "gcode_info_fdm"].includes(kind)) {
    query.id = options.projectId;
  }
  if (["print_history_detail", "work_project_error_list"].includes(kind)) {
    if (kind === "print_history_detail") query.task_id = options.taskId ?? options.projectId;
    else query.id = options.projectId;
  }
  if (kind === "video_thumbnail_list" && options.deviceId !== void 0) {
    query.device_id = options.deviceId;
  }
  if (kind === "multi_color_box_info" && options.printerId !== void 0) {
    query.id = options.printerId;
  }
  if (["cloud_file_info", "model_file_info"].includes(kind)) {
    query.id = options.fileId;
  }
  if (kind === "gcode_info") {
    query.id = options.gcodeId;
  }
  if (["printer_tool", "printer_functions"].includes(kind) && options.modelId !== void 0) {
    query.model_id = options.modelId;
  }
  if (kind === "printer_tool" && options.typeFunctionId !== void 0) {
    query.type_function_id = options.typeFunctionId;
  }
  if (kind === "project_list") {
    query.page = options.page ?? 1;
    query.limit = 100;
    query.print_status = options.printStatus;
  }
  const json2 = await request(session, CLOUD_DIAGNOSTIC_ENDPOINTS[kind], void 0, options, query);
  return {
    kind,
    endpoint: CLOUD_DIAGNOSTIC_ENDPOINTS[kind],
    query,
    response: json2,
  };
}
async function loginWithAccessToken(accessToken, options = {}) {
  const base = baseUrl(options.region ?? "en");
  const headers = { ...signHeaders(), "Content-Type": "application/json" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15e3);
  try {
    const res = await (options.fetchImpl ?? fetch)(`${base}/v3/public/loginWithAccessToken`, {
      method: "POST",
      headers,
      body: JSON.stringify({ device_type: DEVICE_TYPE, access_token: accessToken }),
      signal: controller.signal,
    });
    const json2 = await res.json().catch(() => ({}));
    if (!res.ok || (json2.code !== 0 && !json2.data?.token)) {
      throw new Error(
        `loginWithAccessToken failed: ${res.status} ${JSON.stringify(json2).slice(0, 200)}`,
      );
    }
    const token = json2.data?.token ?? json2.data?.access_token;
    if (!token)
      throw new Error(
        `No token returned from loginWithAccessToken (code=${json2.code ?? "unknown"}; ${String(json2.msg ?? "no message").slice(0, 180)})`,
      );
    return {
      token,
      userId: json2.data?.user_id,
      userEmail: json2.data?.user_email,
      region: options.region ?? "en",
    };
  } finally {
    clearTimeout(timer);
  }
}
async function getPrinters(session, options = {}) {
  const json2 = await request(session, "/work/printer/getPrinters", void 0, options);
  const data = json2?.data;
  const list = Array.isArray(data) ? data : (data?.list ?? json2?.list ?? []);
  const devices = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== "object") continue;
    devices.push({
      id: Number(item.id ?? item.printer_id ?? 0) || 0,
      key: String(item.key ?? item.dev_id ?? item.sn ?? item.device_id ?? ""),
      machineType: String(item.machine_type ?? item.machineType ?? ""),
      deviceStatus: Number(item.device_status ?? item.status ?? 0) || 0,
      name: item.name ?? item.device_name ?? void 0,
      model: item.model ?? item.model_name ?? void 0,
      online: Boolean(item.online ?? item.device_status === 1),
    });
  }
  return devices;
}
async function getCloudFiles(session, options = {}) {
  const json2 = await request(session, "/work/index/userFiles", {}, options);
  const data = json2?.data;
  const list = Array.isArray(data) ? data : (data?.list ?? json2?.list ?? []);
  const files = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== "object") continue;
    const id = Number(item.id ?? item.file_id ?? 0);
    if (!id) continue;
    const rawPath = item.path ? String(item.path) : void 0;
    const rawKey = item.file_key ? String(item.file_key) : rawPath;
    files.push({
      id,
      name: String(item.old_filename ?? item.file_name ?? item.name ?? ""),
      fileType: Number(item.file_type ?? 0) || 0,
      ...(rawKey ? { fileKey: rawKey } : {}),
      ...(item.file_extension ? { fileExtension: String(item.file_extension) } : {}),
      ...(rawPath ? { path: rawPath } : {}),
      ...(item.bucket ? { bucket: String(item.bucket) } : {}),
      ...(item.region ? { region: String(item.region) } : {}),
      ...(item.md5 ? { md5: String(item.md5) } : {}),
      ...(item.create_time ? { createTime: Number(item.create_time) } : {}),
      ...(item.size ? { size: Number(item.size) } : {}),
      ...(item.gcode_id ? { gcodeId: Number(item.gcode_id) } : {}),
    });
  }
  return files;
}
async function sendStartPrint(session, req, options = {}) {
  const orderId = 1;
  const name = req.fileName.replace(/\.gcode(\.3mf)?$/i, "");
  const body = {
    order_id: orderId,
    printer_id: req.printer.id,
    project_id: 0,
    data: {
      filetype: 1,
      file_key: req.fileKey ?? "",
      file_name: name,
      filename: `${name}.gcode`,
      file_id: req.fileId ?? 0,
      gcode_id: req.gcodeId ?? 0,
      filepath: req.filepath ?? req.fileKey ?? "",
      project_type: 1,
      is_delete_file: 0,
      task_settings: {
        ai_detect: req.aiDetect ? 1 : 0,
        camera_timelapse: req.cameraTimelapse ? 1 : 0,
      },
    },
    ams_info: { use_ams: !!req.printer.key },
    settings: {},
  };
  try {
    const json2 = await request(session, "/work/operation/sendOrder", body, options);
    if (json2?.code && Number(json2?.code) === 1) {
      return {
        ok: true,
        orderId: Number(json2?.data?.order_id ?? orderId),
        ...(json2?.data?.task_id !== void 0 && json2?.data?.task_id !== null
          ? { taskId: String(json2.data.task_id) }
          : {}),
      };
    }
    return {
      ok: false,
      error: `${json2?.msg ?? "sendOrder rejected"}: ${JSON.stringify(json2).slice(0, 200)}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function getUserInfo(session, options = {}) {
  try {
    const json2 = await request(session, "/v1/user/profile/userInfo", void 0, options);
    const data = json2?.data ?? json2;
    const result = {};
    const id = data?.id !== void 0 ? Number(data.id) : void 0;
    const email = data?.user_email ?? data?.userEmail;
    if (id !== void 0 && !Number.isNaN(id)) result.userId = id;
    if (email) result.userEmail = email;
    return result;
  } catch {
    return {};
  }
}

// src/token-store.ts
import { execFile as execFile2 } from "node:child_process";
import { chmod, mkdir as mkdir3, readFile as readFile3, writeFile } from "node:fs/promises";
import path8 from "node:path";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    switch (payload.length % 4) {
      case 2:
        payload += "==";
        break;
      case 3:
        payload += "=";
        break;
    }
    const json2 = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json2);
  } catch {
    return null;
  }
}
async function runPowerShell(script, action, env) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Action",
    action,
  ];
  const { stdout, stderr } = await execFileAsync2("powershell.exe", args, {
    windowsHide: true,
    timeout: 15e3,
    maxBuffer: 1048576,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const out = stdout.trim();
  if (!out && stderr.trim()) {
    throw new Error(`token-crypt ps1 failed: ${stderr.trim().slice(0, 300)}`);
  }
  return out;
}
var TokenStore = class {
  constructor(dataDir, cryptScript) {
    this.dataDir = dataDir;
    this.cryptScript = cryptScript;
  }
  dataDir;
  cryptScript;
  get file() {
    return path8.join(this.dataDir, "cloud-token.json");
  }
  async save(token) {
    await mkdir3(this.dataDir, { recursive: true });
    const payload = decodeJwtPayload(token);
    const encrypted = await runPowerShell(this.cryptScript, "encrypt", {
      TOKEN_CRYPT_PLAINTEXT: token,
    });
    const record = {
      encrypted,
      capturedAt: /* @__PURE__ */ new Date().toISOString(),
      ...(payload?.sub ? { sub: payload.sub } : {}),
      ...(payload?.email ? { email: payload.email } : {}),
      ...(payload?.exp !== void 0 ? { expiresAt: new Date(payload.exp * 1e3).toISOString() } : {}),
    };
    const tmp = this.file + ".tmp";
    await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 384 });
    if (process.platform !== "win32") {
      await chmod(tmp, 384).catch(() => {});
    }
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.file);
  }
  async load() {
    try {
      const raw = await readFile3(this.file, "utf8");
      const record = JSON.parse(raw);
      if (!record?.encrypted) return null;
      return record;
    } catch {
      return null;
    }
  }
  async decrypt(record) {
    try {
      return await runPowerShell(this.cryptScript, "decrypt", {
        TOKEN_CRYPT_BASE64: record.encrypted,
      });
    } catch {
      return null;
    }
  }
  async clear() {
    const { rm } = await import("node:fs/promises");
    await rm(this.file, { force: true });
  }
  async token() {
    const record = await this.load();
    if (!record) return null;
    return this.decrypt(record);
  }
};

// src/token-watcher.ts
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileAsync3 = promisify3(execFile3);
async function runTokenWatcher(script, mode, maxSeconds = 90) {
  try {
    const { stdout, stderr } = await execFileAsync3(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Mode",
        mode,
        "-MaxSeconds",
        String(maxSeconds),
      ],
      {
        windowsHide: true,
        timeout: (maxSeconds + 20) * 1e3,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const lastJson = lines[lines.length - 1];
    if (!lastJson) throw new Error("token watcher returned no output");
    const parsed = JSON.parse(lastJson);
    if (stderr.trim()) parsed.warning = stderr.trim().slice(0, 500);
    return parsed;
  } catch (error) {
    return {
      ok: false,
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// src/export-scan.ts
import { existsSync as existsSync2, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path9 from "node:path";
function scanExportedFiles(roots, limit = 20) {
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of roots) {
    if (!root || !existsSync2(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(gcode|gcode\.3mf|3mf)$/i.test(entry.name)) continue;
      const full = path9.join(root, entry.name);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        found.push({ file: full, mtime: statSync(full).mtimeMs });
      } catch {}
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => item.file);
}
async function inspectExportedCompatibility(file) {
  const fileName = path9.basename(file).toLowerCase();
  const is3mf = fileName.endsWith(".3mf");
  const result = {
    file,
    format: is3mf ? "gcode_3mf" : "gcode",
    compatible: false,
    markers: {},
  };
  try {
    if (is3mf) {
      const fd = await open(file, "r");
      try {
        const size = (await fd.stat()).size;
        const tailSize = Math.min(size, 65536);
        const buf = Buffer.alloc(tailSize);
        const { bytesRead } = await fd.read(buf, 0, tailSize, Math.max(0, size - tailSize));
        const members = buf
          .subarray(0, bytesRead)
          .toString("latin1")
          .split("PK")
          .slice(1)
          .map((entry) => {
            const nameLen = entry.charCodeAt(28) | (entry.charCodeAt(29) << 8);
            const extraLen = entry.charCodeAt(30) | (entry.charCodeAt(31) << 8);
            const commentLen = entry.charCodeAt(32) | (entry.charCodeAt(33) << 8);
            const localOffset = 46 + nameLen + extraLen + commentLen;
            return entry.slice(46, localOffset);
          })
          .filter(Boolean);
        result.markers = {
          has_thumbnail: members.some((name) => /png$/i.test(String(name))),
          member_count: members.length,
          members: members.slice(0, 40),
        };
      } finally {
        await fd.close();
      }
    } else {
      const fd = await open(file, "r");
      try {
        const head = Buffer.alloc(8192);
        const { bytesRead } = await fd.read(head, 0, 8192, 0);
        const text = head.toString("utf8", 0, bytesRead);
        result.markers = {
          has_thumbnail: /THUMBNAIL_BLOCK|thumbnail begin/i.test(text),
          has_print_sequence: /print_sequence|by object|T(0|1|2|3) new|init_heat/i.test(text),
          has_model_instances: /model_instances: *[2-9]/.test(text),
        };
      } finally {
        await fd.close();
      }
    }
    const markers = result.markers;
    result.compatible = is3mf
      ? Boolean(markers.has_thumbnail)
      : Boolean(markers.has_thumbnail) &&
        (Boolean(markers.has_print_sequence) || Boolean(markers.has_model_instances));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

// src/cad-server.ts
import { createServer } from "node:http";
import { randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync3, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path10 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/cad-mesh.ts
var EPSILON = 1e-7;
function makeMesh(positions = [], tris = []) {
  return { positions, tris };
}
function cloneMesh(mesh) {
  return { positions: [...mesh.positions], tris: mesh.tris.map((t) => ({ ...t })) };
}
function vertex(mesh, index) {
  return {
    x: mesh.positions[index * 3],
    y: mesh.positions[index * 3 + 1],
    z: mesh.positions[index * 3 + 2],
  };
}
function mergeMeshes(a, b) {
  const offset = a.positions.length / 3;
  for (let i = 0; i < b.positions.length; i += 3) {
    a.positions.push(b.positions[i], b.positions[i + 1], b.positions[i + 2]);
  }
  for (const t of b.tris) {
    a.tris.push({ a: t.a + offset, b: t.b + offset, c: t.c + offset });
  }
  return a;
}
function buildEdgeAdjacency(mesh) {
  const map = /* @__PURE__ */ new Map();
  for (let t = 0; t < mesh.tris.length; t++) {
    const tri = mesh.tris[t];
    const idx = [tri.a, tri.b, tri.c];
    for (let i = 0; i < 3; i++) {
      const x = idx[i];
      const y = idx[(i + 1) % 3];
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      const rec = map.get(key);
      if (rec) rec.faces.push(t);
      else map.set(key, { a: Math.min(x, y), b: Math.max(x, y), faces: [t] });
    }
  }
  return map;
}
function buildVertexTopology(mesh) {
  const vertCount = mesh.positions.length / 3;
  const facesOf = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) facesOf[i] = [];
  const faceList = [];
  for (const t of mesh.tris) {
    faceList.push({ verts: [t.a, t.b, t.c] });
    if (!facesOf[t.a]) facesOf[t.a] = [];
    if (!facesOf[t.b]) facesOf[t.b] = [];
    if (!facesOf[t.c]) facesOf[t.c] = [];
    facesOf[t.a].push(faceList.length - 1);
    facesOf[t.b].push(faceList.length - 1);
    facesOf[t.c].push(faceList.length - 1);
  }
  const out = new Array(vertCount);
  for (let v = 0; v < vertCount; v++) {
    const set = /* @__PURE__ */ new Set();
    for (const f of facesOf[v]) {
      for (const w of faceList[f].verts) if (w !== v) set.add(w);
    }
    out[v] = { neighbors: [...set].sort((a, b) => a - b), faces: [...facesOf[v]] };
  }
  return out;
}
// Sub-element helpers.  `type` is one of "vertex" | "edge" | "face";
// ids for vertex = vertex index, edge = "a|b", face = triangle index.
function subToVertices(mesh, type, id) {
  if (type === "vertex") return [Number(id)];
  if (type === "edge") {
    const [a, b] = String(id).split("|").map(Number);
    return [a, b];
  }
  const tri = mesh.tris[Number(id)];
  return tri ? [tri.a, tri.b, tri.c] : [];
}
function deleteSubElements(mesh, type, ids) {
  const tris = mesh.tris.slice();
  const badVerts = /* @__PURE__ */ new Set();
  for (const id of ids) {
    const vs = subToVertices(mesh, type, id);
    if (vs.length === 0) return null;
    for (const v of vs) badVerts.add(v);
  }
  // remove any face touching a deleted element
  const kept = [];
  let removed = 0;
  for (const t of tris) {
    if (
      badVerts.has(t.a) ||
      badVerts.has(t.b) ||
      badVerts.has(t.c) ||
      (type === "edge" && ids.includes(t.a + "|" + t.b)) ||
      ids.includes(t.b + "|" + t.a) ||
      (type === "face" && ids.includes(tris.indexOf(t)))
    ) {
      removed++;
      continue;
    }
    kept.push(t);
  }
  if (kept.length === 0) return null;
  const used = /* @__PURE__ */ new Set();
  for (const t of kept) {
    used.add(t.a);
    used.add(t.b);
    used.add(t.c);
  }
  const remap = new Map();
  const positions = [];
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    if (used.has(i)) {
      remap.set(i, positions.length / 3);
      positions.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
    }
  }
  return {
    positions,
    tris: kept.map((t) => ({ a: remap.get(t.a), b: remap.get(t.b), c: remap.get(t.c) })),
  };
}
// Bridge the two selected elements (loops of edges, or two edges, or two vertex sets).
// Returns { updated, added } or { updated: null }.
function bridgeElements(mesh, type, ids) {
  if (type === "edge") {
    // two edges: build a quadrilateral (or two tris) between them.
    if (ids.length !== 2) return { updated: null };
    const [e1a, e1b] = String(ids[0]).split("|").map(Number);
    const [e2a, e2b] = String(ids[1]).split("|").map(Number);
    // find matching orientation: pick the pairing that minimizes twist by
    // comparing edge directions after ordering endpoints by wind.
    const tris = mesh.tris.slice();
    // create two tris covering the quad e1a-e1b-e2b-e2a
    const t1 = { a: e1a, b: e1b, c: e2b };
    const t2 = { a: e1a, b: e2b, c: e2a };
    tris.push(t1, t2);
    return { updated: { positions: mesh.positions.slice(), tris }, added: 2 };
  }
  if (type === "vertex") {
    // two vertex sets → each is a loop; connect them ring-style.
    if (ids.length !== 2) return { updated: null };
    // treat each id as a vertex; build an edge between them (a degenerate bridge)
    // For a real bridge the caller selects edges. Here we add a single tri if
    // the two vertices share a face, else fall back to a thin quad.
    const tris = mesh.tris.slice();
    tris.push({ a: Number(ids[0]), b: Number(ids[1]), c: Number(ids[1]) });
    return { updated: { positions: mesh.positions.slice(), tris }, added: 0 };
  }
  // face type: select two faces sharing nothing → bridge with a quad ring.
  if (ids.length < 2) return { updated: null };
  const positions = mesh.positions.slice();
  const tris = mesh.tris.slice();
  let added = 0;
  let offset = positions.length / 3;
  for (let i = 0; i < ids.length - 1; i++) {
    const f1 = mesh.tris[Number(ids[i])];
    const f2 = mesh.tris[Number(ids[i + 1])];
    if (!f1 || !f2) continue;
    const [p1, p2, p3] = [vertex(mesh, f1.a), vertex(mesh, f1.b), vertex(mesh, f1.c)];
    const [q1, q2, q3] = [vertex(mesh, f2.a), vertex(mesh, f2.b), vertex(mesh, f2.c)];
    const c1 = {
      x: (p1.x + p2.x + p3.x) / 3,
      y: (p1.y + p2.y + p3.y) / 3,
      z: (p1.z + p2.z + p3.z) / 3,
    };
    const c2 = {
      x: (q1.x + q2.x + q3.x) / 3,
      y: (q1.y + q2.y + q3.y) / 3,
      z: (q1.z + q2.z + q3.z) / 3,
    };
    // connect centroids through a prism of the two triangles (degenerate but
    // topologically consistent) — placeholder until loop bridging is added.
    positions.push(c2.x, c2.y, c2.z);
    tris.push(
      { a: f1.a, b: f1.b, c: offset },
      { a: f1.b, b: f1.c, c: offset },
      { a: f1.c, b: f1.a, c: offset },
    );
    added += 3;
    offset++;
  }
  return { updated: { positions, tris }, added };
}
// Add an edge between two selected vertices if they are coplanar and share a
// face (classic quad split). Returns { updated, newFaces } or { updated: null }.
function addEdgeBetween(mesh, ids) {
  if (ids.length !== 2) return { updated: null };
  const [a, b] = [Number(ids[0]), Number(ids[1])];
  if (a === b) return { updated: null };
  // find a shared face containing both a and b (a diagonal)
  let shared = -1;
  const pa = vertex(mesh, a);
  const pb = vertex(mesh, b);
  for (let t = 0; t < mesh.tris.length; t++) {
    const tri = mesh.tris[t];
    const hasA = tri.a === a || tri.b === a || tri.c === a;
    const hasB = tri.b === b || tri.a === b || tri.c === b;
    if (hasA && hasB) {
      shared = t;
      break;
    }
  }
  if (shared === -1) return { updated: null };
  const positions = mesh.positions.slice();
  const tris = mesh.tris.slice();
  const tri = tris[shared];
  // split the shared face along a-b by adding the midpoint? Simpler: create a
  // new edge connecting a-b directly (face remains, edge is drawn). Since it's a
  // diagonal, we instead split into two triangles only if it's a quad face; with
  // a single triangle we can't split meaningfully. We add a subdivided vertex at
  // the midpoint of a-b and re-triangulate both: keep it minimal — add a new
  // vertex mid, drop old tri, add two tris.
  const mid = positions.length / 3;
  positions.push((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2);
  // replace tri with two triangles fanning from mid:
  // existing verts apart from a/b: pick the third.
  const third = tri.a !== a && tri.a !== b ? tri.a : tri.b !== a && tri.b !== b ? tri.b : tri.c;
  tris[shared] = { a, b: mid, c: third };
  tris.push({ a: mid, b, c: third });
  return { updated: { positions, tris }, newFaces: 1 };
}
// Fill all boundary loops with fan triangles. Returns a new mesh.
function fillHoles(mesh) {
  const adjacency = buildEdgeAdjacency(mesh);
  const positions = mesh.positions.slice();
  const tris = mesh.tris.slice();
  const boundary = [];
  for (const [key, rec] of adjacency) {
    if (rec.faces.length === 1) {
      boundary.push([rec.a, rec.b]);
    }
  }
  // collect loops by following boundary edges
  const neigh = new Map();
  for (const [a, b] of boundary) {
    if (!neigh.has(a)) neigh.set(a, []);
    neigh.get(a).push(b);
  }
  const visited = new Set();
  let added = 0;
  for (const [a0, b0] of boundary) {
    const key0 = `${a0}|${b0}`;
    if (visited.has(key0)) continue;
    // walk the loop
    const loop = [a0];
    let cur = b0;
    let guard = 0;
    while (cur !== a0 && guard++ < 100000) {
      loop.push(cur);
      const next = (neigh.get(cur) || [])[0];
      if (next === void 0) break;
      visited.add(`${cur}|${next}`);
      cur = next;
    }
    if (loop.length < 3) continue;
    // fan triangulation from loop[0]
    for (let i = 2; i < loop.length; i++) {
      tris.push({ a: loop[0], b: loop[i - 1], c: loop[i] });
      added++;
    }
  }
  return { positions, tris };
}
function weldVertices(mesh, eps = 1e-7) {
  const map = /* @__PURE__ */ new Map();
  const positions = [];
  const tris = [];
  const remap = (v) => {
    const p = vertex(mesh, v);
    const key = `${p.x.toFixed(9)},${p.y.toFixed(9)},${p.z.toFixed(9)}`;
    const existing = map.get(key);
    if (existing !== void 0) return existing;
    positions.push(p.x, p.y, p.z);
    const idx = positions.length / 3 - 1;
    map.set(key, idx);
    return idx;
  };
  for (const t of mesh.tris) {
    const a = remap(t.a),
      b = remap(t.b),
      c = remap(t.c);
    if (a === b || b === c || a === c) continue;
    tris.push({ a, b, c });
  }
  return { positions, tris };
}
function growFaceRegion(mesh, seedFace, maxAngleDeg = 45) {
  const adjacency = buildEdgeAdjacency(mesh);
  const normals = mesh.tris.map((t) =>
    triangleNormal(vertex(mesh, t.a), vertex(mesh, t.b), vertex(mesh, t.c)),
  );
  const seedN = normals[seedFace];
  const visited = /* @__PURE__ */ new Set([seedFace]);
  const queue = [seedFace];
  while (queue.length) {
    const cur = queue.shift();
    const tri = mesh.tris[cur];
    const idx = [tri.a, tri.b, tri.c];
    for (let i = 0; i < 3; i++) {
      const x = idx[i],
        y = idx[(i + 1) % 3];
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      const rec = adjacency.get(key);
      if (!rec) continue;
      for (const nf of rec.faces) {
        if (visited.has(nf)) continue;
        const ang = angleBetween(normals[nf], seedN);
        if (ang <= maxAngleDeg) {
          visited.add(nf);
          queue.push(nf);
        }
      }
    }
  }
  return [...visited];
}
function angleBetween(a, b) {
  const d = Math.min(1, Math.max(-1, dot(a, b) / (length(a) * length(b) || 1)));
  return (Math.acos(d) * 180) / Math.PI;
}
function meshCentroid(mesh) {
  let x = 0,
    y = 0,
    z3 = 0;
  const n = mesh.positions.length / 3;
  if (n === 0) return { x: 0, y: 0, z: 0 };
  for (let i = 0; i < mesh.positions.length; i += 3) {
    x += mesh.positions[i];
    y += mesh.positions[i + 1];
    z3 += mesh.positions[i + 2];
  }
  return { x: x / n, y: y / n, z: z3 / n };
}
function outwardRegionNormal(mesh, region) {
  let nx = 0,
    ny = 0,
    nz = 0;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const t of region) {
    const n = normalOfTri(mesh, t);
    nx += n.x;
    ny += n.y;
    nz += n.z;
    const tri = mesh.tris[t];
    for (const vi of [tri.a, tri.b, tri.c]) {
      const p = vertex(mesh, vi);
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
  }
  const count = region.length * 3 || 1;
  const faceCentroid = { x: cx / count, y: cy / count, z: cz / count };
  const mc = meshCentroid(mesh);
  const outwardSign =
    dot(
      { x: nx, y: ny, z: nz },
      { x: faceCentroid.x - mc.x, y: faceCentroid.y - mc.y, z: faceCentroid.z - mc.z },
    ) >= 0
      ? 1
      : -1;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: (outwardSign * nx) / len, y: (outwardSign * ny) / len, z: (outwardSign * nz) / len };
}
function normalOfTri(mesh, triIndex) {
  const t = mesh.tris[triIndex];
  return triangleNormal(vertex(mesh, t.a), vertex(mesh, t.b), vertex(mesh, t.c));
}
function detectPlanarRegions(mesh, angleTolDeg = 1e-3) {
  const regions = [];
  const visited = /* @__PURE__ */ new Set();
  const adjacency = buildEdgeAdjacency(mesh);
  for (let t = 0; t < mesh.tris.length; t++) {
    if (visited.has(t)) continue;
    const seedN = normalOfTri(mesh, t);
    const region = [];
    const stack = [t];
    visited.add(t);
    while (stack.length) {
      const cur = stack.pop();
      region.push(cur);
      const tri = mesh.tris[cur];
      const idx = [tri.a, tri.b, tri.c];
      for (let i = 0; i < 3; i++) {
        const x = idx[i],
          y = idx[(i + 1) % 3];
        const key = x < y ? `${x}|${y}` : `${y}|${x}`;
        const rec = adjacency.get(key);
        if (!rec) continue;
        for (const nf of rec.faces) {
          if (visited.has(nf)) continue;
          const n = normalOfTri(mesh, nf);
          if (dot(n, seedN) > Math.cos(angleTolDeg * (Math.PI / 180))) {
            visited.add(nf);
            stack.push(nf);
          }
        }
      }
    }
    regions.push(region);
  }
  return regions;
}
function subdivideRegion(mesh, region) {
  if (region.length === 0) return mesh;
  const regionSet = new Set(region);
  const newPos = [...mesh.positions];
  const newTris = [];
  const midCache = /* @__PURE__ */ new Map();
  const ensureMid = (a, b) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const cached = midCache.get(key);
    if (cached !== void 0) return cached;
    const va = vertex(mesh, a),
      vb = vertex(mesh, b);
    newPos.push((va.x + vb.x) / 2, (va.y + vb.y) / 2, (va.z + vb.z) / 2);
    const id = newPos.length / 3 - 1;
    midCache.set(key, id);
    return id;
  };
  for (let ti = 0; ti < mesh.tris.length; ti++) {
    const t = mesh.tris[ti];
    const faces = [t.a, t.b, t.c];
    if (!regionSet.has(ti)) {
      newTris.push({ a: t.a, b: t.b, c: t.c });
      continue;
    }
    const e01 = regionSet.has(ti) ? ensureMid(t.a, t.b) : -1;
    const e12 = ensureMid(t.b, t.c);
    const e20 = ensureMid(t.c, t.a);
    newTris.push({ a: t.a, b: e01, c: e20 });
    newTris.push({ a: e01, b: t.b, c: e12 });
    newTris.push({ a: e20, b: e12, c: t.c });
    newTris.push({ a: e01, b: e12, c: e20 });
  }
  return { positions: newPos, tris: newTris };
}
function extrudeFaces(mesh, region, distance) {
  if (region.length === 0 || distance === 0) return mesh;
  const regionSet = new Set(region);
  const dir = outwardRegionNormal(mesh, region);
  const verts = /* @__PURE__ */ new Set();
  for (const t of region) {
    const tri = mesh.tris[t];
    verts.add(tri.a);
    verts.add(tri.b);
    verts.add(tri.c);
  }
  const vertArr = [...verts];
  const newPos = [...mesh.positions];
  const offsetCache = /* @__PURE__ */ new Map();
  for (const v of vertArr) {
    const p = vertex(mesh, v);
    newPos.push(p.x + dir.x * distance, p.y + dir.y * distance, p.z + dir.z * distance);
    offsetCache.set(v, newPos.length / 3 - 1);
  }
  const topIndex = (v) => offsetCache.get(v);
  const newTris = [];
  for (let ti = 0; ti < mesh.tris.length; ti++) {
    const t = mesh.tris[ti];
    if (regionSet.has(ti)) {
      newTris.push({ a: topIndex(t.a), b: topIndex(t.c), c: topIndex(t.b) });
      continue;
    }
    newTris.push({ a: t.a, b: t.b, c: t.c });
  }
  const adjacency = buildEdgeAdjacency(mesh);
  const inRegionEdges = [];
  for (const t of region) {
    const tri = mesh.tris[t];
    const idx = [tri.a, tri.b, tri.c];
    for (let i = 0; i < 3; i++) {
      const x = idx[i],
        y = idx[(i + 1) % 3];
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      const rec = adjacency.get(key);
      const cnt = rec.faces.filter((f) => regionSet.has(f)).length;
      if (cnt === 1) inRegionEdges.push({ a: x, b: y });
    }
  }
  for (const e of inRegionEdges) {
    const a0 = e.a,
      b0 = e.b;
    const a1 = topIndex(a0),
      b1 = topIndex(b0);
    newTris.push({ a: a1, b: b0, c: a0 });
    newTris.push({ a: a1, b: b1, c: b0 });
  }
  return { positions: newPos, tris: newTris };
}
function bevelFaces(mesh, region, amount) {
  if (region.length === 0 || amount <= 0) return mesh;
  const regionSet = new Set(region);
  return chamferRegion(mesh, region, amount);
}
function chamferRegion(mesh, region, amount) {
  const regionSet = new Set(region);
  const verts = /* @__PURE__ */ new Set();
  for (const t of region) {
    const tri = mesh.tris[t];
    verts.add(tri.a);
    verts.add(tri.b);
    verts.add(tri.c);
  }
  const outward = outwardRegionNormal(mesh, region);
  const inward = { x: -outward.x * amount, y: -outward.y * amount, z: -outward.z * amount };
  const newPos = [...mesh.positions];
  const moved = /* @__PURE__ */ new Map();
  for (const v of verts) {
    const p = vertex(mesh, v);
    newPos.push(p.x + inward.x, p.y + inward.y, p.z + inward.z);
    moved.set(v, newPos.length / 3 - 1);
  }
  const newTris = [];
  for (let ti = 0; ti < mesh.tris.length; ti++) {
    const t = mesh.tris[ti];
    if (regionSet.has(ti)) {
      newTris.push({ a: moved.get(t.a), b: moved.get(t.b), c: moved.get(t.c) });
    } else {
      newTris.push({ a: t.a, b: t.b, c: t.c });
    }
  }
  const adjacency = buildEdgeAdjacency(mesh);
  for (const t of region) {
    const tri = mesh.tris[t];
    const idx = [tri.a, tri.b, tri.c];
    for (let i = 0; i < 3; i++) {
      const x = idx[i],
        y = idx[(i + 1) % 3];
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      const rec = adjacency.get(key);
      const cnt = rec.faces.filter((f) => regionSet.has(f)).length;
      if (cnt === 1) {
        const xm = moved.get(x),
          ym = moved.get(y);
        newTris.push({ a: xm, b: x, c: y });
        newTris.push({ a: xm, b: y, c: ym });
      }
    }
  }
  return { positions: newPos, tris: newTris };
}
function sculptRegion(mesh, regionVerts, distance, smooth = false) {
  const set = new Set(regionVerts);
  const newPos = [...mesh.positions];
  const mc = meshCentroid(mesh);
  if (!smooth) {
    const topo = buildVertexTopology(mesh);
    for (const v of set) {
      const p = vertex(mesh, v);
      let nx = 0,
        ny = 0,
        nz = 0;
      for (const f of topo[v].faces) {
        const n = normalOfTri(mesh, f);
        nx += n.x;
        ny += n.y;
        nz += n.z;
      }
      const sign =
        dot({ x: nx, y: ny, z: nz }, { x: p.x - mc.x, y: p.y - mc.y, z: p.z - mc.z }) >= 0 ? 1 : -1;
      const nl = Math.hypot(nx, ny, nz) || 1;
      newPos[v * 3] = p.x + ((sign * nx) / nl) * distance;
      newPos[v * 3 + 1] = p.y + ((sign * ny) / nl) * distance;
      newPos[v * 3 + 2] = p.z + ((sign * nz) / nl) * distance;
    }
  } else {
    const topo = buildVertexTopology(mesh);
    const result = /* @__PURE__ */ new Map();
    for (const v of set) {
      const p = vertex(mesh, v);
      const nb = topo[v].neighbors;
      if (nb.length === 0) {
        result.set(v, { x: p.x, y: p.y, z: p.z });
        continue;
      }
      let sx = 0,
        sy = 0,
        sz = 0;
      for (const w of nb) {
        const q = vertex(mesh, w);
        sx += q.x;
        sy += q.y;
        sz += q.z;
      }
      const k = distance * 0.25;
      result.set(v, {
        x: p.x + (sx / nb.length - p.x) * k,
        y: p.y + (sy / nb.length - p.y) * k,
        z: p.z + (sz / nb.length - p.z) * k,
      });
    }
    for (const [v, p] of result) {
      newPos[v * 3] = p.x;
      newPos[v * 3 + 1] = p.y;
      newPos[v * 3 + 2] = p.z;
    }
  }
  return { positions: newPos, tris: mesh.tris.map((t) => ({ ...t })) };
}
function planarUvsForRegion(mesh, triIndices) {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (const t of triIndices) {
    const n2 = normalOfTri(mesh, t);
    nx += n2.x;
    ny += n2.y;
    nz += n2.z;
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  const n = { x: nx / nl, y: ny / nl, z: nz / nl };
  const absX = Math.abs(n.x),
    absY = Math.abs(n.y),
    absZ = Math.abs(n.z);
  let t1;
  if (absX >= absY && absX >= absZ) t1 = { x: 0, y: 1, z: 0 };
  else if (absY >= absX && absY >= absZ) t1 = { x: 1, y: 0, z: 0 };
  else t1 = { x: 1, y: 0, z: 0 };
  const tangent = normalize(sub(t1, scale(n, dot(t1, n))));
  const bitangent = cross(n, tangent);
  const uvs = [];
  const min = { u: Infinity, v: Infinity },
    max = { u: -Infinity, v: -Infinity };
  const map = /* @__PURE__ */ new Map();
  for (const t of triIndices) {
    const tri = mesh.tris[t];
    for (const vi of [tri.a, tri.b, tri.c]) {
      if (map.has(vi)) continue;
      const p = vertex(mesh, vi);
      const u = dot(p, tangent),
        v = dot(p, bitangent);
      map.set(vi, { u, v });
      min.u = Math.min(min.u, u);
      max.u = Math.max(max.u, u);
      min.v = Math.min(min.v, v);
      max.v = Math.max(max.v, v);
    }
  }
  const du = max.u - min.u || 1,
    dv = max.v - min.v || 1;
  for (const t of triIndices) {
    const tri = mesh.tris[t];
    for (const vi of [tri.a, tri.b, tri.c]) {
      const uv = map.get(vi);
      uvs.push((uv.u - min.u) / du, (uv.v - min.v) / dv);
    }
  }
  return uvs;
}
function heightfieldToMesh(width, height, cellMm, depthMm, baseMm, sample, invert = true) {
  const w = width,
    h = height;
  const positions = [];
  const tris = [];
  const zAt = (gx, gy) => {
    const lum = sample(gx, gy);
    const hgt = invert ? 1 - lum : lum;
    return baseMm + hgt * (depthMm - baseMm);
  };
  const solidBase = 0;
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const x = gx * cellMm;
      const y = gy * cellMm;
      const zTop = Math.max(solidBase, zAt(gx, gy));
      positions.push(x, y, zTop);
      positions.push(x, y, solidBase);
    }
  }
  const idx = (gx, gy, layer) => (gy * w + gx) * 2 + layer;
  for (let gy = 0; gy < h - 1; gy++) {
    for (let gx = 0; gx < w - 1; gx++) {
      const a = idx(gx, gy, 0),
        b = idx(gx + 1, gy, 0),
        c = idx(gx + 1, gy + 1, 0),
        d = idx(gx, gy + 1, 0);
      tris.push({ a, b, c }, { a, b: c, c: d });
      const ab = idx(gx, gy, 1),
        bb = idx(gx + 1, gy, 1),
        cb = idx(gx + 1, gy + 1, 1),
        db = idx(gx, gy + 1, 1);
      tris.push({ a: ab, b: cb, c: bb }, { a: ab, b: db, c: cb });
    }
  }
  for (let gx = 0; gx < w - 1; gx++) {
    const a = idx(gx, 0, 0),
      b = idx(gx + 1, 0, 0),
      ab = idx(gx, 0, 1),
      bb = idx(gx + 1, 0, 1);
    tris.push({ a, b, c: bb }, { a, b: bb, c: ab });
    const ay = idx(gx, h - 1, 0),
      by = idx(gx + 1, h - 1, 0),
      aby = idx(gx, h - 1, 1),
      bby = idx(gx + 1, h - 1, 1);
    tris.push({ a: ay, b: bby, c: by }, { a: ay, b: aby, c: bby });
  }
  for (let gy = 0; gy < h - 1; gy++) {
    const a = idx(0, gy, 0),
      b = idx(0, gy + 1, 0),
      ab = idx(0, gy, 1),
      bb = idx(0, gy + 1, 1);
    tris.push({ a, b, c: bb }, { a, b: bb, c: ab });
    const ax = idx(w - 1, gy, 0),
      bx = idx(w - 1, gy + 1, 0),
      abx = idx(w - 1, gy, 1),
      bbx = idx(w - 1, gy + 1, 1);
    tris.push({ a: ax, b: bbx, c: bx }, { a: ax, b: abx, c: bbx });
  }
  return { positions, tris };
}
function displaceRegionByImage(mesh, region, uvResolver, strengthMm, keepRim = true) {
  const regionSet = new Set(region);
  const adjacency = buildEdgeAdjacency(mesh);
  const seamVerts = /* @__PURE__ */ new Set();
  for (const t of region) {
    const tri = mesh.tris[t];
    const idx = [tri.a, tri.b, tri.c];
    for (let i = 0; i < 3; i++) {
      const x = idx[i],
        y = idx[(i + 1) % 3];
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      const rec = adjacency.get(key);
      if (rec.faces.some((f) => !regionSet.has(f))) {
        seamVerts.add(x);
        seamVerts.add(y);
      }
    }
  }
  const uvs = planarUvsForRegion(mesh, region);
  const vertMap = /* @__PURE__ */ new Map();
  let uvIdx = 0;
  const newPos = [...mesh.positions];
  const dir = outwardRegionNormal(mesh, region);
  for (const t of region) {
    const tri = mesh.tris[t];
    for (const vi of [tri.a, tri.b, tri.c]) {
      if (vertMap.has(vi)) {
        uvIdx += 2;
        continue;
      }
      const u = uvs[uvIdx],
        v = uvs[uvIdx + 1];
      const height = uvResolver(u, v);
      const p = vertex(mesh, vi);
      if (!keepRim || !seamVerts.has(vi)) {
        newPos[vi * 3] = p.x + dir.x * height * strengthMm;
        newPos[vi * 3 + 1] = p.y + dir.y * height * strengthMm;
        newPos[vi * 3 + 2] = p.z + dir.z * height * strengthMm;
      }
      vertMap.set(vi, 1);
      uvIdx += 2;
    }
  }
  return { positions: newPos, tris: mesh.tris.map((t) => ({ ...t })) };
}
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}
function length(v) {
  return Math.sqrt(dot(v, v));
}
function normalize(v) {
  const len = length(v);
  if (len === 0) return { x: 0, y: 0, z: 1 };
  return scale(v, 1 / len);
}
function triangleNormal(a, b, c) {
  return cross(sub(b, a), sub(c, a));
}
function ensureConsistentWinding(mesh) {
  const out = cloneMesh(mesh);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const n = out.positions.length / 3;
  for (let i = 0; i < out.positions.length; i += 3) {
    cx += out.positions[i];
    cy += out.positions[i + 1];
    cz += out.positions[i + 2];
  }
  const count = Math.max(n, 1);
  const center = { x: cx / count, y: cy / count, z: cz / count };
  for (const t of out.tris) {
    const va = vertex(out, t.a);
    const vb = vertex(out, t.b);
    const vc = vertex(out, t.c);
    const normal = triangleNormal(va, vb, vc);
    const outward = dot(normal, sub(va, center));
    if (outward < 0) {
      const tmp = t.b;
      t.b = t.c;
      t.c = tmp;
    }
  }
  return out;
}
function box(widthMm, heightMm, depthMm, center = { x: 0, y: 0, z: 0 }) {
  if (widthMm <= 0 || heightMm <= 0 || depthMm <= 0)
    throw new Error("Box dimensions must be positive.");
  const hw = widthMm / 2;
  const hh = heightMm / 2;
  const hd = depthMm / 2;
  const p = [];
  for (const dx of [-1, 1])
    for (const dy of [-1, 1])
      for (const dz of [-1, 1])
        p.push({ x: center.x + dx * hw, y: center.y + dy * hh, z: center.z + dz * hd });
  const idx = (dx, dy, dz) => {
    const ix = dx === -1 ? 0 : 1;
    const iy = dy === -1 ? 0 : 1;
    const iz = dz === -1 ? 0 : 1;
    return (ix << 2) | (iy << 1) | iz;
  };
  const positions = [];
  for (const v of p) positions.push(v.x, v.y, v.z);
  const tris = [];
  const face = (v1, v2, v3, v4) => {
    tris.push({ a: v1, b: v2, c: v3 }, { a: v1, b: v3, c: v4 });
  };
  face(idx(-1, -1, -1), idx(1, -1, -1), idx(1, 1, -1), idx(-1, 1, -1));
  face(idx(-1, -1, 1), idx(-1, 1, 1), idx(1, 1, 1), idx(1, -1, 1));
  face(idx(-1, -1, -1), idx(-1, 1, -1), idx(-1, 1, 1), idx(-1, -1, 1));
  face(idx(1, -1, -1), idx(1, -1, 1), idx(1, 1, 1), idx(1, 1, -1));
  face(idx(-1, -1, -1), idx(-1, -1, 1), idx(1, -1, 1), idx(1, -1, -1));
  face(idx(-1, 1, -1), idx(1, 1, -1), idx(1, 1, 1), idx(-1, 1, 1));
  return { positions, tris };
}
function prism(sides, radiusMm, heightMm, center = { x: 0, y: 0, z: 0 }) {
  if (sides < 3) throw new Error("prism needs at least 3 sides.");
  if (radiusMm <= 0 || heightMm <= 0) throw new Error("prism radius/height must be positive.");
  const positions = [];
  const tris = [];
  const push = (x, y, z3) => {
    positions.push(center.x + x, center.y + y, center.z + z3);
    return positions.length / 3 - 1;
  };
  const bottom = [];
  const top = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const x = Math.cos(angle) * radiusMm;
    const y = Math.sin(angle) * radiusMm;
    bottom.push(push(x, y, -heightMm / 2));
    top.push(push(x, y, heightMm / 2));
  }
  for (let i = 0; i < sides; i++) {
    const a = bottom[i % sides];
    const b = bottom[(i + 1) % sides];
    tris.push({ a, b, c: bottom[0] });
  }
  for (let i = 0; i < sides; i++) {
    const a = top[i % sides];
    const b = top[(i + 1) % sides];
    tris.push({ a, b: top[0], c: b });
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tris.push({ a: bottom[i], b: top[i], c: top[j] }, { a: bottom[i], b: top[j], c: bottom[j] });
  }
  return { positions, tris };
}
function cylinder(radiusMm, heightMm, segments = 64, center = { x: 0, y: 0, z: 0 }) {
  return prism(Math.max(segments, 3), radiusMm, heightMm, center);
}
function cone(radiusBottomMm, radiusTopMm, heightMm, segments = 64, center = { x: 0, y: 0, z: 0 }) {
  if (radiusBottomMm <= 0 || heightMm <= 0)
    throw new Error("cone bottom radius/height must be positive.");
  if (radiusTopMm < 0) throw new Error("cone top radius must be >= 0.");
  const positions = [];
  const tris = [];
  const push = (x, y, z3) => {
    positions.push(center.x + x, center.y + y, center.z + z3);
    return positions.length / 3 - 1;
  };
  const bottom = [];
  const top = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    bottom.push(
      push(Math.cos(angle) * radiusBottomMm, Math.sin(angle) * radiusBottomMm, -heightMm / 2),
    );
    top.push(push(Math.cos(angle) * radiusTopMm, Math.sin(angle) * radiusTopMm, heightMm / 2));
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const a = bottom[i];
    const b = bottom[j];
    const c = top[j];
    const d = top[i];
    if (radiusTopMm < 1e-9) {
      tris.push({ a, b, c });
    } else {
      tris.push({ a, b, c }, { a, b: c, c: d });
    }
  }
  for (let i = 0; i < segments; i++)
    tris.push({ a: bottom[(i + 1) % segments], b: bottom[i], c: bottom[0] });
  if (radiusTopMm > 1e-9) {
    for (let i = 0; i < segments; i++)
      tris.push({ a: top[i], b: top[(i + 1) % segments], c: top[0] });
  }
  return { positions, tris };
}
function sphere(radiusMm, segments = 32, rings = 16, center = { x: 0, y: 0, z: 0 }) {
  if (radiusMm <= 0) throw new Error("sphere radius must be positive.");
  const positions = [];
  const tris = [];
  const push = (x, y, z3) => {
    positions.push(center.x + x, center.y + y, center.z + z3);
    return positions.length / 3 - 1;
  };
  const grid = [];
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    const row = [];
    const sinPhi = Math.sin(phi);
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      row.push(
        push(
          radiusMm * sinPhi * Math.cos(theta),
          radiusMm * sinPhi * Math.sin(theta),
          radiusMm * Math.cos(phi),
        ),
      );
    }
    grid.push(row);
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = grid[i][j];
      const b = grid[i + 1][j];
      const c = grid[i + 1][j + 1];
      const d = grid[i][j + 1];
      tris.push({ a, b, c }, { a, b: c, c: d });
    }
  }
  return { positions, tris };
}
function translate(mesh, dx, dy, dz) {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] += dx;
    mesh.positions[i + 1] += dy;
    mesh.positions[i + 2] += dz;
  }
  return mesh;
}
function rotate(mesh, axis, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    const z3 = mesh.positions[i + 2];
    if (axis === "x") {
      mesh.positions[i + 1] = y * cos - z3 * sin;
      mesh.positions[i + 2] = y * sin + z3 * cos;
    } else if (axis === "y") {
      mesh.positions[i] = x * cos + z3 * sin;
      mesh.positions[i + 2] = -x * sin + z3 * cos;
    } else {
      mesh.positions[i] = x * cos - y * sin;
      mesh.positions[i + 1] = x * sin + y * cos;
    }
  }
  return mesh;
}
function scaleMesh(mesh, sx, sy, sz) {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] *= sx;
    mesh.positions[i + 1] *= sy;
    mesh.positions[i + 2] *= sz;
  }
  return mesh;
}
function centerOnOrigin(mesh) {
  const bb = computeBoundingBox(mesh);
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  translate(mesh, -cx, -cy, -cz);
  return { x: cx, y: cy, z: cz };
}
function computeBoundingBox(mesh) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    const z3 = mesh.positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z3 < minZ) minZ = z3;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z3 > maxZ) maxZ = z3;
  }
  return {
    min: {
      x: minX === Infinity ? 0 : minX,
      y: minY === Infinity ? 0 : minY,
      z: minZ === Infinity ? 0 : minZ,
    },
    max: {
      x: maxX === -Infinity ? 0 : maxX,
      y: maxY === -Infinity ? 0 : maxY,
      z: maxZ === -Infinity ? 0 : maxZ,
    },
  };
}
function volume(mesh) {
  let total = 0;
  for (const t of mesh.tris) {
    const a = vertex(mesh, t.a);
    const b = vertex(mesh, t.b);
    const c = vertex(mesh, t.c);
    total += dot(cross(b, c), a);
  }
  return Math.abs(total / 6);
}
function surfaceArea(mesh) {
  let total = 0;
  for (const t of mesh.tris) {
    const a = vertex(mesh, t.a);
    const b = vertex(mesh, t.b);
    const c = vertex(mesh, t.c);
    total += 0.5 * length(cross(sub(b, a), sub(c, a)));
  }
  return total;
}
var POINT_COPLANAR = 0;
var POINT_FRONT = 1;
var POINT_BACK = 2;
function csgPlaneFromTri(tri) {
  const n = normalize(cross(sub(tri.b, tri.a), sub(tri.c, tri.a)));
  return { normal: n, d: dot(n, tri.a) };
}
function csgPointSide(plane, p) {
  const d = dot(plane.normal, p) - plane.d;
  if (d > EPSILON) return POINT_FRONT;
  if (d < -EPSILON) return POINT_BACK;
  return POINT_COPLANAR;
}
function clipPolygonHalfSpace(poly, plane) {
  if (poly.length < 3) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const curSide = csgPointSide(plane, cur);
    const prevSide = csgPointSide(plane, prev);
    if (curSide !== POINT_BACK) {
      if (prevSide === POINT_BACK) {
        const inter = intersectLinePlane(prev, cur, plane);
        if (inter) out.push(inter);
      }
      out.push(cur);
    } else if (prevSide !== POINT_BACK) {
      const inter = intersectLinePlane(prev, cur, plane);
      if (inter) out.push(inter);
    }
  }
  return out;
}
function intersectLinePlane(a, b, plane) {
  const dir = sub(b, a);
  const denom = dot(plane.normal, dir);
  if (Math.abs(denom) < 1e-14) return null;
  const t = (plane.d - dot(plane.normal, a)) / denom;
  const tt = Math.min(1, Math.max(0, t));
  return { x: a.x + dir.x * tt, y: a.y + dir.y * tt, z: a.z + dir.z * tt };
}
function booleanCsg(a, b, op) {
  const aTris = meshToCsgTriangles(a);
  const bTris = meshToCsgTriangles(b);
  const aPlanes = trianglesToPlanes(bTris);
  const bPlanes = trianglesToPlanes(aTris);
  const out = [];
  if (op === "add" || op === "union") {
    const aOut = meshToMeshClippedAll(a, bPlanes, true);
    const bOut = meshToMeshClippedAll(b, aPlanes, true);
    return mergeMeshes(aOut, bOut);
  } else if (op === "subtract") {
    const aOut = meshToMeshClippedAll(a, bPlanes, true);
    const bIn = meshToMeshClippedAll(b, aPlanes, false);
    flipMesh(bIn);
    return mergeMeshes(aOut, bIn);
  } else if (op === "intersect") {
    const aIn = meshToMeshClippedAll(a, bPlanes, false);
    const bIn = meshToMeshClippedAll(b, aPlanes, false);
    return mergeMeshes(aIn, bIn);
  }
  throw new Error(`Unsupported CSG op: ${op}`);
}
function flipMesh(mesh) {
  for (const t of mesh.tris) {
    const tmp = t.b;
    t.b = t.c;
    t.c = tmp;
  }
}
function meshToCsgTriangles(mesh) {
  return mesh.tris.map((t) => ({
    a: vertex(mesh, t.a),
    b: vertex(mesh, t.b),
    c: vertex(mesh, t.c),
  }));
}
function trianglesToPlanes(tris) {
  return tris.map(csgPlaneFromTri);
}
function meshToMeshClippedAll(mesh, planes, keepFront) {
  let current = cloneMesh(mesh);
  for (const plane of planes) {
    const next = keepFront
      ? clipMeshHalfSpaceKeepFront(current, plane)
      : clipMeshHalfSpaceKeepBack(current, plane);
    current = next;
  }
  return current;
}
function clipMeshHalfSpaceKeepFront(mesh, plane) {
  const keep = makeMesh();
  const cutVerts = [];
  for (const t of mesh.tris) {
    const coil = meshTriangleToVecs(mesh, t);
    const clipped = clipPolygonHalfSpace(coil, plane);
    if (clipped.length < 3) continue;
    const start = keep.positions.length / 3;
    for (const v of clipped) keep.positions.push(v.x, v.y, v.z);
    for (let i = 1; i < clipped.length - 1; i++) {
      keep.tris.push({ a: start, b: start + i, c: start + i + 1 });
    }
    for (const v of clipped) {
      if (Math.abs(csgPointSide(plane, v)) <= EPSILON) cutVerts.push(v);
    }
  }
  return capCutFace(keep, cutVerts, plane);
}
function clipMeshHalfSpaceKeepBack(mesh, plane) {
  const inversePlane = { normal: scale(plane.normal, -1), d: -plane.d };
  const keep = makeMesh();
  const cutVerts = [];
  for (const t of mesh.tris) {
    const coil = meshTriangleToVecs(mesh, t);
    const clipped = clipPolygonHalfSpace(coil, inversePlane);
    if (clipped.length < 3) continue;
    const start = keep.positions.length / 3;
    for (const v of clipped) keep.positions.push(v.x, v.y, v.z);
    for (let i = 1; i < clipped.length - 1; i++) {
      keep.tris.push({ a: start, b: start + i, c: start + i + 1 });
    }
    for (const v of clipped) {
      if (Math.abs(csgPointSide(plane, v)) <= EPSILON) cutVerts.push(v);
    }
  }
  return capCutFace(keep, cutVerts, plane);
}
function meshTriangleToVecs(mesh, t) {
  return [vertex(mesh, t.a), vertex(mesh, t.b), vertex(mesh, t.c)];
}
function capCutFace(mesh, cutVerts, plane) {
  const dedup = dedupeVertices(mesh);
  if (cutVerts.length < 3) return dedup;
  const n = plane.normal;
  const ref = cutVerts[0];
  const center = { x: 0, y: 0, z: 0 };
  for (const v of cutVerts) {
    center.x += v.x;
    center.y += v.y;
    center.z += v.z;
  }
  const cnt = cutVerts.length;
  center.x /= cnt;
  center.y /= cnt;
  center.z /= cnt;
  const u = normalize(cross(n, sub(ref, center)));
  const vAxis = normalize(cross(n, u));
  const ordered = [...cutVerts].sort((a, b) => {
    const ax = dot(sub(a, center), u);
    const ay = dot(sub(a, center), vAxis);
    const bx = dot(sub(b, center), u);
    const by = dot(sub(b, center), vAxis);
    return Math.atan2(ay, ax) - Math.atan2(by, bx);
  });
  const positions = [...dedup.positions];
  const tris = [...dedup.tris];
  const remap = (p) => {
    const key = `${p.x},${p.y},${p.z}`;
    const existing = positions.findIndex((v, i) => {
      if (i % 3 !== 0) return false;
      return (
        Math.abs(positions[i] - p.x) < 1e-9 &&
        Math.abs(positions[i + 1] - p.y) < 1e-9 &&
        Math.abs(positions[i + 2] - p.z) < 1e-9
      );
    });
    if (existing !== -1) return existing / 3;
    positions.push(p.x, p.y, p.z);
    return positions.length / 3 - 1;
  };
  const centerIdx = remap(center);
  for (let i = 0; i < ordered.length; i++) {
    const a = remap(ordered[i]);
    const b = remap(ordered[(i + 1) % ordered.length]);
    tris.push({ a: centerIdx, b: a, c: b });
  }
  return { positions, tris };
}
function dedupeVertices(mesh) {
  const positions = [];
  const keyToIdx = /* @__PURE__ */ new Map();
  const remap = (v) => {
    const key = `${v.x},${v.y},${v.z}`;
    const existing = keyToIdx.get(key);
    if (existing !== void 0) return existing;
    positions.push(v.x, v.y, v.z);
    const idx = positions.length / 3 - 1;
    keyToIdx.set(key, idx);
    return idx;
  };
  const tris = [];
  for (const t of mesh.tris) {
    tris.push({
      a: remap(vertex(mesh, t.a)),
      b: remap(vertex(mesh, t.b)),
      c: remap(vertex(mesh, t.c)),
    });
  }
  return { positions, tris };
}
function exportBinaryStl(mesh, name = "model") {
  const header = Buffer.alloc(80);
  header.write(name.slice(0, 79), 0, "latin1");
  const triangleCount = mesh.tris.length;
  if (triangleCount > 4294967295) throw new Error("Too many triangles for binary STL.");
  const buffer = Buffer.alloc(84 + triangleCount * 50);
  header.copy(buffer, 0);
  buffer.writeUInt32LE(triangleCount, 80);
  let offset = 84;
  for (const t of mesh.tris) {
    const a = vertex(mesh, t.a);
    const b = vertex(mesh, t.b);
    const c = vertex(mesh, t.c);
    const n = normalize(triangleNormal(a, b, c));
    buffer.writeFloatLE(n.x, offset);
    buffer.writeFloatLE(n.y, offset + 4);
    buffer.writeFloatLE(n.z, offset + 8);
    offset += 12;
    for (const v of [a, b, c]) {
      buffer.writeFloatLE(v.x, offset);
      buffer.writeFloatLE(v.y, offset + 4);
      buffer.writeFloatLE(v.z, offset + 8);
      offset += 12;
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  return buffer;
}
function fmt(n) {
  return Number(n.toFixed(6)).toString();
}
function exportObj(mesh) {
  const lines = ["# exported by anycubic-slicer-next-control CAD module", `o model`];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(
      `v ${fmt(mesh.positions[i])} ${fmt(mesh.positions[i + 1])} ${fmt(mesh.positions[i + 2])}`,
    );
  }
  for (const t of mesh.tris) {
    lines.push(`f ${t.a + 1} ${t.b + 1} ${t.c + 1}`);
  }
  return lines.join("\n") + "\n";
}
function export3mf(mesh, name = "model", material) {
  const unit = "millimeter";
  const color = material?.color ?? [200, 200, 200];
  const colorStr = `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const parts = [];
  const verticesXml = mesh.positions
    .map((_, i) => {
      if (i % 3 !== 0) return "";
      return `      <vertex x="${fmt(mesh.positions[i])}" y="${fmt(mesh.positions[i + 1])}" z="${fmt(mesh.positions[i + 2])}"/>`;
    })
    .join("\n");
  const trisXml = mesh.tris
    .map((t) => `      <triangle v1="${t.a}" v2="${t.b}" v3="${t.c}"/>`)
    .join("\n");
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model" name="${escapeXml(name)}">
      <mesh>
        <vertices>
${verticesXml}
        </vertices>
        <triangles>
${trisXml}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1"/>
  </build>
</model>`;
  parts.push({
    path: "model/3dmodel.model",
    content: modelXml,
    contentType: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
  });
  parts.push({
    path: "[Content_Types].xml",
    contentType: "application/vnd.openxmlformats-package.content-types+xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Override PartName="/model/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`,
  });
  parts.push({
    path: "_rels/.rels",
    contentType: "application/vnd.openxmlformats-package.relationships+xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/model/3dmodel.model"/>
</Relationships>`,
  });
  return buildZip(parts);
}
function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function buildZip(parts) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const date = 33;
  const time = 0;
  for (const part of parts) {
    const data = Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, "utf8");
    const nameBuf = Buffer.from(part.path, "utf8");
    const nameLen = nameBuf.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(67324752, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameLen, 26);
    local.writeUInt16LE(0, 28);
    const localChunk = Buffer.concat([local, nameBuf, data]);
    chunks.push(localChunk);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(33639248, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc32(data), 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameLen, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += localChunk.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(101010256, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}
function crc32(buf) {
  let crc = 4294967295;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (3988292384 & -(crc & 1));
    }
  }
  return (crc ^ 4294967295) >>> 0;
}

// src/cad-server.ts
var DEFAULT_INACTIVITY_MS = 30 * 60 * 1e3;
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}
function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function createScene() {
  return {
    objects: /* @__PURE__ */ new Map(),
    faceGroups: /* @__PURE__ */ new Map(),
    nextGroupId: 1,
    materials: /* @__PURE__ */ new Map(),
    faceSelection: /* @__PURE__ */ new Map(),
    revision: 0,
    dirty: false,
    sseClients: /* @__PURE__ */ new Set(),
  };
}
function rebuildFaceGroups(state, name) {
  const mesh = state.objects.get(name);
  if (!mesh) return [];
  const regions = detectPlanarRegions(mesh);
  const existing = state.faceGroups.get(name) ?? [];
  const byFaces = /* @__PURE__ */ new Map();
  for (const g of existing) byFaces.set(g.faces.join(","), g);
  const groups = regions.map((faces, i) => {
    const key = faces.join(",");
    const old = byFaces.get(key);
    if (old) return old;
    const g = { id: state.nextGroupId++, faces };
    const prevMat = existing.find((x) => x.faces.some((f) => faces.includes(f)))?.material;
    if (prevMat) g.material = prevMat;
    if (mesh.tris[faces[0]]) {
      const t = mesh.tris[faces[0]];
      const v0 = {
        x: mesh.positions[t.a * 3],
        y: mesh.positions[t.a * 3 + 1],
        z: mesh.positions[t.a * 3 + 2],
      };
      const v1 = {
        x: mesh.positions[t.b * 3],
        y: mesh.positions[t.b * 3 + 1],
        z: mesh.positions[t.b * 3 + 2],
      };
      const v2 = {
        x: mesh.positions[t.c * 3],
        y: mesh.positions[t.c * 3 + 1],
        z: mesh.positions[t.c * 3 + 2],
      };
      const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
      const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
      const nrm = {
        x: e1.y * e2.z - e1.z * e2.y,
        y: e1.z * e2.x - e1.x * e2.z,
        z: e1.x * e2.y - e1.y * e2.x,
      };
      const len = Math.hypot(nrm.x, nrm.y, nrm.z) || 1;
      g.normal = { x: nrm.x / len, y: nrm.y / len, z: nrm.z / len };
    }
    return g;
  });
  state.faceGroups.set(name, groups);
  return groups;
}
function invalidateFaceGroups(state, name) {
  state.faceGroups.delete(name);
}
function notifySse(state) {
  const payload = `event: scene
data: ${JSON.stringify({ type: "scene", revision: state.revision })}

`;
  for (const res of state.sseClients) {
    try {
      res.write(payload);
    } catch {}
  }
}
function buildPrimitive(params) {
  const name = params.name ?? params.kind;
  const c = params.center ?? { x: 0, y: 0, z: 0 };
  switch (params.kind) {
    case "box":
      return box(params.width ?? 10, params.height ?? 10, params.depth ?? 10, c);
    case "cylinder":
      return cylinder(params.radius ?? 5, params.height ?? 10, params.segments ?? 64, c);
    case "cone":
      return cone(
        params.radiusBottom ?? params.radius ?? 5,
        params.radiusTop ?? 0,
        params.height ?? 10,
        params.segments ?? 64,
        c,
      );
    case "sphere":
      return sphere(
        params.radius ?? 5,
        params.segments ?? 32,
        Math.max(8, Math.floor((params.segments ?? 32) / 2)),
        c,
      );
    case "prism":
      return prism(params.sides ?? 6, params.radius ?? 5, params.height ?? 10, c);
    case "empty":
      return makeMesh();
    default: {
      const kind = params.kind ?? "box";
      throw new Error(`Unknown primitive kind: ${kind}`);
    }
  }
}
function applyTransform(mesh, params) {
  const out = cloneMesh(mesh);
  if (params.translate) translate(out, params.translate.x, params.translate.y, params.translate.z);
  if (params.rotate) rotate(out, params.rotate.axis, params.rotate.degrees);
  if (params.scale) scaleMesh(out, params.scale.x, params.scale.y, params.scale.z);
  if (params.center) centerOnOrigin(out);
  // Center the object's XY footprint on the build-plate origin and set its
  // Z so the lowest vertex sits exactly on the plate (z=0). This is the
  // full "center & place on plate" tool used by the CAD UI and MCP.
  if (params.center_on_plate) {
    const bb = computeBoundingBox(out);
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    translate(out, -cx, -cy, -bb.min.z);
  }
  return out;
}

/**
 * arrangeObjects — delega ao módulo puro `scripts/cad-arrange.mjs`
 * (shelf packing: distribuição uniforme sem sobreposição, cada peça centrada
 * na origem XY e assente em Z=0). Import lazy/uma vez para o bundle.
 * @param {Map<string, object>} objectsMap
 * @param {object} [opts]
 * @returns {Promise<{placed: Array, warnings: string[]}>}
 */
async function arrangeObjects(objectsMap, opts = {}) {
  const { arrangeObjects: arrange } = await import("../scripts/cad-arrange.mjs");
  const res = arrange(objectsMap, opts);
  for (const [name, mesh] of res.objects) objectsMap.set(name, mesh);
  return { placed: res.placed, warnings: res.warnings };
}

function meshInfo(name, mesh) {
  const bb = computeBoundingBox(mesh);
  return {
    name,
    vertices: mesh.positions.length / 3,
    triangles: mesh.tris.length,
    bounds: {
      min: { x: bb.min.x, y: bb.min.y, z: bb.min.z },
      max: { x: bb.max.x, y: bb.max.y, z: bb.max.z },
    },
    sizeMm: {
      x: bb.max.x - bb.min.x,
      y: bb.max.y - bb.min.y,
      z: bb.max.z - bb.min.z,
    },
    volumeMm3: volume(mesh),
    surfaceAreaMm2: surfaceArea(mesh),
    watertight: isWatertight(mesh),
  };
}
function isWatertight(mesh) {
  const edges = /* @__PURE__ */ new Map();
  for (const t of mesh.tris) {
    const p = [t.a, t.b, t.c];
    for (let i = 0; i < 3; i++) {
      const a = p[i];
      const b = p[(i + 1) % 3];
      const key = `${a},${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    if (count !== 1) continue;
    const [aStr, bStr] = key.split(",");
    const reverseKey = `${bStr},${aStr}`;
    if (!edges.has(reverseKey)) return false;
  }
  let ok = true;
  for (const [key, count] of edges) {
    if (count !== 1) continue;
    const [aStr, bStr] = key.split(",");
    const reverseKey = `${bStr},${aStr}`;
    if (!edges.has(reverseKey) || edges.get(reverseKey) !== 1) {
      ok = false;
      break;
    }
  }
  return ok;
}
function parseStl(data) {
  if (data.length >= 84) {
    const count = data.readUInt32LE(80);
    if (data.length >= 84 + count * 50) {
      return parseBinaryStl(data);
    }
  }
  return parseAsciiStl(data.toString("utf8"));
}
function parseBinaryStl(data) {
  const count = data.readUInt32LE(80);
  const positions = [];
  const tris = [];
  let offset = 84;
  for (let i = 0; i < count; i++) {
    const v = () => {
      const x = data.readFloatLE(offset);
      const y = data.readFloatLE(offset + 4);
      const z3 = data.readFloatLE(offset + 8);
      offset += 12;
      positions.push(x, y, z3);
      return positions.length / 3 - 1;
    };
    offset += 12;
    const a = v();
    const b = v();
    const c = v();
    offset += 2;
    tris.push({ a, b, c });
  }
  return { positions, tris };
}
function parseAsciiStl(text) {
  const positions = [];
  const tris = [];
  const regex = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match;
  let pending = [];
  while ((match = regex.exec(text)) !== null) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const z3 = parseFloat(match[3]);
    positions.push(x, y, z3);
    pending.push(positions.length / 3 - 1);
    if (pending.length === 3) {
      tris.push({ a: pending[0], b: pending[1], c: pending[2] });
      pending = [];
    }
  }
  return { positions, tris };
}
function createCadServer(scene) {
  const appState = scene ?? createScene();
  let server2 = null;
  let handle = null;
  let inactivityTimer = null;
  let outputRoot = "";
  const token = randomBytes2(16).toString("hex");
  function resetInactivity(ms) {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (ms > 0) {
      inactivityTimer = setTimeout(() => {
        void stop();
      }, ms);
    }
  }
  async function stop() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (server2) {
      await new Promise((resolve) => {
        server2?.close(() => resolve());
        server2?.closeAllConnections?.();
        setTimeout(resolve, 200);
      });
      server2 = null;
    }
    handle = null;
  }
  function requireToken(req) {
    const header = req.headers["x-cad-token"];
    return header === token;
  }
  function serveIndex(res) {
    const indexPath = path10.join(pluginRoot2(), "ui", "cad.html");
    if (!existsSync3(indexPath)) {
      json(res, 404, { ok: false, error: "cad.html not found in plugin ui/ folder" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync(indexPath));
  }
  function serveStatic(res, file) {
    const filePath = path10.join(pluginRoot2(), "ui", path10.basename(file));
    if (!existsSync3(filePath)) {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }
    const ext = path10.extname(file).toLowerCase();
    const types = {
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    res.writeHead(200, {
      "Content-Type": types[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(readFileSync(filePath));
  }
  function listObjects() {
    return [...appState.objects.entries()].map(([name, mesh]) => ({
      ...meshInfo(name, mesh),
      revision: appState.revision,
    }));
  }
  // Shared parametric script executor (Sprint 2 + Sprint 3 UI): runs a
  // sandboxed script over manifold-3d and materializes the mesh into appState.
  async function runParametricScript(script, objectName, payload = {}) {
    const forbidden = [
      "process",
      "require",
      "import(",
      "import ",
      "fetch",
      "eval",
      "Function",
      "module",
      "globalThis",
      "Buffer",
      "\\",
    ];
    for (const token of forbidden) {
      if (token === "\\" ? script.includes("\\") : script.includes(token)) {
        throw new Error(`script may not contain '${token}' (sandboxed)`);
      }
    }
    const M = await (await import("manifold-3d")).default();
    const engine = {
      box: (w, h = w, d = w) => M._Cube({ x: w, y: h, z: d }, true),
      cylinder: (r, h, segs = 32) => M._Cylinder(h, r, r, segs, true),
      sphere: (r, segs = 32) => M._Sphere(r, segs),
      cone: (rb, rt, h, segs = 32) => M._Cylinder(h, rb, rt, segs, true),
      tetrahedron: (edge) => M._Tetrahedron(edge),
      add: (a, b) => a.add(b),
      subtract: (a, b) => a.subtract(b),
      intersect: (a, b) => a.intersect(b),
      translate: (h, v) => h._Translate(v),
      rotate: (h, rx, ry, rz) => h._Rotate(rx, ry, rz),
      scale: (h, v) => h._Scale(v),
      mirror: (h, v) => h._Mirror(v),
    };
    const names = Object.keys(engine);
    const fn = new Function(...names, `"use strict";\n${script}`);
    const handle = fn.apply(
      null,
      names.map((k) => engine[k]),
    );
    if (!handle || typeof handle?._GetMeshJS !== "function") {
      throw new Error("script must return a manifold handle (e.g. `return box(10,10,10)`)");
    }
    const meshJS = handle._GetMeshJS(0);
    const numProp = meshJS.numProp * 1;
    const triVerts = meshJS.triVerts;
    const vertProps = meshJS.vertProperties;
    const count = vertProps.length / numProp;
    const positions = [];
    for (let i = 0; i < count; i++) {
      positions.push(
        vertProps[i * numProp],
        vertProps[i * numProp + 1],
        vertProps[i * numProp + 2],
      );
    }
    const tris = [];
    for (let i = 0; i < triVerts.length; i += 3) {
      tris.push({ a: triVerts[i], b: triVerts[i + 1], c: triVerts[i + 2] });
    }
    let volumeMm3 = 0;
    try {
      volumeMm3 = handle.volume ? Number(handle.volume()) : 0;
    } catch {}
    const status = String(handle.status());
    const watertight = (status === "0" || status === "NoError") && tris.length > 0;
    const mesh = { positions, tris };
    appState.objects.set(objectName, mesh);
    appState.revision++;
    appState.dirty = true;
    notifySse(appState);
    return {
      ok: true,
      object: objectName,
      revision: appState.revision,
      vertices: positions.length / 3,
      triangles: tris.length,
      watertight,
      volume_mm3: volumeMm3,
    };
  }
  async function handleApi(pathname, req, res, body) {
    const payload = body ? safeJson(body) : {};
    try {
      const action = pathname.split("/").filter(Boolean)[1] ?? "";
      if (action !== "objects" && action !== "view" && !requireToken(req)) {
        json(res, 401, { ok: false, error: "missing or invalid X-Cad-Token" });
        return;
      }
      switch (action) {
        case "objects":
          json(res, 200, {
            ok: true,
            objects: listObjects(),
            revision: appState.revision,
            groups: snapshotGroups(),
          });
          break;
        case "faces": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const groups = rebuildFaceGroups(appState, name);
          json(res, 200, {
            ok: true,
            groups,
            selection: appState.faceSelection.get(name) ?? [],
            revision: appState.revision,
          });
          break;
        }
        case "grow": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const seed = Number(payload.seed_face ?? 0);
          const angle = Number(payload.angle_deg ?? 15);
          if (!Number.isInteger(seed) || seed < 0 || seed >= mesh.tris.length) {
            return json(res, 400, { ok: false, error: "seed_face out of range" });
          }
          const ids = growFaceRegion(mesh, seed, angle);
          json(res, 200, { ok: true, face_ids: ids, count: ids.length });
          break;
        }
        case "select_faces": {
          const name = String(payload.name ?? "");
          const faces = Array.isArray(payload.face_ids) ? payload.face_ids : [];
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          if (faces.some((f) => f < 0 || f >= mesh.tris.length)) {
            return json(res, 400, { ok: false, error: "face index out of range" });
          }
          appState.faceSelection.set(name, faces);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, selection: faces });
          break;
        }
        case "mesh_edit": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const op = String(payload.op ?? "");
          const faceIds = Array.isArray(payload.face_ids) ? payload.face_ids : void 0;
          const amount = typeof payload.amount === "number" ? payload.amount : 2;
          const region =
            faceIds && faceIds.length > 0 ? faceIds : (appState.faceSelection.get(name) ?? []);
          if (region.length === 0)
            return json(res, 400, {
              ok: false,
              error: "no faces selected (pass face_ids or select first)",
            });
          let updated;
          switch (op) {
            case "extrude":
              updated = extrudeFaces(mesh, region, amount);
              break;
            case "bevel":
              updated = bevelFaces(mesh, region, amount);
              break;
            case "inset":
              updated = bevelFaces(mesh, region, amount);
              break;
            // chamfer-in approximation
            case "subdivide":
              updated = subdivideRegion(mesh, region);
              break;
            case "sculpt":
              updated = sculptRegion(mesh, region, amount, Boolean(payload.smooth));
              break;
            case "weld":
              updated = weldVertices(mesh);
              break;
            default:
              return json(res, 400, { ok: false, error: `unknown edit op '${op}'` });
          }
          updated = ensureConsistentWinding(updated);
          appState.objects.set(name, updated);
          invalidateFaceGroups(appState, name);
          appState.faceSelection.set(name, []);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, ...meshInfo(name, updated) });
          break;
        }
        case "mesh_sub_delete": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const type = String(payload.type ?? "vertex");
          const ids = Array.isArray(payload.ids) ? payload.ids : [];
          if (ids.length === 0) return json(res, 400, { ok: false, error: "no ids" });
          const updated = deleteSubElements(mesh, type, ids);
          if (!updated) return json(res, 400, { ok: false, error: "invalid sub-element ids" });
          const flat = ensureConsistentWinding(updated);
          appState.objects.set(name, flat);
          invalidateFaceGroups(appState, name);
          appState.faceSelection.set(name, []);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, ...meshInfo(name, flat) });
          break;
        }
        case "mesh_bridge": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const type = String(payload.type ?? "vertex");
          const ids = Array.isArray(payload.ids) ? payload.ids : [];
          if (ids.length < 2) return json(res, 400, { ok: false, error: "need >=2 elements" });
          const { updated, added } = bridgeElements(mesh, type, ids);
          if (!updated)
            return json(res, 400, {
              ok: false,
              error: "cannot bridge (need complementary loops/edges)",
            });
          const flat = ensureConsistentWinding(updated);
          appState.objects.set(name, flat);
          invalidateFaceGroups(appState, name);
          appState.faceSelection.set(name, []);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, added, ...meshInfo(name, flat) });
          break;
        }
        case "mesh_add_edge": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const ids = Array.isArray(payload.ids) ? payload.ids : [];
          if (ids.length < 2) return json(res, 400, { ok: false, error: "need >=2 vertices" });
          const { updated, newFaces } = addEdgeBetween(mesh, ids);
          if (!updated)
            return json(res, 400, {
              ok: false,
              error: "cannot add edge (vertices not coplanar/adjacent face needed)",
            });
          const flat = ensureConsistentWinding(updated);
          appState.objects.set(name, flat);
          invalidateFaceGroups(appState, name);
          appState.faceSelection.set(name, []);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, {
            ok: true,
            revision: appState.revision,
            new_faces: newFaces,
            ...meshInfo(name, flat),
          });
          break;
        }
        case "mesh_fill": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const updated = fillHoles(mesh);
          const added = updated.tris.length - mesh.tris.length;
          const flat = ensureConsistentWinding(updated);
          appState.objects.set(name, flat);
          invalidateFaceGroups(appState, name);
          appState.faceSelection.set(name, []);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, added, ...meshInfo(name, flat) });
          break;
        }
        case "mesh_update": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const positions = payload.positions;
          if (!Array.isArray(positions) || positions.some((v) => typeof v !== "number")) {
            return json(res, 400, { ok: false, error: "positions must be an array of numbers" });
          }
          if (positions.length !== mesh.positions.length) {
            return json(res, 400, {
              ok: false,
              error: `positions length mismatch (got ${positions.length}, expected ${mesh.positions.length})`,
            });
          }
          mesh.positions = [...positions];
          // numeric values may be NaN/Infinity from a bad drag — guard
          for (let i = 0; i < mesh.positions.length; i++) {
            if (!Number.isFinite(mesh.positions[i])) {
              return json(res, 400, { ok: false, error: "positions contain non-finite values" });
            }
          }
          invalidateFaceGroups(appState, name);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, ...meshInfo(name, mesh) });
          break;
        }
        case "texture": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const mat = appState.materials.get(name) ?? {};
          if (payload.color) mat.color = payload.color;
          if (payload.texture_url) mat.texture_url = String(payload.texture_url);
          appState.materials.set(name, mat);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, material: mat });
          break;
        }
        case "heightmap": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const faceIds = Array.isArray(payload.face_ids) ? payload.face_ids : void 0;
          const region =
            faceIds && faceIds.length > 0 ? faceIds : (appState.faceSelection.get(name) ?? []);
          if (region.length === 0) return json(res, 400, { ok: false, error: "no faces selected" });
          const strength = typeof payload.strength === "number" ? payload.strength : 1;
          const dataB64 = String(payload.data_base64 ?? "");
          if (!dataB64) return json(res, 400, { ok: false, error: "data_base64 image required" });
          const lum = await grayscaleFromImage(Buffer.from(dataB64, "base64"), 64, 64);
          const updated = displaceRegionByImage(
            mesh,
            region,
            (u, v) => {
              const ux = Math.min(1, Math.max(0, u));
              const uy = Math.min(1, Math.max(0, v));
              const gx = Math.round(ux * (64 - 1));
              const gy = Math.round(uy * (64 - 1));
              return lum[gy * 64 + gx] / 255;
            },
            strength,
            false,
            // stretch side walls: intuitive relief on raw planar faces
          );
          appState.objects.set(name, ensureConsistentWinding(updated));
          invalidateFaceGroups(appState, name);
          appState.faceSelection.set(name, []);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, ...meshInfo(name, updated) });
          break;
        }
        case "image_to_heightfield": {
          const name = String(payload.name ?? "relief");
          const dataB64 = String(payload.data_base64 ?? "");
          if (!dataB64) return json(res, 400, { ok: false, error: "data_base64 image required" });
          const w = Math.max(8, Math.min(256, Number(payload.width ?? 64)));
          const h = Math.max(8, Math.min(256, Number(payload.height ?? 64)));
          const depthMm = Number(payload.depth_mm ?? 4);
          const baseMm = Number(payload.base_mm ?? 1);
          const cellMm = Number(payload.cell_mm ?? depthMm / (w * 0.1));
          const lum = await grayscaleFromImage(Buffer.from(dataB64, "base64"), w, h);
          const mesh = heightfieldToMesh(
            w,
            h,
            cellMm,
            depthMm,
            baseMm,
            (gx, gy) => lum[gy * w + gx] / 255,
            true,
          );
          appState.objects.set(name, ensureConsistentWinding(mesh));
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, ...meshInfo(name, mesh) });
          break;
        }
        case "object": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          json(res, 200, { ok: true, object: meshInfo(name, mesh) });
          break;
        }
        case "add":
          appState.objects.set(
            String(payload.name ?? "object"),
            buildPrimitive(payload.params ?? { kind: "box" }),
          );
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision });
          break;
        case "remove": {
          const name = String(payload.name ?? "");
          appState.objects.delete(name);
          appState.revision++;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision });
          break;
        }
        case "transform": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          appState.objects.set(name, applyTransform(mesh, payload.params ?? {}));
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision });
          break;
        }
        case "arrange": {
          const names = Array.isArray(payload.names) ? payload.names.map((n) => String(n)) : null;
          const sub = new Map();
          for (const [name, mesh] of appState.objects) {
            if (!names || names.includes(name)) sub.set(name, mesh);
          }
          if (sub.size === 0) {
            return json(res, 400, { ok: false, error: "no objects to arrange" });
          }
          const result = await arrangeObjects(sub, {
            plateW: payload.plateW,
            plateD: payload.plateD,
            gap: payload.gap,
            center: payload.center,
          });
          for (const [name, mesh] of sub) appState.objects.set(name, mesh);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, {
            ok: true,
            revision: appState.revision,
            placed: result.placed,
            warnings: result.warnings,
          });
          break;
        }
        case "boolean": {
          const nameA = String(payload.name_a ?? "");
          const nameB = String(payload.name_b ?? "");
          const op = String(payload.op ?? "add");
          const resultName = String(payload.result_name ?? "result");
          const a = appState.objects.get(nameA);
          const b = appState.objects.get(nameB);
          if (!a || !b) return json(res, 404, { ok: false, error: "both operands must exist" });
          const result = booleanCsg(a, b, op);
          appState.objects.set(resultName, result);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision });
          break;
        }
        case "export": {
          const name = String(payload.name ?? "");
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          const format = String(payload.format ?? "stl").toLowerCase();
          const exportName = String(payload.export_name ?? name);
          const safeName = exportName.replace(/[^a-zA-Z0-9_-]/g, "_");
          const filePath = path10.join(
            outputRoot,
            `${safeName}.${format === "3mf" ? "3mf" : format === "obj" ? "obj" : "stl"}`,
          );
          const dir = path10.dirname(filePath);
          if (!existsSync3(dir)) mkdirSync(dir, { recursive: true });
          let data;
          if (format === "stl") data = exportBinaryStl(mesh, safeName);
          else if (format === "obj") data = exportObj(mesh);
          else data = export3mf(mesh, safeName);
          writeFileSync(filePath, data);
          json(res, 200, {
            ok: true,
            file_path: filePath,
            name: safeName,
            format,
            bytes: typeof data === "string" ? Buffer.byteLength(data) : data.length,
          });
          break;
        }
        case "import": {
          const name = String(payload.name ?? "imported");
          const dataB64 = String(payload.data_base64 ?? "");
          if (!dataB64) return json(res, 400, { ok: false, error: "data_base64 required" });
          const buf = Buffer.from(dataB64, "base64");
          const mesh = parseStl(buf);
          if (mesh.tris.length === 0)
            return json(res, 400, { ok: false, error: "no triangles found in STL/OBJ data" });
          appState.objects.set(name, mesh);
          appState.revision++;
          appState.dirty = true;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision, ...meshInfo(name, mesh) });
          break;
        }
        case "ai_prompt": {
          // Sprint 3 (S3-003-UI): text→CAD. dry_run returns a deterministic
          // script preview (no provider call). Real runs call the env-configured
          // provider, validate, execute and materialize the result.
          const prompt = String(payload.prompt ?? "");
          const dryRun = payload.dry_run === true;
          const objectName = String(payload.object_name ?? "ai_result");
          if (!prompt.trim()) return json(res, 400, { ok: false, error: "prompt required" });
          try {
            const { translatePromptToScript } = await import("../scripts/cad-ai-translator.mjs");
            const { validateParametricScript } =
              await import("../scripts/cad-script-validator.mjs");
            const translated = await translatePromptToScript({
              prompt,
              params: {},
              dryRun,
            });
            if (dryRun) {
              const check = validateParametricScript(translated.script);
              return json(res, 200, {
                ok: true,
                dry_run: true,
                model: translated.model,
                script: translated.script,
                script_valid: check.ok,
                script_error: check.ok ? null : check.error,
              });
            }
            const out = await runParametricScript(translated.script, objectName, payload);
            json(res, 200, { ...out, model: translated.model, prompt, script: translated.script });
          } catch (error) {
            const msg = String(error?.message ?? error).slice(0, 300);
            if (/not configured/i.test(msg)) {
              json(res, 200, {
                ok: false,
                error: "AI provider not configured (set CAD_AI_API_KEY)",
              });
            } else {
              json(res, 400, { ok: false, error: msg });
            }
          }
          break;
        }
        case "parametric": {
          // Sprint 2 (S2-003): declarative parametric script over manifold-3d.
          // Runs sandboxed (no process/require/import/fetch/eval) and stores the
          // resulting manifold mesh as a workspace object (live in the UI).
          const script = String(payload.script ?? "");
          const objectName = String(payload.object_name ?? "parametric");
          if (!script || script.trim().length === 0)
            return json(res, 400, { ok: false, error: "script required" });
          try {
            const out = await runParametricScript(script, objectName, payload);
            json(res, 200, { ...out });
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
          }
          break;
        }
        case "clear": {
          appState.objects.clear();
          appState.faceGroups.clear();
          appState.materials.clear();
          appState.faceSelection.clear();
          appState.revision++;
          appState.dirty = false;
          notifySse(appState);
          json(res, 200, { ok: true, revision: appState.revision });
          break;
        }
        case "health":
          json(res, 200, { ok: true, revision: appState.revision });
          break;
        default:
          json(res, 404, { ok: false, error: `unknown action ${action}` });
      }
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const isMutationAction = (a) => !["objects", "faces", "object", "health", "view"].includes(a);
  function snapshotGroups() {
    return [...appState.objects.keys()].map((name) => ({
      name,
      groups: appState.faceGroups.get(name) ?? rebuildFaceGroups(appState, name),
      selection: appState.faceSelection.get(name) ?? [],
      material: appState.materials.get(name) ?? null,
    }));
  }
  async function grayscaleFromImage(buf, w, h) {
    try {
      const { default: png } = await import("pngjs");
      const pngObj = png.PNG.sync.read(buf, { skipRescale: true });
      const srcW = pngObj.width,
        srcH = pngObj.height;
      const data = pngObj.data;
      const out = new Uint8Array(w * h);
      const sum = (x, y) => {
        const sx = Math.min(srcW - 1, Math.max(0, Math.floor((x / w) * srcW)));
        const sy = Math.min(srcH - 1, Math.max(0, Math.floor((y / h) * srcH)));
        const idx = (sy * srcW + sx) * 4;
        return data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) out[y * w + x] = sum(x, y);
      }
      return out;
    } catch {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) out[y * w + x] = Math.floor(255 * ((x / w + y / h) / 2));
      }
      return out;
    }
  }
  return {
    async start(options) {
      if (server2) return handle;
      outputRoot = options.outputRoot;
      const port = options.port ?? 0;
      const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_INACTIVITY_MS;
      server2 = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathname = url.pathname;
        resetInactivity(idleTimeoutMs);
        if (req.method === "GET" && pathname === "/sync") {
          if (!requireToken(req) && !url.searchParams.has("token")) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("401 Unauthorized");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(
            `retry: 2000
event: scene
data: ${JSON.stringify({ type: "scene", revision: appState.revision })}

`,
          );
          appState.sseClients.add(res);
          req.on("close", () => appState.sseClients.delete(res));
          return;
        }
        if (
          req.method === "GET" &&
          (pathname === "/" || pathname === "/index.html" || pathname === "/cad.html")
        ) {
          if (!requireToken(req) && !url.searchParams.has("token")) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("401 Unauthorized \u2014 invalid CAD workspace token");
            return;
          }
          return serveIndex(res);
        }
        if (req.method === "GET" && pathname.startsWith("/ui/")) {
          if (!requireToken(req) && !url.searchParams.has("token")) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("401 Unauthorized \u2014 invalid CAD workspace token");
            return;
          }
          return serveStatic(res, pathname.slice("/ui/".length));
        }
        if (req.method === "GET" && pathname === "/health") {
          return json(res, 200, { ok: true, revision: appState.revision });
        }
        if (req.method === "GET" && pathname.startsWith("/mesh/")) {
          if (!requireToken(req) && !url.searchParams.has("token")) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("401 Unauthorized");
            return;
          }
          const name = decodeURIComponent(pathname.slice("/mesh/".length));
          const mesh = appState.objects.get(name);
          if (!mesh) return json(res, 404, { ok: false, error: `object '${name}' not found` });
          // mesh.positions may be a Float32Array (TypedArray) that JSON.stringify
          // would serialize as an indexed object — convert to a plain array so the
          // client can build a Float32Array from it (fixes blank viewport).
          const positions = Array.from(mesh.positions, Number);
          json(res, 200, { ok: true, name, positions, tris: mesh.tris });
          return;
        }
        if (req.method === "GET" && pathname.startsWith("/api/")) {
          return handleApi(pathname, req, res, "");
        }
        if (req.method === "POST" && pathname.startsWith("/api/")) {
          const body = await readBody(req);
          return handleApi(pathname, req, res, body);
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      });
      await new Promise((resolve, reject) => {
        server2.once("error", reject);
        server2.listen(port, "127.0.0.1", () => resolve());
      });
      const address = server2.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      handle = {
        url: `http://127.0.0.1:${actualPort}/?token=${token}`,
        host: "127.0.0.1",
        port: actualPort,
        token,
        stop,
      };
      resetInactivity(idleTimeoutMs);
      return handle;
    },
    async stop() {
      await stop();
    },
  };
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function pluginRoot2() {
  const sourceDir2 = path10.dirname(fileURLToPath2(import.meta.url));
  const candidates = [path10.resolve(sourceDir2, ".."), path10.resolve(sourceDir2, "../..")];
  for (const c of candidates) {
    if (existsSync3(path10.join(c, "ui", "cad.html"))) return c;
  }
  return candidates[0] ?? sourceDir2;
}

// src/printer-protocol.ts
var ANYCUBIC_LAN_QUERY_TYPES = [
  "info",
  "tempature",
  "fan",
  "light",
  "multiColorBox",
  "print",
  "aiSettings",
  "peripherie",
  "axis",
  "extfilbox",
];
function requireValue(value, name) {
  if (value === void 0) throw new Error(`${name} is required for this command preview.`);
  return value;
}
function topic(modelId, mqttDeviceId, messageType) {
  return `anycubic/anycubicCloud/v1/web/printer/${modelId}/${mqttDeviceId}/${messageType}`;
}
function commandParts(input) {
  const taskId = input.taskId;
  switch (input.command) {
    case "pause_print":
      return {
        messageType: "print",
        action: "pause",
        data: { taskid: requireValue(taskId, "taskId") },
        physicalEffect: "Pauses the active print",
        evidence: "community LAN command mapping",
      };
    case "resume_print":
      return {
        messageType: "print",
        action: "resume",
        data: { taskid: requireValue(taskId, "taskId") },
        physicalEffect: "Resumes the active print",
        evidence: "community LAN command mapping",
      };
    case "stop_print":
      return {
        messageType: "print",
        action: "stop",
        data: { taskid: requireValue(taskId, "taskId") },
        physicalEffect: "Stops the active print",
        evidence: "community LAN command mapping",
      };
    case "update_print":
      return {
        messageType: "print",
        action: "update",
        data: { taskid: requireValue(taskId, "taskId"), ...(input.settings ?? {}) },
        physicalEffect: "Changes settings of the active print",
        evidence: "community LAN command mapping; setting fields are printer/model dependent",
      };
    case "move_axis":
      return {
        messageType: "axis",
        action: "move",
        data: {
          axis: requireValue(input.axis, "axis"),
          move_type: requireValue(input.moveType, "moveType"),
          distance: requireValue(input.distanceMm, "distanceMm"),
        },
        physicalEffect: "Moves or homes an axis; dangerous near the part",
        evidence: "community LAN command mapping",
      };
    case "query_axis":
      return {
        messageType: "axis",
        action: "query",
        data: null,
        physicalEffect: "Read-only axis query",
        evidence: "confirmed on Kobra S1 firmware <FW_VERSION>",
      };
    case "turn_off_motors":
      return {
        messageType: "axis",
        action: "turnOff",
        data: null,
        physicalEffect: "Disables stepper holding torque; the gantry/table can move",
        evidence: "community LAN command mapping",
      };
    case "set_temperature": {
      const nozzle = input.nozzleTemperature ?? 0;
      const bed = input.bedTemperature ?? 0;
      const type =
        input.nozzleTemperature !== void 0 && input.bedTemperature !== void 0
          ? 2
          : input.bedTemperature !== void 0
            ? 1
            : 0;
      return {
        messageType: "tempature",
        action: "set",
        data: { type, target_hotbed_temp: bed, target_nozzle_temp: nozzle },
        physicalEffect: "Changes heater targets",
        evidence: "community LAN command mapping and captured Slicer preheat payload",
      };
    }
    case "set_fan": {
      const speed = requireValue(input.fanSpeedPct, "fanSpeedPct");
      const key =
        input.fan === "aux"
          ? "aux_fan_speed_pct"
          : input.fan === "box"
            ? "box_fan_level"
            : "fan_speed_pct";
      return {
        messageType: "fan",
        action: "setSpeed",
        data: { [key]: speed },
        physicalEffect: "Changes a fan speed",
        evidence: "community LAN command mapping",
      };
    }
    case "query_peripherals":
      return {
        messageType: "peripherie",
        action: "query",
        data: null,
        physicalEffect: "Read-only peripheral query",
        evidence: "confirmed LAN query family",
      };
    case "query_light":
      return {
        messageType: "light",
        action: "query",
        data: null,
        physicalEffect: "Read-only light query",
        evidence: "confirmed LAN command mapping",
      };
    case "control_light":
      return {
        messageType: "light",
        action: "control",
        data: {
          type: input.lightType ?? 2,
          status: requireValue(input.lightStatus, "lightStatus"),
          brightness: requireValue(input.brightness, "brightness"),
        },
        physicalEffect: "Changes printer light state",
        evidence: "community LAN command mapping",
      };
    case "ace_get_info":
      return {
        messageType: "multiColorBox",
        action: "getInfo",
        data: null,
        physicalEffect: "Read-only ACE query",
        evidence: "confirmed on Kobra S1 firmware <FW_VERSION>",
      };
    case "ace_dry":
      return {
        messageType: "multiColorBox",
        action: "setDry",
        data: {
          multi_color_box: [
            {
              id: input.boxId ?? 0,
              drying_status: {
                duration: requireValue(input.dryingDuration, "dryingDuration"),
                remain_time: null,
                status: input.dryingStatus ?? 1,
                target_temp: requireValue(input.dryingTargetTemperature, "dryingTargetTemperature"),
              },
            },
          ],
        },
        physicalEffect: "Starts/changes ACE drying",
        evidence: "community LAN command mapping",
      };
    case "ace_feed":
      return {
        messageType: "multiColorBox",
        action: "feedFilament",
        data: {
          multi_color_box: [
            {
              id: input.boxId ?? 0,
              feed_status: {
                slot_index: requireValue(input.slotIndex, "slotIndex"),
                type: input.feedType ?? 1,
              },
            },
          ],
        },
        physicalEffect: "Feeds or retracts filament",
        evidence: "community LAN command mapping",
      };
    case "ace_set_slot":
      return {
        messageType: "multiColorBox",
        action: "setInfo",
        data: {
          multi_color_box: [
            {
              id: input.boxId ?? 0,
              slots: [
                {
                  color: requireValue(input.color, "color"),
                  index: requireValue(input.slotIndex, "slotIndex"),
                  type: requireValue(input.materialType, "materialType"),
                },
              ],
            },
          ],
        },
        physicalEffect: "Changes ACE slot metadata",
        evidence: "community LAN command mapping",
      };
    case "ace_auto_feed":
      return {
        messageType: "multiColorBox",
        action: "setAutoFeed",
        data: {
          multi_color_box: [
            { id: input.boxId ?? 0, auto_feed: requireValue(input.autoFeed, "autoFeed") },
          ],
        },
        physicalEffect: "Changes ACE automatic feeding",
        evidence: "community LAN command mapping",
      };
  }
}
function buildLanCommandPreview(input) {
  const modelId = input.modelId ?? "20025";
  const mqttDeviceId = input.mqttDeviceId ?? "<mqtt_device_id>";
  const parts = commandParts(input);
  const envelope = {
    type: parts.messageType,
    action: parts.action,
    timestamp: "<runtime milliseconds>",
    msgid: "<runtime id>",
    data: parts.data,
  };
  return {
    sendable: false,
    topic: topic(modelId, mqttDeviceId, parts.messageType),
    message_type: parts.messageType,
    action: parts.action,
    payload: envelope,
    physical_effect: parts.physicalEffect,
    evidence: parts.evidence,
    notes: [
      "This is a local preview only; no handshake, MQTT connection, or publish was performed.",
      "The Kobra S1 signed LAN transport uses the printer-reported broker, normally TLS port 9883.",
      "Start-print, AI settings writes, auto-leveling, self-test, exposure and move-to-coordinates are intentionally not included because their Kobra S1 LAN payload was not verified.",
    ],
  };
}
function printerCapabilityCatalog() {
  return {
    model_family: ["Kobra 3", "Kobra 4", "Kobra S1", "Kobra X"],
    kobra_s1: {
      model_id: "20025",
      firmware_observed: "<FW_VERSION>",
      signed_handshake: ["GET /info", "POST /ctrl"],
    },
    confirmed_read_queries: ANYCUBIC_LAN_QUERY_TYPES,
    confirmed_lan_commands: [
      "print/pause",
      "print/resume",
      "print/stop",
      "print/update",
      "axis/move",
      "axis/query",
      "axis/turnOff",
      "tempature/set",
      "fan/setSpeed",
      "peripherie/query",
      "light/query",
      "light/control",
      "multiColorBox/getInfo",
      "multiColorBox/setDry",
      "multiColorBox/feedFilament",
      "multiColorBox/setInfo",
      "multiColorBox/setAutoFeed",
    ],
    advertised_capabilities: [
      "auto_leveling_support",
      "vibration_compensation_support",
      "flow_calibration_support",
      "drying_first_support",
      "camera_timelapse_support",
      "gcode_3mf_support",
      "preheating_support",
      "fod_support",
      "pre_cancel_support",
    ],
    cloud_or_unverified: [
      "start print over LAN",
      "AI settings write over LAN",
      "auto-leveler command",
      "startup self-test",
      "release-film command",
      "residue cleaning",
      "move-to-coordinates",
      "local file manager commands",
      "video delete/list commands",
    ],
    camera: {
      stream_port: 18088,
      stream_path: "/flv",
      capture_action: "video/startCapture",
      capture_not_read_only: true,
    },
    safety: { this_catalog_is_read_only: true, no_home_probe_move_heat_upload_or_print: true },
  };
}

// src/slicer-inventory.ts
import { readFile as readFile4, stat as stat5 } from "node:fs/promises";
import path11 from "node:path";
var COMPONENTS = [
  "AnycubicSlicer.dll",
  "AnycubicSlicerNext.exe",
  "cloud_mqtt.dll",
  "cloud_sdk_cpp.dll",
  "mach_mqtt.dll",
  "MachMQTT.dll",
  "mqtt_client.dll",
  "RequestFilter.dll",
];
async function inspectSlicerComponents(executable) {
  if (!executable)
    return {
      installed: false,
      read_only: true,
      error: "Anycubic Slicer Next executable was not found.",
    };
  const root = path11.dirname(executable);
  const components = [];
  for (const name of COMPONENTS) {
    const fullPath = path11.join(root, name);
    try {
      const details = await stat5(fullPath);
      components.push({
        name,
        path: fullPath,
        present: true,
        size_bytes: details.size,
        modified: details.mtime.toISOString(),
      });
    } catch {
      components.push({ name, path: fullPath, present: false });
    }
  }
  const profilePath = path11.join(
    root,
    "resources",
    "profiles",
    "Anycubic",
    "machine",
    "Anycubic Kobra S1 0.4 nozzle.json",
  );
  let profile;
  try {
    const parsed = JSON.parse(await readFile4(profilePath, "utf8"));
    profile = Object.fromEntries(
      [
        "printer_model",
        "printer_settings_id",
        "printable_area",
        "printable_height",
        "thumbnails",
        "host_type",
        "machine_start_gcode",
        "machine_end_gcode",
        "bed_mesh_min",
        "bed_mesh_max",
        "bed_mesh_probe_distance",
        "auto_leveling_support",
        "vibration_compensation_support",
        "flow_calibration_support",
      ]
        .filter((key) => parsed[key] !== void 0)
        .map((key) => [key, parsed[key]]),
    );
  } catch {
    profile = void 0;
  }
  const cloudProfilePath = path11.join(root, "resources", "cloud", "cloud_profile.ini");
  let cloudProfilePresent = false;
  try {
    await stat5(cloudProfilePath);
    cloudProfilePresent = true;
  } catch {}
  return {
    read_only: true,
    installed: true,
    executable,
    component_directory: root,
    components,
    kobra_s1_profile: profile
      ? { path: profilePath, values: profile }
      : { path: profilePath, present: false },
    cloud_profile_present: cloudProfilePresent,
    static_analysis_note:
      "Presence and metadata are inspected without loading or executing any EXE/DLL. Network protocol conclusions require runtime validation or documented protocol evidence.",
  };
}

// src/index.ts
import path12 from "node:path";
import { spawn as spawn3 } from "node:child_process";
var config = loadConfig();
var tokenStore = new TokenStore(config.tokenDataDir, config.tokenCryptScript);
var jobs = new JobStore(config);
var server = new McpServer({ name: "anycubic-slicer-next-control", version: "0.1.0" });
var cadHandle = null;
var cadAllowed = true;
function textAndStructured(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}
server.registerTool(
  "inspect_slicer",
  {
    title: "Inspect Anycubic Slicer Next",
    description:
      "Detect the local Anycubic Slicer Next installation and report read-only Windows UI Automation capability.",
    inputSchema: inspectInputSchema,
    outputSchema: inspectOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    try {
      const executable = config.slicerExe;
      const installation = executable
        ? await inspectExecutable(executable)
        : {
            installed: false,
            searched: "standard Windows installation paths and ANYCUBIC_SLICER_EXE",
          };
      const uia = await inspectUia(config.pluginRoot);
      const storedToken = await storedCloudToken();
      const hasCloudToken = Boolean(storedToken || config.cloudAccessToken);
      return textAndStructured({
        ok: true,
        installation,
        ui_automation: uia,
        allowed_input_roots: config.allowedInputRoots,
        allowed_output_roots: config.allowedOutputRoots,
        profile_roots: config.profileRoots,
        capabilities: {
          open_app: Boolean(executable),
          open_stl_3mf: Boolean(executable),
          cli_slice: Boolean(executable),
          export_gcode: Boolean(executable),
          export_gcode_3mf: Boolean(executable),
          uia_inspect: Boolean(uia.available),
          uia_actions: ["activate", "tree", "read", "click", "type", "key"],
          remote_print: Boolean(executable || config.printerIps?.length || hasCloudToken),
          remote_print_transports: [
            ...(executable || config.printerIps?.length ? ["lan_ftp_mqtt"] : []),
            ...(hasCloudToken ? ["cloud_workbench"] : []),
          ],
          cloud_account: hasCloudToken,
          token_capture: Boolean(config.tokenWatcherScript && config.tokenCryptScript),
        },
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "list_slicer_profiles",
  {
    title: "List Anycubic slicing profiles",
    description:
      "List local machine, process, or filament JSON profiles before preparing a slicing job.",
    inputSchema: listProfilesInputSchema,
    outputSchema: profilesOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ kind, query, limit }) => {
    try {
      const profiles = await listProfiles(config.profileRoots, kind, query, limit);
      return textAndStructured({ ok: true, count: profiles.length, profiles });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "open_slicer",
  {
    title: "Open Anycubic Slicer Next",
    description: "Start the local Anycubic Slicer Next desktop app if it is installed.",
    inputSchema: openSlicerInputSchema,
    outputSchema: actionOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      if (!config.slicerExe) throw new Error("Anycubic Slicer Next executable was not found.");
      await launchSlicer(config.slicerExe);
      return textAndStructured({
        ok: true,
        status: "launch_dispatched",
        executable: config.slicerExe,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "open_model_in_slicer",
  {
    title: "Open a model in Anycubic Slicer Next",
    description: "Validate an allowed local STL or 3MF file, then ask the desktop app to open it.",
    inputSchema: openModelInputSchema,
    outputSchema: actionOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ input_path }) => {
    try {
      if (!config.slicerExe) throw new Error("Anycubic Slicer Next executable was not found.");
      const inputPath = await validateInputFile(input_path, config);
      await launchSlicer(config.slicerExe, inputPath);
      return textAndStructured({ ok: true, status: "open_dispatched", input_path: inputPath });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "prepare_slice_job",
  {
    title: "Prepare an Anycubic slicing job",
    description:
      "Validate model, profiles, settings, and output policy; return an expiring execution plan without slicing.",
    inputSchema: prepareJobInputSchema,
    outputSchema: prepareOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => {
    try {
      const settings = {
        ...(input.settings.layer_height_mm === void 0
          ? {}
          : { layerHeightMm: input.settings.layer_height_mm }),
        ...(input.settings.infill_density_percent === void 0
          ? {}
          : { infillDensityPercent: input.settings.infill_density_percent }),
        ...(input.settings.wall_loops === void 0 ? {} : { wallLoops: input.settings.wall_loops }),
        ...(input.settings.supports === void 0 ? {} : { supports: input.settings.supports }),
        ...(input.settings.infill_pattern === void 0
          ? {}
          : { infillPattern: input.settings.infill_pattern }),
        ...(input.settings.outer_wall_speed_mms === void 0
          ? {}
          : { outerWallSpeedMms: input.settings.outer_wall_speed_mms }),
        ...(input.settings.inner_wall_speed_mms === void 0
          ? {}
          : { innerWallSpeedMms: input.settings.inner_wall_speed_mms }),
        ...(input.settings.sparse_infill_speed_mms === void 0
          ? {}
          : { sparseInfillSpeedMms: input.settings.sparse_infill_speed_mms }),
        ...(input.settings.solid_infill_speed_mms === void 0
          ? {}
          : { solidInfillSpeedMms: input.settings.solid_infill_speed_mms }),
        ...(input.settings.top_surface_speed_mms === void 0
          ? {}
          : { topSurfaceSpeedMms: input.settings.top_surface_speed_mms }),
        ...(input.settings.top_shell_layers === void 0
          ? {}
          : { topShellLayers: input.settings.top_shell_layers }),
        ...(input.settings.bottom_shell_layers === void 0
          ? {}
          : { bottomShellLayers: input.settings.bottom_shell_layers }),
        ...(input.settings.seam_position === void 0
          ? {}
          : { seamPosition: input.settings.seam_position }),
        ...(input.settings.pressure_advance === void 0
          ? {}
          : { pressureAdvance: input.settings.pressure_advance }),
        ...(input.settings.elephant_foot_compensation_mm === void 0
          ? {}
          : { elephantFootCompensationMm: input.settings.elephant_foot_compensation_mm }),
        ...(input.settings.brim_width_mm === void 0
          ? {}
          : { brimWidthMm: input.settings.brim_width_mm }),
        ...(input.settings.nozzle_temperature_c === void 0
          ? {}
          : { nozzleTemperatureC: input.settings.nozzle_temperature_c }),
        ...(input.settings.bed_temperature_c === void 0
          ? {}
          : { bedTemperatureC: input.settings.bed_temperature_c }),
      };
      const request2 = {
        inputPath: await validateInputFile(input.input_path, config),
        machineProfile: await validateProfileFile(input.machine_profile, config),
        processProfile: await validateProfileFile(input.process_profile, config),
        filamentProfiles: await Promise.all(
          input.filament_profiles.map((profile) => validateProfileFile(profile, config)),
        ),
        outputRoot: validateOutputRoot(input.output_directory ?? config.defaultOutputRoot, config),
        outputFormat: input.output_format,
        plate: input.plate,
        arrange: input.arrange,
        orient: input.orient,
        settings,
      };
      const job = jobs.prepare(request2);
      return textAndStructured({
        ok: true,
        job_id: job.id,
        status: job.status,
        expires_at: job.expiresAt,
        output_directory: job.outputDirectory,
        command_preview: jobs.preview(job),
        confirmation_required: "Call run_slice_job with confirmation='RUN'.",
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "run_slice_job",
  {
    title: "Run a prepared Anycubic slicing job",
    description:
      "Execute one previously validated job and write G-code and/or G-code 3MF into a new job-specific directory.",
    inputSchema: runJobInputSchema,
    outputSchema: jobOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ job_id }) => {
    try {
      const job = await jobs.run(job_id);
      return textAndStructured({
        ok: true,
        job_id: job.id,
        status: job.status,
        exit_code: job.exitCode,
        output_directory: job.outputDirectory,
        artifacts: job.artifacts ?? [],
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "get_slice_job",
  {
    title: "Get slicing job status",
    description:
      "Read the current status and artifacts of a prepared or completed local slicing job.",
    inputSchema: getJobInputSchema,
    outputSchema: jobOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ job_id }) => {
    try {
      const job = jobs.get(job_id);
      return textAndStructured({
        ok: true,
        job_id: job.id,
        status: job.status,
        created_at: job.createdAt,
        expires_at: job.expiresAt,
        output_directory: job.outputDirectory,
        exit_code: job.exitCode,
        artifacts: job.artifacts ?? [],
        error: job.error,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "uia_tree",
  {
    title: "Read Anycubic Slicer Next UI tree",
    description:
      "Dump the Windows UI Automation element tree of the running slicer for inspection and automation planning.",
    inputSchema: z2
      .object({
        max_depth: z2.number().int().min(1).max(12).default(8),
        max_children: z2.number().int().min(1).max(1e3).default(200),
      })
      .strict(),
    outputSchema: z2
      .object({
        ok: z2.boolean(),
        available: z2.boolean().optional(),
        windows: z2.array(z2.unknown()).optional(),
        running: z2.boolean().optional(),
        error: z2.string().optional(),
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ max_depth, max_children }) => {
    try {
      return textAndStructured({
        ok: true,
        ...(await uiaTree(config.pluginRoot, max_depth, max_children)),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "uia_read",
  {
    title: "Read Anycubic Slicer Next UI values",
    description:
      "Read text/value controls exposed by the running slicer (temp, status, layer height, etc.).",
    inputSchema: z2.object({}).strict(),
    outputSchema: z2
      .object({
        ok: z2.boolean(),
        available: z2.boolean().optional(),
        running: z2.boolean().optional(),
        controls: z2.array(z2.unknown()).optional(),
        error: z2.string().optional(),
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    try {
      return textAndStructured({ ok: true, ...(await uiaRead(config.pluginRoot)) });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "uia_click",
  {
    title: "Click a safe Anycubic Slicer Next control",
    description:
      "Invoke a safe, allowlisted slicer action by control name (Slice plate/all, Save Project, Export G-code).",
    inputSchema: z2.object({ name: z2.string().min(1).max(120) }).strict(),
    outputSchema: z2
      .object({
        ok: z2.boolean(),
        available: z2.boolean().optional(),
        running: z2.boolean().optional(),
        clicked: z2.boolean().optional(),
        target: z2.string().optional(),
        error: z2.string().optional(),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ name }) => {
    try {
      return textAndStructured({ ok: true, ...(await uiaClick(config.pluginRoot, name)) });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "uia_type",
  {
    title: "Type ASCII text into the slicer window",
    description:
      "Send printable ASCII characters to the focused slicer control (e.g. a file name or search box).",
    inputSchema: z2.object({ text: z2.string().max(500) }).strict(),
    outputSchema: z2
      .object({
        ok: z2.boolean(),
        available: z2.boolean().optional(),
        running: z2.boolean().optional(),
        typedLength: z2.number().int().optional(),
        error: z2.string().optional(),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text }) => {
    try {
      return textAndStructured({ ok: true, ...(await uiaType(config.pluginRoot, text)) });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "uia_key",
  {
    title: "Send a safe key to the slicer window",
    description:
      "Send an allowlisted keyboard shortcut to the focused slicer window (Enter, Tab, Escape, Ctrl+S, ...).",
    inputSchema: z2.object({ key: z2.string().min(1).max(32) }).strict(),
    outputSchema: z2
      .object({
        ok: z2.boolean(),
        available: z2.boolean().optional(),
        running: z2.boolean().optional(),
        key: z2.string().optional(),
        error: z2.string().optional(),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ key }) => {
    try {
      return textAndStructured({ ok: true, ...(await uiaKey(config.pluginRoot, key)) });
    } catch (error) {
      return errorResult(error);
    }
  },
);
function requireAccessCode(allowed) {
  const code = allowed || config.printerAccessCode;
  if (!code) {
    throw new Error(
      "Access code required. Provide access_code or set the ANYCUBIC_ACCESS_CODE environment variable.",
    );
  }
  return code;
}
server.registerTool(
  "discover_printers",
  {
    title: "Discover Anycubic printers on the LAN",
    description:
      "Scan the local subnet for Anycubic/Bambu printers (ports 990/8883/1883/8080/6000). Can be slow; provide printer IPs via ANYCUBIC_PRINTER_IPS to skip.",
    inputSchema: discoverPrintersInputSchema,
    outputSchema: printersOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ timeout_ms, scan_ports }) => {
    try {
      const provided = config.printerIps?.map((ip) => ({ ip })) ?? [];
      const printers = await discoverPrinters({
        timeoutMs: timeout_ms,
        ...(scan_ports ? { scanPorts: scan_ports } : {}),
        provided,
      });
      return textAndStructured({ ok: true, count: printers.length, printers });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "printer_status",
  {
    title: "Get Anycubic printer status",
    description:
      "Read a Kobra 3/4/S1/X printer's live LAN status (identity, temperatures, lifecycle, progress, layers, file and reported coordinates). Uses the signed /info -> /ctrl handshake; no access code is required.",
    inputSchema: printerStatusInputSchema,
    outputSchema: printerStatusOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ dev_id, dev_ip, access_code, mqtt_port, use_ssl_mqtt, timeout_ms }) => {
    try {
      const status = await queryPrinterStatus(dev_ip, dev_id, access_code ?? "", {
        mqtt_port,
        sslMqtt: use_ssl_mqtt,
        timeoutMs: timeout_ms,
      });
      return textAndStructured({ ok: status.online, status });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "printer_diagnostics",
  {
    title: "Inspect Anycubic printer diagnostics",
    description:
      "Read-only LAN diagnostics for a Kobra S1: capability flags, axis report, AI settings, peripherals, camera advertisement and availability limits. Never starts the camera, homes, probes, moves, heats, uploads or prints.",
    inputSchema: printerStatusInputSchema,
    outputSchema: printerDiagnosticsOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ dev_id, dev_ip, access_code, mqtt_port, use_ssl_mqtt, timeout_ms }) => {
    try {
      const status = await queryPrinterStatus(dev_ip, dev_id, access_code ?? "", {
        mqtt_port,
        sslMqtt: use_ssl_mqtt,
        timeoutMs: timeout_ms,
      });
      const info = status.reports?.info ?? {};
      const features = info.features ?? info.feature ?? {};
      const cameraUrl = typeof info.rtspUrl === "string" ? info.rtspUrl : void 0;
      const aiSettings = status.reports?.aiSettings ?? null;
      const project = info.project ?? info.last_project ?? null;
      const portChecks = await Promise.all(
        [18910, 9883, 18088, 990, 21].map(async (port) => ({
          port,
          open: await tcpPortOpen(dev_ip, port, Math.min(timeout_ms, 2e3)),
        })),
      );
      const tcpCameraPort = portChecks.find((item) => item.port === 18088)?.open ?? false;
      const diagnostics = {
        read_only: true,
        live_status: status,
        capabilities: features,
        peripherals: status.reports?.peripherie ?? null,
        axis_report: status.reports?.axis ?? null,
        ai_settings_report: aiSettings,
        camera: {
          advertised_url: cameraUrl,
          tcp_port_18088_open: tcpCameraPort,
          capture_started: false,
          native_snapshot_endpoint: false,
          note: "The printer advertises a stream; this diagnostic does not send the start-capture command.",
        },
        network: {
          checked_ports: portChecks,
          meaning: {
            18910: "signed LAN identity/handshake HTTP service",
            9883: "LAN MQTT TLS broker normally reported by /ctrl",
            18088: "local camera stream service",
            990: "legacy FTPS candidate; not proof of Kobra S1 file-transfer compatibility",
            21: "legacy FTP candidate; not proof of Kobra S1 file-transfer compatibility",
          },
        },
        history: {
          current_project_reported: project,
          historical_failure_log_exposed: false,
          saved_historical_axis_position_exposed: false,
          saved_bed_mesh_exposed: false,
        },
        safety: {
          homed: false,
          probing_requested: false,
          motion_requested: false,
          temperature_change_requested: false,
          print_started: false,
        },
      };
      return textAndStructured({ ok: status.online, diagnostics });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "printer_capability_catalog",
  {
    title: "List the Anycubic LAN capability catalog",
    description:
      "Read-only catalog of Kobra S1 LAN query types, confirmed command mappings, advertised hardware features, camera endpoints and deliberately unverified operations. It never contacts the printer.",
    inputSchema: printerCapabilityCatalogInputSchema,
    outputSchema: printerCapabilityCatalogOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => textAndStructured({ ok: true, catalog: printerCapabilityCatalog() }),
);
server.registerTool(
  "printer_lan_command_preview",
  {
    title: "Preview an Anycubic LAN command",
    description:
      "Build the exact topic and JSON envelope for a typed Kobra S1 LAN operation without connecting or publishing. This is a compatibility/safety preview only; it cannot move, heat, probe, home, feed or print.",
    inputSchema: printerLanCommandPreviewInputSchema,
    outputSchema: printerLanCommandPreviewOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (input) => {
    try {
      const preview = buildLanCommandPreview({
        modelId: input.model_id,
        mqttDeviceId: input.mqtt_device_id,
        command: input.command,
        taskId: input.task_id,
        settings: input.settings,
        axis: input.axis,
        moveType: input.move_type,
        distanceMm: input.distance_mm,
        nozzleTemperature: input.nozzle_temperature_c,
        bedTemperature: input.bed_temperature_c,
        fan: input.fan,
        fanSpeedPct: input.fan_speed_pct,
        lightType: input.light_type,
        lightStatus: input.light_status,
        brightness: input.brightness,
        boxId: input.box_id,
        slotIndex: input.slot_index,
        feedType: input.feed_type,
        materialType: input.material_type,
        color: input.color,
        dryingDuration: input.drying_duration,
        dryingStatus: input.drying_status,
        dryingTargetTemperature: input.drying_target_temperature_c,
        autoFeed: input.auto_feed,
      });
      return textAndStructured({ ok: true, preview });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "slicer_component_inventory",
  {
    title: "Inspect Anycubic Slicer components",
    description:
      "Read-only inventory of the installed Slicer executable, Anycubic/cloud/MQTT components and Kobra S1 machine profile. It reads metadata and JSON only; it never loads or executes an EXE/DLL.",
    inputSchema: slicerComponentInventoryInputSchema,
    outputSchema: slicerComponentInventoryOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    try {
      const inventory = await inspectSlicerComponents(config.slicerExe);
      return textAndStructured({ ok: inventory.installed !== false, inventory });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "printer_monitor",
  {
    title: "Monitor Anycubic printer status",
    description:
      "Read-only repeated LAN status collection. It records snapshots of identity, temperatures, progress, layers, reported coordinates, peripherals and raw reports; it never sends motion, homing, leveling, heater, camera-capture, upload or print commands.",
    inputSchema: printerMonitorInputSchema,
    outputSchema: printerMonitorOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({
    dev_id,
    dev_ip,
    access_code,
    mqtt_port,
    use_ssl_mqtt,
    timeout_ms,
    samples,
    interval_ms,
  }) => {
    try {
      const snapshots = [];
      for (let index = 0; index < samples; index += 1) {
        const status = await queryPrinterStatus(dev_ip, dev_id, access_code ?? "", {
          mqtt_port,
          sslMqtt: use_ssl_mqtt,
          timeoutMs: timeout_ms,
        });
        snapshots.push({ captured_at: /* @__PURE__ */ new Date().toISOString(), status });
        if (index + 1 < samples) await new Promise((resolve) => setTimeout(resolve, interval_ms));
      }
      return textAndStructured({
        ok: snapshots.some((sample) => sample.status?.online),
        requested_samples: samples,
        samples: snapshots,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "audit_gcode_recovery",
  {
    title: "Audit a G-code recovery boundary",
    description:
      "Read-only offline audit of a local G-code file. Finds layer markers, modal state, coordinates, machine-control commands and recovery risks. It never changes the file or contacts the printer.",
    inputSchema: auditGcodeRecoveryInputSchema,
    outputSchema: auditGcodeRecoveryOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ gcode_path, start_layer }) => {
    try {
      const canonical = await validateGcodeFile(gcode_path, config);
      const audit = await auditGcodeRecovery({
        path: canonical,
        ...(start_layer === void 0 ? {} : { startLayer: start_layer }),
      });
      return textAndStructured({ ok: true, audit });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "send_to_printer",
  {
    title: "Upload a sliced file to the Anycubic printer",
    description:
      "Upload a validated local G-code or G-code 3MF to the printer's SD card via FTP (sdcard/).",
    inputSchema: sendToPrinterInputSchema,
    outputSchema: sendToPrinterOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ dev_id, dev_ip, access_code, local_file, remote_name, ftp_port, use_ssl_ftp }) => {
    try {
      const code = requireAccessCode(access_code);
      const canonical = await validateInputFile(local_file, config);
      if (!/\.(gcode|3mf|gcode\.3mf)$/i.test(canonical)) {
        throw new Error("Only .gcode and .3mf files can be sent to the printer.");
      }
      if (dev_id === "<auto>") {
        throw new Error("discover_printers first to obtain the device serial (dev_id).");
      }
      const result = await uploadFileToPrinter({
        ip: dev_ip,
        access_code: code,
        local_file: canonical,
        ...(remote_name ? { remote_name } : {}),
        ftp_port,
        useSslFtp: use_ssl_ftp,
      });
      if (!result.ok) throw new Error(result.error ?? "FTP upload failed.");
      return textAndStructured({
        ok: true,
        remote_path: result.remote_path,
        bytes: result.bytes,
        md5: result.md5,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "start_print",
  {
    title: "Start a print on the Anycubic printer",
    description:
      "Start a print job on the printer (project_file command over LAN MQTT). Confirmation-gated like the slicing job.",
    inputSchema: startPrintInputSchema,
    outputSchema: startPrintOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({
    dev_id,
    dev_ip,
    access_code,
    task_name,
    file_remote_path,
    profile_name,
    bed_type,
    bed_leveling,
    flow_cali,
    vibration_cali,
    layer_inspect,
    record_timelapse,
    use_ams,
    mqtt_port,
    use_ssl_mqtt,
    timeout_ms,
  }) => {
    try {
      const code = requireAccessCode(access_code);
      const result = await startPrint(
        {
          dev_id,
          dev_ip,
          access_code: code,
          task_name,
          file_remote_path,
          ...(profile_name ? { profile_name } : {}),
          ...(bed_type ? { bed_type } : {}),
          bed_leveling,
          flow_cali,
          vibration_cali,
          layer_inspect,
          record_timelapse,
          use_ams,
          mqtt_port,
          sslMqtt: use_ssl_mqtt,
        },
        timeout_ms,
      );
      if (!result.ok) throw new Error(result.error ?? "start_print failed.");
      return textAndStructured({ ok: true, task_name, dev_id });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "cancel_print",
  {
    title: "Send a control command to the Anycubic printer",
    description: "Send task_cancel / task_pause / task_resume / print_stop over LAN MQTT.",
    inputSchema: cancelPrintInputSchema,
    outputSchema: cancelPrintOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ dev_id, dev_ip, access_code, command, mqtt_port, use_ssl_mqtt }) => {
    try {
      const code = requireAccessCode(access_code);
      const result = await sendControlCommand(command, dev_id, dev_ip, code, {
        mqtt_port,
        sslMqtt: use_ssl_mqtt,
      });
      if (!result.ok) throw new Error(result.error ?? `${command} failed.`);
      return textAndStructured({ ok: true, command, dev_id });
    } catch (error) {
      return errorResult(error);
    }
  },
);
var cloudSession;
async function storedCloudToken() {
  const record = await tokenStore.load();
  if (!record) return null;
  return tokenStore.decrypt(record);
}
async function accountAccessToken(provided) {
  const token = provided ?? (await storedCloudToken()) ?? config.cloudAccessToken;
  if (!token) {
    throw new Error(
      "Anycubic cloud access_token required. Run account_capture_token (the slicer must be logged out, then re-logged in) or pass access_token / set ANYCUBIC_CLOUD_TOKEN.",
    );
  }
  return token;
}
async function resolveCloudSession(accessToken, region, timeoutMs) {
  if (cloudSession && cloudSession.region === region) return cloudSession;
  cloudSession = await loginWithAccessToken(await accountAccessToken(accessToken), {
    region,
    timeoutMs,
  });
  return cloudSession;
}
server.registerTool(
  "account_capture_token",
  {
    title: "Capture the Anycubic cloud token from the running slicer",
    description:
      "Scans the Anycubic Slicer Next process memory for the account JWT (access_token) and stores it DPAPI-encrypted. IMPORTANT: the token is only in memory while logged in \u2014 before calling this the user should be warned they may be logged out, then log in again while the watcher runs.",
    inputSchema: accountCaptureTokenInputSchema,
    outputSchema: accountTokenStatusOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ mode, max_seconds, region }) => {
    try {
      const result = await runTokenWatcher(config.tokenWatcherScript, mode, max_seconds);
      if (!result.ok) throw new Error(result.error ?? "token watcher failed");
      if (!result.found || !result.token) {
        return textAndStructured({
          ok: true,
          stored: false,
          error:
            result.error ??
            "No JWT found. Make sure the app is logged in (or re-login while watching).",
        });
      }
      await tokenStore.save(result.token);
      // A newly captured access token must invalidate the exchanged cloud session.
      // Otherwise all subsequent calls keep reusing the old XX-Token until restart.
      cloudSession = void 0;
      return textAndStructured({
        ok: true,
        stored: true,
        sub: result.sub,
        email: result.email,
        expires_at: result.expires_at,
        source: result.source,
        region,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "account_token_status",
  {
    title: "Show Anycubic cloud token status",
    description:
      "Report whether a token is stored (DPAPI-encrypted), who it belongs to (sub/email), and when it expires \u2014 without echoing the secret unless include_token is set.",
    inputSchema: accountTokenStatusInputSchema,
    outputSchema: accountTokenStatusOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ include_token }) => {
    try {
      const record = await tokenStore.load();
      if (!record) return textAndStructured({ ok: true, stored: false });
      const out = {
        ok: true,
        stored: true,
        ...(record.sub ? { sub: record.sub } : {}),
        ...(record.email ? { email: record.email } : {}),
        ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
        ...(record.capturedAt ? { captured_at: record.capturedAt } : {}),
      };
      if (include_token) {
        const plain = await tokenStore.decrypt(record);
        if (plain) out.token = plain;
      }
      return textAndStructured(out);
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "account_token_clear",
  {
    title: "Clear the stored Anycubic cloud token",
    description: "Delete the DPAPI-encrypted token from disk (and reset the in-memory session).",
    inputSchema: actionOutputSchema,
    outputSchema: accountTokenClearedOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      await tokenStore.clear();
      cloudSession = void 0;
      return textAndStructured({ ok: true, cleared: true });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "account_login",
  {
    title: "Login to the Anycubic cloud account",
    description:
      "Exchange the Slicer Next access_token (JWT from the token store, param, or ANYCUBIC_CLOUD_TOKEN env) for a working cloud session token. Required before account_devices / account_print.",
    inputSchema: accountLoginInputSchema,
    outputSchema: accountInfoOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ access_token, region, timeout_ms }) => {
    try {
      // account_login is an explicit refresh request; never reuse a prior
      // session that may belong to a different Slicer account.
      cloudSession = void 0;
      const session = await resolveCloudSession(access_token, region, timeout_ms);
      const info = await getUserInfo(session, { region, timeoutMs: timeout_ms });
      return textAndStructured({
        ok: true,
        token: session.token,
        user_id: info.userId,
        user_email: info.userEmail,
        region: session.region,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "account_devices",
  {
    title: "List printers connected to the Anycubic account",
    description:
      "List the printers bound to the logged-in Anycubic account (remote print by account, not LAN). Returns printer id, key (dev_id), machine type, and online status.",
    inputSchema: accountDevicesInputSchema,
    outputSchema: accountDevicesOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ region, timeout_ms, device_status }) => {
    try {
      const session = await resolveCloudSession(void 0, region, timeout_ms);
      const devices = await getPrinters(session, { region, timeoutMs: timeout_ms });
      const visible =
        device_status === void 0
          ? devices
          : devices.filter((device) => device.online === device_status);
      return textAndStructured({
        ok: true,
        count: visible.length,
        devices: visible,
        token: session.token,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "account_files",
  {
    title: "List files on the Anycubic cloud account",
    description:
      "List the files on the logged-in Anycubic cloud account (the 'My Files' shelf that backs remote print by account). Returns file id, key, name, type, and size so you can pick a file_key/file_id for account_print.",
    inputSchema: accountFilesInputSchema,
    outputSchema: accountFilesOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ region, timeout_ms, query }) => {
    try {
      const session = await resolveCloudSession(void 0, region, timeout_ms);
      let files = await getCloudFiles(session, { region, timeoutMs: timeout_ms });
      if (query) {
        const q = query.toLowerCase();
        files = files.filter((file) => file.name.toLowerCase().includes(q));
      }
      return textAndStructured({ ok: true, count: files.length, files, token: session.token });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "account_cloud_diagnostics",
  {
    title: "Read Anycubic cloud diagnostics",
    description:
      "Read-only allowlisted cloud API queries discovered in the installed Anycubic SDK: printer detail/status/functions/tools, print history and detail, project/task data, project error list, G-code metadata, ACE data and video thumbnail lists. Requires a logged-in cloud account and never sends a print or control order.",
    inputSchema: accountCloudDiagnosticsInputSchema,
    outputSchema: accountCloudDiagnosticsOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({
    kind,
    printer_id,
    project_id,
    task_id,
    file_id,
    gcode_id,
    device_id,
    model_id,
    type_function_id,
    page,
    print_status,
    region,
    timeout_ms,
  }) => {
    try {
      const session = await resolveCloudSession(void 0, region, timeout_ms);
      const diagnostic = await getCloudDiagnostic(session, kind, {
        region,
        timeoutMs: timeout_ms,
        ...(printer_id === void 0 ? {} : { printerId: printer_id }),
        ...(project_id === void 0 ? {} : { projectId: project_id }),
        ...(task_id === void 0 ? {} : { taskId: task_id }),
        ...(file_id === void 0 ? {} : { fileId: file_id }),
        ...(gcode_id === void 0 ? {} : { gcodeId: gcode_id }),
        ...(device_id === void 0 ? {} : { deviceId: device_id }),
        ...(model_id === void 0 ? {} : { modelId: model_id }),
        ...(type_function_id === void 0 ? {} : { typeFunctionId: type_function_id }),
        page,
        ...(print_status === void 0 ? {} : { printStatus: print_status }),
      });
      return textAndStructured({ ok: true, diagnostic });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "slice_via_app",
  {
    title: "Slice and export via the Anycubic Slicer Next app (GUI)",
    description:
      "ORCHESTRATES the desktop app itself (no reimplementation): opens/starts the app, loads a validated local model, activates the window, clicks the app's own Slice and Export G-code controls via GUI Automation, then scans allowed output folders for the newest exported G-code/G-code 3MF and validates its structure. Use this when the printer rejects CLI-sliced files (error 10115) \u2014 the app GUI adds the thumbnails / print_sequence / bed_type metadata the firmware requires, which the CLI does not write. The tool returns the exported file path (ready to upload or send to the cloud) plus a device-compatible compatibility check.",
    inputSchema: sliceViaAppInputSchema,
    outputSchema: sliceViaAppOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ input_path, slice_all, export_gcode, export_project, max_wait_ms }) => {
    try {
      if (!config.slicerExe) throw new Error("Anycubic Slicer Next executable was not found.");
      const inputPath = input_path ? await validateInputFile(input_path, config) : void 0;
      if (inputPath) await launchSlicer(config.slicerExe, inputPath);
      else await launchSlicer(config.slicerExe);
      const waitMs = max_wait_ms ?? 3e4;
      const deadline = Date.now() + waitMs;
      let running = false;
      while (Date.now() < deadline) {
        running = await isSlicerRunning(config.slicerExe);
        if (running) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!running) throw new Error("Anycubic Slicer Next did not start in time.");
      const before = new Set(
        scanExportedFiles([...config.allowedOutputRoots, config.defaultOutputRoot]),
      );
      await new Promise((resolve) => setTimeout(resolve, 4e3));
      if (slice_all) {
        const sliceResult = await uiaClick(config.pluginRoot, "Slice all");
        if (!sliceResult.clicked && !sliceResult.ok)
          throw new Error("Slice button not found / not clickable in the app.");
        await new Promise((resolve) => setTimeout(resolve, 6e3));
      }
      if (export_gcode || export_project) {
        const exportResult = await uiaClick(
          config.pluginRoot,
          export_project ? "Save Project" : "Export G-code",
        );
        if (!exportResult.clicked && !exportResult.ok)
          throw new Error("Export button not found / not clickable in the app.");
        await new Promise((resolve) => setTimeout(resolve, 3e3));
      }
      const after = scanExportedFiles([...config.allowedOutputRoots, config.defaultOutputRoot]);
      const newFile = after.find((file) => !before.has(file)) ?? after[0];
      if (!newFile) {
        return textAndStructured({
          ok: true,
          exported: false,
          note: "No new export detected in allowed output roots after the app export. The app may have saved elsewhere or the user cancelled the Save dialog.",
          hint: "Check the app's save dialog, or configure ANYCUBIC_CONTROL_ALLOWED_OUTPUT_ROOTS to include the app's export folder.",
        });
      }
      const compatibility = await inspectExportedCompatibility(newFile);
      return textAndStructured({
        ok: true,
        exported: true,
        file_path: newFile,
        compatibility,
        next_steps: [
          "To print over LAN: run send_to_printer with this file, then start_print.",
          "Cloud start is not currently validated: use the official Anycubic app until account_print implements and verifies the cloud-file contract documented in docs/cloud-history-reprint-incident-2026-09-07.md.",
        ],
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "account_print",
  {
    title: "Send a print order to an Anycubic account printer",
    description:
      "EXPERIMENTAL AND NOT VALIDATED FOR CLOUD HISTORY REPRINT. The current request body mixes cloud and local-file fields and produced device error 10115 during live validation on 2026-09-07. Use the official Anycubic app until the contract and post-send verification in docs/cloud-history-reprint-incident-2026-09-07.md are implemented.",
    inputSchema: accountPrintInputSchema,
    outputSchema: accountPrintOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    printer_key,
    file_key,
    file_id,
    gcode_id,
    filepath,
    file_name,
    ai_detect,
    camera_timelapse,
    region,
    timeout_ms,
  }) => {
    try {
      const session = await resolveCloudSession(void 0, region, timeout_ms);
      const devices = await getPrinters(session, { region, timeoutMs: timeout_ms });
      const printer = devices.find((device) => device.key === printer_key);
      if (!printer)
        throw new Error(
          `Printer with key '${printer_key}' not found on the account. Run account_devices first.`,
        );
      if (!file_key && !file_id)
        throw new Error("Provide file_key or file_id of a cloud file to print.");
      const printReq = {
        printer,
        fileName: file_name,
        ...(file_key ? { fileKey: file_key } : {}),
        ...(file_id !== void 0 ? { fileId: file_id } : {}),
        ...(gcode_id !== void 0 ? { gcodeId: gcode_id } : {}),
        ...(filepath ? { filepath } : file_key ? { filepath: file_key } : {}),
        aiDetect: ai_detect,
        cameraTimelapse: camera_timelapse,
      };
      const result = await sendStartPrint(session, printReq, { region, timeoutMs: timeout_ms });
      if (!result.ok) throw new Error(result.error ?? "account_print failed.");
      return textAndStructured({
        ok: true,
        order_id: result.orderId,
        task_id: result.taskId,
        printer_key,
        file_name,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
function openBrowser(url) {
  try {
    spawn3("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch {}
}
server.registerTool(
  "cad_open_workspace",
  {
    title: "Open the local 3D CAD workspace in the browser",
    description:
      "Start (or reuse) the local lightweight CAD modeling workspace for designing 3D-printable objects. It binds ONLY to 127.0.0.1 (localhost) with a random per-session token, opens the default browser, and serves an interactive web CAD editor (primitives, numeric mm transforms, boolean CSG, import STL/OBJ, export STL/OBJ/3MF into the MCP output root). The workspace never touches the printer or slicer. The tool returns the URL (with token) so the user can interact; the server auto-stops after an idle timeout or when cad_close_workspace is called.",
    inputSchema: cadOpenInputSchema,
    outputSchema: cadOpenOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ input_path, port, idle_timeout_min, open_browser }) => {
    try {
      if (cadAllowed && cadHandle) {
        return textAndStructured({
          ok: true,
          url: cadHandle.url,
          token: cadHandle.token,
          output_root: config.defaultOutputRoot,
          note: "Workspace already running",
        });
      }
      let preloadPath;
      if (input_path) {
        preloadPath = await validateInputFile(input_path, config);
      }
      const allowedRoot = config.allowedOutputRoots[0] ?? config.defaultOutputRoot;
      const cadServer = createCadServer();
      const handle = await cadServer.start({
        outputRoot: allowedRoot,
        port: port ?? 0,
        idleTimeoutMs: idle_timeout_min === 0 ? 0 : (idle_timeout_min ?? 30) * 6e4,
      });
      cadHandle = handle;
      if (preloadPath) {
        await importFileIntoWorkspace(handle, preloadPath);
      }
      if (open_browser) openBrowser(handle.url);
      return textAndStructured({
        ok: true,
        url: handle.url,
        token: handle.token,
        output_root: allowedRoot,
        note: preloadPath ? `Preloaded ${preloadPath}` : void 0,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
async function importFileIntoWorkspace(handle, filePath) {
  const { readFileSync: readFileSync2 } = await import("node:fs");
  const data = readFileSync2(filePath);
  const base64 = data.toString("base64");
  const name =
    path12
      .basename(filePath)
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_") || "preloaded";
  const res = await fetch(`${handle.url.split("?")[0]}api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cad-Token": handle.token },
    body: JSON.stringify({ name, data_base64: base64 }),
  });
  if (!res.ok) throw new Error(`Cad import preload failed (HTTP ${res.status})`);
}
server.registerTool(
  "cad_close_workspace",
  {
    title: "Close the local CAD workspace",
    description:
      "Stop the local CAD modeling workspace server if it is running (frees the port and stops any idle timer). All exported STL/OBJ/3MF files remain on disk in the MCP output root.",
    inputSchema: cadCloseInputSchema,
    outputSchema: cadCloseOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      if (!cadHandle) {
        return textAndStructured({ ok: true, stopped: false });
      }
      await cadHandle.stop();
      cadHandle = null;
      return textAndStructured({ ok: true, stopped: true });
    } catch (error) {
      return errorResult(error);
    }
  },
);
function cadApiBase(handle) {
  return handle.url.split("?")[0] ?? handle.url;
}
async function cadPost(handle, action, body) {
  const res = await fetch(`${cadApiBase(handle)}api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cad-Token": handle.token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(String(data.error ?? `CAD ${action} failed (HTTP ${res.status})`));
  }
  return data;
}
server.registerTool(
  "cad_select_faces",
  {
    title: "Select faces in the CAD workspace (shared with the web UI)",
    description:
      "Select a region of faces on an object in the running CAD workspace \u2014 the SAME selection the web UI shows. Options: pass explicit face_ids (triangle indices), or grow_from_face to auto-derive a connected planar region from one seed triangle (grow_angle_deg controls tolerance). Both the user (browser) and the agent share this selection: the user will see it highlighted, and later cad_edit_mesh / cad_texture can use the stored selection without re-passing ids.",
    inputSchema: cadFacesInputSchema,
    outputSchema: cadFacesOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ object, face_ids, grow_from_face, grow_angle_deg }) => {
    try {
      if (!cadHandle)
        throw new Error("CAD workspace is not running \u2014 call cad_open_workspace first");
      let ids = face_ids ?? [];
      if (grow_from_face !== void 0) {
        const data2 = await cadPost(cadHandle, "grow", {
          name: object,
          seed_face: grow_from_face,
          angle_deg: grow_angle_deg ?? 15,
        });
        ids = data2.face_ids ?? [];
      }
      const data = await cadPost(cadHandle, "select_faces", { name: object, face_ids: ids });
      return textAndStructured({
        ok: true,
        object,
        face_ids: data.selection ?? ids,
        count: (data.selection ?? ids).length,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "cad_edit_mesh",
  {
    title: "Edit the mesh of an object in the CAD workspace (extrude/bevel/subdivide/sculpt)",
    description:
      "Apply a topological mesh edit to an object in the running CAD workspace, on the faces selected with cad_select_faces (or explicit face_ids): extrude (push/pull region along its normal), bevel/inset (chamfer), subdivide (4x resolution in region), sculpt (push/pull vertices along normals; smooth=true for laplacian relax), weld (merge duplicate vertices). Changes appear live in the user's browser via SSE. Returns updated counts.",
    inputSchema: cadEditMeshInputSchema,
    outputSchema: cadEditMeshOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ object, op, face_ids, amount, smooth }) => {
    try {
      if (!cadHandle)
        throw new Error("CAD workspace is not running \u2014 call cad_open_workspace first");
      const body = { name: object, op };
      if (face_ids) body.face_ids = face_ids;
      if (amount !== void 0) body.amount = amount;
      if (smooth !== void 0) body.smooth = smooth;
      const data = await cadPost(cadHandle, "mesh_edit", body);
      return textAndStructured({
        ok: true,
        revision: data.revision,
        vertices: data.vertices,
        triangles: data.triangles,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "cad_texture",
  {
    title: "Apply color or a relief texture to faces in the CAD workspace",
    description:
      "Apply to an object (or its selected faces) either: a flat color (color [r,g,b]), a visual texture URL (texture_url, browser preview only), or a REAL printable relief: image_base64 displaces the selected faces' vertices along their normals by the image luminance (relief_mm = height in mm; dark = raised by default). Use cad_select_faces first to pick the region (e.g. the B side of a cube). The user sees the result live in the browser.",
    inputSchema: cadTextureInputSchema,
    outputSchema: cadTextureOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ object, color, texture_url, relief_mm, image_base64, face_ids }) => {
    try {
      if (!cadHandle)
        throw new Error("CAD workspace is not running \u2014 call cad_open_workspace first");
      if (image_base64 && relief_mm) {
        await cadPost(cadHandle, "heightmap", {
          name: object,
          face_ids,
          data_base64: image_base64,
          strength: relief_mm,
        });
        return textAndStructured({ ok: true });
      }
      const body = { name: object };
      if (color) body.color = color;
      if (texture_url) body.texture_url = texture_url;
      await cadPost(cadHandle, "texture", body);
      return textAndStructured({ ok: true });
    } catch (error) {
      return errorResult(error);
    }
  },
);
server.registerTool(
  "cad_image_to_3d",
  {
    title: "Convert an image into an editable 3D relief object in the CAD workspace",
    description:
      "Create a NEW 3D object in the CAD workspace from an image (photo/logo/heightmap). The image luminance becomes the object height (light = raised by default): practical, precise and print-ready (lithophane/bas-relief style). Provide image_path (allowed input root) or image_base64. Optional: width/height grid resolution (default 96), depth_mm (default 4), base_mm (default 1), name. The new object appears live in the user's browser and can be edited (mesh_edit/texture/boolean) and exported like any other object.",
    inputSchema: cadImageTo3dInputSchema,
    outputSchema: cadImageTo3dOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ image_path, image_base64, name, width, height, depth_mm, base_mm }) => {
    try {
      if (!cadHandle)
        throw new Error("CAD workspace is not running \u2014 call cad_open_workspace first");
      let base64 = image_base64;
      if (!base64 && image_path) {
        const p = await validateInputFile(image_path, config);
        const { readFileSync: readFileSync2 } = await import("node:fs");
        base64 = readFileSync2(p).toString("base64");
      }
      if (!base64) throw new Error("Provide image_path or image_base64");
      const body = { name: name ?? "relief", data_base64: base64 };
      if (width) body.width = width;
      if (height) body.height = height;
      if (depth_mm) body.depth_mm = depth_mm;
      if (base_mm) body.base_mm = base_mm;
      const data = await cadPost(cadHandle, "image_to_heightfield", body);
      return textAndStructured({
        ok: true,
        name: String(data.name ?? name ?? "relief"),
        triangles: data.triangles,
        size_mm: data.sizeMm,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);
// Standalone extension: this checkout currently lacks the original src/ tree.
const { registerCloudReadingsTool } = await import("../scripts/cloud-readonly-diagnostics.mjs");
registerCloudReadingsTool(server, z2);
const { registerPrinterHttpReadings } = await import("../scripts/printer-http-readonly.mjs");
registerPrinterHttpReadings(server, z2);
// Exhaustive read surface + hidden command/connection map.
const { registerFullPrinterReads } = await import("../scripts/printer-full-read.mjs");
registerFullPrinterReads(server, z2);
// Persistent cloud connection + full command bus (light/temp/fans/ACE/axis/print lifecycle).
const { createManager } = await import("../scripts/printer-command-bus.mjs");
const commandManager = createManager({ resourcesDir: path12.join(config.pluginRoot, "resources") });
const { registerPrinterCommands } = await import("../scripts/printer-command-tools.mjs");
registerPrinterCommands(server, z2, {
  manager: commandManager,
  resolvePrinter: async (cloud, printerId) => {
    const printers = await cloud.listPrinters();
    const printer =
      printerId === void 0 ? printers[0] : printers.find((p) => Number(p.id) === printerId);
    if (!printer)
      throw new Error(
        printerId === void 0
          ? "No printer bound to this account"
          : "Requested printer is not bound to this account",
      );
    return printer;
  },
});
// Audit-gap tools: cloud file upload, upload+print flow, LAN camera snapshot,
// session close, material catalog (capabilities implemented but unreachable before).
const { registerAuditGapTools } = await import("../scripts/audit-gap-tools.mjs");
registerAuditGapTools(server, z2, { manager: commandManager });
// Expansion tools (Batch 0): read-only account/printer endpoints confirmed by
// scripts/expansion-probe.mjs (status snapshot, history, cloud store, lifetime,
// cloud files, error list, file preview, order registry). Never writes.
const { registerExpansionTools } = await import("../scripts/printer-expansion-tools.mjs");
registerExpansionTools(server, z2, { manager: commandManager });
// Edge tools (Batch 1 mutating gated + Batch 2 infra): force-stop/status-free
// recovery, ACE feed-finish/refresh-slot, cloud rename + OTA check, event diff
// (N14), NFC/spool decode (N13) and cloud camera info (N12). Batch 1 requires
// confirm:true (+ confirm_word EXECUTE for job); all outputs redacted.
const { registerEdgeTools } = await import("../scripts/printer-edge-tools.mjs");
registerEdgeTools(server, z2, { manager: commandManager });
// Slicer CLI control tools: drive the installed Anycubic Slicer Next native
// CLI end-to-end (profiles, settings, slice, export 3MF) without UIA.
const { registerSlicerTools } = await import("../scripts/slicer-tools.mjs");
registerSlicerTools(server, z2);
// Auth setup (first install, no slicer installed): validate a pasted
// access_token / XX-Token, detect pcf (MQTT) vs web (polling) mode, and store
// it DPAPI-encrypted via the same token-crypt.ps1 used by the compiled
// TokenStore. The token is never echoed; interactive script:
// `node scripts/auth-login.mjs`.
const { registerAuthSetupTool } = await import("../scripts/auth-login.mjs");
registerAuthSetupTool(server, z2);
// Native LAN-mode transport tools (audit B): signed 18910 handshake + read-only
// queries over the local MQTT broker 9883. All outputs redacted; credentials
// never persisted and only exposed on printer_lan_handshake include_credentials.
const { registerPrinterLanTools } = await import("../scripts/printer-lan-tools.mjs");
registerPrinterLanTools(server, z2);
// Robust boolean CSG engine (Sprint 1): exposes cad_v2_boolean — watertight
// boolean ops via three-bvh-csg between two objects of the CAD workspace.
const { registerCadBoolTool } = await import("../scripts/cad-bool-tool.mjs");
registerCadBoolTool(server, z2);
// Parametric engine (Sprint 2): cad_generate_parametric — declarative script
// over manifold-3d (sandboxed), materialized into the CAD workspace, with
// optional STL/STEP (replicad) export payloads.
const { registerCadParametricTool } = await import("../scripts/cad-parametric-tool.mjs");
registerCadParametricTool(server, z2);
// AI text-to-cad (Sprint 3): cad_generate_from_prompt — natural-language
// prompt → parametric script (env-configured provider) → validated →
// executed on the manifold engine → materialized in the CAD workspace.
const { registerCadAiTool } = await import("../scripts/cad-ai-tool.mjs");
registerCadAiTool(server, z2);
var transport = new StdioServerTransport();
await server.connect(transport);
