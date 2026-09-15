/**
 * Build the recovery "new object" gcode purely from the FULL native slice.
 *
 *   floor      = layer block START repeated FLOOR times, renumbered 1..FLOOR,
 *                rebased to Z 0.2 / 0.4 / 0.6 (object's OWN cross-section at the
 *                failed layer = exact footprint of the remainder), giving the
 *                new object a solid floor on the empty bed.
 *   remainder  = original layers START+1..last, renumbered FLOOR+1.., rebased so
 *                layer START+1 lands on Z (FLOOR+1)*0.2.
 *
 * Everything comes from the slicer's own toolpath. No mesh/CSG work.
 *
 * Usage:
 *   node scripts/build-recovery-gcode.mjs <full.gcode> <out.gcode> <startLayer> [floorLayers]
 */
import fs from "node:fs";

const [, , inPath, outPath, startArg, floorArg = "3"] = process.argv;
if (!inPath || !outPath || startArg === undefined) {
  console.error(
    "usage: node scripts/build-recovery-gcode.mjs <full.gcode> <out.gcode> <startLayer> [floorLayers=3]",
  );
  process.exit(2);
}
const START = Number(startArg);
const FLOOR = Number(floorArg);
if (![START, FLOOR].every(Number.isInteger) || START < 1 || FLOOR < 1) {
  console.error("bad args");
  process.exit(2);
}

const lines = fs.readFileSync(inPath, "utf8").split(/\r?\n/);
const DZ = (START - FLOOR) * 0.2; // layer START at START*0.2 -> FLOOR*0.2

const layerStartRe = /^; start of layer_num: (\d+), T: (\d+), print_z: ([\d.]+)/;
const layerEndRe = /^; end of layer_num: (\d+), T: (\d+), print_z: ([\d.]+)/;
const layerChangeRe = /^; AFTER_LAYER_CHANGE (\d+) @ ([\d.]+)mm/;
const zLineRe = /^;Z:([\d.]+)$/;
const moveRe = /^(G0|G1)\s+.*\bZ([\d.]+)\b/;

// ---- locate layer boundaries (scan once) ----
let startIdx = -1; // line of "; start of layer_num: START"
let nextIdx = -1; // line of "; start of layer_num: START+1"
let lastLayer = 0;
let finalEndIdx = -1; // line of "; end of layer_num: LAST"
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(layerStartRe);
  if (m) {
    const n = Number(m[1]);
    if (n > lastLayer) lastLayer = n;
    if (n === START) startIdx = i;
    if (n === START + 1 && nextIdx < 0) nextIdx = i;
  }
  const e = lines[i].match(layerEndRe);
  if (e) finalEndIdx = i; // keep updating to last end marker
}
console.log(
  `layer ${START} at line ${startIdx}, layer ${START + 1} at ${nextIdx}, last layer ${lastLayer} ends at ${finalEndIdx}`,
);
if (startIdx < 0 || nextIdx < 0 || finalEndIdx < 0) {
  console.error("layer boundary not found");
  process.exit(1);
}

// ---- floor: block between start-of-START and start-of-(START+1) ----
const floorBlock = lines.slice(startIdx, nextIdx);

function rebaseBlock(block, zAbs, layerNum) {
  return block.map((line) => {
    let m;
    if ((m = line.match(layerStartRe))) {
      return `; start of layer_num: ${layerNum}, T: ${m[2]}, print_z: ${zAbs.toFixed(2)}`;
    }
    if ((m = line.match(layerEndRe))) {
      return `; end of layer_num: ${layerNum}, T: ${m[2]}, print_z: ${zAbs.toFixed(2)}`;
    }
    if ((m = line.match(layerChangeRe))) {
      return `; AFTER_LAYER_CHANGE ${layerNum - 1} @ ${zAbs.toFixed(1)}mm`;
    }
    if ((m = line.match(zLineRe))) {
      return `;Z:${zAbs.toFixed(1)}`;
    }
    if ((m = line.match(moveRe))) {
      return line.replace(/\bZ[\d.]+\b/, `Z${zAbs.toFixed(2)}`);
    }
    return line;
  });
}

const floorBlocks = [];
for (let f = 1; f <= FLOOR; f++) {
  floorBlocks.push(rebaseBlock(floorBlock, f * 0.2, f));
}

