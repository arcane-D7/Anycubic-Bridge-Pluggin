import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { resolveCloudGcode } from "./printer-command-bus.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
const g = await resolveCloudGcode(cloud, 120193034);
console.log(
  "RESOLVED",
  JSON.stringify(
    {
      file_id: g.file_id,
      gcode_id: g.gcode_id,
      name: g.name,
      status: g.status,
      size: g.size,
      total_layers: g.total_layers,
      print_time_s: g.print_time_s,
    },
    null,
    1,
  ),
);
console.log("SLICE_PARAM KEYS", g.slice_param ? Object.keys(g.slice_param).join(", ") : "MISSING");
console.log("SLICE_PARAM", JSON.stringify(g.slice_param).slice(0, 1800));

