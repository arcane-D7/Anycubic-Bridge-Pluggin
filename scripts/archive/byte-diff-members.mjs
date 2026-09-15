// Exact byte-diff of the 4 differing members (A=slicer parsed, B=ours 0).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const read = (f) => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "b3mf-"));
  execFileSync("tar", ["-xf", f, "-C", tmp], { stdio: "pipe" });
  const res = {};
  for (const p of fs.readdirSync(tmp, { recursive: true })) {
    if (typeof p !== "string") continue;
    const full = path.join(tmp, p);
    if (fs.statSync(full).isFile()) res[p.replace(/\\/g, "/")] = fs.readFileSync(full);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return res;
};

const a = read("<EXPORT_ROOT>/cli-native/output.gcode.3mf");
const b = read(
  "<EXPORT_ROOT>/recovery-remainder-starter.gcode.3mf",
);

for (const member of [
  "Metadata/plate_1.gcode.md5",
  "Metadata/plate_1.gcode.metadata",
  "Metadata/slice_info.config",
  "Metadata/plate_1.gcode",
]) {
  const A = a[member].toString("utf8");
  const B = b[member].toString("utf8");
  console.log(`\n########## ${member} ##########`);
  console.log(
    "A (parsed): len",
    A.length,
    "| B (ours): len",
    B.length,
    "| md5 A",
    crypto.createHash("md5").update(a[member]).digest("hex").slice(0, 8),
    "B",
    crypto.createHash("md5").update(b[member]).digest("hex").slice(0, 8),
  );
  if (member.endsWith(".gcode")) {
    console.log("A first line:", A.split(/\r?\n/)[0], "| B first line:", B.split(/\r?\n/)[0]);
    console.log("A total_layers line:", (A.match(/; total layer number: \d+/) || ["none"])[0]);
    console.log("B total_layers line:", (B.match(/; total layer number: \d+/) || ["none"])[0]);
  } else {
    const aLines = A.split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(0, 4);
    const bLines = B.split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(0, 4);
    console.log("A head:", JSON.stringify(aLines));
    console.log("B head:", JSON.stringify(bLines));
  }
}
