// Compare the gcode HEADER (first 70 non-empty lines) of the recovery gcode vs the slicer template gcode.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REC = "<EXPORT_ROOT>/recovery-remainder-starter.gcode";
const TPL = "<EXPORT_ROOT>/cli-native/output.gcode.3mf";

const nonEmptyFirst = (txt, n) =>
  txt
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, n)
    .join("\n");

const rec = fs.readFileSync(REC, "utf8");
console.log("===== RECOVERY gcode header =====");
console.log(nonEmptyFirst(rec, 60));

const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "tplhdr-"));
execFileSync("tar", ["-xf", TPL, "-C", tmp], { stdio: "pipe" });
const tpl = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode"), "utf8");
console.log("\n===== TEMPLATE gcode header =====");
console.log(nonEmptyFirst(tpl, 60));
fs.rmSync(tmp, { recursive: true, force: true });
