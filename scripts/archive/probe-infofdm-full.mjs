// Full infoFdm detail for old parsed file vs ours — see ALL parse fields.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();

const targets = [
  ["OLD-parsed-anymcp-final", 116200625],
  ["OURS-gcode.3mf", 120187854],
  ["OURS-raw.gcode", 120186031],
];
for (const [label, id] of targets) {
  const info = await cloud.rawApi("GET", "/work/gcode/infoFdm", { query: { id } });
  const d = info?.data ?? {};
  console.log(`\n===== ${label} (${id}) =====`);
  console.log(
    JSON.stringify(
      {
        ...d,
        slice_param: d.slice_param,
        slice_result: d.slice_result,
        task_list: undefined,
        img: undefined,
        image_id: d.image_id ? "yes" : "no",
      },
      null,
      1,
    ).slice(0, 2200),
  );
}
process.exit(0);
