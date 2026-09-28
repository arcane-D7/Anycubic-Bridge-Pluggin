#!/usr/bin/env node
/**
 * render-headless.mjs — PoC de renderização fiel de meshes 3D via Blender headless.
 *
 * Gera um PNG geometricamente EXATO de um STL/OBJ/3MF usando o Blender instalado
 * (Store/MSIX ou clássico). Sem IA: a imagem é a própria geometria — dimensões
 * exatas, reprodutível, determinística.
 *
 * Usage:
 *   node tools/render-headless.mjs model.stl --out renders/model.png
 *   node tools/render-headless.mjs model.3mf --view front --engine cycles --samples 64
 *   node tools/render-headless.mjs model.stl --view iso --zoom 1.2 --width 1920 --height 1080
 *
 * Exit codes: 0 = ok (PNG + _report.json written), 1 = falha (stderr com detalhe).
 */

import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { env } from "node:process";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    view: "iso",
    engine: "eevee",
    samples: 128,
    width: 1024,
    height: 1024,
    zoom: 1.0,
    rotateX: 0,
    rotateY: 0,
    rotateZ: 0,
    bg: "240,240,240",
    timeoutMs: 120_000,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) fail(`--${name} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out":
        args.out = need(i, "out");
        i++;
        break;
      case "--view":
        args.view = need(i, "view").toLowerCase();
        i++;
        break;
      case "--engine":
        args.engine = need(i, "engine").toLowerCase();
        i++;
        break;
      case "--samples":
        args.samples = Number(need(i, "samples"));
        i++;
        break;
      case "--width":
        args.width = Number(need(i, "width"));
        i++;
        break;
      case "--height":
        args.height = Number(need(i, "height"));
        i++;
        break;
      case "--zoom":
        args.zoom = Number(need(i, "zoom"));
        i++;
        break;
      case "--rotate-x":
        args.rotateX = Number(need(i, "rotate-x"));
        i++;
        break;
      case "--rotate-y":
        args.rotateY = Number(need(i, "rotate-y"));
        i++;
        break;
      case "--rotate-z":
        args.rotateZ = Number(need(i, "rotate-z"));
        i++;
        break;
      case "--bg":
        args.bg = need(i, "bg");
        i++;
        break;
      case "--timeout":
        args.timeoutMs = Number(need(i, "timeout"));
        i++;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) fail(`unknown option: ${a}`);
        if (args.input) fail("only one input file allowed");
        args.input = a;
    }
  }
  if (!args.input) {
    printUsage();
    fail("input file required");
  }
  return args;
}

function printUsage() {
  console.log(`render-headless.mjs — faithful headless mesh rendering via Blender

Usage:
  node tools/render-headless.mjs <model.stl|obj|3mf> [options]

Options:
  --out <path>        output PNG (default: renders/<input>.png)
  --view <name>       iso|front|side|top|back|bottom|left|right (default: iso)
  --engine <name>     eevee|cycles (default: eevee)
  --samples <n>       cycles samples (default: 128)
  --width <px>        render width  (default: 1024)
  --height <px>       render height (default: 1024)
  --zoom <z>          >1 closer, <1 farther (default: 1.0)
  --rotate-x <deg>    extra rotation X (default: 0)
  --rotate-y <deg>    extra rotation Y (default: 0)
  --rotate-z <deg>    extra rotation Z (default: 0)
  --bg <r,g,b>        background color 0-255 (default: 240,240,240)
  --timeout <ms>      blender timeout (default: 120000)
  -h | --help         this help`);
}

function fail(msg) {
  console.error(`render-headless: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Blender discovery — MSIX (Store) first, then classic installs, then PATH
// ---------------------------------------------------------------------------

function discoverBlender() {
  const candidates = [];

  if (env.BLENDER_EXE) candidates.push(env.BLENDER_EXE);

  // MSIX app execution alias (verified working on this machine, Blender 5.2.2).
  // NOTE: the alias is an APPEXECLINK reparse point — existsSync()/statSync()
  // fail with EACCES because Node cannot resolve the target; lstatSync() sees
  // the link itself and is enough to prove presence.
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(join(localAppData, "Microsoft", "WindowsApps", "blender-launcher.exe"));
  }

  // Classic installs
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  try {
    const base = join(programFiles, "Blender Foundation");
    for (const entry of readdirSync(base)) {
      candidates.push(join(base, entry, "blender.exe"));
    }
  } catch {
    /* not installed classically */
  }

  for (const c of candidates) {
    if (c && pathExists(c)) return c;
  }
  return null;
}

