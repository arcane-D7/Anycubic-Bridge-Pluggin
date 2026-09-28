#!/usr/bin/env node
/**
 * loopback-bridge.mjs — S6-005 read-only loopback bridge to the preserved Node
 * MCP/CAD server.
 *
 * Why this exists:
 *   During the migration the legacy scene (ui/cad.html + vendor/server.mjs) must
 *   remain readable through the new app (§1.1 migration gate: "legacy scene reads
 *   through the bridge with no data loss"). The preserved server is spawned as a
 *   child (via scripts/mcp-entry.mjs so it resolves dist/server.mjs itself and
 *   auto-builds on a fresh clone) and driven through its MCP surface
 *   (cad_open_workspace → per-session token + loopback URL).
 *
 *   This module exposes a get-only REST surface on a SECOND random loopback port
 *   with its OWN token (X-Bridge-Token header or ?token= query). Every route
 *   proxies the preserved server's read endpoints verbatim:
 *
 *     GET /health               → { ok, state: "ready"|"unavailable" }
 *     GET /objects              → proxy  GET /api/objects
 *     GET /object?name=X        → proxy POST /api/object { name }
 *     GET /mesh/<name>          → proxy  GET /mesh/<name>
 *     GET /project              → project read (object list + groups + revision)
 *
 *   Zero write paths in R0: any non-GET method → 405; unknown GET → 404.
 *
 *   Stale/absent server is never a crash or silent fallback: if the child exits
 *   or an upstream proxy call fails, every route reports a clean
 *   `{ ok:false, state:"unavailable", error:"legacy server not running" }`.
 *
 * Usage (module):
 *   const bridge = await startBridge({ inputPath, port, token });
 *   bridge.url  // http://127.0.0.1:PORT/?token=...
 *   await bridge.close();
 *
 * Usage (CLI, for the future editor):
 *   node scripts/loopback-bridge.mjs [--input <file.stl|3mf>]
 *   → prints the handle JSON on stdout, stays running until SIGINT/SIGTERM.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpEntry = path.join(root, "scripts", "mcp-entry.mjs");

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

/**
 * Start the loopback bridge.
 *
 * @param {object} options
 * @param {string} [options.inputPath] optional file to preload into the CAD
 *   workspace (validateInputFile allows .stl/.3mf; the preserved importer parses
 *   STL — a .3mf must be converted to STL first, e.g. via scripts/import-3mf-mesh.mjs).
 * @param {number} [options.port] bridge HTTP port (0 = ephemeral, default 0).
 * @param {string} [options.token] bridge session token (default: random 32-hex).
 * @param {number} [options.timeoutMs] MCP request timeout (default 30000).
 * @returns {Promise<object>} handle { url, port, token, upstreamUrl,
 *   upstreamToken, upstreamPid, state, isReady, close(), killUpstream() }
 */
