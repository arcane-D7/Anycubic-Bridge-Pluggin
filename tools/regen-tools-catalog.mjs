// One-shot: regenerate schemas/tools.json from the live MCP server (source of truth).
// Run: node tools/regen-tools-catalog.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  stderr: "pipe",
  args: [path.join(root, "dist", "server.mjs")],
});
const client = new Client({ name: "catalog-regen", version: "0.1.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const out = tools
    .map((x) => ({
      name: x.name,
      readOnlyHint: Boolean(
        x.annotations?.readOnlyHint ?? x.annotations?.destructiveHint === false,
      ),
      inputSchema: x.inputSchema || { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(
    path.join(root, "schemas", "tools.json"),
    JSON.stringify({ tools: out }, null, 2) + "\n",
  );

  const smoke = fs.readFileSync(path.join(root, "scripts", "smoke.mjs"), "utf8");
  const quoted = [...smoke.matchAll(/"([a-z][a-z0-9_]+)"/g)].map((m) => m[1]);
  const smokeToolish = [...new Set(quoted)].filter((n) => (n.match(/_/g) || []).length >= 2);
  const names = out.map((t) => t.name);
  const missing = smokeToolish.filter((n) => !names.includes(n));
  console.log(`WRITTEN tools: ${out.length}`);
  console.log(`smoke-name-missing after regen: ${JSON.stringify(missing)}`);
  await client.close();
} finally {
  process.exit(0);
}
