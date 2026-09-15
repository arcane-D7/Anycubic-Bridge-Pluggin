import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const id = Number(process.argv[2]) || <TASK_ID>;
const c = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await c.login();
const info = await c.rawApi("GET", "/v2/project/info", { query: { id } });
const d = info?.data ?? info;
console.log(
  JSON.stringify(
    {
      id: d.id,
      print_status: d.print_status,
      reason: d.reason,
      device_message: d.device_message,
      gcode_id: d.gcode_id,
      model: d.model,
      create_time: d.create_time,
      end_time: d.end_time,
    },
    null,
    1,
  ),
);


