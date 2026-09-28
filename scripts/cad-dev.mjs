// Dev helper: start a standalone CAD workspace server for manual/browser testing.
// Reescrito contra o server MCP (o src/cad-server.js foi removido do build).
// Usage: node scripts/cad-dev.mjs [--open-browser false]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const openBrowser = args.includes("--open-browser")
  ? args[args.indexOf("--open-browser") + 1] !== "false"
  : true;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/server.mjs", import.meta.url))],
  stderr: "pipe",
});
const client = new Client({ name: "cad-dev", version: "0.1.0" });
await client.connect(transport);

try {
  const reply = await client.callTool({
    name: "cad_open_workspace",
    arguments: { open_browser: openBrowser },
  });
  const text = reply.structuredContent ?? JSON.parse(reply.content?.[0]?.text ?? "{}");
  console.log(JSON.stringify(text, null, 2));
  if (text?.url) console.log(`\nCAD workspace: ${text.url}`);
  console.log("A carregar… mantenha este processo vivo (Ctrl+C para parar).");
  await new Promise(() => {});
} finally {
  await client.close().catch(() => {});
}
