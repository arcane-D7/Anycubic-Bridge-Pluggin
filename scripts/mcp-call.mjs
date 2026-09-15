/**
 * Generic MCP stdio driver: call a tool and print the structured result.
 * Usage: node scripts/mcp-call.mjs <tool_name> '<json-args>'
 * Sequential use only — the cloud broker allows one client per identity.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const [toolName, argsJson] = process.argv.slice(2);
if (!toolName) {
  console.error("usage: node scripts/mcp-call.mjs <tool> [json-args]");
  process.exit(2);
}
let args = {};
if (argsJson) {
  try {
    args = JSON.parse(argsJson);
  } catch (e) {
    console.error(`bad json: ${e.message}`);
    process.exit(2);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./mcp-entry.mjs", import.meta.url))],
  stderr: "pipe",
});
const client = new Client({ name: "mcp-call", version: "1.0.0" });
try {
  await client.connect(transport);
  const reply = await client.callTool({ name: toolName, arguments: args });
  if (reply.isError) {
    console.error("TOOL_ERROR:", reply.content?.[0]?.text);
    process.exit(1);
  }
  console.log(JSON.stringify(reply.structuredContent ?? reply.content?.[0]?.text, null, 1));
} finally {
  await client.close().catch(() => {});
}
