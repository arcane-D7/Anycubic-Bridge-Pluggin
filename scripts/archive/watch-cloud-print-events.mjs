// Monitor cloud MQTT for print/task events after an order was sent.
// Usage: node scripts/watch-cloud-print-events.mjs [seconds=30]
import crypto from "node:crypto";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WATCH = Number(process.argv[2] ?? 30);
const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
console.log(`printer: ${printer.name} is_printing=${printer.is_printing} reason=${printer.reason}`);

const pub = (type) =>
  `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/${type}`;
const events = [];
const client = await cloud.connectMqtt(printer, {
  onEvent: (e) => {
    events.push(e);
    const d = e.data?.data ?? e.data ?? {};
    const short = JSON.stringify(d);
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${e.topic.split("/").pop()} => ${short.slice(0, 260)}`,
    );
  },
});
await sleep(800);
const cmd = (type, action, data) =>
  client.publish(
    pub(type),
    JSON.stringify({ type, action, timestamp: Date.now(), msgid: crypto.randomUUID(), data }),
  );

const poll = setInterval(() => {
  try {
    cmd("print", "query", null);
    cmd("status", "query", null);
    cmd("info", "query", null);
  } catch {}
}, 3000);

await sleep(WATCH * 1000);
clearInterval(poll);
console.log(`=== total events: ${events.length}`);
// summarize taskid-bearing events
const tasks = events.filter((e) => {
  const d = e.data?.data ?? e.data ?? {};
  return d.taskid !== undefined || d.task_id !== undefined || d.project !== undefined;
});
console.log(`task-bearing events: ${tasks.length}`);
for (const t of tasks.slice(0, 6)) {
  const d = t.data?.data ?? t.data ?? {};
  console.log("  TASK", JSON.stringify(d).slice(0, 300));
}
client.end(true);
process.exit(0);

