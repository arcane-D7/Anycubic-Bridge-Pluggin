// redact-evidence-json.mjs — replace placeholder tokens inside docs/evidence JSON
// with stable synthetic values so the files parse as valid JSON while staying
// fully agnostic (no user machine/account identifiers).
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(
  new URL("../docs/evidence", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
);
const map = [
  ["<PRINTER_ID>", "0"],
  ["<MACHINE_TYPE>", "0"],
  ["<ACE_MODEL_ID>", "0"],
  ['"<FW_VERSION>"', '""'],
  ['"<LAN_IP>"', '"127.0.0.1"'],
  ['"<DEVICE_KEY>"', '"dev-key-redacted"'],
  ['"<MD5>"', '"md5-redacted"'],
];

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const p = path.join(dir, f);
  let c = fs.readFileSync(p, "utf8");
  for (const [k, v] of map) c = c.split(k).join(v);
  try {
    JSON.parse(c);
    fs.writeFileSync(p, c);
    console.log("fixed", f);
  } catch (e) {
    console.log("STILL BROKEN", f, e.message.slice(0, 80));
  }
}
