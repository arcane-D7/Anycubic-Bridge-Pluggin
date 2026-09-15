#!/usr/bin/env node
/**
 * Regenerate `scripts/printer-http-property-catalog.mjs` from live captures.
 *
 * Source of truth: the `http` section of the saved cloud evidence files
 * (docs/evidence/cloud-*.json and docs/evidence/http-read-orders-*.json).
 * Run after any capture that adds or changes HTTP endpoint fields:
 *
 *   node scripts/gen-http-property-catalog.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const evidenceDir = path.join(root, "docs", "evidence");

const ENDPOINT_META = {
  printer_status: { path: "/v2/Printer/status", evidence: "live" },
  printer_info: {
    path: "/v2/printer/info",
    evidence: "live",
    note: "richest single source: 128 fields",
  },
  printer_tool: {
    path: "/v2/printer/tool",
    evidence: "live",
    note: "type_function_id must be positive (13 = XYZ tool)",
  },
  printer_functions: {
    path: "/v2/printer/functions",
    evidence: "live",
    note: "returned Photon S metadata for Kobra S1 inputs — not a reliable capability list",
  },
  ace: {
    path: "/v2/printer/getMultiColorBoxInfo",
    evidence: "live",
    note: "initial /v2/printer/multiColorBoxInfo returned 404",
  },
  project_info: {
    path: "/v2/project/info",
    evidence: "live",
    note: "126 fields incl. slice_param/slice_result and device_message",
  },
  project_monitor: { path: "/v2/project/monitor", evidence: "live" },
  history_detail: { path: "/v5/project/printHistory/detail", evidence: "live" },
  gcode_info_fdm: {
    path: "/work/gcode/infoFdm",
    evidence: "live",
    note: "resolves gcode_id -> cloud file id + slice metadata (63 fields)",
  },
};

function collectPaths(value, prefix, out, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.slice(0, 1).forEach((item) => collectPaths(item, `${prefix}[]`, out, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    out.add(next);
    collectPaths(child, next, out, depth + 1);
  }
}

function groupFor(p) {
  if (/^(code|msg)$/.test(p)) return "envelope";
  if (/temp|temperature/.test(p)) return "temperature";
  if (/fan/.test(p)) return "cooling";
  if (/color|filament|material|paint|supplies_usage/.test(p)) return "material";
  if (/multi_color_box|ace|box_/.test(p)) return "ace";
  if (/layer|print_status|progress|time|state|reason|pause|task/.test(p)) return "print";
  if (/features|tool|function/.test(p)) return "capability";
  if (/slice_param|slice_result|fill_density|perimeter|support|brim|layer_height/.test(p))
    return "slice";
  if (/machine|printer|model|firmware|nozzle|base\.|version/.test(p)) return "identity";
  if (/id$|key$|name$|filename|file_name|img|image|mac/.test(p)) return "identity";
  return "general";
}

function unitFor(p) {
  if (/_temp|_temperature/.test(p)) return "celsius";
  if (/estimated_time_s|print_time|remain_time|print_totaltime/.test(p)) return "second";
  if (/file_size|size$|filament_used/.test(p)) return "mixed";
  if (/progress|density/.test(p)) return "percent";
  return undefined;
}

const best = new Map();
const files = fs.readdirSync(evidenceDir).filter((f) => f.endsWith(".json"));
for (const file of files) {
  let capture;
  try {
    capture = JSON.parse(fs.readFileSync(path.join(evidenceDir, file), "utf8"));
  } catch {
    continue;
  }
  for (const [kind, entry] of Object.entries(capture.http ?? {})) {
    if (!ENDPOINT_META[kind] || entry.state !== "reply") continue;
    const paths = new Set();
    collectPaths(entry.response, "", paths);
    const current = best.get(kind);
    if (!current || current.size < paths.size) best.set(kind, paths);
  }
}

const catalog = {};
for (const [kind, paths] of best) {
  const meta = ENDPOINT_META[kind];
  catalog[kind] = {
    path: meta.path,
    evidence: meta.evidence,
    ...(meta.note ? { note: meta.note } : {}),
    properties: [...paths].sort().map((p) => {
      const unit = unitFor(p);
      return { path: p, group: groupFor(p), ...(unit ? { unit } : {}) };
    }),
  };
}

const header = `/**
 * HTTP property catalog — GENERATED, do not hand-edit.
 *
 * Produced by scripts/gen-http-property-catalog.mjs from the live captures in
 * docs/evidence (real Kobra S1 <PRINTER_ID>, firmware <FW_VERSION>). Regenerate after any
 * capture that adds or changes endpoint fields:
 *
 *   node scripts/gen-http-property-catalog.mjs
 */
`;
const body = `export const HTTP_PROPERTY_CATALOG = Object.freeze(${JSON.stringify(catalog, null, 1)});\n`;
fs.writeFileSync(path.join(root, "scripts", "printer-http-property-catalog.mjs"), header + body);

const total = Object.values(catalog).reduce((sum, entry) => sum + entry.properties.length, 0);
console.log(
  Object.entries(catalog)
    .map(([kind, entry]) => `${kind}: ${entry.properties.length}`)
    .join("\n"),
);
console.log(`TOTAL: ${total}`);
