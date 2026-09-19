// Probe the Anycubic CLI --paint-info flag structure.
// Usage: node scripts/cli-paint-info-probe.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const exe = "C:\\Program Files\\AnycubicSlicerNext\\AnycubicSlicerNext.exe";
const input = path.join(root, "tests", "fixtures", "cube-20mm.stl");

const variants = [
  { name: "empty-obj", json: `{"paint":[]}` },
  { name: "empty-arr", json: `[]` },
  { name: "facets", json: `{"facets":[{"facet_index":0,"extruder":2}]}` },
  { name: "faces", json: `{"faces":[{"face":0,"extruder":3}]}` },
  { name: "colors", json: `{"colors":[{"ids":[0,1,2],"extruder":2}]}` },
];

for (const v of variants) {
  const r = spawnSync(exe, ["--paint-info", v.json, "--slice", "0",
    "--outputdir", path.join(root, "poc-output", "paint-roundtrip", "slice"),
    input], { encoding: "utf8", timeout: 60000 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim().slice(0, 300);
  console.log(`\n=== ${v.name} json=${v.json} exit=${r.status}`);
  console.log(out);
}
