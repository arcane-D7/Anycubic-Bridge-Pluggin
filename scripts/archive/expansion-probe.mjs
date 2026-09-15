// Exploration probe: exercise cloud endpoints and order ids that the current
// MCP surface does NOT yet expose. READ-ONLY by construction — GETs and the
// validated read-only order ids only (axis/peripherie/light/multiColorBox/
// local_files/usb_files). Reports what resolves, what 404s, and the raw shape
// so the expansion audit can cite real evidence instead of hypotheses.
// The saved capture is redacted before writing.
import { AnycubicCloud, findSlicerJwt, ORDER } from "./anycubic-cloud.mjs";
import { redact } from "./cloud-readonly-diagnostics.mjs";
import fs from "node:fs";

const LOG_DIR = (process.env.APPDATA ?? "") + "/AnycubicSlicerNext/log";
const cloud = new AnycubicCloud({
  access_token: findSlicerJwt(LOG_DIR),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
const printers = await cloud.listPrinters();
const printer = printers.find((p) => String(p.id) === "<PRINTER_ID>") ?? printers[0];
console.log(`printer: ${printer.name} (${printer.id}) machine_type=${printer.machine_type}`);

const out = { printer_id: printer.id, captured_at: new Date().toISOString(), results: {} };
// The n documented read-order ids; each one exercises the MQTT query path.
const READ_ORDERS = {
  axis: 1214,
  peripherie: 1231,
  light: 1232,
  multiColorBox: 1206,
  local_files: 103,
  usb_files: 101,
};

// 1) exercise the read-only order ids over MQTT to measure which reply
let client;
try {
  client = await cloud.connectMqtt(printer, {
    onEvent: (event) => {
      const key = event.topic.split("/").pop();
      if (!out.mqtt_reports) out.mqtt_reports = {};
      if (!out.mqtt_reports[key]) out.mqtt_reports[key] = [];
      out.mqtt_reports[key].push(redact(event.data));
    },
  });
  out.connection = "mqtt-ok";
} catch (e) {
  out.connection = redact(e.message);
}

for (const [name, id] of Object.entries(READ_ORDERS)) {
  try {
    const ack = await cloud.sendOrder(printer, id, {}, name === "axis" ? { projectId: 0 } : {});
    out.results[`order_${id}_${name}`] = { state: "accepted", ack: redact(ack) };
  } catch (e) {
    out.results[`order_${id}_${name}`] = { state: "error", error: redact(e.message) };
  }
}

// 2) cloud account/read endpoints (all GET, no mutation)
const ENDPOINTS = [
  ["/work/index/getUserStore", {}],
  ["/v2/project/printHistory", { page: 1, limit: 3 }],
  ["/work/printer/printersStatus", {}],
  ["/work/printer/getPrinters", {}],
  ["/v2/printer/all", {}],
  ["/v3/work_project/getErrorList", { id: printer.id }],
  ["/work/project/getProjects", { page: 1, limit: 3 }],
  ["/work/index/userFiles", {}],
  ["/v1/user/profile/userInfo", {}],
];
// Wait long enough for the MQTT replies to the read orders to land.
await new Promise((r) => setTimeout(r, 9000));

for (const [path, query] of ENDPOINTS) {
  try {
    const r = await cloud.rawApi("GET", path, { query });
    out.results[path] = { state: "reply", response: redact(r) };
  } catch (e) {
    out.results[path] = { state: "error", error: redact(e.message) };
  }
}

if (client) client.end(true);

fs.mkdirSync("docs/evidence", { recursive: true });
const file = `docs/evidence/expansion-probe-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
// Summarize the outcome (avoid dumping full payloads to the console)
console.log("\n=== SUMMARY ===");
for (const [k, v] of Object.entries(out.results)) {
  if (v.state === "reply") {
    const data = v.response?.data;
    const summary =
      data && typeof data === "object"
        ? Array.isArray(data)
          ? `array(${data.length})`
          : `object keys=${Object.keys(data).length}`
        : String(data).slice(0, 40);
    console.log(`${k} -> reply: ${summary}`);
  } else {
    console.log(`${k} -> ${v.state}: ${v.error}`);
  }
}
console.log(`\ncapture: ${file}`);

