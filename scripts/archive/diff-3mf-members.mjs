// Diff inner members of slicer output.gcode.3mf (parses) vs our wrapped recovery (0 layers).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const A = "<EXPORT_ROOT>/cli-native/output.gcode.3mf"; // parsed ok
const B = "<EXPORT_ROOT>/recovery-remainder-starter.gcode.3mf"; // 0 layers

const read = (f) => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "diff3mf-"));
  execFileSync("tar", ["-xf", f, "-C", tmp], { stdio: "pipe" });
  const out = {};
  for (const p of fs.readdirSync(tmp, { recursive: true })) {
    if (typeof p !== "string") continue;
    const full = path.join(tmp, p);
    if (fs.statSync(full).isFile()) out[p.replace(/\\/g, "/")] = fs.readFileSync(full, "utf8");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
};

const a = read(A),
  b = read(B);
const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
console.log("member".padEnd(42), "A", "B");
for (const k of [...allKeys].sort()) {
  if (!a[k] || !b[k]) continue; // only compare shared
  const same = a[k] === b[k];
  console.log(k.padEnd(42), same ? "SAME" : "DIFF");
}
console.log("\n=== members present in A only ===");
Object.keys(a)
  .filter((k) => !(k in b))
  .forEach((k) => console.log(" ", k));
console.log("=== members present in B only ===");
Object.keys(b)
  .filter((k) => !(k in a))
  .forEach((k) => console.log(" ", k));
