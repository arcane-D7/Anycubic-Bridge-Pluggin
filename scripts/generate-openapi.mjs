/**
 * generate-openapi.mjs — gera um OpenAPI 3.0 estático a partir de schemas/tools.json.
 *
 * Fase 5 do roadmap (REST/OpenAPI): cada MCP tool torna-se uma operação HTTP:
 *   POST /tools/{tool_name}   (body = inputSchema)  -> outputSchema/resultado
 *   GET  /openapi.json        (spec estático)
 * O ficheiro gerado (schemas/openapi.json) alimenta clients genéricos
 * (HASS/Node-RED/n8n/Postman) e o rest-bridge.mjs serve-o token-gated.
 *
 * Uso: node scripts/generate-openapi.mjs [caminho-do-tools.json] [saída]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function toOperationId(toolName) {
  return toolName.replace(/[^a-zA-Z0-9]+/g, "_");
}

function zodToJsonSchema(prop) {
  // properties já vêm em formato JSON Schema no tools.json (resultado de z).toJSON()).
  return prop ?? { type: "object" };
}

export function buildOpenApiSpec(tools, { title = "Anycubic Slicer Next Control bridge", version = "0.1.0" } = {}) {
  const paths = {};
  const schemas = {};

  for (const tool of tools ?? []) {
    const name = tool?.name;
    if (!name) continue;
    const opId = toOperationId(name);
    const inputSchema = tool.inputSchema ?? { type: "object" };
    const outputSchema = tool.outputSchema ?? { type: "object" };
    const readOnly = tool.readOnlyHint === true;

    const bodySchemaName = `${opId}Request`;
    schemas[bodySchemaName] = zodToJsonSchema(inputSchema);
    schemas[`${opId}Response`] = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        ...(outputSchema.properties ?? {}),
        error: { type: "string" },
      },
    };

    paths[`/tools/${name}`] = {
      post: {
        operationId: opId,
        summary: `${readOnly ? "R" : "W"}: ${name}`,
        description:
          (tool?.description ?? "") + (readOnly ? "\n\nREAD-ONLY." : "\n\nMay WRITE device state; requires a confirm argument where documented."),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${bodySchemaName}` } } },
        },
        responses: {
          "200": {
            description: "Tool result",
            content: { "application/json": { schema: { $ref: `#/components/schemas/${opId}Response` } } },
          },
          "401": { description: "Missing/invalid bearer token" },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: { title, version, description: "Auto-generated from schemas/tools.json (MCP tool surface)." },
    servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "8766" } } }],
    tags: [{ name: "tools", description: "MCP tools exposed over HTTP" }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "mcp-token" } },
      schemas,
    },
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const toolsPath = path.resolve(positional[0] ?? path.join(pluginRoot, "schemas", "tools.json"));
  const outPath = path.resolve(positional[1] ?? path.join(pluginRoot, "schemas", "openapi.json"));
  const raw = JSON.parse(await readFile(toolsPath, "utf8"));
  const tools = raw.tools ?? [];
  if (process.argv.includes("--live")) {
    // Fonte da verdade: lista as tools reais do dist (MCP) e funde os schemas
    // estáticos do tools.json quando disponíveis (inputs ricos).
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(pluginRoot, "dist", "server.mjs")],
      stderr: "pipe",
    });
    const client = new Client({ name: "openapi-live", version: "1.0.0" });
    await client.connect(transport);
    const listed = (await client.listTools()).tools;
    const staticByName = new Map(tools.map((t) => [t.name, t]));
    const merged = listed.map((tool) => ({
      name: tool.name,
      description: tool.description ?? staticByName.get(tool.name)?.description,
      inputSchema: tool.inputSchema ?? staticByName.get(tool.name)?.inputSchema ?? { type: "object" },
      outputSchema: tool.outputSchema ?? staticByName.get(tool.name)?.outputSchema ?? { type: "object" },
      readOnlyHint: tool.annotations?.readOnlyHint ?? staticByName.get(tool.name)?.readOnlyHint,
    }));
    await client.close();
    const spec = buildOpenApiSpec(merged, raw);
    await writeFile(outPath, JSON.stringify(spec, null, 2));
    console.log(
      `openapi.json gerado (LIVE): ${Object.keys(spec.paths).length} operations, ${Object.keys(spec.components.schemas).length} schemas -> ${outPath}`,
    );
  } else {
    const spec = buildOpenApiSpec(tools, raw);
    await writeFile(outPath, JSON.stringify(spec, null, 2));
    console.log(
      `openapi.json gerado: ${Object.keys(spec.paths).length} operations, ${Object.keys(spec.components.schemas).length} schemas -> ${outPath}`,
    );
  }
}
