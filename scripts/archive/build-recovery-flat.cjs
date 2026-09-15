const fs = require("node:fs");

// Load project settings extracted from recovery 3MF and produce a FLAT config
// accepted by --load-settings (strip "from":"project", add layer_gcode).
const src = fs.readFileSync(
  "<EXPORT_ROOT>\\csh-3mf\\Metadata_project_settings.config",
  "utf8",
);
const proj = JSON.parse(src);

// Ensure critical machine gcode fields are present; patch the missing ones.
const flat = { ...proj };

// Identity fixes
delete flat.from; // "from":"project" makes CLI reject external load
flat.type = "config";
flat.version = "2.0.0.1";

// Add the missing per-layer reset the engine REQUIRES with relative E dists
flat.layer_gcode = "G92 E0";

// Ensure machine identity keys exist for compatibility matching
flat.compatible_printers = [proj.printer_settings_id ?? "Anycubic Kobra S1 0.4 nozzle"];
flat.compatible_printers_condition = flat.compatible_printers_condition ?? "";

fs.writeFileSync(
  "<EXPORT_ROOT>\\csh-3mf\\recovery-flat-settings.json",
  JSON.stringify(flat, null, 2),
);
console.log("flat settings written. keys:", Object.keys(flat).length);
console.log("layer_gcode:", JSON.stringify(flat.layer_gcode));
console.log("from removed:", !("from" in flat));
