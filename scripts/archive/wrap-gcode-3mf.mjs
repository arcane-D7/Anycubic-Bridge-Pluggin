// Wrap the recovery gcode into a parseable .gcode.3mf container:
// template = the slicer's own cli-native/output.gcode.3mf (has thumbnails,
// JSON, slice_info, model, rels) — we only swap the gcode + metadata members.
// This makes the cloud parse it (total_layers/print_time/estimate/image)
// so the order 1 print start can build a real task.
// Usage: node scripts/wrap-gcode-3mf.mjs <recovery.gcode> <out.gcode.3mf>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execSync } from "node:child_process";

const TPL = "<EXPORT_ROOT>\\cli-native\\output.gcode.3mf";
const IN = process.argv[2];
const OUT = process.argv[3];
if (!IN || !OUT) {
  console.error("usage: node scripts/wrap-gcode-3mf.mjs <recovery.gcode> <out.gcode.3mf>");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "wrap3mf-"));
const gcode = fs.readFileSync(IN, "utf8");
const md5 = crypto.createHash("md5").update(gcode).digest("hex").toUpperCase();

// extract template
execFileSync("tar", ["-xf", TPL, "-C", tmp], { stdio: "pipe" });

// 1) replace gcode member
fs.writeFileSync(path.join(tmp, "Metadata", "plate_1.gcode"), gcode);
// 2) md5 member
fs.writeFileSync(path.join(tmp, "Metadata", "plate_1.gcode.md5"), md5);

// 3) header-derived stats
const mLayers = gcode.match(/; total layer number: (\d+)/);
const mZ = gcode.match(/; max_z_height: ([\d.]+)/);
const totalLayers = Number(mLayers?.[1] ?? 0);
const maxZ = Number(mZ?.[1] ?? 0);
const prediction = Math.round(totalLayers * (9312 / 151)); // original per-layer seconds
let extMM = 0;
for (const line of gcode.split(/\r?\n/)) {
  const e = line.match(/^G1 .* E(-?[\d.]+)/);
  if (e) {
    const v = parseFloat(e[1]);
    if (v > 0.01) extMM += v;
  }
}
const usedGrams = extMM * Math.PI * (1.75 / 2) ** 2 * 1.24e-3;
const usedM = extMM / 1000;

// 4) slice_info.config
const siPath = path.join(tmp, "Metadata", "slice_info.config");
let si = fs.readFileSync(siPath, "utf8");
si = si.replace(
  /<metadata key="prediction" value="\d+"\/>/,
  `<metadata key="prediction" value="${prediction}"/>`,
);
si = si.replace(
  /<metadata key="weight" value="[^"]*"\/>/,
  `<metadata key="weight" value="${usedGrams.toFixed(2)}"/>`,
);
si = si.replace(
  /used_m="[^"]*" used_g="[^"]*"/,
  `used_m="${usedM.toFixed(2)}" used_g="${usedGrams.toFixed(2)}"`,
);
fs.writeFileSync(siPath, si);

// 5) plate_1.json bbox z
const pjPath = path.join(tmp, "Metadata", "plate_1.json");
let pj = fs.readFileSync(pjPath, "utf8");
pj = pj.replace(/("bbox_all":\[)([^\]]+)(\])/, (_m, pre, inner, post) => {
  const parts = inner.split(",");
  if (parts.length >= 6) {
    parts[4] = "0";
    parts[5] = maxZ.toFixed(6);
  }
  return pre + parts.join(",") + post;
});
fs.writeFileSync(pjPath, pj);

// 6) plate_1.gcode.metadata — MUST carry the statistics block
//    (the cloud parser reads `total_layers`/`print_time`/`used_filament`
//    from this member's tail: `; statistics = begin ... total_layers = N ...`).
//    Write the FULL gcode so the tail stats + config block survive.
fs.writeFileSync(path.join(tmp, "Metadata", "plate_1.gcode.metadata"), gcode);

// 7) repack via scripts/zip-3mf-dir.ps1 (clean relative entries, gcode stored)
const tmpAbs = path.resolve(tmp);
const outAbs = path.resolve(OUT);
const script = path.resolve("scripts", "zip-3mf-dir.ps1");
const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -SrcDir "${tmpAbs}" -OutFile "${outAbs}"`;
execSync(psCmd, { stdio: "inherit", maxBuffer: 1024 * 1024 * 8 });

console.log(
  `wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB): layers=${totalLayers} maxZ=${maxZ} prediction=${prediction}s weight=${usedGrams.toFixed(2)}g md5=${md5}`,
);
fs.rmSync(tmp, { recursive: true, force: true });

