// Clear a stuck busy state on the device via print/stop (taskid -1),
// then report the resulting state. Used to recover from the MQTT start probe
// that left the printer busy with no task.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { CloudConnectionManager } from "./printer-command-bus.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log("  " + m),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
console.log(
  "[before]",
  JSON.stringify({
    is_printing: printer.is_printing,
    reason: printer.reason,
    ready_status: printer.ready_status,
  }),
);

const cm = new CloudConnectionManager({ cloud, log: (m) => console.log("  [cm] " + m) });
const client = await cm.acquire(printer);
// use print_stop builder (taskid -1) but we need the raw envelope with our topic
const data = { taskid: "-1" };
const topic = `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/print`;
const msgid = crypto.randomUUID();
await new Promise((resolve, reject) =>
  client.publish(
    topic,
    JSON.stringify({ type: "print", action: "stop", timestamp: Date.now(), msgid, data }),
    (e) => (e ? reject(e) : resolve()),
  ),
);
console.log("[print/stop] sent msgid", msgid, "topic", topic.replace(printer.key, "[redacted]"));
await new Promise((r) => setTimeout(r, 10000));

const p2 = (await cloud.listPrinters())[0];
console.log(
  "[after]",
  JSON.stringify({ is_printing: p2.is_printing, reason: p2.reason, ready_status: p2.ready_status }),
);
await cm.release();
process.exit(0);

