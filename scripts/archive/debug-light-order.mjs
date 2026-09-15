// Debug: send light order, log the full HTTP response body, count MQTT replies.
import crypto from "node:crypto";
import { AnycubicCloud, findSlicerJwt, ORDER } from "./anycubic-cloud.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = "https://cloud-universe.anycubic.com";
const API_ROOT = `${BASE}/p/p/workbench/api`;

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
const p = (await cloud.listPrinters())[0];

let count = 0;
const client = await cloud.connectMqtt(p, { onEvent: e => { count++; console.log("EVT", e.topic, JSON.stringify(e.data).slice(0, 250)); } });
await sleep(800);

// Raw call so we see the actual body (sendOrder hides it)
const body = {
  printer_id: p.id,
  order_type: 0,
  order_id: ORDER.SET_LIGHT_STATUS,
  msgid: crypto.randomUUID(),
  timestamp: Date.now(),
  project_id: 0,
  data: { type: 2, status: 1, brightness: 100 },
};
const res = await fetch(`${API_ROOT}/work/operation/sendOrder`, {
  method: "POST",
  headers: cloud["#authHeaders"] ? undefined : undefined,
  body: JSON.stringify(body),
}).catch(() => null);

// Use the class (it injects headers correctly) but wrap fetch to dump the response
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const r = await origFetch(url, opts);
  if (String(url).includes("sendOrder")) {
    const clone = r.clone();
    console.log("[sendOrder HTTP]", r.status, await clone.text().then(t => t.slice(0, 300)));
  }
  return r;
};

const r = await cloud.sendOrder(p, ORDER.SET_LIGHT_STATUS, { type: 2, status: 1, brightness: 100 });
console.log("msgid:", r?.msgid);
await sleep(8000);
console.log("events:", count);
client.end(true);
process.exit(0);

