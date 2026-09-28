/**
 * rest-bridge.mjs — ponte REST local (token-gated) para as tools MCP.
 *
 * Fase 5 (REST/OpenAPI): permite a clients genéricos (n8n, Node-RED, HASS,
 * scripts curl) chamar as mesmas tools do servidor MCP via HTTP:
 *
 *   POST /tools/{tool_name}        body = argumentos JSON
 *   GET  /openapi.json             spec OpenAPI 3.0 gerada de schemas/tools.json
 *   GET  /health                   estado do bridge
 *
 * Autenticação: Bearer token. O token é o conteúdo de %LOCALAPPDATA%\
 * AnycubicSlicerNextControl\bridge-token (criado no start; se faltar, o bridge
 * gera um novo e mostra no terminal). Sempre em 127.0.0.1 (loopback).
 *
 * Uso: node scripts/rest-bridge.mjs [--port 8766] [--token <hex>]
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(pluginRoot, "dist", "server.mjs");
const TOOLS_JSON = path.join(pluginRoot, "schemas", "tools.json");

/** Mesma regra de auth-login.mjs: PLUGIN_DATA > %LOCALAPPDATA%\AnycubicSlicerNextControl > pluginRoot\AnycubicSlicerNextControl */
function dataRoot() {
  const local = process.env.LOCALAPPDATA;
  return (
    process.env.PLUGIN_DATA ??
    (local
      ? path.join(local, "AnycubicSlicerNextControl")
      : path.join(pluginRoot, "AnycubicSlicerNextControl"))
  );
}
const TOKEN_FILE = path.join(dataRoot(), "bridge-token");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadOrCreateToken() {
  try {
    const existing = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString("hex");
  await mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

/** Spawna o servidor MCP uma vez e reutiliza o client (uma identidade). */
function createMcpClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "mcp-rest-bridge", version: "1.0.0" });
  return { client, transport };
}

async function main() {
  const argv = process.argv.slice(2);
  let port = 8766;
  let tokenArg;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") port = Number(argv[i + 1]) || 8766;
    else if (argv[i] === "--token") tokenArg = argv[i + 1];
  }
  const token = tokenArg ?? (await loadOrCreateToken());
  const { client, transport } = createMcpClient();
  await client.connect(transport);

  const toolsJson = JSON.parse(await readFile(TOOLS_JSON, "utf8"));
  const knownTools = new Set((toolsJson.tools ?? []).map((t) => t.name));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/health") return send(200, { ok: true, tool_count: knownTools.size });
    if (url.pathname === "/openapi.json") {
      try {
        const spec = JSON.parse(
          await readFile(path.join(pluginRoot, "schemas", "openapi.json"), "utf8"),
        );
        return send(200, spec);
      } catch {
        return send(500, {
          error: "openapi.json not generated yet — run node scripts/generate-openapi.mjs",
        });
      }
    }

    const m = /^\/tools\/([A-Za-z0-9_]+)$/.exec(url.pathname ?? "");
    if (!m) return send(404, { error: "not found" });
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    if (!auth || sha256(auth) !== sha256(token))
      return send(401, { error: "invalid bearer token" });

    const toolName = m[1];
    if (!knownTools.has(toolName)) return send(404, { error: `unknown tool: ${toolName}` });

    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(400, { error: "invalid JSON body" });
    }

    try {
      const reply = await client.callTool({ name: toolName, arguments: body });
      if (reply.isError) return send(502, { error: reply.content?.[0]?.text ?? "tool error" });
      return send(200, reply.structuredContent ?? JSON.parse(reply.content?.[0]?.text ?? "{}"));
    } catch (error) {
      return send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`REST bridge em http://127.0.0.1:${port}`);
    console.log(`Token: ${token}`);
    console.log(
      `Exemplo: curl -X POST http://127.0.0.1:${port}/tools/inspect_slicer -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{}'`,
    );
  });

  const shutdown = async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => {
      if (Buffer.byteLength(Buffer.concat(chunks)) > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

main().catch((error) => {
  console.error("rest-bridge failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
