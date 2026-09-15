// Craft test variants of the recovery gcode to bisect what breaks the cloud parser.
// Variant A: head + (single floor layer 1) + nothing else. Tests whether floor content breaks.
// Variant B: full slice body (layers 1..151 unchanged) but with the RECOVERY header (92 layers / maxZ 18.4).
//            Tests whether header/tail mismatch (92 header vs 151 body) aborts.
import fs from "node:fs";

const FULL = "<EXPORT_ROOT>/cli-native/plate_1.gcode";
const REC = "<EXPORT_ROOT>/recovery-remainder-starter.gcode";
const OUTDIR = "<EXPORT_ROOT>";

const lines = fs.readFileSync(FULL, "utf8").split(/\r?\n/);
const recLines = fs.readFileSync(REC, "utf8").split(/\r?\n/);

const headEnd = lines.findIndex((l) => l.startsWith("; start of layer_num: 1,"));
const head = lines.slice(0, headEnd);
const lastEnd = lines.reduce((acc, l, i) => (l.startsWith("; end of layer_num:") ? i : acc), -1);
const tail = lines.slice(lastEnd + 1);

// ---- Variant A: head + floor layer 1 only + tail ----
const aLines = lines.findIndex((l) => l.startsWith("; start of layer_num: 62,"));
const aNext = lines.findIndex((l, i) => i > aLines && l.startsWith("; start of layer_num: 63,"));
const floor62 = lines.slice(aLines, aNext);
// renumber 62 -> 1, rebase Z to 0.2
const floor1 = floor62.map((l) =>
  l
    .replace(
      /^; start of layer_num: \d+, T: (\d+), print_z: [\d.]+/,
      "; start of layer_num: 1, T: $1, print_z: 0.20",
    )
    .replace(
      /^; end of layer_num: \d+, T: (\d+), print_z: [\d.]+/,
      "; end of layer_num: 1, T: $1, print_z: 0.20",
    )
    .replace(/^;Z:\d+(\.\d+)?$/, ";Z:0.2")
    .replace(/^(G0|G1)\s+.*\bZ[\d.]+\b/, (m) => m.replace(/\bZ[\d.]+\b/, "Z0.20")),
);

let headerA = head.join("\n").replace(/; total layer number: \d+/, "; total layer number: 1");
headerA = headerA.replace(/(max_z_height: )[\d.]+/, "$10.20");
const variantA = [headerA, floor1.join("\n"), tail.join("\n")].join("\n") + "\n";
fs.writeFileSync(`${OUTDIR}/test-variant-A.gcode`, variantA);
console.log("variant A written:", fs.statSync(`${OUTDIR}/test-variant-A.gcode`).size, "bytes");

// ---- Variant B: recovery header (92) + FULL body (151) + recovery tail ----
const recHeadEnd = recLines.findIndex((l) => l.startsWith("; start of layer_num: 1,"));
const recHead = recLines.slice(0, recHeadEnd);
const recTailStart = recLines.reduce(
  (acc, l, i) => (l.startsWith("; end of layer_num:") ? i : acc),
  -1,
);
const recTail = recLines.slice(recTailStart + 1);
const variantB =
  [recHead.join("\n"), ...lines.slice(headEnd, lastEnd + 1), recTail.join("\n")].join("\n") + "\n";
fs.writeFileSync(`${OUTDIR}/test-variant-B.gcode`, variantB);
console.log("variant B written:", fs.statSync(`${OUTDIR}/test-variant-B.gcode`).size, "bytes");
