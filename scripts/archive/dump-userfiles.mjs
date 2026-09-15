// Dump userFiles schema (all fields of every entry, compact).
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();

const files = await cloud.rawApi("GET", "/work/index/userFiles", { query: {} });
const list = Array.isArray(files?.data) ? files.data : (files?.data?.list ?? []);
console.log("count:", list.length);
for (const f of list) {
  console.log(JSON.stringify(f).slice(0, 420));
}
process.exit(0);

