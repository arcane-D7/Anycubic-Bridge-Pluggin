#!/usr/bin/env node
/**
 * check-architecture.mjs — SOLID/DRY architecture gate (Sprint 5, S5-004).
 *
 * Rules enforced on the NEW workspace (apps/editor + crates) plus the
 * preserved root where applicable:
 *
 *  1. No UI-layer file may import a DB/keystore module directly
 *     (DIP: broker owns secrets; dependency direction UI -> broker only).
 *  2. MCP tool adapters must not duplicate shared zod schemas — they must
 *     import from the shared schema registry. If a `register*Tools` file
 *     contains an inline zod schema block instead of an import, it is a
 *     DRY violation and the check fails.
 *  3. No tool layer may touch secrets: `process.env.ANYCUBIC_*` (or the
 *     keystore module) may only appear inside broker/keystore modules.
 *  4. Banned copy-paste marker: `// DESIGN: duplicated on purpose` is
 *     banned by default (S5-004) anywhere in the workspace.
 *  5. (S6-005) `ui/cad.html` is FROZEN during the migration: its SHA-256
 *     must equal the recorded baseline and no new `/api/<action>` authoring
 *     path may be introduced (read-only surface only). Retired at cutover
 *     (R5+). Bump the baseline deliberately (with a new ticket) when the
 *     freeze is lifted.
 *
 * The preserved root (scripts/, vendor/, schemas/, tests/) is exempt
 * EXCEPT for rule 4 (the marker is banned everywhere).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKSPACE_DIRS = ["apps/editor/src", "crates"];
const PRESERVED_DIRS = ["scripts", "vendor", "schemas", "tests", "tools"];
// This checker itself contains the banned marker string in its rule text, so
// exclude it (and its siblings under scripts/) from the self-scan.
const SELF_EXCLUDED = new Set(["scripts/check-architecture.mjs"]);

// Rule 5 — frozen legacy UI. Baseline SHA-256 of ui/cad.html at the moment the
// freeze landed (S6-005). Any content change fails the gate. RECORDED so the
// message tells the developer exactly what to do when the freeze is lifted.
const FROZEN_UI = {
  file: "ui/cad.html",
  label: "legacy CAD workspace (ui/cad.html)",
  baselineSha256: "dfe0ce838d4549ae6fb66b5ec85a94c228b23e1192d4984b66b875babc2db1a9",
  note: "frozen read-only during migration (S6-005); retired at cutover (R5+)",
};

// The exact set of API actions the frozen ui/cad.html is allowed to drive.
// Anything else (new /api/<action>, new api("name") calls) is an authoring
// path that must NOT be re-added to the legacy UI.
const FROZEN_UI_ACTIONS = new Set([
  "objects",
  "remove",
  "add",
  "transform",
  "arrange",
  "boolean",
  "import",
  "parametric",
  "ai_prompt",
  "clear",
  "mesh_edit",
  "mesh_sub_delete",
  "mesh_bridge",
  "mesh_add_edge",
  "mesh_fill",
  "mesh_update",
  "select_faces",
  "texture",
  "heightmap",
  "image_to_heightfield",
  "export",
]);

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry === "target") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|rs)$/.test(entry)) out.push(full);
  }
  return out;
}

const failures = [];

function checkFile(file, isWorkspace) {
  const rel = relative(root, file).replace(/\\/g, "/");
  if (SELF_EXCLUDED.has(rel)) return;
  const src = readFileSync(file, "utf8");

  // Rule 4 — banned marker everywhere.
  if (src.includes("// DESIGN: duplicated on purpose")) {
    failures.push(`${rel}: banned duplicate-on-purpose marker (S5-004 DRY rule)`);
  }

  if (!isWorkspace) return;

  const f = rel;

  // Rule 1 — UI must not import DB/keystore directly.
  if (
    f.startsWith("apps/editor/src/ui") &&
    /from\s+["'][^"']*(keystore|db|database|storage)["']/i.test(src)
  ) {
    failures.push(`${rel}: UI layer imports a DB/keystore module directly (DIP violation)`);
  }

  // Rule 2 — tool adapters share schemas (no inline zod blocks in register files).
  if (/(register\w*Tools|registerTools)/.test(f) && /zod\.(object|string|number)\(/.test(src)) {
    const hasSharedImport = /import\s+.*[\s{](schema|schemas|z)\s*}/.test(src);
    if (!hasSharedImport) {
      failures.push(
        `${rel}: register*Tools file contains an inline zod schema block instead of importing the shared schema (DRY violation)`,
      );
    }
  }

  // Rule 3 — secrets only in broker/keystore modules.
  const isSecretOwner = /(broker|keystore)/i.test(f);
  if (!isSecretOwner && /process\.env\.ANYCUBIC_[A-Z_]+/.test(src)) {
    failures.push(`${rel}: secret env access outside broker/keystore layer (DIP violation)`);
  }
}

for (const d of WORKSPACE_DIRS) {
  for (const file of walk(join(root, d))) checkFile(file, true);
}
for (const d of PRESERVED_DIRS) {
  for (const file of walk(join(root, d))) checkFile(file, false);
}

// Rule 5 — frozen legacy UI (S6-005). ui/cad.html is a fixed read-only asset
// during the migration: hash must match the baseline and only the recorded
// action set may be referenced.
{
  const frozenPath = join(root, FROZEN_UI.file);
  if (!existsSync(frozenPath)) {
    failures.push(`[S6-005] ${FROZEN_UI.file} missing — cannot verify freeze`);
  } else {
    const src = readFileSync(frozenPath, "utf8");
    const actual = sha256(src);
    if (actual !== FROZEN_UI.baselineSha256) {
      failures.push(
        `[S6-005] ${FROZEN_UI.label} changed (sha256 ${actual}) — ${FROZEN_UI.note}. ` +
          "If the freeze is deliberately lifted, record the new hash in " +
          "FROZEN_UI.baselineSha256 with a new ticket.",
      );
    }
    // A new /api/<action> or api("action") reference not in the frozen set is
    // an authoring path being re-added — fail.
    const actions = new Set();
    const reApiCall = /\bapi\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g;
    const reFetchApi = /\/api\/([a-zA-Z_][a-zA-Z0-9_]*)/g;
    for (const matches of [src.matchAll(reApiCall), src.matchAll(reFetchApi)]) {
      for (const m of matches) actions.add(m[1]);
    }
    for (const action of actions) {
      if (!FROZEN_UI_ACTIONS.has(action)) {
        failures.push(
          `[S6-005] ${FROZEN_UI.label} drives new API action "${action}" — ${FROZEN_UI.note}.`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error("[check-architecture] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[check-architecture] OK — no SOLID/DRY violations.");
