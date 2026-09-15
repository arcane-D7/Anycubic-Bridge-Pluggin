// Full print flow test — file list + start local print via MQTT-native commands.
// Usage: node cloud-print-flow.mjs [start <filename>]
import crypto from "node:crypto";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG_DIR = (process.env.APPDATA ?? "") + "/AnycubicSlicerNext/log";
const RES = "<REPO_ROOT>\\resources";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt(LOG_DIR),
  resources_dir: RES,
  log: () => {},
});
await cloud.login();
const p = (await cloud.listPrinters())[0];
console.log(`printer: ${p.name} (printing=${p.is_printing})`);

const client = await cloud.connectMqtt(p, {
  onEvent: e => {
    const d = e.data.data ?? e.data;
    if (e.topic.startsWith("file") && Array.isArray(d)) {
      console.log(`[files] ${d.length} ficheiros:`);
      for (const f of d.slice(0, 15)) console.log("  -", JSON.stringify(f).slice(0, 160));
    } else if (e.topic.startsWith("print") && (d.progress !== undefined || d.taskid)) {
      console.log("[print]", JSON.stringify(d).slice(0, 250));
    } else if (e.topic.startsWith("status")) {
      console.log("[status]", e.data.state);
    } else if (e.topic.startsWith("tempature")) {
      console.log("[temp]", JSON.stringify(d).slice(0, 160));
    }
  },
});
await sleep(800);

const pub = ep => `anycubic/anycubicCloud/v1/pc/printer/${p.machine_type}/${p.key}/${ep}`;
const cmd = (type, action, data) =>
  client.publish(pub(type), JSON.stringify({ type, action, timestamp: Date.now(), msgid: crypto.randomUUID(), data }));

const mode = process.argv[2] ?? "list";

if (mode === "list") {
  cmd("file", "getLocalFileList", null);
  await sleep(6000);
} else if (mode === "start" && process.argv[3]) {
  const filename = process.argv[3];
  console.log(`STARTING PRINT: ${filename}`);
  // start print from local file (filetype 1 = local sdcard)
  cmd("print", "start", {
    filetype: 1,
    file_name: filename,
    file_key: "",
    filename,
    filepath: `/${filename}`,
    task_settings: { ai_detect: 1, camera_timelapse: 1 },
  });
  await sleep(20000);
  // follow with progress polls
  for (let i = 0; i < 4; i++) {
    cmd("print", "query", null);
    await sleep(8000);
  }
}

client.end(true);
process.exit(0);

