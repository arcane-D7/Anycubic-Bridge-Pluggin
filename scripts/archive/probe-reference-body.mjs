// Probe: exact anycubic-cloud-api wire body for START_PRINT (order 1).
// Reference AnycubicOrderID.START_PRINT = 1; 1240 was disproven live 2026-09-11.
// Reference order_request_data for AnycubicProjectCtrlOrderRequest has NO
// msgid/timestamp top-level; our production builder adds them. This probe
// sends byte-exact reference body and watches MQTT for a new task.
import crypto from "node:crypto";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { resolveCloudGcode, CloudConnectionManager } from "./printer-command-bus.mjs";

const GCODE_ID = Number(process.argv[2]) || 120193034;
const NAME = process.argv[3] || "recovery-remainder-starter";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log(`  ${m}`),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
const gcode = await resolveCloudGcode(cloud, GCODE_ID);

// Byte-exact reference body: no msgid, no timestamp, order_id integer.
const body = {
  order_id: 1, // START_PRINT (reference IntEnum), INTEGER
  printer_id: printer.id,
  project_id: 0,
  data: {
    filetype: 0,
    file_key: "",
    file_name: NAME,
    file_id: gcode.file_id,
    hollow_param: null,
    is_delete_file: 0,
    matrix: "",
    project_type: 1,
    punching_param: null,
    slice_param: null,
    slice_size: null,
    template_id: 0,
    task_settings: { ai_detect: 0, camera_timelapse: 0 },
  },
  ams_info: null,
  settings: null,
};

console.log("[probe body]", JSON.stringify(body));
const response = await cloud.rawApi("POST", "/work/operation/sendOrder", { params: body });
console.log("[response]", JSON.stringify(response).slice(0, 400));

// Watch MQTT 45s for a NEW task (id != <TASK_ID>) or state change.
console.log("[watch] connecting MQTT for 45s...");
const cm = new CloudConnectionManager({ cloud, log: (m) => console.log(`  ${m}`) });
const seen = new Set();
cm.onReport = (report) => {
  const taskId = report?.data?.taskid ?? report?.last_project?.task_id;
  if (taskId) {
    if (!seen.has(taskId)) {
      seen.add(taskId);
      console.log(
        `[task] id=${taskId} state=${report.state} curr=${report.last_project?.curr_layer}/${report.last_project?.total_layers} status=${report.last_project?.print_status}`,
      );
    }
  }
};
await cm.connect();
await new Promise((r) => setTimeout(r, 45000));
await cm.disconnect().catch(() => {});
console.log("[done] unique task ids seen:", [...seen].join(", ") || "none");
process.exit(0);

