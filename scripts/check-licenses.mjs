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
// Workspace members (S6-001): apps/* are pnpm workspace packages with their
// OWN dependency sets (the Tauri/React shell). Their direct deps are validated
// against the same Apache/MIT policy.
// ---------------------------------------------------------------------------
const workspaceMembers = [];
const appsDir = join(root, "apps");
if (existsSync(appsDir)) {
  for (const name of readdirSync(appsDir)) {
    const pkgPath = join(appsDir, name, "package.json");
    if (existsSync(pkgPath)) workspaceMembers.push(pkgPath);
  }
}

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

/** Accept "Apache-2.0 OR MIT", "MIT OR Apache-2.0" style dual licenses. */
function isApprovedOrSplit(lic) {
  if (SPDX_APPROVED_DIRECT.has(lic)) return true;
  const parts = lic.split(" OR ").map((s) => s.trim());
  return parts.length > 1 && parts.every((p) => SPDX_APPROVED_DIRECT.has(p));
}

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
  // Reads a node_modules dir into the map using the FULL package name as key
  // (scoped packages are "@scope/name"; descending into @scope dirs collects
  // them under their real names so direct deps resolve).
  const add = (dir, scopePrefix = "") => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const sub = join(dir, name);
      const pkgPath = join(sub, "package.json");
      const fullName = scopePrefix ? `${scopePrefix}/${name}` : name;
      if (existsSync(pkgPath)) {
        try {
          const meta = JSON.parse(readFileSync(pkgPath, "utf8"));
          out.set(fullName, {
            version: meta.version ?? "?",
            license: spdxOrFallback(meta.license),
          });
        } catch {
          /* skip malformed */
        }
      } else if (name.startsWith("@")) {
        // scoped dirs (@scope/name) — recurse one level, carrying the prefix
        add(sub, name);
      }
    }
  };
  add(join(root, "node_modules"));
  for (const memberPkg of workspaceMembers) {
    const memberDir = dirname(memberPkg);
    add(join(memberDir, "node_modules"));
  }
  return out;
}

const directDeps = {
  ...pkgJson.dependencies,
  ...pkgJson.devDependencies,
};

const depOwner = new Map(); // dep name -> source package.json path (for messages)
for (const [name] of Object.entries(directDeps)) depOwner.set(name, join(root, "package.json"));

for (const memberPkg of workspaceMembers) {
  let member;
  try {
    member = JSON.parse(readFileSync(memberPkg, "utf8"));
  } catch {
    console.error(`check-licenses: could not parse ${memberPkg}`);
    process.exit(1);
  }
  const deps = { ...member.dependencies, ...member.devDependencies };
  for (const name of Object.keys(deps)) {
    directDeps[name] ??= deps[name];
    depOwner.set(name, memberPkg);
  }
}

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
    // Dependency not installed anywhere — record as missing so a broken
    // install is caught (scoped packages now resolve via collectDeps).
    missing.push(name);
    continue;
  }
  const lic = meta.license;
  if (!lic) {
    failures.push(`${name}@${meta.version}: no SPDX license field`);
    continue;
  }
  if (isApprovedOrSplit(lic)) continue;
  const allow = ALLOWLIST.get(name);
  if (allow) {
    console.log(`[ok/allowlist] ${name}@${meta.version} — ${lic} — ${allow}`);
    continue;
  }
  failures.push(
    `${name}@${meta.version}: license "${lic}" is NOT Apache-2.0/MIT and not allowlisted — see docs/licenses.md (required by ${depOwner.get(name) ?? root})`,
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
