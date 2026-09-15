// Compare template layer 1 structure vs recovery floor layer 1 + remainder boundary.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REC = "<EXPORT_ROOT>/recovery-remainder-starter.gcode";
const TPL = "<EXPORT_ROOT>/cli-native/output.gcode.3mf";

const recLines = fs.readFileSync(REC, "utf8").split(/\r?\n/);
const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "tpll1-"));
execFileSync("tar", ["-xf", TPL, "-C", tmp], { stdio: "pipe" });
const tplLines = fs
  .readFileSync(path.join(tmp, "Metadata", "plate_1.gcode"), "utf8")
  .split(/\r?\n/);
fs.rmSync(tmp, { recursive: true, force: true });

const block = (lines, fromMatch, toMatch, max = 18) => {
  const from = lines.findIndex((l) => l.includes(fromMatch));
  if (from < 0) return `[no ${fromMatch}]`;
  let to = lines.findIndex((l, i) => i > from && l.includes(toMatch));
  if (to < 0) to = Math.min(from + max, lines.length);
  return lines.slice(from, Math.min(to, from + max)).join("\n");
};

console.log("=========== TEMPLATE layer 1 (start of layer_num 1) ===========");
console.log(block(tplLines, "; start of layer_num: 1,", "; start of layer_num: 2,", 22));
console.log("\n=========== RECOVERY floor layer 1 ===========");
console.log(block(recLines, "; start of layer_num: 1,", "; start of layer_num: 2,", 22));
console.log("\n=========== RECOVERY layer boundary 3->4 ===========");
console.log(block(recLines, "; start of layer_num: 3,", "; start of layer_num: 5,", 18));
