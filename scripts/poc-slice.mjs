import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptsDir, "..");
const shouldRun = process.argv.includes("--run");
const outputRoot = path.join(pluginRoot, "poc-output");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginRoot, "dist", "server.mjs")],
  env: {
    ...getDefaultEnvironment(),
    ANYCUBIC_CONTROL_OUTPUT_ROOT: outputRoot,
  },
  stderr: "inherit",
});
const client = new Client({ name: "anycubic-control-poc", version: "0.1.0" });

async function structured(name, arguments_) {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  assert.ok(result.structuredContent, `${name} did not return structuredContent`);
  return result.structuredContent;
}

async function firstProfile(kind, query) {
  const result = await structured("list_slicer_profiles", { kind, query, limit: 10 });
  assert.ok(Array.isArray(result.profiles) && result.profiles.length > 0, `No ${kind} profile matched '${query}'`);
  return result.profiles[0].path;
}

try {
  await client.connect(transport);
  const machine = await firstProfile("machine", "Anycubic Kobra S1 0.4 nozzle");
  const processProfile = await firstProfile("process", "0.20mm High Quality @Anycubic Kobra S1 0.4 nozzle");
  const filament = await firstProfile("filament", "Anycubic PLA @Anycubic Kobra S1 0.4 nozzle");
  const prepared = await structured("prepare_slice_job", {
    input_path: path.join(pluginRoot, "tests", "fixtures", "cube-20mm.stl"),
    machine_profile: machine,
    process_profile: processProfile,
    filament_profiles: [filament],
    output_format: "both",
    settings: {
      layer_height_mm: 0.2,
      infill_density_percent: 15,
      wall_loops: 3,
      supports: false,
      infill_pattern: "gyroid",
    },
  });
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
  if (shouldRun) {
    const completed = await structured("run_slice_job", { job_id: prepared.job_id, confirmation: "RUN" });
    process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
  } else {
    process.stdout.write("Dry run only. Pass --run to execute this generated cube job.\n");
  }
} finally {
  await client.close();
}
