// LAN Mode full telemetry probe: query all report types via local MQTT.
import fs from "node:fs";
import crypto from "node:crypto";
import mqtt from "mqtt";

const creds = JSON.parse(fs.readFileSync("<REPO_ROOT>\\.lan-creds.json", "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mt = creds.modelId, devId = creds.deviceId;
const PRE = "anycubic/anycubicCloud/v1";

const client = mqtt.connect({
  host: creds.printer_ip,
  port: 9883,
  protocol: "mqtts",
  clientId: "probe_" + Date.now(),
  username: creds.username,
  password: creds.password,
  rejectUnauthorized: false,
  protocolVersion: 4,
  clean: true,
});

const query = (type) => {
  const t = `${PRE}/printer/public/${mt}/${devId}/${type}`;
  client.publish(t, JSON.stringify({ type, action: "query", timestamp: Date.now(), msgid: crypto.randomUUID(), data: null }));
};

let topics = new Set();
client.on("connect", () => {
  console.log("[mqtt] connected, subscribing + querying...");
  client.subscribe([
    `${PRE}/printer/app/${mt}/${devId}/#`,
    `${PRE}/+/public/${mt}/${devId}/#`,
  ]);
  setTimeout(() => { query("info"); query("peripherie"); query("light"); query("multiColorBox"); query("status"); }, 800);
  // multiColorBox needs getInfo action per protocol research
  setTimeout(() => {
    const t = `${PRE}/printer/public/${mt}/${devId}/multiColorBox`;
    client.publish(t, JSON.stringify({ type: "multiColorBox", action: "getInfo", timestamp: Date.now(), msgid: crypto.randomUUID(), data: null }));
  }, 2000);
});

client.on("message", (topic, payload) => {
  let d;
  try { d = JSON.parse(payload.toString()); } catch { return; }
  const suffix = topic.split("/").slice(-2).join("/");
  topics.add(suffix);
  const data = d.data ?? d;
  console.log(`[${suffix}]`, JSON.stringify(data).slice(0, 400));
});

await sleep(15000);
console.log(`\n=== topics: ${[...topics].join(", ")}`);
client.end(true);
process.exit(0);