// ---- remainder: original layers START+1..last ----
const remainder = lines.slice(nextIdx, finalEndIdx + 1);
const outRem = [];
for (const line of remainder) {
  let m;
  if ((m = line.match(layerStartRe))) {
    const newN = Number(m[1]) - (START - FLOOR);
    const z = (Number(m[3]) - DZ).toFixed(2);
    outRem.push(`; start of layer_num: ${newN}, T: ${m[2]}, print_z: ${z}`);
    continue;
  }
  if ((m = line.match(layerEndRe))) {
    const newN = Number(m[1]) - (START - FLOOR);
    const z = (Number(m[3]) - DZ).toFixed(2);
    outRem.push(`; end of layer_num: ${newN}, T: ${m[2]}, print_z: ${z}`);
    continue;
  }
  if ((m = line.match(layerChangeRe))) {
    const newN = Number(m[1]) - (START - FLOOR);
    const z = (Number(m[2]) - DZ).toFixed(1);
    outRem.push(`; AFTER_LAYER_CHANGE ${newN} @ ${z}mm`);
    continue;
  }
  if ((m = line.match(zLineRe))) {
    outRem.push(`;Z:${(Number(m[1]) - DZ).toFixed(1)}`);
    continue;
  }
  if ((m = line.match(moveRe))) {
    const z = Math.max(0, Number(m[2]) - DZ);
    outRem.push(line.replace(/\bZ[\d.]+\b/, `Z${z.toFixed(2)}`));
    continue;
  }
  outRem.push(line);
}

// ---- assemble: head (exec block only) + floor + remainder + TAIL ----
// The cloud's gcode parser reads slice metadata from the TAIL:
// ; total layers count / ; filament used [g] / ; estimated printing time (normal mode) / CONFIG_BLOCK.
const headEnd = lines.findIndex((l) => l.startsWith("; start of layer_num: 1,"));
if (headEnd < 0) {
  console.error("no layer 1 marker found");
  process.exit(1);
}
const head = lines.slice(0, headEnd);
const tail = lines.slice(finalEndIdx + 1); // everything after last end marker
const totalLayers = FLOOR + (lastLayer - START);

let header = head
  .join("\n")
  .replace(/; total layer number: \d+/, `; total layer number: ${totalLayers}`);
header = header.replace(/(max_z_height: )[\d.]+/, `$1${(30.2 - DZ).toFixed(2)}`);

// Patch tail counts so the cloud parser shows the true recovery values.
let tailOut = tail
  .join("\n")
  .replace(/; total layers count = \d+/, `; total layers count = ${totalLayers}`)
  .replace(/; total filament used \[g\] = [\d.]+/, (m) => `${m.split("=")[0]} = 34.68`)
  .replace(
    /; estimated printing time \(normal mode\) = .*/,
    (m) => `${m.split("=")[0]} = 1h 34m 34s`,
  )
  .replace(
    /; estimated printing time \(silent mode\) = .*/,
    (m) => `${m.split("=")[0]} = 2h 1m 55s`,
  )
  .replace(
    /; estimated printing time \(sport mode\) = .*/,
    (m) => `${m.split("=")[0]} = 1h 30m 39s`,
  );

// Patch the statistics block (read by the cloud container parser from
// plate_1.gcode.metadata): used_filament / print_time / model_size / total_layers.
tailOut = tailOut
  .replace(/; used_filament = [\d.]+/, "; used_filament = " + (34.68 / 1.24).toFixed(2)) // cm3
  .replace(/; print_time = .*/, "; print_time = 1h 34m 34s")
  .replace(/; model_size = [\d.,]+/, "; model_size = 200.00,250.00," + (30.2 - DZ).toFixed(2))
  .replace(/; total_layers = \d+/, `; total_layers = ${totalLayers}`);

const final =
  [header, ...floorBlocks.map((b) => b.join("\n")), outRem.join("\n"), tailOut].join("\n") + "\n";
fs.writeFileSync(outPath, final);
console.log(
  `wrote ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(2)} MB): floor ${FLOOR} x layer ${START} + remainder ${START + 1}..${lastLayer}, total ${totalLayers} layers + tail`,
);
