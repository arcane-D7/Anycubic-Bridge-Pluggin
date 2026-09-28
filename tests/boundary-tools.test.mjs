// Boundary test — Sprint 5, S5-002.
// Asserts the preserved MCP contract (schemas/tools.json) remains a superset
// of the tool list the running server must expose (smoke.mjs expected list),
// so a breaking rename in the preserved root fails CI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(resolve(root, "schemas/tools.json"), "utf8"));
const catalogNames = catalog.tools.map((t) => t.name);

// Smoke expected list is parsed from smoke.mjs itself (source of truth lives
// in the preserved scripts boundary; this test must not fork it).
const smoke = readFileSync(resolve(root, "scripts/smoke.mjs"), "utf8");
const quoted = [...smoke.matchAll(/"([a-z][a-z0-9_]+)"/g)].map((m) => m[1]);
const uniqueQuoted = [...new Set(quoted)];
// Tool-looking identifiers only (at least two underscores = tool name pattern).
const smokeToolish = uniqueQuoted.filter((n) => (n.match(/_/g) || []).length >= 2);

assert.ok(
  Array.isArray(catalog.tools) && catalog.tools.length >= 79,
  `expected >= 79 tools in tools.json, got ${catalog.tools.length}`,
);

const missing = smokeToolish.filter((n) => !catalogNames.includes(n));
assert.deepEqual(
  missing,
  [],
  `tools.json is missing smoke-listed tool names — preserved boundary broken: ${missing.join(", ")}`,
);

// Every catalog tool must carry a parseable inputSchema.
for (const t of catalog.tools) {
  assert.ok(t.inputSchema && typeof t.inputSchema === "object", `${t.name} missing inputSchema`);
}

console.log(
  `boundary: OK — tools.json superset-compatible with smoke list (${catalogNames.length} tools)`,
);
