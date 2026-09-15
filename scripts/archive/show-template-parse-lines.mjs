// Show the header + M73/;-time lines of the template gcode (the one that parses).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TPL = "<EXPORT_ROOT>/cli-native/output.gcode.3mf";
const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "tplh2-"));
execFileSync("tar", ["-xf", TPL, "-C", tmp], { stdio: "pipe" });
const tpl = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode"), "utf8");
fs.rmSync(tmp, { recursive: true, force: true });

const lines = tpl.split(/\r?\n/);
console.log("===== lines containing 'estimated printing time' =====");
lines.filter((l) => l.includes("estimated printing time")).forEach((l) => console.log(l));
console.log("\n===== lines containing 'Filament used' =====");
lines.filter((l) => l.includes("Filament used")).forEach((l) => console.log(l));
console.log("\n===== lines containing 'TIME' =====");
lines
  .filter((l) => l.includes("TIME") && !l.includes("_TIME_"))
  .slice(0, 20)
  .forEach((l) => console.log(l));
console.log("\n===== G92 lines =====");
lines.filter((l) => l.includes("G92")).forEach((l) => console.log(l));
console.log("\n===== first 25 lines after EXECUTABLE_BLOCK_START =====");
const st = lines.findIndex((l) => l.includes("EXECUTABLE_BLOCK_START"));
lines.slice(st, st + 25).forEach((l) => console.log(l));
