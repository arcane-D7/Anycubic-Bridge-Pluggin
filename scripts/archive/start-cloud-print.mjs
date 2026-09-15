// Start a cloud print from an uploaded cloud gcode using the LIVE-VALIDATED
// order 1 contract (2026-09-11: task <TASK_ID> started the physical printer).
// Usage: node scripts/start-cloud-print.mjs <gcode_id> [file_name] [ace_slot]
import crypto from "node:crypto";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import {
  resolveCloudGcode,
  buildCloudStartPrintBody,
  assertIdle,
  verifyStartedTask,
} from "./printer-command-bus.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GCODE_ID = Number(process.argv[2]);
const NAME = process.argv[3] ?? "recovery-remainder-starter";
const ACE_SLOT = process.argv[4] ? Number(process.argv[4]) : null;
if (!GCODE_ID) {
  console.error("usage: node scripts/start-cloud-print.mjs <gcode_id> [file_name] [ace_slot]");
  process.exit(2);
}

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log(`  ${m}`),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
console.log(
  `printer: ${printer.name} is_printing=${printer.is_printing} ready_status=${printer.ready_status} reason=${printer.reason}`,
);

// guard: busy check
if (Number(printer.is_printing) !== 1) {
  console.log(
    `[guard] printer is not idle (is_printing=${printer.is_printing}, reason=${printer.reason}). Refusing to start.`,
  );
  process.exit(1);
}
console.log("[guard] printer idle OK");

const gcode = await resolveCloudGcode(cloud, GCODE_ID);
console.log("[resolve]", JSON.stringify(gcode));

// Build the ACE mapping from the file's paint_infos when the printer has an
// ACE and a slot was requested (paint_index is NOT a physical slot).
const paint = gcode.slice_param?.paint_infos?.[0] ?? null;
let ams = null;
if (ACE_SLOT != null && paint) {
  const slotColor = printer.color?.[ACE_SLOT] ?? paint.paint_color;
  ams = {
    ams_box_mapping: [
      {
        ams_color: slotColor,
        ams_index: ACE_SLOT,
        filament_used: paint.filament_used,
        material_type: paint.material_type,
        paint_color: paint.paint_color,
        paint_index: paint.paint_index,
      },
    ],
  };
}

const body = buildCloudStartPrintBody({
  printer,
  gcode,
  file_name: NAME,
  ai_detect: 0,
  camera_timelapse: 0,
  ams,
});

console.log(
  "[sendOrder order 1]",
  JSON.stringify({
    order_id: body.order_id,
    file_id: body.data.file_id,
    file_name: body.data.file_name,
    has_slice_param: !!body.data.slice_param,
    ams_info: body.ams_info?.use_ams ? "mapped" : "null",
  }).slice(0, 300),
);
const response = await cloud.rawApi("POST", "/work/operation/sendOrder", { params: body });
const taskId = response?.data?.task_id ?? response?.data?.id ?? null;
console.log(
  "[response]",
  JSON.stringify({ code: response?.code, msg: response?.msg, data: response?.data }).slice(0, 400),
);
console.log("[task_id]", taskId ?? "none");
console.log(
  "ORDER SENT — task_id present means a task was created (verify state with node scripts/monitor-print.mjs)",
);
process.exit(0);


