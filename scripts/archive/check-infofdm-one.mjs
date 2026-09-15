// Quick infoFdm check for ONE gcode id.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
const id = Number(process.argv[2]);
for (const ms of [0, 12000]) {
  if (ms) await new Promise((r) => setTimeout(r, ms));
  const info = await cloud.rawApi("GET", "/work/gcode/infoFdm", { query: { id } });
  const d = info?.data ?? {};
  console.log(
    `${ms}ms: est=${d.estimate} layers=${d.slice_result?.total_layers ?? "?"} time=${JSON.stringify(d.slice_result?.print_time)} img=${d.img ? "yes" : "no"} status=${d.status} name=${d.name}`,
  );
}
process.exit(0);

