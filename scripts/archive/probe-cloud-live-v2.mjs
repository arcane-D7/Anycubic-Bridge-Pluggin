// Live cloud probe v2 — correct workbench protocol (reverse-engineered from
// hass-anycubic / anycubic-cloud-api, GPL-3.0). Runs against the real API.
import crypto from "node:crypto";
import fs from "node:fs";

const LOG_DIR = "%APPDATA%/AnycubicSlicerNext/log";
const AC_KNOWN_AID = "f9b3528877c94d5c9c5af32245db46ef";
const AC_KNOWN_SEC = "0cf75926606049a3937f56b0373b99fb";
const AC_KNOWN_VID_SLICER = "V3.0.0";
const BASE = "https://cloud-universe.anycubic.com";
const API_ROOT = `${BASE}/p/p/workbench/api`;

function findJwt() {
  const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith("debug_"));
  for (const f of files.sort().reverse()) {
    try {
      const txt = fs.readFileSync(`${LOG_DIR}\\${f}`, "utf8");
      const m = txt.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (m) return m[0];
    } catch {}
  }
  return null;
}

function sliceAuthHeaders(xxToken) {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  const ts = Date.now().toString();
  const sigInput = `${AC_KNOWN_AID}${ts}${AC_KNOWN_VID_SLICER}${AC_KNOWN_SEC}${nonce}${AC_KNOWN_AID}`;
  const sig = crypto.createHash("md5").update(sigInput).digest("hex");
  const h = {
    "Xx-Device-Type": "pcf",
    "Xx-Is-Cn": "1",
    "Xx-Nonce": nonce,
    "Xx-Signature": sig,
    "Xx-Timestamp": ts,
    "Xx-Version": AC_KNOWN_VID_SLICER,
    "XX-LANGUAGE": "US",
    "Content-Type": "application/json",
  };
  if (xxToken) h["XX-Token"] = xxToken;
  return h;
}

async function api(method, path, xxToken, body, query) {
  const url = new URL(API_ROOT + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: sliceAuthHeaders(xxToken),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 500) };
}

const jwt = findJwt();
if (!jwt) { console.error("NO JWT"); process.exit(1); }
const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
console.log(`[jwt] sub=${payload.sub} exp=${new Date(payload.exp * 1000).toISOString()}`);

const login = await api("POST", "/v3/public/loginWithAccessToken", null, {
  device_type: "pcf",
  access_token: jwt,
});
console.log(`[login] HTTP ${login.status} code=${login.json?.code} msg=${login.json?.msg}`);
if (!login.json?.data?.token) {
  console.log("[login] body:", login.json ? JSON.stringify(login.json).slice(0, 400) : login.text);
  process.exit(1);
}
const xx = login.json.data.token;
console.log("[login] XX-Token acquired");

const user = await api("GET", "/user/profile/userInfo", xx);
console.log(`[user] HTTP ${user.status} code=${user.json?.code} id=${user.json?.data?.id} email=${user.json?.data?.user_email}`);

const printers = await api("GET", "/work/printer/getPrinters", xx);
console.log(`[printers] HTTP ${printers.status} code=${printers.json?.code}`);
if (printers.json?.data) {
  for (const p of printers.json.data) {
    console.log("  ---");
    console.log("  id:", p.id, "| name:", p.name, "| status:", p.status);
    console.log("  key:", String(p.key ?? "").slice(0, 12) + "...", "| machine_type:", p.machine_type ?? p.printer_type);
    console.log("  fw:", p.version ?? p.fw_version);
    const box = p.multi_color_box ?? p.ace ?? null;
    if (box) console.log("  ACE:", JSON.stringify(box).slice(0, 400));
    if (p.ai_settings || p.aiSettings) console.log("  ai_settings:", JSON.stringify(p.ai_settings ?? p.aiSettings).slice(0, 200));
  }
} else {
  console.log("[printers] body:", JSON.stringify(printers.json ?? printers.text).slice(0, 400));
}

fs.writeFileSync(
  "<REPO_ROOT>\\.probe-session.json",
  JSON.stringify({ xxToken: xx, jwt, user: user.json?.data, printers: printers.json?.data ?? null }, null, 2),
  { mode: 0o600 },
);
console.log("[saved] .probe-session.json");
