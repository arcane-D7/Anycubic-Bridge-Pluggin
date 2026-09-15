// LAN Mode handshake + telemetry probe (protocol validated by chrisfore/anycubic_ha_local).
// 1. GET :18910/info  -> token, ctrlInfoUrl, modelId
// 2. POST ctrlInfoUrl with ts/nonce/did/sign  -> {token: local_token, info: <b64>}
// 3. AES-CBC decrypt info: key=token[16:32], IV=local_token -> broker credentials
// 4. MQTT TLS to :9883 with those credentials
import crypto from "node:crypto";
import fs from "node:fs";
import tls from "node:tls";
import mqtt from "mqtt";

const PRINTER_IP = "<LAN_IP>";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = s => crypto.createHash("md5").update(s).digest("hex");

// Step 1
const info = await (await fetch(`http://${PRINTER_IP}:18910/info`)).json();
console.log("[info] modelId:", info.modelId, "| ctrlInfoUrl:", info.ctrlInfoUrl);
const token = info.token;

// Step 2
const ts = Date.now().toString();
const nonce = Math.random().toString(36).slice(2, 8);
const did = Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)]).join("");
const sign = md5(md5(token.slice(0, 16)) + ts + nonce);
const ctrlUrl = new URL(info.ctrlInfoUrl);
ctrlUrl.searchParams.set("ts", ts);
ctrlUrl.searchParams.set("nonce", nonce);
ctrlUrl.searchParams.set("did", did);
ctrlUrl.searchParams.set("sign", sign);
const ctrl = await (await fetch(ctrlUrl, { method: "POST" })).json();
console.log("[ctrl] code:", ctrl.code, ctrl.message);
if (ctrl.code !== 200) process.exit(1);
const localToken = ctrl.data.token;

// Step 3 — AES-CBC decrypt
const key = Buffer.from(token.slice(16, 32), "utf8").subarray(0, 16);
const iv = Buffer.from(localToken, "utf8").subarray(0, 16);
const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
const dec = Buffer.concat([decipher.update(Buffer.from(ctrl.data.info, "base64")), decipher.final()]);
const creds = JSON.parse(dec.toString());
console.log("[creds] broker:", creds.broker, "| deviceId:", creds.deviceId);
fs.writeFileSync(".lan-creds.json", JSON.stringify({ ...creds, printer_ip: PRINTER_IP, modelId: info.modelId }, null, 2), { mode: 0o600 });

// Step 4 — MQTT
const mt = info.modelId, devId = creds.deviceId;
const PRE = "anycubic/anycubicCloud/v1";
const client = mqtt.connect({
  host: PRINTER_IP,
  port: 9883,
  protocol: "mqtts",
  clientId: "probe_" + Date.now(),
  username: creds.username,
  password: creds.password,
  rejectUnauthorized: false,
  protocolVersion: 4,
  clean: true,
  keepalive: 60,
});

let n = 0;
client.on("error", e => console.error("[mqtt] error:", e.message));
client.on("connect", () => {
  console.log("[mqtt] CONNECTED to local broker");
  client.subscribe([
    `${PRE}/printer/app/${mt}/${devId}/#`,
    `${PRE}/+/public/${mt}/${devId}/#`,
  ]);
});
client.on("message", (topic, payload) => {
  n++;
  let d;
  try { d = JSON.parse(payload.toString()); } catch { return; }
  const suffix = topic.split("/").slice(-2).join("/");
  console.log(`[${suffix}]`, JSON.stringify(d).slice(0, 260));
});

await sleep(12000);
console.log(`\ntotal messages: ${n}`);
client.end(true);
process.exit(0);
