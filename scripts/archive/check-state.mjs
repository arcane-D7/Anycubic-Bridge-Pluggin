import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const c = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await c.login();
const printers = await c.listPrinters();
const p = printers[0];
const interesting = (obj) =>
  Object.fromEntries(
    Object.entries(obj).filter(([k]) =>
      /is_printing|ready_status|reason|device_status|printing_status|upload|download|state|task|project|curr|progress/.test(
        k,
      ),
    ),
  );
console.log("PRINTER", JSON.stringify(interesting(p), null, 1));
try {
  const st = await c.rawApi("GET", "/v2/printer/status", { query: {} });
  console.log("STATUS-V2", JSON.stringify(interesting(st?.data ?? st), null, 1));
} catch (e) {
  console.log("status err", e.message);
}

