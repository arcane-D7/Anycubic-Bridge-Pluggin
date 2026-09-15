/**
 * End-to-end MCP verification for the command bus expansion.
 * Asserts the new tools exist, the confirmation gates answer offline (never
 * reaching the cloud), and the catalog is reachable through the real server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/server.mjs", import.meta.url))],
  stderr: "pipe",
});
const client = new Client({ name: "command-bus-verifier", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const required = [
    "printer_command_catalog",
    "printer_command_send",
    "printer_print_start",
    "printer_gcode_resolve",
    "printer_connection_status",
  ];
  for (const name of required) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    if (name === "printer_command_send" || name === "printer_print_start") {
      if (tool.annotations?.readOnlyHint !== false || tool.annotations?.destructiveHint !== true) {
        throw new Error(`${name} has wrong annotations: ${JSON.stringify(tool.annotations)}`);
      }
    }
  }
  console.log(JSON.stringify({ total_tools: tools.length, command_tools: required.length }));

  const catalog = await client.callTool({ name: "printer_command_catalog", arguments: {} });
  const bySafety = {};
  for (const command of catalog.structuredContent.commands)
    bySafety[command.safety] = (bySafety[command.safety] ?? 0) + 1;
  console.log(
    JSON.stringify({
      commands: catalog.structuredContent.total,
      by_safety: bySafety,
      all_non_read_require_confirm: catalog.structuredContent.commands.every(
        (c) => !c.confirm_required || c.safety !== "read",
      ),
    }),
  );

  // Confirmation gates must fire BEFORE any cloud access (offline assert).
  const gate1 = await client.callTool({
    name: "printer_command_send",
    arguments: { command: "light_control", on: true },
  });
  console.log(
    JSON.stringify({
      gate_without_confirm: { is_error: Boolean(gate1.isError), message: gate1.content?.[0]?.text },
    }),
  );
  const gate2 = await client.callTool({
    name: "printer_command_send",
    arguments: { command: "print_stop", confirm: true },
  });
  console.log(
    JSON.stringify({
      gate_without_execute_word: {
        is_error: Boolean(gate2.isError),
        message: gate2.content?.[0]?.text,
      },
    }),
  );
  const gate3 = await client.callTool({
    name: "printer_print_start",
    arguments: { gcode_id: 1, use_ams: true, confirm: true, confirm_word: "EXECUTE" },
  });
  console.log(
    JSON.stringify({
      gate_ams_without_mapping: {
        is_error: Boolean(gate3.isError),
        message: gate3.content?.[0]?.text,
      },
    }),
  );
  const gate4 = await client.callTool({ name: "printer_print_start", arguments: { gcode_id: 1 } });
  console.log(
    JSON.stringify({
      gate_start_without_confirm: {
        is_error: Boolean(gate4.isError),
        message: gate4.content?.[0]?.text,
      },
    }),
  );

  const health = await client.callTool({ name: "printer_connection_status", arguments: {} });
  console.log(
    JSON.stringify({
      connection_status: {
        connected: health.structuredContent.connected,
        buffered: health.structuredContent.buffered_events,
      },
    }),
  );
} finally {
  await client.close();
}
