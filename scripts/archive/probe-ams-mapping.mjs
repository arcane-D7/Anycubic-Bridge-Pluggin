// Probe (A): HTTP sendOrder 1 (START_PRINT) WITH ams_info mapping for the ACE
// printer. Live 2026-09-11: order 1 created real tasks (<TASK_ID>/<TASK_ID>);
// 1240 never created a task.
// The reference library refuses cloud print on an ACE printer without
// ams_box_mapping (no_map_for_ace). Our previous 4 variants all sent
// ams_info null -> silently swallowed. Mapping derived from the file's
// paint_infos + the printer's own color array (slot 1 = PLA [212,185,150]).
import crypto from "node:crypto";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { resolveCloudGcode } from "./printer-command-bus.mjs";

const GCODE_ID = Number(process.argv[2]) || 120193034;
const NAME = process.argv[3] || "recovery-remainder-starter";
const SLOT = Number(process.argv[4]) || 1; // physical ACE slot (1 = PLA [212,185,150])

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log("  " + m),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
const gcode = await resolveCloudGcode(cloud, GCODE_ID);

// paint_infos: [{filament_used, material_type, paint_color, paint_index}]
const [paint] = gcode.slice_param?.paint_infos ?? [];
if (!paint) throw new Error("no paint_infos in slice_param");
const slotColor = printer.color?.[SLOT];
console.log(
  "[before] printer state:",
  JSON.stringify({
    is_printing: printer.is_printing,
    reason: printer.reason,
    ready_status: printer.ready_status,
  }),
);

const data = {
  filetype: 0,
  file_key: "",
  file_name: NAME,
  file_id: gcode.file_id,
  hollow_param: null,
  is_delete_file: 0,
  matrix: "",
  project_type: 1,
  punching_param: null,
  slice_param: null,
  slice_size: null,
  template_id: 0,
  task_settings: { ai_detect: 0, camera_timelapse: 0 },
};

const body = {
  printer_id: printer.id,
  order_id: 1, // START_PRINT (reference IntEnum), INTEGER — 1240 never starts
  project_id: 0,
  data,
  ams_info: {
    ams_box_mapping: [
      {
        ams_color: slotColor ?? paint.paint_color,
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

console.log("[sendOrder] full body:\n" + JSON.stringify(body, null, 2));
const res = await cloud.rawApi("POST", "/work/operation/sendOrder", { params: body });
console.log("[sendOrder] response:", JSON.stringify(res));

console.log("[sendOrder] watching 50s for task creation...");
const client = await cloud.connectMqtt(printer, {
  onEvent: (event) => {
    const d = event.data;
    if (d?.type === "status" && d?.action === "workReport") {
      const lp = d.printerName ? d : (event.data?.data ?? {});
      const t = JSON.stringify(d).slice(0, 0);
      console.log(`[report] state=${d.state} ${t}`);
    }
  },
});
await new Promise((r) => setTimeout(r, 50000));
await client.endAsync(true).catch(() => {});
console.log("[done]");
process.exit(0);

