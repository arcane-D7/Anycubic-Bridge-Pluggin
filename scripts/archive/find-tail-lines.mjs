// Where do '; estimated printing time' lines live in the full slice? Tail?
import fs from "node:fs";

const FULL = "<EXPORT_ROOT>/cli-native/plate_1.gcode";
const lines = fs.readFileSync(FULL, "utf8").split(/\r?\n/);
console.log("total lines:", lines.length);

const hits = [];
lines.forEach((l, i) => {
  if (
    l.includes("estimated printing time") ||
    l.includes(";TIME") ||
    l.includes(";Filament used") ||
    l.includes(";LAYER_COUNT")
  )
    hits.push([i, l]);
});
console.log("hits:", JSON.stringify(hits, null, 0));

// last layer end marker index
let lastEnd = -1;
lines.forEach((l, i) => {
  if (l.startsWith("; end of layer_num:")) lastEnd = i;
});
console.log("last end marker at line", lastEnd);
console.log("\n===== tail after last end marker (first 40 lines) =====");
console.log(lines.slice(lastEnd, lastEnd + 40).join("\n"));
console.log("\n===== last 30 lines of file =====");
console.log(lines.slice(lines.length - 30).join("\n"));
