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
 *
 * The preserved root (scripts/, vendor/, schemas/, tests/) is exempt
 * EXCEPT for rule 4 (the marker is banned everywhere).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKSPACE_DIRS = ["apps/editor/src", "crates"];
const PRESERVED_DIRS = ["scripts", "vendor", "schemas", "tests", "tools"];
// This checker itself contains the banned marker string in its rule text, so
// exclude it (and its siblings under scripts/) from the self-scan.
const SELF_EXCLUDED = new Set(["scripts/check-architecture.mjs"]);

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

if (failures.length) {
  console.error("[check-architecture] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[check-architecture] OK — no SOLID/DRY violations.");
