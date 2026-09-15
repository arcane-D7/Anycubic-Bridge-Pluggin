// Verify a wrapped .gcode.3mf: member md5 matches plate_1.gcode, header fields, EXCLUDE balance.
// Usage: node scripts/verify-gcode-3mf.mjs <file.gcode.3mf>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const F = process.argv[2];
if (!F) {
  console.error("usage: node scripts/verify-gcode-3mf.mjs <file>");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "vg3mf-"));
execFileSync("tar", ["-xf", F, "-C", tmp], { stdio: "pipe" });
const gcode = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode"), "utf8");
const md5Member = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode.md5"), "utf8").trim();
const calc = crypto.createHash("md5").update(gcode).digest("hex").toUpperCase();
const lm = gcode.match(/; total layer number: (\d+)/);
const lz = gcode.match(/; max_z_height: ([\d.]+)/);
const startCnt = (gcode.match(/EXCLUDE_OBJECT_START/g) ?? []).length;
const endCnt = (gcode.match(/EXCLUDE_OBJECT_END/g) ?? []).length;
console.log(
  `members: ${fs.readdirSync(tmp, { recursive: true }).filter((x) => typeof x === "string").length}`,
);
console.log(`md5 member: ${md5Member} calc: ${calc} MATCH: ${md5Member === calc}`);
console.log(`first line: ${gcode.split(/\r?\n/)[0].trim()}`);
console.log(`layers: ${lm?.[1]} maxZ: ${lz?.[1]}`);
console.log(
  `EXCLUDE start/end: ${startCnt}/${endCnt} ${startCnt === endCnt ? "BALANCED" : "UNBALANCED"}`,
);
console.log(`gcode bytes: ${Buffer.byteLength(gcode)}`);
fs.rmSync(tmp, { recursive: true, force: true });
