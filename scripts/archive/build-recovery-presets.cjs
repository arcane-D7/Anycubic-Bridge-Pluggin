const fs = require("node:fs");

const base = "C:\\Program Files\\AnycubicSlicerNext\\resources\\profiles\\Anycubic";
const outDir = "<EXPORT_ROOT>\\csh-3mf";

// 1) Patch machine preset: add layer_gcode "G92 E0" (required for klipper + relative E)
const machine = JSON.parse(
  fs.readFileSync(`${base}\\machine\\Anycubic Kobra S1 0.4 nozzle.json`, "utf8"),
);
machine.layer_gcode = "G92 E0";
machine.from = "system"; // keep valid
fs.writeFileSync(`${outDir}\\kobra-s1-0.4-recovery-machine.json`, JSON.stringify(machine, null, 2));
console.log("patched machine written");

// 2) Copy process preset (0.20 Standard) — keep as-is
const process = JSON.parse(
  fs.readFileSync(`${base}\\process\\0.20mm Standard @Anycubic Kobra S1 0.4 nozzle.json`, "utf8"),
);
process.from = "system";
fs.writeFileSync(`${outDir}\\kobra-s1-0.4-recovery-process.json`, JSON.stringify(process, null, 2));
console.log("process written");

// 3) Copy filament preset
const filament = JSON.parse(
  fs.readFileSync(`${base}\\filament\\Anycubic PLA @Anycubic Kobra S1 0.4 nozzle.json`, "utf8"),
);
filament.from = "system";
fs.writeFileSync(
  `${outDir}\\kobra-s1-0.4-recovery-filament.json`,
  JSON.stringify(filament, null, 2),
);
console.log("filament written");
