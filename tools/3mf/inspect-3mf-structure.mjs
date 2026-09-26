import { read3mf } from "../../scripts/read-3mf.mjs";

const path = process.argv[2];
const files = read3mf(path);
console.log("files:");
for (const f of files) console.log("  ", f.name, f.size);
const model = files.find((f) => f.name === "3D/3dmodel.model");
if (model) {
  const s = model.data.toString("utf8");
  console.log("\n=== 3dmodel.model ===");
  console.log(s.slice(0, 1600));
}
const settings = files.find((f) => f.name === "Metadata/model_settings.config");
if (settings) {
  const s = settings.data.toString("utf8");
  console.log("\n=== model_settings.config ===");
  console.log(s.slice(0, 1200));
}
