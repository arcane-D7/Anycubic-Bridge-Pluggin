// Phase 2 — control orders on the idle printer: light on/off, home axes, query position.
// Safe sequence: light (benign) -> home X/Y -> home Z -> query position.
import fs from "node:fs";
import { AnycubicCloud, findSlicerJwt, ORDER } from "./anycubic-cloud.mjs";

const LOG_DIR = (process.env.APPDATA ?? "") + "/AnycubicSlicerNext/log";
const RES = "<REPO_ROOT>\\resources";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const jwt = findSlicerJwt(LOG_DIR);
const cloud = new AnycubicCloud({ access_token: jwt, resources_dir: RES, log: () => {} });
await cloud.login();
const p = (await cloud.listPrinters())[0];
// `is_printing` on the cloud object is stale between sessions; the authoritative
// idle signal is msg/reason ("free") plus MQTT state:free. Proceed but log it.
console.log(`note: cloud is_printing=${p.is_printing} (stale), reason="${p.reason}" — proceeding on user confirmation of standby`);

const events = [];
const client = await cloud.connectMqtt(p, { onEvent: e => { events.push(e); console.log(`[mqtt] ${e.topic}: ${JSON.stringify(e.data).slice(0, 220)}`); } });
await sleep(1000);

console.log("\n=== 1. LIGHT ON ===");
await cloud.setLight(p, true);
await sleep(2500);

console.log("\n=== 2. LIGHT OFF ===");
await cloud.setLight(p, false);
await sleep(2000);

console.log("\n=== 3. HOME X+Y (axis 4, home) ===");
try { await cloud.sendOrder(p, ORDER.MOVE_AXLE, { axis: 4, move_type: 2, distance: 0 }); }
catch (e) { console.log(`home xy failed: ${e.message}`); }
await sleep(5000);

console.log("\n=== 4. HOME Z (axis 3, home) ===");
try { await cloud.sendOrder(p, ORDER.MOVE_AXLE, { axis: 3, move_type: 2, distance: 0 }); }
catch (e) { console.log(`home z failed: ${e.message}`); }
await sleep(8000);

console.log("\n=== 5. QUERY AXIS POSITION ===");
await cloud.sendOrder(p, ORDER.QUERY_AXIS_POSITION, {});
await sleep(3000);

console.log(`\n=== events: ${events.length} ===`);
fs.writeFileSync("<REPO_ROOT>\\.control-events.json", JSON.stringify(events, null, 2));
client.end(true);
process.exit(0);

