// Phase 1 — read-only capability sweep. Exercises every query/status order and
// documents every field the cloud exposes. No movement, no temperatures.
import fs from "node:fs";
import { AnycubicCloud, findSlicerJwt, ORDER } from "./anycubic-cloud.mjs";

const LOG_DIR = (process.env.APPDATA ?? "") + "/AnycubicSlicerNext/log";
const RES = "<REPO_ROOT>\\resources";

const jwt = findSlicerJwt(LOG_DIR);
if (!jwt) { console.error("no JWT"); process.exit(1); }
const cloud = new AnycubicCloud({ access_token: jwt, resources_dir: RES, log: () => {} });

await cloud.login();
const printers = await cloud.listPrinters();
const p = printers[0];
console.log(`=== PRINTER: ${p.name} (id=${p.id}) ===`);
console.log(`fw=${p.version?.firmware_version} status=${p.status} is_printing=${p.is_printing}`);
console.log(`material_used=${p.material_used}g total_time=${p.print_totaltime} count=${p.print_count}`);
console.log(`video_taskid=${p.video_taskid ?? "-"} type_function_ids=${JSON.stringify(p.type_function_ids ?? "-").slice(0,120)}`);

const events = [];
const client = await cloud.connectMqtt(p, { onEvent: e => events.push(e) });

const queries = [
  ["QUERY_PERIPHERALS", 1230, {}],
  ["GET_LIGHT_STATUS", 1231, {}],
  ["QUERY_AXIS_POSITION", 1219, {}],
  ["LIST_LOCAL_FILES", 1234, {}],
  ["ACE_GET_INFO", ORDER.MULTI_COLOR_BOX_GET_INFO, {}],
];
for (const [name, id, data] of queries) {
  try {
    const r = await cloud.sendOrder(p, id, data);
    console.log(`[ok] ${name} (${id}) -> msgid=${r?.msgid?.slice(0,8)}`);
    await new Promise(r2 => setTimeout(r2, 1500));
  } catch (e) {
    console.log(`[FAIL] ${name}: ${e.message}`);
  }
}

await new Promise(r => setTimeout(r, 8000));
console.log(`\n=== MQTT events: ${events.length} ===`);
const byTopic = {};
for (const e of events) (byTopic[e.topic] ??= []).push(e.data);
for (const [t, datas] of Object.entries(byTopic)) {
  console.log(`\n--- ${t} (${datas.length}) ---`);
  console.log(JSON.stringify(datas[0]).slice(0, 800));
}
fs.writeFileSync("<REPO_ROOT>\\.sweep-events.json", JSON.stringify(events, null, 2));
client.end(true);
process.exit(0);

