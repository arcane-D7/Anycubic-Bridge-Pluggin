#!/usr/bin/env node
/**
 * cloud-bridge.mjs — S9.13-001 loopback HTTP bridge to the Anycubic CLOUD
 * printer tools of the preserved MCP server.
 *
 * WHY: the editor currently discovers printers ONLY via LAN
 * (`ANYCUBIC_PRINTER_IPS` + port probe). The preserved MCP server owns the
 * full cloud stack (`account_login`, `account_devices`,
 * `account_cloud_diagnostics`, …) but exposes it over stdio only. This
 * bridge gives the webview a CLOUD lane on a fixed loopback port with the
 * same egress posture as the Rust broker loopback (S9.6-008):
 *
 *   POST /printer/cloud/login     → account_login { region?, timeout_ms? }
 *   GET  /printer/cloud/devices   → account_devices → normalized { id, key,
 *                                  machineType, name?, model?, online }
 *   GET  /printer/cloud/snapshot  → account_cloud_diagnostics
 *                                  ?printerId=&kind=&region= (read-only)
 *   GET  /health                  → { ok, state }
 *
 * SECURITY MODEL (mirrors broker-server/loopback-bridge):
 *   - Binds 127.0.0.1 ONLY (loopback). No external exposure.
 *   - Origin allow-list: dev `http://127.0.0.1:1420` + prod `tauri://localhost`
 *     (same CORS allow-list as crates/broker-server). Unknown Origin → 403,
 *     exactly like `chat_handler`.
 *   - The MCP child holds the JWT (DPAPI TokenStore) — the webview NEVER sees
 *     a token. Only `account_login` (takes the stored cloud token, not a raw
 *     secret from the request) + read-only diagnostics are exposed; there is
 *     NO write path (no `account_print` / `printer_command_send`).
 *   - The MCP child is spawned via `scripts/mcp-entry.mjs` (resolves
 *     dist/server.mjs itself, auto-builds on a fresh clone) through the
 *     official SDK client — exactly like `scripts/loopback-bridge.mjs`.
 *
 * USAGE:
 *   node scripts/cloud-bridge.mjs [--port 18182] [--timeout 30000]
 *
 * Env (AGENTS.md §4, agnostic — every value per-machine flows via env):
 *   ANYCUBIC_CLOUD_LOOPBACK_PORT  (default 18182)
 *   ANYCUBIC_CLOUD_REGION         (default "en")
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpEntry = path.join(root, "scripts", "mcp-entry.mjs");

export const CLOUD_BRIDGE_DEFAULT_PORT = 18182;
export const ALLOWED_ORIGIN_DEV = "http://127.0.0.1:1420";
export const ALLOWED_ORIGIN_PROD = "tauri://localhost";

const STATE = Object.freeze({
  STARTING: "starting",
  READY: "ready",
  UNAVAILABLE: "unavailable",
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) have no Origin — allowed.
  return origin === ALLOWED_ORIGIN_DEV || origin === ALLOWED_ORIGIN_PROD;
}

function tryParseText(result) {
  if (!result || !Array.isArray(result.content)) return null;
  for (const part of result.content) {
    if (part && part.type === "text") {
      try {
        return JSON.parse(part.text);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the cloud bridge.
 *
 * @param {object} [options]
 * @param {number} [options.port] loopback port (default 18182; 0 = ephemeral).
 * @param {number} [options.timeoutMs] MCP call timeout (default 30000).
 * @returns {Promise<object>} handle { url, port, state, isReady, close() }
 */
