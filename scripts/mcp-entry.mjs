#!/usr/bin/env node
/**
 * mcp-entry.mjs — machine-agnostic MCP server entry point.
 *
 * Why this exists:
 *   - `.mcp.json` cannot rely on `${workspaceFolder}` expansion: some MCP
 *     clients (VS Code, Claude Desktop, Codex, Cursor, ...) expand the token
 *     differently or not at all, so `node ${workspaceFolder}/dist/server.mjs`
 *     breaks with MODULE_NOT_FOUND like `...\${workspaceFolder}\dist\server.mjs`.
 *   - This entry resolves `dist/server.mjs` relative to THIS file, so it works
 *     from any cwd, any machine, with zero configuration.
 *   - If `dist/server.mjs` is missing (fresh clone after `pnpm install`), it
 *     auto-builds it from `vendor/server.mjs` via `scripts/build.mjs`.
 *
 * Usage (any MCP client):
 *   command: node
 *   args:    ["<abspath>/scripts/mcp-entry.mjs"]
 *   cwd:     optional — not required thanks to relative resolution.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 1. Resolve the built bundle relative to this entry (never cwd-dependent).
const serverPath = path.join(ROOT, "dist", "server.mjs");

// 2. Auto-build if the bundle is not present yet (idempotent build.mjs).
if (!existsSync(serverPath)) {
  const buildScript = path.join(ROOT, "scripts", "build.mjs");
  const r = spawnSync(process.execPath, [buildScript], { stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write(
      `[mcp-entry] build failed (exit ${r.status}); cannot start server at ${serverPath}\n`,
    );
    process.exit(r.status ?? 1);
  }
  if (!existsSync(serverPath)) {
    process.stderr.write(`[mcp-entry] build ok but ${serverPath} still missing\n`);
    process.exit(1);
  }
}

// 3. Delegate to the real server (replaces the current process so stdio MCP
//    transport stays intact). On Windows the ESM loader requires a file:// URL.
process.argv[1] = serverPath;
try {
  await import(pathToFileURL(serverPath).href);
} catch (err) {
  process.stderr.write(`[mcp-entry] failed to load ${serverPath}: ${err.stack ?? err}\n`);
  process.exit(1);
}
