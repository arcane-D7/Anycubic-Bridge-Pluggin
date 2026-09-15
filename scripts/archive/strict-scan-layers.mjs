// Strict-scan the recovery gcode body like the cloud parser would:
// - each ";LAYER_CHANGE" must be followed by ";Z:float" then ";HEIGHT:float"
// - count EXCLUDE start/end
// - find first malformed layer (missing ;Z, missing HEIGHT, Z regressions)
import fs from "node:fs";

const files = {
  full: "<EXPORT_ROOT>/cli-native/plate_1.gcode",
  rec: "<EXPORT_ROOT>/recovery-remainder-starter.gcode",
};

for (const [label, f] of Object.entries(files)) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  let layerCount = 0,
    bad = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim().startsWith(";LAYER_CHANGE")) {
      layerCount++;
      const z = lines[i + 1]?.trim();
      const h = lines[i + 2]?.trim();
      if (!/^;Z:\d/.test(z || ""))
        bad.push([layerCount, i + 1, "no ;Z after LAYER_CHANGE: " + JSON.stringify(z)]);
      if (!/^;HEIGHT:\d/.test(h || ""))
        bad.push([layerCount, i + 1, "no ;HEIGHT after ;Z: " + JSON.stringify(h)]);
    }
  }
  const excS = (lines.join("\n").match(/EXCLUDE_OBJECT_START/g) || []).length;
  const excE = (lines.join("\n").match(/EXCLUDE_OBJECT_END/g) || []).length;
  console.log(`${label}: LAYER_CHANGE=${layerCount} EXC_S=${excS} EXC_E=${excE} bad=${bad.length}`);
  if (bad.length) console.log("  first bad:", JSON.stringify(bad.slice(0, 5), null, 1));
}
