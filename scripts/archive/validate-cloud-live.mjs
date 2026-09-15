// Full live validation of the cloud client: login -> printers -> MQTT subscribe
// -> ACE getInfo order -> capture slot/telemetry reports. Read-only, safe.
import fs from "node:fs";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const LOG_DIR = (process.env.APPDATA ?? "") + "/AnycubicSlicerNext/log";
const RES = "<REPO_ROOT>\\resources";

const jwt = findSlicerJwt(LOG_DIR);
if (!jwt) { console.error("no JWT"); process.exit(1); }
const cloud = new AnycubicCloud({ access_token: jwt, resources_dir: RES, log: m => console.log(`  ${m}`) });

await cloud.login();
const printers = await cloud.listPrinters();
const printer = printers[0];
console.log(`printer: ${printer.name} (id=${printer.id}, key=${printer.key.slice(0, 10)}..., fw=${printer.version?.firmware_version})`);
console.log(`status: is_printing=${printer.is_printing} ready=${printer.ready_status}`);
console.log(`features: ${printer.features.map(f => f.name).join(", ")}`);
const box = printer.multi_color_box?.[0];
if (box) {
  console.log(`ACE: humidity=${box.humidity} loaded_slot=${box.loaded_slot}`);
  for (const s of box.slots ?? []) {
    console.log(`  slot ${s.index}: ${s.type || "(vazio)"} rgb=[${(s.color ?? []).join(",")}] pct=${s.consumables_percent} sku=${s.sku || "-"} edit_status=${s.edit_status}`);
  }
}

// MQTT: subscribe and ask ACE for fresh info (order via cloud, answer via MQTT)
const events = [];
const client = await cloud.connectMqtt(printer, {
  onEvent: ev => {
    events.push(ev);
    console.log(`[mqtt] ${ev.topic}: ${JSON.stringify(ev.data).slice(0, 300)}`);
  },
});

// Ask ACE for its state (order goes over cloud API; answer arrives on MQTT)
try {
  const r = await cloud.aceGetInfo(printer);
  console.log(`[order] aceGetInfo -> msgid=${r?.msgid ?? "?"}`);
} catch (e) {
  console.log(`[order] aceGetInfo FAILED: ${e.message}`);
}

// Also query peripherals (safe, read-only)
try {
  const r = await cloud.sendOrder(printer, 1230, {}); // QUERY_PERIPHERALS
  console.log(`[order] queryPeripherals -> msgid=${r?.msgid ?? "?"}`);
} catch (e) {
  console.log(`[order] queryPeripherals FAILED: ${e.message}`);
}

await new Promise(r => setTimeout(r, 12000));
console.log(`\n[summary] ${events.length} eventos MQTT recebidos`);
fs.writeFileSync(
  "<REPO_ROOT>\\.probe-mqtt-events.json",
  JSON.stringify(events, null, 2),
);
client.end(true);
process.exit(0);

