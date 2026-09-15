// The reference (Nino6689/anycubic-cloud-api, hardware-validated) defines
// START_PRINT = 1 (IntEnum). The incident doc's "1240" was a pre-reference
// hypothesis. Evidence: the buggy MCP request with order_id=1 DID create a
// task (119720568) — proving order_id=1 reaches the device; it only failed
// because data was the malformed local-file shape (filetype 1 + empty filepath
// + no slice_param + model 0). Send order_id=1 (int) with the FULL correct
// cloud shape.
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
    slice_param: gcode.slice_param,
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

console.log("[sendOrder] order_id=1 body keys:", Object.keys(body).join(","));
const res = await cloud.rawApi("POST", "/work/operation/sendOrder", { params: body });
console.log("[sendOrder] response:", JSON.stringify(res));

const client = await cloud.connectMqtt(printer, {
  onEvent: (event) => {
    const d = event.data;
    if (d?.type === "status" && d?.action === "workReport") {
      const lp = d.last_project;
      console.log(
        `[w] state=${d.state} project=${lp ? `task=${lp.taskid} st=${lp.state} st_p=${lp.print_status} layer=${lp.curr_layer}/${lp.total_layers}` : "null"}`,
      );
    }
  },
});
await new Promise((r) => setTimeout(r, 60000));
await client.endAsync(true).catch(() => {});
console.log("[done]");
process.exit(0);
