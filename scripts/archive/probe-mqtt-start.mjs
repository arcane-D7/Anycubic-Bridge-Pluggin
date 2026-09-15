// Probe: cloud MQTT-native START_PRINT via print/start with cloud file_id.
// Envelope matches the validated light/homexy working path (docs):
// {type, action, timestamp(ms), msgid, data} published to
// anycubic/anycubicCloud/v1/pc/printer/{machine_type}/{key}/print
// data carries the CLOUD start shape (filetype 0, file_id, no filepath).
import crypto from "node:crypto";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { resolveCloudGcode } from "./printer-command-bus.mjs";

const GCODE_ID = Number(process.argv[2]) || 120193034;
const NAME = process.argv[3] || "recovery-remainder-v3";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log(`  ${m}`),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
const gcode = await resolveCloudGcode(cloud, GCODE_ID);

// Pass full slice_param as the reference does: the device needs the material
// config (bed temp, nozzle temp, layer height, paint_infos) to actually start.
const data = {
  filetype: 0,
  file_key: "",
  file_name: NAME,
  file_id: gcode.file_id,
  hollow_param: null,
  is_delete_file: 0,
  matrix: "",
  project_type: 1,
  punching_param: null,
  slice_param: gcode.slice_param ?? null,
  slice_size: null,
  template_id: 0,
  task_settings: { ai_detect: 0, camera_timelapse: 0 },
};
console.log("[mqtt start] slice_param:", JSON.stringify(data.slice_param).slice(0, 400));

console.log("[mqtt start] connecting cloud MQTT...");
const client = await cloud.connectMqtt(printer, {
  onEvent: (event) => {
    const d = event.data;
    const type = d?.type ?? event.topic.split("/").pop();
    if (type === "print" || type === "status") {
      const taskId = d?.data?.taskid ?? d?.last_project?.task_id;
      console.log(
        `[report] type=${type} action=${d?.action} state=${d?.state} task=${taskId ?? "-"} curr=${d?.last_project?.curr_layer}/${d?.last_project?.total_layers} st=${d?.last_project?.print_status}`,
      );
    }
  },
});

await new Promise((r) => setTimeout(r, 3000)); // let SUBACK land
const topic = `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/print`;
const msgid = crypto.randomUUID();
const envelope = {
  type: "print",
  action: "start",
  timestamp: Date.now(),
  msgid,
  data,
};
console.log(
  "[mqtt publish]",
  topic,
  JSON.stringify({ action: "start", file_id: data.file_id, file_name: data.file_name }),
);
await new Promise((resolve, reject) =>
  client.publish(topic, JSON.stringify(envelope), (err) => (err ? reject(err) : resolve())),
);
console.log("[mqtt] published msgid", msgid);
console.log("[mqtt] watching 45s for device reply...");
await new Promise((r) => setTimeout(r, 45000));
await client.endAsync(true).catch(() => {});
console.log("[done]");
process.exit(0);
