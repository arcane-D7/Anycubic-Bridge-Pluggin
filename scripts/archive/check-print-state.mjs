// Check the real print state: cloud status field + fresh MQTT status report.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
const LOG_DIR = (process.env.APPDATA ?? "") + "/AnycubicSlicerNext/log";
const RES = "<REPO_ROOT>\\resources";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cloud = new AnycubicCloud({ access_token: findSlicerJwt(LOG_DIR), resources_dir: RES, log: () => {} });
await cloud.login();
const p = (await cloud.listPrinters())[0];
console.log(`cloud fields: is_printing=${p.is_printing} ready_status=${p.ready_status} device_status=${p.device_status} status=${p.status}`);
console.log(`last project info: name=${p.msg ?? "-"} reason=${p.reason ?? "-"}`);

const events = [];
const client = await cloud.connectMqtt(p, { onEvent: e => events.push(e) });
// ask for a full status refresh
try { await cloud.sendOrder(p, 1231, {}); } catch {}
await sleep(6000);
for (const e of events) {
  if (e.topic.startsWith("status") || e.topic.startsWith("tempature") || e.topic.startsWith("print")) {
    console.log(`${e.topic}: ${JSON.stringify(e.data).slice(0, 400)}`);
  }
}
console.log(`total events: ${events.length}`);
client.end(true);
process.exit(0);

