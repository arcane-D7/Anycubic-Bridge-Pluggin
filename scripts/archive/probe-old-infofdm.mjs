// infoFdm for the OLD CLI-generated files (2026-08-27) — did the cloud parse them?
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();

const targets = [
  ["anymcp-plate.gcode.3mf (container)", 116213248],
  ["anymcp-plate-final.gcode (raw)", 116200625],
  ["anymcp-plate(3).gcode (raw)", 116197627],
];
for (const [label, id] of targets) {
  const info = await cloud.rawApi("GET", "/work/gcode/infoFdm", { query: { id } });
  const d = info?.data ?? {};
  console.log(
    String(label).padEnd(38),
    "est=" + d.estimate,
    "layers=" + (d.slice_result?.total_layers ?? "?"),
    "time=" + JSON.stringify(d.slice_result?.print_time),
    "img=" + (d.img ? "yes" : "no"),
    "name=" + (d.name ?? "").slice(0, 30),
  );
}
process.exit(0);
