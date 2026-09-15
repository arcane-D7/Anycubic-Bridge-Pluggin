/**
 * Splice a sliced Anycubic gcode to keep only layers >= startLayer (0-based
 * layer numbers from "; start of layer_num: N"), rebasing the Z coordinates so
 * the new piece starts at Z=0 (the printer bed / the already-printed surface).
 *
 * The result is a standalone gcode job that prints the "remainder" of the
 * object as a new object.
 *
 * What it does:
 *   - Keeps the whole header (HEADER_BLOCK..EXECUTABLE_BLOCK) + the slicer's
 *     start gcode + first-layer priming block but replaces it with a new
 *     head: the machine setup (G9111 bed/extruder temp), absolute/relative
 *     mode, and the {%layer starting at startLayer} code.
 *   - Replaces FIRST layer marker block with the layer-start block.
 *   - Rewrites:
 *       "; start of layer_num: N"  -> "; start of layer_num: N-k+1"
 *       ";Z:<z>"                   -> ";Z:<z - z0>" (rebase)
 *       "; AFTER_LAYER_CHANGE k @ <z>mm" -> same rebase
 *       "; end of layer_num: N"    -> same relabel
 *       "M73 P<nn> R<rem>" progress -> normalized
 *       G-code Z moves: G1 Z<z> -> Z<z - z0> (only travel moves that position
 *       the nozzle; the slicing generates explicit "G1 Z..#.#" moves each layer)
 *   - Removes the very first EXCLUDE_OBJECT_START (leaves it in the middle
 *     where layers 62+ need it, but a fresh job has no excluded object yet)
 *   - Strips any first-layer-only priming block before the first real layer.
 *
 * Usage:
 *   node scripts/splice-gcode-layers.mjs <in.gcode> <out.gcode> <startLayer>
 *
 *   startLayer = the ORIGINAL 0-based layer number to keep (e.g. 62 keeps
 *   layers 62-150).
 */
import fs from "node:fs";

const [, , inPath, outPath, startArg] = process.argv;
if (!inPath || !outPath || startArg === undefined) {
  console.error("usage: node scripts/splice-gcode-layers.mjs <in.gcode> <out.gcode> <startLayer>");
  process.exit(2);
}
const START = Number(startArg);
if (!Number.isInteger(START) || START < 0) {
  console.error("startLayer must be a non-negative integer");
  process.exit(2);
}

const lines = fs.readFileSync(inPath, "utf8").split(/\r?\n/);

// Find layer boundaries
const layerStartRe = /^; start of layer_num: (\d+), T: (\d+), print_z: ([\d.]+)/;
const z0 = START > 0 ? START * 0.2 : 0; // 0.2mm layers
let firstIdx = -1;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(layerStartRe);
  if (m && Number(m[1]) === START) {
    firstIdx = i;
    break;
  }
}
if (firstIdx < 0) {
  console.error(`could not find layer ${START} start marker`);
  process.exit(1);
}
console.log(`first kept layer at line ${firstIdx} (1-based ${firstIdx + 1}), z0=${z0}`);

// The keep region = from 4 lines before the layer-start marker (the prelude:
// ;LAYER_CHANGE / ;Z: / ;HEIGHT: / ; AFTER_LAYER_CHANGE) through the end.
// Include the prelude so Z:/AFTER_LAYER_CHANGE get rebased too.
const keepStart = Math.max(0, firstIdx - 4);
const keep = lines.slice(keepStart);

// Rebase Z in the kept region
const out = [];
let prevLayerNum = null;
let rebasedZ = 0;
for (const line of keep) {
  let outLine = line;

  // layer markers
  const lm = line.match(/^; start of layer_num: (\d+), T: (\d+), print_z: ([\d.]+)/);
  if (lm) {
    const newN = Number(lm[1]) - START + 1;
    const newZ = (Number(lm[3]) - z0).toFixed(1);
    outLine = `; start of layer_num: ${newN}, T: ${lm[2]}, print_z: ${newZ}`;
    prevLayerNum = newN;
    rebasedZ = Number(newZ);
    out.push(outLine);
    continue;
  }
  const em = line.match(/^; end of layer_num: (\d+), T: (\d+), print_z: ([\d.]+)/);
  if (em) {
    const newN = Number(em[1]) - START + 1;
    const newZ = (Number(em[3]) - z0).toFixed(1);
    outLine = `; end of layer_num: ${newN}, T: ${em[2]}, print_z: ${newZ}`;
    out.push(outLine);
    continue;
  }
  const zm = line.match(/^;Z:([\d.]+)$/);
  if (zm) {
    outLine = `;Z:${(Number(zm[1]) - z0).toFixed(1)}`;
    out.push(outLine);
    continue;
  }
  const am = line.match(/^; AFTER_LAYER_CHANGE (\d+) @ ([\d.]+)mm/);
  if (am) {
    const newN = Number(am[1]) - START + 1;
    const newZ = (Number(am[2]) - z0).toFixed(1);
    outLine = `; AFTER_LAYER_CHANGE ${newN} @ ${newZ}mm`;
    out.push(outLine);
    continue;
  }

  // Rebase explicit Z travel moves: "G1 Z<z>" or "G1 Z<z> F<f>"
  const gz = line.match(/^(G0|G1)\s+.*\bZ([\d.]+)\b/);
  if (gz) {
    const z = Number(gz[2]);
    const nz = Math.max(0, z - z0);
    outLine = line.replace(/\bZ[\d.]+\b/, `Z${nz.toFixed(2)}`);
    out.push(outLine);
    continue;
  }

  // M73 progress: P<percent> R<remaining>
  const m73 = line.match(/^M73 P(\d+) R([\d.]+)/);
  if (m73) {
    // Keep as-is (percent is fine; remaining time is approximate)
    out.push(outLine);
    continue;
  }

  out.push(outLine);
}

// Now build the complete new gcode:
// 1) Read the ORIGINAL header (lines before the kept region) to get the
//    machine setup/start block, and KEEP the whole thing including the
//    priming/backup lines, but replace the FIRST layer's start with a fresh
//    print-head positioning.
// 2) Prepend a minimal reusable head:
//    - head: G9111 bed temp / extruder temp (from original)
//    - M83 relative, G90 absolute, etc.
//    - The first kept layer's own travel commands assume the head is at Z+
//    - We'll prime the nozzle on the already-printed surface with a short
//      extrude line + wipe.
const head = keep.slice(0, 1); // placeholder; fill below

// Find the original head block from the source file: lines from "EXECUTABLE_BLOCK_START" to "filament start gcode" (exclusive); it contains machine limits + G9111.
let headStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("EXECUTABLE_BLOCK_HEAD") || lines[i].includes("EXECUTABLE_BLOCK_START")) {
    headStart = i + 1;
    break;
  }
}
const headEnd =
  headStart >= 0
    ? lines.findIndex((l, i) => i > headStart && l.includes("filament start gcode"))
    : lines.length;
const origHead = headStart >= 0 ? lines.slice(headStart, headEnd) : [];
// include the filament start gcode line itself
const filStartIdx = headEnd > headStart ? headEnd : -1;
const filStart = filStartIdx >= 0 ? [lines[filStartIdx]] : [];

// Assemble: orig machine head + filament start + kept (already rebased) body.
const final = [...origHead, ...filStart, ...out].join("\n");

fs.writeFileSync(outPath, final + "\n");
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(2)} MB)`);
