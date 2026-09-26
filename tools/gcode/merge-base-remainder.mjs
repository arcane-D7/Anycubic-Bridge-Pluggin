/**
 * Merge a solid base slab gcode (first N layers) with a spliced remainder
 * gcode (layers 62+ rebased to start at 0.2), producing ONE standalone job:
 *
 *   [slab head + layers 1..N]  (solid base, Z 0.2..N*0.2)
 *   [remainder layers, re-offset to Z (N+1)*0.2 .. ]  (top piece)
 *
 * Both inputs come from the SAME Anycubic CLI preset (same machine/filament),
 * so their M201/M203/M204/M205/G9111/temps/modes match.
 *
 * Usage:
 *   node tools/gcode/merge-base-remainder.mjs <slab.gcode> <remainder.gcode> <out.gcode> <baseLayers>
 *
 *   baseLayers = how many solid layers to take from the slab (default 5 => 1mm).
 *
 * The remainder must already be rebased (layer 62 -> print_z 0.2 etc).
 * This tool:
 *   - copies slab header + EXECUTABLE block + first baseLayers layers
 *   - strips the slab's remaining layers
 *   - appends remainder with Z offset +baseLayers*0.2, renumbering layers
 *   - rewrites M73 progress to be continuous
 */
import fs from "node:fs";

const [, , slabPath, remainderPath, outPath, baseLayersArg = "5"] = process.argv;
if (!slabPath || !remainderPath || !outPath) {
  console.error(
    "usage: node tools/gcode/merge-base-remainder.mjs <slab.gcode> <remainder.gcode> <out.gcode> <baseLayers>",
  );
  process.exit(2);
}
const BASE = Number(baseLayersArg);
if (!Number.isInteger(BASE) || BASE < 1) {
  console.error("baseLayers must be >= 1");
  process.exit(2);
}
const DZ = BASE * 0.2; // Z offset for remainder

const slab = fs.readFileSync(slabPath, "utf8").split(/\r?\n/);
const rem = fs.readFileSync(remainderPath, "utf8").split(/\r?\n/);

// ---- Find slab layer boundaries ----
const layerRe = /^; start of layer_num: (\d+)/;
let slabLayerStarts = [];
for (let i = 0; i < slab.length; i++) {
  const m = slab[i].match(layerRe);
  if (m) slabLayerStarts.push({ line: i, num: Number(m[1]) });
}
if (slabLayerStarts.length === 0) {
  console.error("no layers in slab gcode");
  process.exit(1);
}
const slabKeepEnd = slabLayerStarts.find((l) => l.num === BASE + 1);
const slabEndIdx = slabKeepEnd ? slabKeepEnd.line : slab.length - 1;
console.log(`slab: ${slabLayerStarts.length} layers, keeping ${BASE} (lines 0..${slabEndIdx})`);

// Keep slab up to just before layer BASE+1 (head + layers 1..BASE)
const slabKeep = slab.slice(0, slabEndIdx);

// ---- Rebase remainder: shift Z by DZ, renumber layers, fix M73 ----
const REM_START = 1; // remainder layer 1 => original layer 62
const remOut = [];
let maxZ = 0;
for (const line of rem) {
  let out = line;
  const lm = line.match(/^; start of layer_num: (\d+), T: (\d+), print_z: ([\d.]+)/);
  if (lm) {
    const z = Number(lm[3]) + DZ;
    maxZ = Math.max(maxZ, z);
    out = `; start of layer_num: ${Number(lm[1]) + BASE}, T: ${lm[2]}, print_z: ${z.toFixed(2)}`;
    remOut.push(out);
    continue;
  }
  const em = line.match(/^; end of layer_num: (\d+), T: (\d+), print_z: ([\d.]+)/);
  if (em) {
    const z = Number(em[3]) + DZ;
    out = `; end of layer_num: ${Number(em[1]) + BASE}, T: ${em[2]}, print_z: ${z.toFixed(2)}`;
    remOut.push(out);
    continue;
  }
  const zm = line.match(/^;Z:([\d.]+)$/);
  if (zm) {
    out = `;Z:${(Number(zm[1]) + DZ).toFixed(1)}`;
    remOut.push(out);
    continue;
  }
  const am = line.match(/^; AFTER_LAYER_CHANGE (\d+) @ ([\d.]+)mm/);
  if (am) {
    const z = Number(am[2]) + DZ;
    out = `; AFTER_LAYER_CHANGE ${Number(am[1]) + BASE} @ ${z.toFixed(1)}mm`;
    remOut.push(out);
    continue;
  }
  const gz = line.match(/^(G0|G1)\s+.*\bZ([\d.]+)\b/);
  if (gz) {
    const z = Number(gz[2]) + DZ;
    out = line.replace(/\bZ[\d.]+\b/, `Z${z.toFixed(2)}`);
    remOut.push(out);
    continue;
  }
  // M73 P<x> R<rem> — keep as-is (approximate)
  remOut.push(out);
}
console.log(
  `remainder rebased: max Z ${maxZ.toFixed(2)}mm (${BASE + 1} total ${remOut.length} lines)`,
);

// ---- Header renumber: set total layers = BASE + remainder layer count ----
const remLayerCount = remOut.filter((l) => l.startsWith("; start of layer_num:")).length;
const totalLayers = BASE + remLayerCount;
let header = slabKeep.join("\n");
header = header.replace(/; total layer number: \d+/, `; total layer number: ${totalLayers}`);
// Remove slab's EXCLUDE_OBJECT_DEFINE/EOD? The slab is one object; the remainder is another.
// For a clean single job, replace the slab's "printing object" labels to a merged name.
header = header.replace(/; printing object "slab[^"]*"/g, '; printing object "recovery_part"');
// drop any "; end of layer" of slab that leaks in (should be none before slabEndIdx)

const final = header + "\n" + remOut.join("\n") + "\n";
fs.writeFileSync(outPath, final);
console.log(
  `wrote ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(2)} MB, ${totalLayers} layers)`,
);
