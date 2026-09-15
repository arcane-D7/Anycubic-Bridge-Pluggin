// Upload a local gcode to the Anycubic cloud using the VALIDATED flow
// (lockStorageSpace -> presigned S3 PUT with Content-Type octet-stream -> newUploadFile claim -> unlock).
// Usage: node scripts/upload-cloud-file.mjs <file> [remote_name]
import fs from "node:fs";
import path from "node:path";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = process.argv[2];
const NAME = process.argv[3] ?? path.basename(LOCAL);
if (!LOCAL) {
  console.error("usage: node scripts/upload-cloud-file.mjs <file> [remote_name]");
  process.exit(2);
}

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log(`  ${m}`),
});
await cloud.login();
const byteLength = fs.statSync(LOCAL).size;
const bytes = fs.readFileSync(LOCAL);
console.log(`[upload] ${NAME}: ${byteLength} bytes`);

const lock = await cloud.rawApi("POST", "/v2/cloud_storage/lockStorageSpace", {
  params: { size: byteLength, name: NAME, is_temp_file: 0 },
});
const lockData = lock?.data ?? {};
const lockId = Number(lockData.id ?? lockData.user_lock_space_id);
const presignedUrl = typeof lockData.preSignUrl === "string" ? lockData.preSignUrl : lockData.url;
if (!Number.isFinite(lockId) || !presignedUrl) {
  console.error("no reservation:", JSON.stringify(lockData).slice(0, 400));
  process.exit(1);
}
console.log(`[lock] id=${lockId} url=${String(presignedUrl).slice(0, 80)}...`);

let claimed = false;
try {
  const put = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(byteLength) },
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  console.log("[aws put]", put.status);
  if (!put.ok) {
    console.error("put failed:", (await put.text()).slice(0, 300));
    process.exit(1);
  }

  const claim = await cloud.rawApi("POST", "/v2/profile/newUploadFile", {
    params: { user_lock_space_id: lockId },
  });
  const cloudFileId = Number(claim?.data?.id);
  console.log("[claim]", JSON.stringify(claim.data).slice(0, 300));
  if (!Number.isFinite(cloudFileId) || cloudFileId <= 0) {
    console.error("no file id");
    process.exit(1);
  }
  claimed = true;
  console.log("[file_id]", cloudFileId);

  await cloud.rawApi("POST", "/v2/cloud_storage/unlockStorageSpace", {
    params: { id: lockId, is_delete_cos: 0 },
  });
  console.log("[unlock] ok");

  // poll for gcode_id
  let matched = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(1000);
    const files = await cloud.rawApi("GET", "/work/index/userFiles", { query: {} });
    const list = Array.isArray(files?.data) ? files.data : (files?.data?.list ?? []);
    matched =
      list.find((f) => Number(f.id) === cloudFileId) ??
      list.find((f) => f.file_name === NAME || f.old_filename === NAME);
    if (matched?.gcode_id || matched?.file_key) break;
  }
  console.log(
    "[match]",
    matched
      ? JSON.stringify({
          id: matched.id,
          gcode_id: matched.gcode_id,
          file_key: matched.file_key,
          file_name: matched.file_name,
        }).slice(0, 300)
      : "none",
  );
  process.exit(0);
} catch (e) {
  if (!claimed) {
    await cloud
      .rawApi("POST", "/v2/cloud_storage/unlockStorageSpace", {
        params: { id: lockId, is_delete_cos: 1 },
      })
      .catch(() => {});
  }
  console.error("ERROR:", e.message);
  process.exit(1);
}

