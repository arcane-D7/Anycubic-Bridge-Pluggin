import fs from "node:fs";
const d = JSON.parse(fs.readFileSync("docs/evidence/cloud-<PRINTER_ID>-1789076993712.json", "utf8"));
const s = JSON.stringify(d, null, 0);
const patterns = [
  /"model":\s*"?\d*"?/g,
  /"gcode_id":\s*"?\d*"?/g,
  /"project_type":\s*\d+/g,
  /"task_id":\s*\d+/g,
  /"print_status":\s*\d+/g,
  /"file_id":\s*\d+/g,
  /"filetype":\s*\d+/g,
  /"curr_layer":\s*\d+/g,
  /"total_layers":\s*\d+/g,
];
const found = new Map();
for (const re of patterns) {
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[0];
    found.set(key, (found.get(key) ?? 0) + 1);
  }
}
for (const [k, v] of [...found.entries()].sort()) console.log(`${k.padEnd(24)} x${v}`);
