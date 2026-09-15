// Definitive HTTP probe: order 1 (START_PRINT int) with reference-exact body +
// AMS mapping + FULL slice_param. The mobile-app successful start (incident
// doc) preserved complete slice metadata. Every prior variant sent
// slice_param:null or used 1240 (which the server accepts, no task created).
// LIVE-RESULT 2026-09-11: order 1 + slice_param -> task <TASK_ID> started.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { resolveCloudGcode } from "./printer-command-bus.mjs";

const GCODE_ID = Number(process.argv[2]) || 120193034;
const SLOT = Number(process.argv[3]) || 1;

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log("  " + m),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
const gcode = await resolveCloudGcode(cloud, GCODE_ID);
const [paint] = gcode.slice_param?.paint_infos ?? [];
if (!paint) throw new Error("no paint_infos");
const slotColor = printer.color?.[SLOT] ?? paint.paint_color;
console.log(
  "[before]",
  JSON.stringify({ is_printing: printer.is_printing, reason: printer.reason }),
);

const body = {
  printer_id: printer.id,
  order_id: 1, // START_PRINT (reference IntEnum), INTEGER
  project_id: 0,
  data: {
    filetype: 0,
    file_key: "",
    file_name: gcode.name.replace(/\.gcode$/i, ""),
    file_id: gcode.file_id,
    hollow_param: null,
    is_delete_file: 0,
    matrix: "",
    project_type: 1,
    punching_param: null,
    slice_param: gcode.slice_param, // FULL slice metadata (mobile-app contract)
    slice_size: null,
    template_id: 0,
    task_settings: { ai_detect: 1, camera_timelapse: 0 },
  },
  ams_info: {
    ams_box_mapping: [
      {
        ams_color: slotColor,
        ams_index: SLOT,
        filament_used: paint.filament_used,
        material_type: paint.material_type,
        paint_color: paint.paint_color,
        paint_index: paint.paint_index,
      },
    ],
    use_ams: true,
  },
  settings: null,
};

console.log("[sendOrder] body keys:", Object.keys(body).join(","));
console.log(
  "[sendOrder] data.slice_param keys:",
  Object.keys(body.data.slice_param ?? {}).join(","),
);
const res = await cloud.rawApi("POST", "/work/operation/sendOrder", { params: body });
console.log("[sendOrder] response:", JSON.stringify(res));

// Watch MQTT for the task sequence
const client = await cloud.connectMqtt(printer, {
  onEvent: (event) => {
    const d = event.data;
    if (d?.type === "status" && d?.action === "workReport") {
      const p = d.printerName ? { state: d.state } : null;
      const lp = d.project ? d.project : null;
      console.log(`[w] state=${d.state} project=${lp ? JSON.stringify(lp).slice(0, 160) : "null"}`);
      void p;
    }
  },
});
await new Promise((r) => setTimeout(r, 60000));
await client.endAsync(true).catch(() => {});
console.log("[done]");
process.exit(0);