export async function startCloudBridge(options = {}) {
  const port = options.port ?? CLOUD_BRIDGE_DEFAULT_PORT;
  const timeoutMs = options.timeoutMs ?? 30_000;

  // 1. Spawn the preserved MCP server (resolves dist/server.mjs itself).
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    stderr: "pipe",
    cwd: root,
  });
  const client = new Client({ name: "cloud-bridge", version: "0.1.0" });

  // 2. HTTP server — loopback only, Origin allow-list (CORS parity).
  let unavailable = false;
  const server = createServer(async (req, res) => {
    if (!originAllowed(req)) {
      json(res, 403, { ok: false, error: "origin not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      // Preflight for the webview fetch.
      res.writeHead(204, {
        "Access-Control-Allow-Origin": req.headers.origin ?? ALLOWED_ORIGIN_DEV,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "7200",
      });
      res.end();
      return;
    }

    if (pathname === "/health") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
      return json(res, 200, {
        ok: !unavailable,
        state: unavailable ? STATE.UNAVAILABLE : STATE.READY,
      });
    }

    if (pathname === "/printer/cloud/login") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      if (unavailable) return json(res, 502, { ok: false, error: "mcp server not running" });
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw) body = JSON.parse(raw);
      } catch {
        return json(res, 400, { ok: false, error: "invalid JSON body" });
      }
      try {
        const reply = await client.callTool({ name: "account_login", arguments: body }, undefined, {
          timeout: timeoutMs,
        });
        if (reply.isError) return json(res, 502, { ok: false, error: structuredText(reply) });
        const data = reply.structuredContent ?? tryParseText(reply) ?? {};
        // Never return a token to the webview — only non-secret fields.
        const { token: _t, ...safe } = data;
        return json(res, 200, { ...safe, ok: data.ok !== false });
      } catch (error) {
        unavailable = true;
        return json(res, 502, { ok: false, error: String(error.message ?? error).slice(0, 200) });
      }
    }

    if (pathname === "/printer/cloud/devices") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
      if (unavailable) return json(res, 502, { ok: false, error: "mcp server not running" });
      const region = url.searchParams.get("region") ?? process.env.ANYCUBIC_CLOUD_REGION ?? "en";
      try {
        const reply = await client.callTool(
          {
            name: "account_devices",
            arguments: { region, device_status: true, timeout_ms: 15_000 },
          },
          undefined,
          { timeout: timeoutMs },
        );
        if (reply.isError) return json(res, 502, { ok: false, error: structuredText(reply) });
        const data = reply.structuredContent ?? tryParseText(reply) ?? {};
        const devices = Array.isArray(data.devices) ? data.devices : [];
        return json(res, 200, {
          ok: data.ok !== false,
          count: devices.length,
          devices: devices.map(normalizeCloudDevice),
        });
      } catch (error) {
        unavailable = true;
        return json(res, 502, { ok: false, error: String(error.message ?? error).slice(0, 200) });
      }
    }

    if (pathname === "/printer/cloud/snapshot") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
      if (unavailable) return json(res, 502, { ok: false, error: "mcp server not running" });
      const printerId = url.searchParams.get("printerId");
      const kind = url.searchParams.get("kind") ?? "printer_all";
      const region = url.searchParams.get("region") ?? process.env.ANYCUBIC_CLOUD_REGION ?? "en";
      if (!printerId) return json(res, 400, { ok: false, error: "printerId query param required" });
      try {
        const reply = await client.callTool(
          {
            name: "account_cloud_diagnostics",
            arguments: {
              kind,
              printer_id: Number(printerId) || undefined,
              region,
              timeout_ms: 15_000,
            },
          },
          undefined,
          { timeout: timeoutMs },
        );
        if (reply.isError) return json(res, 502, { ok: false, error: structuredText(reply) });
        const data = reply.structuredContent ?? tryParseText(reply) ?? {};
        return json(res, 200, { ok: data.ok !== false, diagnostic: data.diagnostic ?? null });
      } catch (error) {
        unavailable = true;
        return json(res, 502, { ok: false, error: String(error.message ?? error).slice(0, 200) });
      }
    }

    return json(res, 404, { ok: false, error: "not found" });
  });

  transport.onclose = () => {
    unavailable = true;
  };
  transport.onerror = () => {
    unavailable = true;
  };

  await client.connect(transport);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  const handle = {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    get state() {
      return unavailable ? STATE.UNAVAILABLE : STATE.READY;
    },
    isReady: !unavailable,
    async close() {
      try {
        await client.close();
      } catch {
        /* upstream already gone */
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return handle;
}

function structuredText(reply) {
  const text = reply?.content?.[0]?.text ?? "";
  return String(text).slice(0, 200);
}

/** Map the MCP `account_devices` entry to a minimal, agnostic device shape
 * (id/key/machineType/name/model/online) — the webview builds PrinterInfo
 * from this; no account identifiers are ever hardcoded. */
function normalizeCloudDevice(raw) {
  return {
    id: raw?.id != null ? String(raw.id) : "",
    key: raw?.key ?? "",
    machineType: raw?.machineType ?? raw?.model ?? null,
    name: raw?.name ?? null,
    model: raw?.model ?? null,
    online: raw?.online === true || raw?.deviceStatus === 1,
  };
}

// CLI entry: bind the fixed loopback port and hold until interrupted.
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let port = Number(process.env.ANYCUBIC_CLOUD_LOOPBACK_PORT) || CLOUD_BRIDGE_DEFAULT_PORT;
  const argIndex = process.argv.indexOf("--port");
  if (argIndex >= 0) port = Number(process.argv[argIndex + 1]) || port;
  const timeoutArg = process.argv.indexOf("--timeout");
  const timeoutMs = timeoutArg >= 0 ? Number(process.argv[timeoutArg + 1]) || 30_000 : 30_000;
  const handle = await startCloudBridge({ port, timeoutMs });
  process.stdout.write(`cloud-bridge listening on ${handle.url}\n`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
