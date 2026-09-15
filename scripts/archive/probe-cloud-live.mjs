// Live cloud probe — uses the JWT found in slicer logs to exercise the workbench API
// Same protocol as src/cloud.ts (see VALIDATION.md): access_token -> XX-Token -> getPrinters
import crypto from "node:crypto";
import fs from "node:fs";

const logFile = process.env.DBG_LOGS || "%APPDATA%/AnycubicSlicerNext/log";
const files = fs.readdirSync(logFile).filter(f => f.startsWith("debug_")).sort();
let jwt = null;
for (const f of files.reverse()) {
  try {
    const txt = fs.readFileSync(`${logFile}\\${f}`, "utf8");
    const m = txt.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (m) { jwt = m[0]; break; }
  } catch {}
}
if (!jwt) { console.error("no JWT found"); process.exit(1); }

const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
console.log(`[jwt] sub=${payload.sub} exp=${new Date(payload.exp * 1000).toISOString()}`);

const APP_ID = "anycubicSlicerNext";
const MD5 = s => crypto.createHash("md5").update(s).digest("hex");

function signHeaders(accessToken) {
  const nonce = MD5(String(Math.random()));
  const ts = Math.floor(Date.now() / 1000).toString();
  const sign = MD5(`appId=${APP_ID}&authToken=${accessToken}&nonce=${nonce}&timestamp=${ts}&key=c9539ee8838b460dbb60e532e6c86f17`);
  return { appId: APP_ID, authToken: accessToken, nonce, timestamp: ts, sign };
}

async function workbench(path, accessToken, body) {
  const h = signHeaders(accessToken);
  const url = `https://cloud-universe.anycubic.com${path}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      ...h,
      "Content-Type": "application/json",
      "User-Agent": "AnycubicSlicerNext/2.0.0.3",
      "Region": "en",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  console.log(`[${path}] HTTP ${res.status} -> ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return null; }
}

// Step 1: exchange access_token (JWT) for XX-Token session
const login = await workbench("/uapi/account/xxLogin", jwt, { platform: 3 });
if (!login || login.code !== 1) {
  console.error("[login] failed:", login?.message ?? login);
  process.exit(1);
}
const xx = login.data?.XXToken ?? login.data?.xx_token;
console.log("[login] XX-Token ok, length:", String(xx ?? "").length);

// Step 2: list printers
const printers = await workbench("/uapi/device/getPrinters", xx);
if (printers && printers.code === 1) {
  const list = printers.data?.printers ?? printers.data ?? [];
  console.log("[printers] count:", Array.isArray(list) ? list.length : "n/a");
  console.log(JSON.stringify(list, null, 2).slice(0, 3000));
}