/**
 * True when the path exists. Handles MSIX app-exec-link aliases, which
 * existsSync() cannot resolve (EACCES when following the reparse point) —
 * falls back to lstatSync(), which sees the alias itself.
 */
function pathExists(p) {
  try {
    accessSync(p, fsConstants.F_OK);
    return true;
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      try {
        return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Script generation (the bpy program Blender will run)
// ---------------------------------------------------------------------------

const VIEWS = {
  iso: { azim: 45, elev: 30 },
  front: { azim: 0, elev: 0 },
  back: { azim: 180, elev: 0 },
  left: { azim: 90, elev: 0 },
  right: { azim: -90, elev: 0 },
  top: { azim: 0, elev: 89.9 },
  bottom: { azim: 0, elev: -89.9 },
  side: { azim: 90, elev: 0 },
};

function buildBpyScript(args, outPng, reportPath) {
  const view = VIEWS[args.view] ?? VIEWS.iso;
  const [br, bg_, bb] = args.bg.split(",").map((s) => Number(s.trim()) / 255);
  const ext = extname(args.input).toLowerCase();

  if (ext === ".stl") {
    return `
import bpy, bmesh, json, math, os, sys, time
from mathutils import Vector

t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)

# --- Import mesh ---
bpy.ops.wm.stl_import(filepath=r"${args.input.replace(/\\/g, "\\\\")}")
obj = bpy.context.selected_objects[0]

# --- Extra rotation (degrees) ---
obj.rotation_euler = (
    math.radians(${args.rotateX}),
    math.radians(${args.rotateY}),
    math.radians(${args.rotateZ}),
)
bpy.context.view_layer.update()

# --- Bounding box in world space (real dimensions, mm) ---
deps = bpy.context.evaluated_depsgraph_get()
ob_eval = obj.evaluated_get(deps)
corners = [ob_eval.matrix_world @ Vector(c) for c in ob_eval.bound_box]
mins = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
maxs = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
center = (mins + maxs) / 2
diag = (maxs - mins).length
size = maxs - mins

# --- Camera: orbit position from azim/elev, distance from bbox * zoom ---
azim = math.radians(${view.azim})
elev = math.radians(${view.elev})
cam = bpy.data.cameras.new("Cam")
cam_obj = bpy.data.objects.new("Cam", cam)
bpy.context.collection.objects.link(cam_obj)
dist = max(diag * 1.6 / max(0.05, ${args.zoom}), 0.5)
cam_obj.location = center + Vector((
    dist * math.cos(elev) * math.cos(azim),
    dist * math.cos(elev) * math.sin(azim),
    dist * math.sin(elev),
))
direction = center - cam_obj.location
cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
cam.lens = 50
bpy.context.scene.camera = cam_obj

# --- 3-point lighting (deterministic) ---
def make_light(name, loc, energy, size):
    l = bpy.data.lights.new(name, "AREA")
    l.energy = energy * max(diag, 1.0)
    l.size = size * max(diag, 1.0)
    lo = bpy.data.objects.new(name, l)
    lo.location = loc
    bpy.context.collection.objects.link(lo)
    track = (center - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    lo.rotation_euler = track
    return lo

make_light("key",  center + Vector(( diag, -diag, diag)), 800, 1.0)
make_light("fill", center + Vector((-diag, -diag, diag * 0.4)), 350, 1.4)
make_light("rim",  center + Vector((0, diag, diag * 0.8)), 500, 0.8)

# --- Material: neutral studio grey ---
mat = bpy.data.materials.new("StudioGrey")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.65, 0.65, 0.68, 1.0)
bsdf.inputs["Roughness"].default_value = 0.45
if "Metallic" in bsdf.inputs: bsdf.inputs["Metallic"].default_value = 0.1
obj.data.materials.clear()
obj.data.materials.append(mat)

# --- World background ---
world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (${br.toFixed(4)}, ${bg_.toFixed(4)}, ${bb.toFixed(4)}, 1.0)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
bpy.context.scene.world = world

# --- Render settings ---
scene = bpy.context.scene
scene.render.engine = "${args.engine === "cycles" ? "CYCLES" : "BLENDER_EEVEE"}"
scene.render.resolution_x = ${args.width}
scene.render.resolution_y = ${args.height}
scene.render.image_settings.file_format = "PNG"
if scene.render.engine == "CYCLES":
    scene.cycles.samples = ${args.samples}
    scene.cycles.device = "CPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "NONE"

scene.render.filepath = r"${outPng.replace(/\\/g, "\\\\")}"
bpy.ops.render.render(write_still=True)

# --- Report (stdout is not capturable under MSIX; we write a JSON file) ---
report = {
    "input": r"${args.input.replace(/\\/g, "\\\\")}",
    "output_png": r"${outPng.replace(/\\/g, "\\\\")}",
    "engine": scene.render.engine,
    "resolution": [${args.width}, ${args.height}],
    "view": "${args.view}",
    "zoom": ${args.zoom},
    "bbox_min_mm": [round(v, 4) for v in mins],
    "bbox_max_mm": [round(v, 4) for v in maxs],
    "bbox_size_mm": [round(v, 4) for v in size],
    "diagonal_mm": round(diag, 4),
    "camera_distance": round(dist, 4),
    "elapsed_s": round(time.time() - t0, 2),
}
with open(r"${reportPath.replace(/\\/g, "\\\\")}", "w") as f:
    json.dump(report, f, indent=2)
print("RENDER_OK")
`;
  }

  // OBJ / 3MF handled by a separate template (imports differ)
  if (ext === ".obj" || ext === ".3mf") {
    const op = ext === ".obj" ? "wm.obj_import" : "wm.read_3mf";
    return `
import bpy, json, math, os, time
from mathutils import Vector

t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.${op}(filepath=r"${args.input.replace(/\\/g, "\\\\")}")
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    raise RuntimeError("no mesh objects after import")

for o in meshes:
    o.rotation_euler = (
        math.radians(${args.rotateX}),
        math.radians(${args.rotateY}),
        math.radians(${args.rotateZ}),
    )
bpy.context.view_layer.update()

deps = bpy.context.evaluated_depsgraph_get()
corners = []
for o in meshes:
    oe = o.evaluated_get(deps)
    corners += [oe.matrix_world @ Vector(c) for c in oe.bound_box]
mins = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
maxs = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
center = (mins + maxs) / 2
diag = (maxs - mins).length
size = maxs - mins

azim = math.radians(${view.azim})
elev = math.radians(${view.elev})
cam = bpy.data.cameras.new("Cam")
cam_obj = bpy.data.objects.new("Cam", cam)
bpy.context.collection.objects.link(cam_obj)
dist = max(diag * 1.6 / max(0.05, ${args.zoom}), 0.5)
cam_obj.location = center + Vector((
    dist * math.cos(elev) * math.cos(azim),
    dist * math.cos(elev) * math.sin(azim),
    dist * math.sin(elev),
))
cam_obj.rotation_euler = (center - cam_obj.location).to_track_quat("-Z", "Y").to_euler()
cam.lens = 50
bpy.context.scene.camera = cam_obj

def make_light(name, loc, energy, size):
    l = bpy.data.lights.new(name, "AREA")
    l.energy = energy * max(diag, 1.0)
    l.size = size * max(diag, 1.0)
    lo = bpy.data.objects.new(name, l)
    lo.location = loc
    bpy.context.collection.objects.link(lo)
    lo.rotation_euler = (center - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return lo

make_light("key",  center + Vector(( diag, -diag, diag)), 800, 1.0)
make_light("fill", center + Vector((-diag, -diag, diag * 0.4)), 350, 1.4)
make_light("rim",  center + Vector((0, diag, diag * 0.8)), 500, 0.8)

mat = bpy.data.materials.new("StudioGrey")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.65, 0.65, 0.68, 1.0)
bsdf.inputs["Roughness"].default_value = 0.45
for o in meshes:
    o.data.materials.clear()
    o.data.materials.append(mat)

world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (${br.toFixed(4)}, ${bg_.toFixed(4)}, ${bb.toFixed(4)}, 1.0)
bpy.context.scene.world = world

scene = bpy.context.scene
scene.render.engine = "${args.engine === "cycles" ? "CYCLES" : "BLENDER_EEVEE"}"
scene.render.resolution_x = ${args.width}
scene.render.resolution_y = ${args.height}
scene.render.image_settings.file_format = "PNG"
if scene.render.engine == "CYCLES":
    scene.cycles.samples = ${args.samples}
    scene.cycles.device = "CPU"

scene.render.filepath = r"${outPng.replace(/\\/g, "\\\\")}"
bpy.ops.render.render(write_still=True)

report = {
    "input": r"${args.input.replace(/\\/g, "\\\\")}",
    "output_png": r"${outPng.replace(/\\/g, "\\\\")}",
    "engine": scene.render.engine,
    "resolution": [${args.width}, ${args.height}],
    "view": "${args.view}",
    "zoom": ${args.zoom},
    "bbox_min_mm": [round(v, 4) for v in mins],
    "bbox_max_mm": [round(v, 4) for v in maxs],
    "bbox_size_mm": [round(v, 4) for v in size],
    "diagonal_mm": round(diag, 4),
    "camera_distance": round(dist, 4),
    "mesh_objects": len(meshes),
    "elapsed_s": round(time.time() - t0, 2),
}
with open(r"${reportPath.replace(/\\/g, "\\\\")}", "w") as f:
    json.dump(report, f, indent=2)
print("RENDER_OK")
`;
  }

  fail(`unsupported format ${ext} — use STL, OBJ, or 3MF`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const inputAbs = isAbsolute(args.input) ? args.input : resolve(args.input);
if (!pathExists(inputAbs)) fail(`input not found: ${inputAbs}`);

const blender = discoverBlender();
if (!blender) {
  fail(
    `blender not found. Set BLENDER_EXE or install via Store (%LOCALAPPDATA%\\Microsoft\\WindowsApps\\blender-launcher.exe).`,
  );
}

const outPng = args.out
  ? isAbsolute(args.out)
    ? args.out
    : resolve(args.out)
  : resolve("renders", basename(inputAbs, extname(inputAbs)) + ".png");
mkdirSync(dirname(outPng), { recursive: true });

const workDir = join(tmpdir(), "render-headless-" + Date.now());
mkdirSync(workDir, { recursive: true });
const scriptPath = join(workDir, "scene.py");
const reportPath = join(workDir, "report.json");
const logPath = join(workDir, "blender.log");

try {
  const script = buildBpyScript(args, outPng, reportPath);
  writeFileSync(scriptPath, script, "utf8");

  const cliArgs = ["-b", "--factory-startup", "--python", scriptPath];
  console.log(`render-headless: blender = ${blender}`);
  console.log(`render-headless: input  = ${inputAbs}`);
  console.log(`render-headless: output = ${outPng}`);
  console.log(`render-headless: running blender -b --factory-startup --python scene.py ...`);

  const child = spawn(blender, cliArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let logTail = "";
  child.stdout.on("data", (d) => {
    logTail += d;
  });
  child.stderr.on("data", (d) => {
    logTail += d;
  });

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    fail(`blender timed out after ${args.timeoutMs}ms`);
  }, args.timeoutMs);

  const code = await new Promise((res) => child.on("close", res));
  clearTimeout(timeout);
  const { appendFileSync } = await import("node:fs");
  appendFileSync(logPath, logTail);

  if (code !== 0) {
    console.error(logTail.split("\n").slice(-20).join("\n"));
    fail(`blender exited with code ${code}. Log: ${logPath}`);
  }
  if (!existsSync(reportPath)) {
    console.error(logTail.split("\n").slice(-30).join("\n"));
    fail(`blender did not write the report. Log: ${logPath}`);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  report.log_path = logPath;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(outPng.replace(/\.png$/i, "_report.json"), JSON.stringify(report, null, 2));

  console.log("render-headless: OK");
  console.log(`  PNG:            ${outPng}`);
  console.log(`  bbox size (mm): ${report.bbox_size_mm.join(" x ")}`);
  console.log(`  diagonal (mm):  ${report.diagonal_mm}`);
  console.log(`  elapsed:        ${report.elapsed_s}s`);
  console.log(`  report:         ${outPng.replace(/\.png$/i, "_report.json")}`);
  process.exit(0);
} catch (err) {
  fail(err.message);
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* keep on error */
  }
}
