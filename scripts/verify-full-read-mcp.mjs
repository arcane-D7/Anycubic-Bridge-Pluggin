/**
 * End-to-end MCP verification for the full-read expansion.
 * Starts dist/server.mjs over stdio and asserts the new tools exist, answer
 * offline, and that the offline catalog is reachable through the real server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/server.mjs", import.meta.url))],
  stderr: "pipe",
});
const client = new Client({ name: "full-read-verifier", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const required = [
    "printer_read_all",
    "printer_property_catalog",
    "printer_hidden_command_map",
    "printer_property_reconcile",
  ];
  for (const name of required) {
    if (!tools.some((tool) => tool.name === name)) throw new Error(`tool not registered: ${name}`);
  }
  console.log(JSON.stringify({ total_tools: tools.length, full_read_tools: required.length }));

  const catalog = await client.callTool({ name: "printer_property_catalog", arguments: {} });
  const stats = catalog.structuredContent?.stats;
  console.log(
    JSON.stringify({
      catalog: {
        sources: stats.sources,
        mqtt_properties: stats.total_properties,
        http_endpoints: stats.http_endpoints_with_catalog,
        http_properties: stats.http_properties,
        grand_total: stats.grand_total_properties,
        commands: stats.commands,
      },
    }),
  );

  const map = await client.callTool({ name: "printer_hidden_command_map", arguments: {} });
  console.log(
    JSON.stringify({
      command_map: {
        executable: map.structuredContent.executable,
        commands: map.structuredContent.commands.length,
        by_safety: map.structuredContent.by_safety,
        by_evidence: map.structuredContent.by_evidence,
        unverified: map.structuredContent.unverified.length,
      },
    }),
  );

  const reconcile = await client.callTool({
    name: "printer_property_reconcile",
    arguments: {
      source: "multiColorBox",
      payload: { multi_color_box: [{ id: 0, slots: [{ index: 0, sku: "AHHSGY-107" }] }] },
    },
  });
  console.log(
    JSON.stringify({
      reconcile: {
        coverage_pct: reconcile.structuredContent.coverage_pct,
        missing: reconcile.structuredContent.missing.length,
        matched_sku: reconcile.structuredContent.matched.some(
          (m) => m.path === "multi_color_box[].slots[].sku",
        ),
      },
    }),
  );

  const readAllError = await client.callTool({
    name: "printer_read_all",
    arguments: { transport: "cloud" },
  });
  console.log(
    JSON.stringify({
      read_all_validation: {
        is_error: Boolean(readAllError.isError),
        message: readAllError.content?.[0]?.text,
      },
    }),
  );
} finally {
  await client.close();
}
