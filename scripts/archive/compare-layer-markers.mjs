// Compare layer marker styles between the slicer template gcode and the recovery gcode.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REC = "<EXPORT_ROOT>/recovery-remainder-starter.gcode";
const TPL = "<EXPORT_ROOT>/cli-native/output.gcode.3mf";

const patterns = [
  ["LAYER_CHANGE", /^;LAYER_CHANGE/gm],
  ["start of layer_num", /^; start of layer_num:/gm],
  ["AFTER_LAYER_CHANGE", /^; AFTER_LAYER_CHANGE/gm],
  [";Z: lines", /^;Z:\d/gm],
  ["; HEIGHT", /^;HEIGHT:\d/gm],
  ["EXCLUDE_OBJECT_DEFINE", /^EXCLUDE_OBJECT_DEFINE/gm],
  ["M73 P0|P1 lines", /^M73 P/gm],
];

const rec = fs.readFileSync(REC, "utf8");
const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "tplmk-"));
execFileSync("tar", ["-xf", TPL, "-C", tmp], { stdio: "pipe" });
const tpl = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode"), "utf8");
fs.rmSync(tmp, { recursive: true, force: true });

const count = (txt, re) => (txt.match(re) ?? []).length;
console.log("pattern".padEnd(24), "RECOVERY".padEnd(10), "TEMPLATE");
for (const [name, re] of patterns) {
  console.log(name.padEnd(24), String(count(rec, re)).padEnd(10), count(tpl, re));
}
