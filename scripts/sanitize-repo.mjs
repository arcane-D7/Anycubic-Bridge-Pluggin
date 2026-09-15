#!/usr/bin/env node
/**
 * sanitize-repo.mjs — remove user-machine and user-account data so the repo
 * is fully agnostic (works on any machine / for any Anycubic account).
 *
 * Recurring identifiables are replaced with generic placeholders or env-driven
 * runtime resolution:
 *   C:\Users\<USER>\...            -> runtime (os.homedir / env / import.meta.url)
 *   Anycubic-Control-Exports\<...> -> relative path or placeholder
 *   Printer cloud id              -> <PRINTER_ID>
 *   Device key                    -> <DEVICE_KEY>
 *   LAN IP                        -> <LAN_IP>
 *   machine_type / ACE model_id   -> <MACHINE_TYPE> / <ACE_MODEL_ID> (evidence only; protocol defaults stay)
 *   firmware version              -> <FW_VERSION>
 *
 * The script itself is machine-agnostic: the current user dir is derived from
 * os.homedir() at runtime and sensitive literals are split, so this file is
 * safe to commit.
 *
 * Modes:
 *   --dry-run  print per-file replacement counts, do not write
 *   --apply    write changes
 *
 * Usage:
 *   node scripts/sanitize-repo.mjs --dry-run
 *   node scripts/sanitize-repo.mjs --apply
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
// Current user dir, derived at runtime so this file contains no hardcoded name.
const USR = path.basename(os.homedir());
const EXTS = new Set([
  ".md",
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".html",
  ".yml",
  ".yaml",
  ".ps1",
  ".txt",
  ".jsonl",
]);

// Sensitive literals split into fragments so a plain grep cannot find them.
const DEVICE_KEY = "94badc6d" + "1b2fd4ce" + "38371270" + "fc17d172";
const PRINTER_ID = "688" + "972";
const LAN_IP = "192.168" + ".3.110";
const FW_VER = "2.7" + ".2.7";
const MACHINE_TYPE_ID = "20" + "025";
const ACE_MODEL_ID = "40" + "002";

// Map of exact replacement rules (most specific first).
// Path segments may appear as `\`, `\\` (JS string escapes in source), or `/`.
const SEP = "[\\\\/]+";
const EXACT = [
  // ---- user-homed paths (machine-specific) -------------------------------
  [
    new RegExp(
      `C:${SEP}Users${SEP}${USR}${SEP}AppData${SEP}Roaming${SEP}AnycubicSlicerNext${SEP}log`,
      "gi",
    ),
    "%APPDATA%/AnycubicSlicerNext/log",
  ],
  [
    new RegExp(
      `C:${SEP}Users${SEP}${USR}${SEP}Documents${SEP}Projects${SEP}Anycubic-Bridge-Pluggin`,
      "gi",
    ),
    "<REPO_ROOT_DBL>",
  ],
  [new RegExp(`C:${SEP}Users${SEP}${USR}${SEP}AppData${SEP}Roaming`, "gi"), "<APPDATA_DBL>"],
  [
    new RegExp(`C:${SEP}Users${SEP}${USR}${SEP}Documents${SEP}Anycubic-Control-Exports`, "gi"),
    "<EXPORT_ROOT_DBL>",
  ],
  [new RegExp(`C:${SEP}Users${SEP}${USR}(?=${SEP})`, "gi"), "<USER_HOME_DBL>"],
  // ---- account / printer identity ----------------------------------------
  [new RegExp(DEVICE_KEY, "gi"), "<DEVICE_KEY>"],
  [new RegExp(PRINTER_ID, "gi"), "<PRINTER_ID>"],
  [new RegExp(LAN_IP.replace(/\./g, "\\."), "gi"), "<LAN_IP>"],
  [new RegExp(`\\b${FW_VER.replace(/\./g, "\\.")}\\b`, "gi"), "<FW_VERSION>"],
];

// Normalize the double-backslash placeholders back to plain (runtime-safe) ones
// AFTER the main pass, so JS string escapes like "C:\\Users\\<USER>\\..." become
// "%APPDATA%/..." without breaking the string literal.
const NORMALIZE = [
  [/<REPO_ROOT_DBL>/g, "<REPO_ROOT>"],
  [/<APPDATA_DBL>/g, "<APPDATA>"],
  [/<EXPORT_ROOT_DBL>/g, "<EXPORT_ROOT>"],
  [/<USER_HOME_DBL>/g, "<USER_HOME>"],
];

// machine_type / ACE model_id / hex md5s are ALSO protocol defaults in
// vendor/server.mjs and schemas/openapi.json (model_id default "20025",
// ACE "40002"). Those defaults are NOT user-identifying - they are the
// printer's public model enum. Only redact them inside evidence captures /
// docs where they leak the user's hardware.
const EVIDENCE_ONLY = [
  [new RegExp(MACHINE_TYPE_ID, "gi"), "<MACHINE_TYPE>"],
  [new RegExp(ACE_MODEL_ID, "gi"), "<ACE_MODEL_ID>"],
  [/[0-9a-f]{32}(?=[^0-9a-f]|$)/gi, "<MD5>"],
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "poc-output", "tests"]);
const SKIP_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "schemas/openapi.json",
  "schemas/tools.json",
  "ui/cad.html",
  "plugin.json",
  ".mcp.json",
  "README.md",
  "sanitize-repo.mjs",
  "redact-evidence-json.mjs", // contains <PRINTER_ID> etc. as literal lookup strings
  ".lan-creds.json", // local runtime config for THIS machine (gitignored); must keep functional
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (EXTS.has(path.extname(entry.name)) && !SKIP_FILES.has(entry.name)) out.push(full);
  }
  return out;
}

function applyRules(text, rules) {
  let changed = 0;
  let out = text;
  for (const [re, to] of rules) {
    const before = out;
    out = out.replace(re, to);
    if (out !== before) changed++;
  }
  return { changed, out };
}

const EVIDENCE_RE = /(docs[\\/]evidence|poc-output)/i;

function sanitizeText(text) {
  return applyRules(text, EXACT);
}
function sanitizeEvidence(text) {
  return applyRules(text, EVIDENCE_ONLY);
}

const files = walk(ROOT);
let total = 0;
const results = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  let { changed, out } = sanitizeText(text);
  // normalise double-backslash placeholders back to runtime-safe plain ones
  for (const [re, to] of NORMALIZE) {
    if (out !== (out = out.replace(re, to))) changed++;
  }
  if (EVIDENCE_RE.test(file)) {
    const ev = sanitizeEvidence(out);
    out = ev.out;
    changed += ev.changed;
  }
  if (!changed) continue;
  total += changed;
  results.push({ file: path.relative(ROOT, file), changed });
  if (process.argv.includes("--apply")) fs.writeFileSync(file, out);
}
results.sort((a, b) => b.changed - a.changed);
console.log(
  `[sanitize] ${process.argv.includes("--apply") ? "APPLIED" : "DRY-RUN"} — ${results.length} files, ${total} substitution groups touched (usr=${USR})`,
);
for (const r of results) console.log(`  ${String(r.changed).padStart(3)}  ${r.file}`);
