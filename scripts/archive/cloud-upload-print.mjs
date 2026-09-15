// Complete cloud upload + print flow:
// 1. lockStorageSpace (get upload id + presigned URL)
// 2. PUT gcode to AWS S3
// 3. newUploadFile (claim) -> file_id/gcode_id
// 4. sendOrder START_PRINT with file_id
// Based on hass-anycubic upload flow (GPL-3.0).
import fs from "node:fs";
import { AnycubicCloud, findSlicerJwt, ORDER } from "./anycubic-cloud.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GCODE =
  process.argv[2] ??
  "<REPO_ROOT>\\poc-output\\fcded498-1a28-4fed-b67c-e27c559cfd78\\plate_1.gcode";
const NAME = process.argv[3] ?? "cube-15mm-test.gcode";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log(`  ${m}`),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
console.log(`printer: ${printer.name} (is_printing=${printer.is_printing})`);

const gcode = fs.readFileSync(GCODE);
console.log(`[upload] ${NAME}: ${gcode.length} bytes`);

// 1. lock storage
const lock = await cloud.rawApi("POST", "/v2/cloud_storage/lockStorageSpace", {
  params: { size: gcode.length, name: NAME, is_temp_file: 0 },
});
console.log("[lock]", JSON.stringify(lock).slice(0, 300));
const lockData = lock.data;
const lockId = lockData?.user_lock_space_id ?? lockData?.id;
const putUrl = lockData?.url ?? lockData?.presigned_url;

if (!putUrl) {
  console.error("no presigned url in lock response:", JSON.stringify(lockData).slice(0, 500));
  process.exit(1);
}

// 2. PUT to S3
const put = await fetch(putUrl, { method: "PUT", body: gcode });
console.log("[aws put]", put.status);
if (!put.ok) {
  console.error("put failed:", await put.text().then((t) => t.slice(0, 300)));
  process.exit(1);
}

// 3. claim upload
const claim = await cloud.rawApi("POST", "/v2/profile/newUploadFile", {
  params: { user_lock_space_id: lockId },
});
console.log("[claim]", JSON.stringify(claim).slice(0, 300));
const fileId = claim.data?.id;
if (!fileId) {
  console.error("no file id");
  process.exit(1);
}
console.log("[file_id]", fileId);

// 4. START_PRINT with cloud file
const start = await cloud.sendOrder(
  printer,
  ORDER.START_PRINT,
  {
    filetype: 0,
    file_key: "",
    file_name: NAME,
    file_id: fileId,
    hollow_param: null,
    is_delete_file: 0,
    matrix: "",
    project_type: 1,
    punching_param: null,
    slice_param: null, // this upload may not be resliced; pass through when available
    slice_size: null,
    template_id: 0,
    task_settings: { ai_detect: 1, camera_timelapse: 0 },
  },
  { projectId: 0, extra: { ams_info: null, settings: null } },
);
console.log("[start print]", JSON.stringify(start).slice(0, 300));
console.log("ORDER SENT — monitor com: node scripts/monitor-print.mjs");
process.exit(0);

