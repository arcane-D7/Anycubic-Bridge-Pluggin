// Live MQTT cloud telemetry capture — subscribes to the Kobra S1's report topics
// while a print is running. Protocol from anycubic-cloud-api (GPL-3.0), ported to Node.
import tls from "node:tls";
import fs from "node:fs";
import crypto from "node:crypto";
import mqtt from "mqtt";

const RES = "<REPO_ROOT>\\resources\\mqtt-tls";
const sess = JSON.parse(fs.readFileSync("<REPO_ROOT>\\.probe-session.json", "utf8"));

// Re-login to get a fresh XX-Token (MQTT username needs api_user_id)
const AC_AID = "f9b3528877c94d5c9c5af32245db46ef";
const AC_SEC = "0cf75926606049a3937f56b0373b99fb";
const AC_VER = "V3.0.0";
const API_ROOT = "https://cloud-universe.anycubic.com/p/p/workbench/api";

function authHeaders(xxToken) {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  const ts = Date.now().toString();
  const sig = crypto.createHash("md5").update(`${AC_AID}${ts}${AC_VER}${AC_SEC}${nonce}${AC_AID}`).digest("hex");
  const h = {
    "Xx-Device-Type": "pcf", "Xx-Is-Cn": "1", "Xx-Nonce": nonce, "Xx-Signature": sig,
    "Xx-Timestamp": ts, "Xx-Version": AC_VER, "XX-LANGUAGE": "US", "Content-Type": "application/json",
  };
  if (xxToken) h["XX-Token"] = xxToken;
  return h;
}

const login = await (await fetch(`${API_ROOT}/v3/public/loginWithAccessToken`, {
  method: "POST", headers: authHeaders(null),
  body: JSON.stringify({ device_type: "pcf", access_token: sess.jwt }),
})).json();
if (login.code !== 1) { console.error("login failed", login); process.exit(1); }
const xx = login.data.token;
const userInfo = await (await fetch(`${API_ROOT}/user/profile/userInfo`, { headers: authHeaders(xx) })).json();
const userId = userInfo.data.id;
const userEmail = userInfo.data.user_email;
console.log(`[auth] userId=${userId} email=${userEmail}`);

// MQTT identity (slicer mode):
//   clientId = md5(email + "pcf")
//   password = RSA-PKCS1v15(user_token, CA public key) -> base64
//   username = "user|pcf|<email>|<md5(clientId + pwd + clientId)>"
import { publicDecrypt, createPublicKey } from "node:crypto";
import forge from "node-forge";

const caPem = fs.readFileSync(`${RES}\\ca.crt`, "utf8");
const caCert = forge.pki.certificateFromPem(caPem);
const caPubKeyPem = forge.pki.publicKeyToPem(caCert.publicKey);

// auth_token for MQTT = the XX-Token (session token), not the raw JWT
const clientId = crypto.createHash("md5").update(userEmail + "pcf").digest("hex");
const mqttTokenBytes = Buffer.from(xx, "utf8");
const rsaPub = crypto.createPublicKey(caPubKeyPem);
const encrypted = crypto.publicEncrypt(
  { key: rsaPub, padding: crypto.constants.RSA_PKCS1_PADDING },
  mqttTokenBytes,
);
const mqttPassword = encrypted.toString("base64");
const sigMd5 = crypto.createHash("md5").update(`${clientId}${mqttPassword}${clientId}`).digest("hex");
const username = `user|pcf|${userEmail}|${sigMd5}`;

const PRINTER_KEY = sess.printers[0].key;
const MACHINE_TYPE = sess.printers[0].machine_type;
const PRE = "anycubic/anycubicCloud/v1";
const topics = [
  `${PRE}/printer/app/${MACHINE_TYPE}/${PRINTER_KEY}/#`,
  `${PRE}/+/public/${MACHINE_TYPE}/${PRINTER_KEY}/#`,
];

console.log(`[mqtt] connecting to mqtt-universe.anycubic.com:8883 as ${username.slice(0, 30)}...`);
// Anycubic's CA is SHA-1 signed; Node's OpenSSL 3 refuses it at default security level.
// Workaround: build the secure context with explicit ciphers permitting SHA-1 signatures.
import { createSecureContext as _csc } from "node:tls";
const ctx = _csc({
  ca: fs.readFileSync(`${RES}\\ca.crt`),
  cert: fs.readFileSync(`${RES}\\client.crt`),
  key: fs.readFileSync(`${RES}\\client.key`),
  ciphers: "DEFAULT:@SECLEVEL=0",
});
const client = mqtt.connect({
  host: "mqtt-universe.anycubic.com",
  port: 8883,
  protocol: "mqtts",
  clientId,
  username,
  password: mqttPassword,
  protocolVersion: 4,
  clean: true,
  keepalive: 60,
  rejectUnauthorized: true,
  ca: [fs.readFileSync(`${RES}\\ca.crt`)],
  cert: fs.readFileSync(`${RES}\\client.crt`),
  key: fs.readFileSync(`${RES}\\client.key`),
});

let msgCount = 0;
const seen = new Set();
client.on("connect", () => {
  console.log("[mqtt] CONNECTED, subscribing:", topics);
  client.subscribe(topics, { qos: 0 });
});
client.on("error", e => { console.error("[mqtt] ERROR:", e.message); });
client.on("close", () => { console.log("[mqtt] closed"); });
client.on("message", (topic, payload) => {
  msgCount++;
  const suffix = topic.split("/").slice(-2).join("/");
  if (!seen.has(suffix)) {
    seen.add(suffix);
    console.log(`\n=== TOPIC [${suffix}] (novos tipos em destaque) ===`);
  }
  let data;
  try { data = JSON.parse(payload.toString()); } catch { data = payload.toString().slice(0, 200); }
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${suffix}: ${JSON.stringify(data).slice(0, 600)}`);
});

// Stop after 45s
setTimeout(() => {
  console.log(`\n[done] ${msgCount} mensagens, ${seen.size} topicos distintos`);
  client.end(true);
  process.exit(0);
}, 45000);
