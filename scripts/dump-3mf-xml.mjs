// Debug: dump structural XML entries from a 3MF
import fs from "node:fs";
import { read3mf } from "./read-3mf.mjs";

const file = process.argv[2];
const files = read3mf(file);
for (const f of files) {
  const isXml =
    f.name.endsWith(".model") ||
    f.name.endsWith(".config") ||
    f.name.endsWith(".rels") ||
    f.name.includes("Content_Types") ||
    f.name.endsWith(".xml");
  if (!isXml) continue;
  const s = f.data.toString("utf8");
  console.log("---", f.name, f.size, "---");
  console.log(s.length > 3000 ? s.slice(0, 3000) : s);
  console.log();
}