export async function startBridge(options = {}) {
  const {
    inputPath,
    port = 0,
    token = randomBytes(16).toString("hex"),
    timeoutMs = 30_000,
  } = options;

  // 1. Spawn the preserved server through the MCP entry (resolves dist/server.mjs
  //    relative to itself and auto-builds if missing). StdioClientTransport
  //    spawns `node scripts/mcp-entry.mjs` with windowsHide on Windows.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    stderr: "pipe",
    cwd: root,
  });
  const client = new Client({ name: "loopback-bridge", version: "0.1.0" });

  // 2. Open the CAD workspace get-only (no browser, no idle timeout). The
  //    preserved handler returns { ok, url, token, output_root }.
  let upstreamUrl = "";
  let upstreamToken = "";

  // 3. Get-only HTTP server.
  let STATE_UNREADY = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const authorized =
      req.headers["x-bridge-token"] === token || url.searchParams.get("token") === token;
    if (!authorized) {
      json(res, 401, { ok: false, error: "missing or invalid X-Bridge-Token" });
      return;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "bridge is read-only (R0): GET only" });
      return;
    }
    const pathname = url.pathname;
    if (pathname === "/health") {
      const state = clientState();
      json(res, 200, state.ok ? { ok: true, state: state.state } : state);
      return;
    }
    void handleGet(pathname, url, res);
  });

  function clientState() {
    if (STATE_UNREADY)
      return { ok: false, state: STATE.UNAVAILABLE, error: "legacy server not running" };
    return { ok: true, state: STATE.READY };
  }

  async function handleGet(pathname, url, res) {
    if (STATE_UNREADY) {
      json(res, 502, { ok: false, state: STATE.UNAVAILABLE, error: "legacy server not running" });
      return;
    }
    try {
      if (pathname === "/objects") {
        const data = await upstreamFetch(`${upstreamBase}/api/objects`, {
          method: "GET",
          headers: upstreamHeaders(),
        });
        json(res, 200, data);
        return;
      }
      if (pathname === "/object") {
        const name = url.searchParams.get("name") ?? "";
        if (!name) {
          json(res, 400, { ok: false, error: "name query parameter required" });
          return;
        }
        const data = await upstreamFetch(`${upstreamBase}/api/object`, {
          method: "POST",
          headers: { ...upstreamHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        json(res, 200, data);
        return;
      }
      if (pathname === "/project") {
        const data = await upstreamFetch(`${upstreamBase}/api/objects`, {
          method: "GET",
          headers: upstreamHeaders(),
        });
        json(res, 200, {
          ok: true,
          state: STATE.READY,
          project: {
            revision: data.revision,
            groups: data.groups,
            meshCount: Array.isArray(data.objects) ? data.objects.length : 0,
            objects: data.objects,
          },
        });
        return;
      }
      if (pathname.startsWith("/mesh/")) {
        const name = decodeURIComponent(pathname.slice("/mesh/".length));
        const data = await upstreamFetch(`${upstreamBase}/mesh/${encodeURIComponent(name)}`, {
          method: "GET",
          headers: upstreamHeaders(),
        });
        json(res, 200, data);
        return;
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      STATE_UNREADY = true;
      json(res, 502, {
        ok: false,
        state: STATE.UNAVAILABLE,
        error: "legacy server not running",
        detail: String(error.message ?? error).slice(0, 200),
      });
    }
  }

  let upstreamBase = "";
  const upstreamHeaders = () => ({ "X-Cad-Token": upstreamToken });

  async function upstreamFetch(base, init) {
    const res = await fetch(base, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`upstream ${res.status}: ${String(data.error ?? "").slice(0, 200)}`);
    }
    return data;
  }

  // 4. Wire transport close → unavailable (never crash).
  transport.onclose = () => {
    STATE_UNREADY = true;
  };
  transport.onerror = () => {
    STATE_UNREADY = true;
  };

  await client.connect(transport);

  const opened = await client.callTool(
    {
      name: "cad_open_workspace",
      arguments: {
        open_browser: false,
        idle_timeout_min: 0,
        ...(inputPath ? { input_path: inputPath } : {}),
      },
    },
    undefined,
    { timeout: timeoutMs },
  );
  const openJson = opened.structuredContent ?? tryParseText(opened);
  if (!openJson || openJson.ok !== true) {
    throw new Error(`cad_open_workspace failed: ${JSON.stringify(opened).slice(0, 300)}`);
  }
  upstreamUrl = String(openJson.url);
  upstreamToken = String(openJson.token);
  upstreamBase = upstreamUrl.split("?")[0].replace(/\/+$/, "");

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  const handle = {
    url: `http://127.0.0.1:${actualPort}/?token=${token}`,
    port: actualPort,
    token,
    upstreamUrl,
    upstreamToken,
    upstreamPid: transport.pid,
    get state() {
      return clientState().state;
    },
    isReady: clientState().ok,
    async close() {
      try {
        await client.close();
      } catch {
        // upstream already gone — fine
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
    async killUpstream() {
      try {
        await client.close();
      } catch {
        // ignore
      }
    },
  };
  return handle;
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

// CLI entry: print the handle and hold the process open until interrupted.
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const arg = process.argv.indexOf("--input");
  const inputPath = arg >= 0 ? process.argv[arg + 1] : undefined;
  const handle = await startBridge({ inputPath, port: 0 });
  process.stdout.write(JSON.stringify(handle, null, 2) + "\n");
  process.stdout.write(`legacy bridge listening on ${handle.url}\n`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // Keep the event loop alive via the HTTP server (already open).
}
