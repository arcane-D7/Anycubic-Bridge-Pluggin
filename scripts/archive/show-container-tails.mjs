// Show tail of the CONTAINER gcode (v2) vs slicer container, and slice_info.config + plate_1.gcode.metadata tails.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const A = "<EXPORT_ROOT>/cli-native/output.gcode.3mf";
const B = "<EXPORT_ROOT>/recovery-remainder-starter.gcode.3mf";

const read = (f) => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP, "tail3-"));
  execFileSync("tar", ["-xf", f, "-C", tmp], { stdio: "pipe" });
  const g = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode"), "utf8");
  const meta = fs.readFileSync(path.join(tmp, "Metadata", "plate_1.gcode.metadata"), "utf8");
  const info = fs.readFileSync(path.join(tmp, "Metadata", "slice_info.config"), "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });
  return { g, meta, info };
};

const a = read(A),
  b = read(B);
for (const [label, x] of [
  ["A:slicer", a],
  ["B:ours", b],
]) {
  console.log(`\n========== ${label} plate_1.gcode tail (last 22 non-empty) ==========`);
  console.log(
    x.g
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-22)
      .join("\n"),
  );
  console.log(`\n-- ${label} plate_1.gcode.metadata (last 12 non-empty) --`);
  console.log(
    x.meta
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-12)
      .join("\n"),
  );
  console.log(`\n-- ${label} slice_info.config --`);
  console.log(x.info.slice(0, 1500));
}
