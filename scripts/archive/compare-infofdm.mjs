// Compare /work/gcode/infoFdm between our uploaded 3mf and a known-good slicer-uploaded gcode.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();

const OUR = Number(process.argv[2]); // 120187854
const GOOD = Number(process.argv[3]); // <TASK_ID>
const out = {};
for (const [label, id] of [
  ["OURS", OUR],
  ["GOOD", GOOD],
]) {
  const info = await cloud.rawApi("GET", "/work/gcode/infoFdm", { query: { id } });
  const d = info?.data ?? {};
  out[label] = {
    name: d.name,
    gcode_id: d.gcode_id,
    file_id: d.file_id,
    file_key: d.file_key,
    estimate: d.estimate,
    status: d.status,
    img: typeof d.img === "string" ? (d.img ? "yes" : "no") : d.img,
    image_id: d.image_id,
    project_type: d.project_type,
    file_type: d.file_type,
    size: d.size,
    sliced_md5: d.sliced_md5,
    slice_param: d.slice_param
      ? {
          total_layers: d.slice_param.total_layers,
          print_time: d.slice_param.print_time,
          layer_height: d.slice_param.layer_height,
        }
      : null,
    slice_result: d.slice_result
      ? {
          total_layers: d.slice_result.total_layers,
          print_time: d.slice_result.print_time,
          estimate: d.slice_result.estimate,
        }
      : null,
    task_count: Array.isArray(d.task_list) ? d.task_list.length : d.task_list,
  };
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);


