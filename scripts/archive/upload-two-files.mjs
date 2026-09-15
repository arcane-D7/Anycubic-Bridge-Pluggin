// Upload two files and report their infoFdm parse state.
import fs from "node:fs";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();

for (const [local, name] of [process.argv[2], process.argv[3]]) {
  const byteLength = fs.statSync(local).size;
  const bytes = fs.readFileSync(local);
  const lock = await cloud.rawApi("POST", "/v2/cloud_storage/lockStorageSpace", {
    params: { size: byteLength, name, is_temp_file: 0 },
  });
  const id = Number(lock?.data?.id);
  if (Number.isFinite(id)) {
    await fetch(lock.data.preSignUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(byteLength) },
      body: bytes,
    });
    const claim = await cloud.rawApi("POST", "/v2/profile/newUploadFile", {
      params: { user_lock_space_id: id },
    });
    console.log(`[${name}] file_id=${claim?.data?.id}`);
    await cloud.rawApi("POST", "/v2/cloud_storage/unlockStorageSpace", {
      params: { id, is_delete_cos: 0 },
    });
  }
}
process.exit(0);

