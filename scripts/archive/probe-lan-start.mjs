// LAN MQTT native print/start via the local broker (device IP).
// This is the reference's publish_command path used when lan_is_connected:
// topic {prefix}/web/printer/{model}/{device}/{type} (web, not pc!).
// The local broker at <LAN_IP>:9883 carries web/printer command topics.
import fs from "node:fs";
import crypto from "node:crypto";
import mqtt from "mqtt";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { resolveCloudGcode } from "./printer-command-bus.mjs";

const GCODE_ID = Number(process.argv[2]) || 120193034;
const creds = JSON.parse(
  fs.readFileSync(
    "<REPO_ROOT>\\.lan-creds.json",
    "utf8",
  ),
);

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log("  " + m),
});
await cloud.login();
const gcode = await resolveCloudGcode(cloud, GCODE_ID);
const printer = (await cloud.listPrinters())[0];
const [paint] = gcode.slice_param?.paint_infos ?? [];
if (!paint) throw new Error("no paint_infos");
const physicalSlot = 1; // PLA [212,185,150] slot
const slotColor = printer.color?.[physicalSlot] ?? paint.paint_color;

// Build a cloud-shape start data (filetype 0 + file_id + full slice_param)
const data = {
  filetype: 0,
  file_key: "",
  file_name: gcode.name.replace(/\.gcode$/i, ""),
  file_id: gcode.file_id,
  hollow_param: null,
  is_delete_file: 0,
  matrix: "",
  project_type: 1,
  punching_param: null,
  slice_param: gcode.slice_param,
  slice_size: null,
  template_id: 0,
  task_settings: { ai_detect: 1, camera_timelapse: 0 },
};

const PRE = "anycubic/anycubicCloud/v1";
const mt = creds.modelId,
  devId = creds.deviceId;
const TOPIC_WEB = `${PRE}/web/printer/${mt}/${devId}/print`;

const client = mqtt.connect({
  host: creds.printer_ip,
  port: 9883,
  protocol: "mqtts",
  clientId: "lanprobe_" + Date.now(),
  username: creds.username,
  password: creds.password,
  rejectUnauthorized: false,
  protocolVersion: 4,
  clean: true,
});

client.on("connect", () => {
  console.log("[lan] connected to local broker");
  client.subscribe([`${PRE}/printer/app/${mt}/${devId}/#`, `${PRE}/+/public/${mt}/${devId}/#`]);
  setTimeout(() => {
    const msgid = crypto.randomUUID();
    const envelope = { type: "print", action: "start", timestamp: Date.now(), msgid, data };
    console.log(
      "[lan] publish",
      TOPIC_WEB.replace(devId, "[redacted]"),
      "msgid",
      msgid,
      "file_id",
      data.file_id,
      "file_name",
      data.file_name,
    );
    client.publish(TOPIC_WEB, JSON.stringify(envelope), (err) => {
      if (err) console.log("[lan] publish error", err.message);
      else console.log("[lan] published OK");
    });
  }, 1500);
});

client.on("message", (topic, payload) => {
  let d;
  try {
    d = JSON.parse(payload.toString());
  } catch {
    return;
  }
  const suffix = topic.split("/").slice(-2).join("/");
  const t = d.printerName
    ? `state=${d.state} project=${d.project ? "TASK" : "null"} last=${d.last_project?.state}`
    : `action=${d.action} state=${d.state} code=${d.code} data=${JSON.stringify(d.data)?.slice?.(0, 200)}`;
  console.log(`[lan:${suffix}] ${t}`);
});
client.on("error", (e) => console.log("[lan] error", e.message));

await new Promise((r) => setTimeout(r, 30000));
client.end(true);
console.log("[done]");
process.exit(0);
