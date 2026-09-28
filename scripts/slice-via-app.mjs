// Slice via app GUI (the firmware-compatible path): launches the slicer UI,
// loads the model, clicks Slice all + Export G-code via UIA allowlist, then
// validates the exported 3MF structure. Uses the MCP server tools.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(pluginRoot, "poc-output");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginRoot, "dist", "server.mjs")],
  env: { ...getDefaultEnvironment(), ANYCUBIC_CONTROL_OUTPUT_ROOT: outputRoot },
  stderr: "inherit",
});
const client = new Client({ name: "anycubic-slice-app", version: "0.1.0" });

async function structured(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent;
}

try {
  await client.connect(transport);
  console.log("[mcp] connected");

  const stl = path.join(pluginRoot, "tests", "fixtures", "cube-20mm.stl");
  console.log("[slice_via_app] starting GUI orchestration for", stl);
  const res = await structured("slice_via_app", {
    input_path: stl,
  });
  console.log("[slice_via_app] result:", JSON.stringify(res, null, 2).slice(0, 2000));
} catch (e) {
  console.error("[error]", e.message.slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
