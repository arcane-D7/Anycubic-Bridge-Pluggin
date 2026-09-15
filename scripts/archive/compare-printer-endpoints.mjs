// Compare printersStatus vs getPrinters endpoints with current account.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
for (const ep of ["/work/printer/printersStatus", "/work/printer/getPrinters", "/v2/printer/all"]) {
  try {
    const r = await cloud.rawApi("GET", ep);
    const d = r.data;
    const n = Array.isArray(d) ? d.length : "(objeto)";
    console.log(`${ep} -> items: ${n}`);
    if (Array.isArray(d) && d.length) {
      console.log("  first:", d[0].name, "| id:", d[0].id, "| status:", d[0].status, "| key:", String(d[0].key ?? "").slice(0, 10));
    } else if (!Array.isArray(d)) {
      console.log("  body:", JSON.stringify(d).slice(0, 300));
    }
  } catch (e) {
    console.log(`${ep} -> FAIL: ${e.message}`);
  }
}
process.exit(0);

