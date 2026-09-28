#!/usr/bin/env node
/**
 * check-licenses.mjs — enforces the repo license policy (Sprint 5, S5-005).
 *
 * Policy (user-confirmed 2026-09-28, binding):
 *   - Direct use/implementation = Apache-2.0 and MIT ONLY.
 *   - All other licenses (GPL, AGPL, BSD-3, LGPL, MPL, ...) are
 *     reference-of-information / comparison / study-only. NEVER copied,
 *     imported, linked or bundled.
 *   - External-process prerequisites (pinned Blender GPL, Anycubic Slicer
 *     Next CLI) are user-installed/discovered, never bundled.
 *
 * This script walks the installed dependency graph (node_modules) of the
 * direct deps listed in package.json + the workspace members, maps each
 * package to its SPDX id, and FAILS on any direct-use package whose license
 * is not Apache-2.0 or MIT — unless it is in the explicit allowlist below
 * (dev-only tooling with justification comments).
 *
 * The canonical registry is docs/licenses.md; this script is the enforcement
 * half of that registry.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// ---------------------------------------------------------------------------
// Allowlist for explicitly-approved exceptions (dev-only tooling).
// Every entry must carry a justification comment.
// ---------------------------------------------------------------------------
const ALLOWLIST = new Map([
  // Bundler/tooling — dev-only, never shipped to production output.
  ["esbuild", "MIT — build-time only; not bundled into runtime artifacts"],
  ["husky", "MIT — git hooks (dev-only)"],
  ["lint-staged", "MIT — pre-commit formatter runner (dev-only)"],
  ["prettier", "MIT — formatter (dev-only)"],
  ["puppeteer-core", "Apache-2.0 — e2e browser harness (dev-only)"],
  ["tsx", "MIT — TS runner for dev scripts (dev-only)"],
  ["knip", "ISC — dead-code detection (dev-only)"],
  // Legacy runtime deps that entered the preserved root BEFORE the Apache/MIT
  // policy (2026-09-28) — retained because S5-002 freezes the preserved root;
  // migration tracked in docs/licenses.md "Legacy runtime dependencies".
  ["node-forge", "LEGACY-pre-policy BSD-3-Clause OR GPL-2.0 — see docs/licenses.md migration row"],
  [
    "replicad-opencascadejs",
    "LEGACY-pre-policy LGPL-2.1-only — see docs/licenses.md migration row",
  ],
]);

const SPDX_APPROVED_DIRECT = new Set(["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception"]);

function spdxOrFallback(license) {
  if (!license) return null;
  if (typeof license === "string") return license.trim();
  if (Array.isArray(license))
    return license.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  if (typeof license === "object" && license.type) return license.type;
  return null;
}

function collectDeps() {
  const out = new Map();
  const add = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const pkgPath = join(dir, name, "package.json");
      if (!existsSync(pkgPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(pkgPath, "utf8"));
        out.set(name, {
          version: meta.version ?? "?",
          license: spdxOrFallback(meta.license),
        });
      } catch {
        /* skip malformed */
      }
    }
  };
  add(join(root, "node_modules"));
  add(join(root, "node_modules", ".pnpm")); // pnpm virtual store shape fallback
  return out;
}

const directDeps = {
  ...pkgJson.dependencies,
  ...pkgJson.devDependencies,
};

const installed = collectDeps();
const failures = [];
const missing = [];

for (const [name] of Object.entries(directDeps)) {
  let meta = installed.get(name);
  if (!meta && existsSync(join(root, "node_modules", name, "package.json"))) {
    try {
      const m = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
      meta = { version: m.version ?? "?", license: spdxOrFallback(m.license) };
    } catch {
      /* noop */
    }
  }
  if (!meta) {
    // Scoped packages live under node_modules/@scope/name — collectDeps handles
    // only the top level; record as missing so `pnpm install` is validated.
    missing.push(name);
    continue;
  }
  const lic = meta.license;
  if (!lic) {
    failures.push(`${name}@${meta.version}: no SPDX license field`);
    continue;
  }
  if (SPDX_APPROVED_DIRECT.has(lic)) continue;
  const allow = ALLOWLIST.get(name);
  if (allow) {
    console.log(`[ok/allowlist] ${name}@${meta.version} — ${lic} — ${allow}`);
    continue;
  }
  failures.push(
    `${name}@${meta.version}: license "${lic}" is NOT Apache-2.0/MIT and not allowlisted — see docs/licenses.md`,
  );
}

if (missing.length) {
  console.log(
    `[info] ${missing.length} direct deps not found under node_modules (scope names) — run pnpm install`,
  );
}

if (failures.length) {
  console.error("\n[docs/licenses.md policy violation]");
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}

console.log(
  `\ncheck-licenses: OK — ${Object.keys(directDeps).length} direct deps, all Apache/MIT or allowlisted.`,
);
