// Read-only probe: find a download URL for the failed task's G-code.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt(`${process.env.APPDATA}/AnycubicSlicerNext/log`),
  resources_dir: "resources",
  log: () => {},
});
await cloud.login();

for (const [ep, query] of [
  ["/work/gcode/info", { id: <TASK_ID> }],
  ["/v2/project/info", { id: <TASK_ID> }],
  ["/v5/project/printHistory/detail", { task_id: <TASK_ID> }],
]) {
  try {
    const r = await cloud.rawApi("GET", ep, { query });
    const s = JSON.stringify(r);
    const urls = [...s.matchAll(/https?:\/\/[^"]+/g)]
      .map((m) => m[0])
      .filter((u) => !/avatar|img|icon|help|image/.test(u));
    console.log(`${ep} -> ${urls.length} candidate url(s)`);
    for (const u of urls.slice(0, 4))
      console.log("  ", u.replace(/eyj[^.]+/gi, "JWT?").slice(0, 140));
  } catch (e) {
    console.log(`${ep} -> ERR ${String(e.message).slice(0, 80)}`);
  }
}
process.exit(0);

