// Compare userFiles records: our uploaded 3mf vs the GOOD slicer-uploaded gcode.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();

const files = await cloud.rawApi("GET", "/work/index/userFiles", { query: {} });
const list = Array.isArray(files?.data) ? files.data : (files?.data?.list ?? []);
const seen = [];
for (const f of list) {
  if (
    [999999998, 999999999].includes(Number(f.id)) ||
    String(f.file_name ?? "").includes("recovery")
  ) {
    seen.push({
      id: f.id,
      name: f.file_name,
      gcode_id: f.gcode_id,
      size: f.size,
      status: f.status,
      is_temp: f.is_temp_file,
      file_key: f.file_key,
      estimate: f.estimate,
      layer_num: f.layer_num,
      print_time: f.print_time,
      total_layers: f.total_layers,
      image_id: f.image_id ? "yes" : "no",
      create_time: f.create_time ? new Date(f.create_time * 1000).toISOString() : null,
    });
  }
}
console.log(JSON.stringify(seen, null, 2));
process.exit(0);


