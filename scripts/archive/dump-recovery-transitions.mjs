// Dump recovery layers 2/3/4 transition verbatim (lines around them).
import fs from "node:fs";
const REC = "<EXPORT_ROOT>/recovery-remainder-starter.gcode";
const lines = fs.readFileSync(REC, "utf8").split(/\r?\n/);
const mark = (m) => lines.findIndex((l) => l.includes(m));
for (const [label, needle] of [
  ["layer2 start", "; start of layer_num: 2,"],
  ["layer3 start", "; start of layer_num: 3,"],
  ["layer4 start", "; start of layer_num: 4,"],
  ["layer5 start", "; start of layer_num: 5,"],
]) {
  const i = mark(needle);
  console.log(`\n===== ${label} (line ${i}) ====`);
  const window = lines.slice(Math.max(0, i - 6), i + 12);
  window.forEach((l, j) => console.log(String(Math.max(0, i - 6) + j).padStart(6), l));
}
