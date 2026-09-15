// Raw getPrinters body — no throw, full response dump.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
const res = await fetch("https://cloud-universe.anycubic.com/p/p/workbench/api/work/printer/getPrinters", {
  headers: cloud.authHeadersPublic(),
});
const txt = await res.text();
console.log("HTTP", res.status);
console.log(txt.slice(0, 1200));
process.exit(0);

