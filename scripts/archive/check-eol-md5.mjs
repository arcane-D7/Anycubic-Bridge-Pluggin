// Check line endings + md5 of recovery gcode vs slicer template.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REC = "<EXPORT_ROOT>/recovery-remainder-starter.gcode";
const TPL = "<EXPORT_ROOT>/cli-native/output.gcode.3mf";

const rec = fs.readFileSync(REC);
const recCrlf = fs.readFileSync(REC, "utf8").replace(/\r?\n/g, "\r\n");
console.log("recovery LF  md5:", crypto.createHash("md5").update(rec).digest("hex"));
console.log("recovery CRLF md5:", crypto.createHash("md5").update(recCrlf, "utf8").digest("hex"));

const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "tplchk-"));
execFileSync("tar", ["-xf", TPL, "-C", tmp], { stdio: "pipe" });
const tpl = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode"));
console.log("template gcode has CRLF:", tpl.includes(Buffer.from("\r\n")));
console.log(
  "template md5 member:",
  fs
    .readFileSync(path.join(tmp, "Metadata", "plate_1.gcode.md5"), "utf8")
    .trim()
    .toLowerCase(),
);
console.log(
  "template md5 calc  :",
  crypto.createHash("md5").update(tpl).digest("hex").toUpperCase(),
);
fs.rmSync(tmp, { recursive: true, force: true });
