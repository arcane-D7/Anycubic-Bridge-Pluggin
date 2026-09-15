import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const c = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await c.login();
const proj = await c.rawApi("GET", "/work/project/getProjects", { query: {} });
const list = (proj?.data ?? []).map((p) => ({
  id: p.id,
  print_status: p.print_status,
  gcode_id: p.gcode_id,
  name: (p.gcode_name || "").slice(0, 46),
  create_time: new Date(p.create_time * 1000).toISOString(),
  model: p.model,
}));
console.log(JSON.stringify({ projects: list }, null, 1));

