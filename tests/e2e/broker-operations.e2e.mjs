#!/usr/bin/env node
/**
 * S9.18-001 E2E — operation discovery catalog (REAL broker binary).
 *
 * Proves, against the current source built into broker-server.exe, that:
 *   - GET /operations reached from a REAL browser page on the VALID vite
 *     origin returns 200 with exactly the 13 known writer entries, every one
 *     `available:false` with the precise stable `backend-not-wired` reason
 *     (the default backend wires no transport/session/resolver)
 *   - each entry exposes schemaVersion, effect, requiredScope,
 *     approvalPolicy, handler and a CLOSED inputSchema
 *   - the catalog body leaks no secrets, provider URLs or account paths
 *   - GET /operations/{id} returns the entry (200) / a structured
 *     `operation-not-found` 404 for unknown ids
 *   - a request with an unknown Origin header gets 403 server-side (the
 *     strict origin guard — the browser CORS sandbox would mask it, so the
 *     403 is asserted at the HTTP layer against the same binary)
 *
 * Hardening rules (same as broker-provider-status.e2e.mjs):
 *   - NO SKIP: the broker binary is built HERE (cargo build -p broker-server);
 *   - dynamic ports everywhere (broker :0 + its own bound-address log line,
 *     vite via a free-port probe), CORS allowlist pinned to THIS vite origin;
 *   - never contacts a printer, cloud or any real network — everything is
 *     127.0.0.1 + fetch fixtures;
 *   - cleanup kills ONLY what this file spawned; the real exit code is the
 *     verdict (1 on any failure).
 */
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const editorDir = path.join(root, "apps", "editor");
const viteEntry = path.join(editorDir, "node_modules", "vite", "bin", "vite.js");
const cratesDir = path.join(root, "crates");
const brokerExe = path.join(cratesDir, "target", "debug", "broker-server.exe");
const cargoPath = path.join(process.env.USERPROFILE ?? os.homedir(), ".cargo", "bin", "cargo.exe");

function pickExecutable() {
  const candidates = [
    ...(process.env.LOCALAPPDATA
      ? [
          `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe`,
        ]
      : []),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.CHROME_PATH,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const executable = pickExecutable();
assert.ok(executable, "no Chromium/Edge executable — install Edge/Chrome or set CHROME_PATH");
assert.ok(fs.existsSync(viteEntry), `vite entry missing: ${viteEntry}`);
assert.ok(
  fs.existsSync(cargoPath),
  `cargo missing at ${cargoPath} — set USERPROFILE (cargo lives under %USERPROFILE%\\.cargo\\bin)`,
);

// MANDATORY: build the CURRENT broker source into the binary this E2E runs.
console.log(
  `[S9.18-001-ops] building broker-server: ${cargoPath} build -p broker-server (cwd ${cratesDir})`,
);
{
  const build = spawnSync(cargoPath, ["build", "-p", "broker-server"], {
    cwd: cratesDir,
    env: process.env,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error(`[S9.18-001-ops] FATAL: cargo build -p broker-server failed (${build.status})`);
    process.exit(1);
  }
}
assert.ok(fs.existsSync(brokerExe), `broker binary still missing after build: ${brokerExe}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function spawnVite(port) {
  const child = spawn(
    process.execPath,
    [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: editorDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout?.on("data", (data) => (log += data.toString()));
  child.stderr?.on("data", (data) => (log += data.toString()));
  return { child, log: () => log };
}

async function waitVite(child, log, port) {
  const url = `http://127.0.0.1:${port}/`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (child.exitCode !== null)
      throw new Error(`vite exited (${child.exitCode}): ${log().slice(-500)}`);
    try {
      const response = await fetch(url);
      if (response.ok && (await response.text()).includes("/src/main.tsx")) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`vite did not start: ${log().slice(-500)}`);
}

function spawnBroker(allowedOrigin) {
  const child = spawn(brokerExe, [], {
    env: {
      ...process.env,
      ANYCUBIC_BROKER_PORT: "0",
      // Pin the CORS allowlist to THIS run's actual vite origin (strict, no
      // wildcard) — the prod origin stays fixed inside the binary.
      ANYCUBIC_BROKER_ALLOWED_ORIGIN: allowedOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (data) => (log += data.toString()));
  child.stderr?.on("data", (data) => (log += data.toString()));
  return { child, log: () => log };
}

async function waitBrokerAddr(broker, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = broker.log().match(/listening on (127\.0\.0\.1:\d+)/);
    if (match) return `http://${match[1]}`;
    if (broker.child.exitCode !== null)
      throw new Error(
        `broker exited early (${broker.child.exitCode}): ${broker.log().slice(-500)}`,
      );
    await sleep(100);
  }
  throw new Error(`broker did not print its bound address: ${broker.log().slice(-500)}`);
}

async function waitBrokerHealth(baseUrl, broker) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(
    `broker did not answer /health on ${baseUrl}` +
      (broker ? `; broker log: ${broker.log().slice(-800)}` : ""),
  );
}

async function killChild(child) {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
  }
}

let browser;
const spawned = [];
let viteChild = null;
let brokerChild = null;

try {
  browser = await puppeteer.launch({
    executablePath: executable,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });

  const vitePort = await freePort();
  const viteHandle = spawnVite(vitePort);
  viteChild = viteHandle.child;
  spawned.push(viteChild);
  await waitVite(viteChild, viteHandle.log, vitePort);

  const brokerHandle = spawnBroker(`http://127.0.0.1:${vitePort}`);
  brokerChild = brokerHandle.child;
  spawned.push(brokerChild);
  const brokerBase = await waitBrokerAddr(brokerHandle);
  await waitBrokerHealth(brokerBase, brokerHandle);

  // Real browser page on the VALID vite origin; the fetch to the broker is a
  // genuine cross-origin request the broker's CORS allowlist must permit.
  const page = await browser.newPage();
  page.on("pageerror", (error) => {
    throw new Error(`pageerror: ${error.message}`);
  });
  // Same proven path the existing broker e2e bootstraps (renders home-page
  // regardless of lane), then waits for it.
  await page.goto(`http://127.0.0.1:${vitePort}/?provider=real`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 30000 });

  const catalog = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/operations`);
    const status = response.status;
    const text = await response.text();
    return { status, json: JSON.parse(text), text };
  }, brokerBase);
  assert.equal(catalog.status, 200, "valid origin must reach the catalog (200)");
  const operations = catalog.json.operations;
  assert.equal(catalog.json.schemaVersion, 1, "catalog wire schemaVersion");
  assert.equal(operations.length, 13, "all known writer actions are listed");
  const ids = operations.map((entry) => entry.id);
  for (const expected of [
    "nozzle",
    "bed",
    "part_fan",
    "speed",
    "light_set_enabled",
    "light_brightness",
    "ace_dry",
    "ace_auto_feed",
    "ace_bind_slot",
    "upload",
    "job.queue",
    "job.start",
    "job.stop",
  ]) {
    assert.ok(ids.includes(expected), `missing entry ${expected}`);
  }
  for (const entry of operations) {
    assert.equal(entry.schemaVersion, 1, `${entry.id} schemaVersion`);
    assert.equal(typeof entry.effect, "string", `${entry.id} effect`);
    assert.equal(typeof entry.requiredScope, "string", `${entry.id} requiredScope`);
    assert.equal(entry.approvalPolicy, "one_use_approval", `${entry.id} approvalPolicy`);
    assert.equal(typeof entry.handler, "string", `${entry.id} handler`);
    assert.equal(entry.inputSchema.type, "object", `${entry.id} inputSchema type`);
    assert.equal(entry.inputSchema.additionalProperties, false, `${entry.id} closed schema`);
    // Discovery is NOT permission — the default backend wires nothing, so
    // every writer reports unavailable with the precise stable reason.
    assert.equal(entry.available, false, `${entry.id} must be unavailable`);
    assert.equal(entry.availabilityReason, "backend-not-wired", `${entry.id} reason`);
  }
  // Public-safe: the catalog carries NO secrets, URLs or account paths.
  for (const forbidden of [
    "://",
    "Users",
    "AppData",
    "api_key",
    "Bearer",
    "token",
    "access_token",
  ]) {
    assert.ok(!catalog.text.includes(forbidden), `catalog must not leak ${forbidden}`);
  }
  console.log(
    "[S9.18-001-ops] valid-origin browser fetch: 13 entries, all unavailable, clean PASS",
  );

  const entry = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/operations/nozzle`);
    return { status: response.status, json: JSON.parse(await response.text()) };
  }, brokerBase);
  assert.equal(entry.status, 200);
  assert.equal(entry.json.id, "nozzle");
  assert.equal(entry.json.requiredScope, "device_control");
  assert.equal(entry.json.effect, "thermal");
  assert.equal(
    entry.json.inputSchema.properties.nozzle.maximum,
    320,
    "single-entry schema agrees with the dispatch window",
  );
  console.log("[S9.18-001-ops] GET /operations/nozzle entry (200) PASS");

  const unknown = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/operations/does-not-exist`);
    return { status: response.status, json: JSON.parse(await response.text()) };
  }, brokerBase);
  assert.equal(unknown.status, 404, "unknown operation id must be 404");
  assert.equal(unknown.json.error, "operation-not-found", "structured error code");
  assert.equal(unknown.json.id, "does-not-exist", "the id is echoed back unchanged");
  console.log("[S9.18-001-ops] unknown id -> structured 404 PASS");

  // Bad-origin 403 at the HTTP layer. The browser CORS sandbox masks the 403
  // body as a network error (its feature), so the strict origin guard is
  // asserted directly against the same binary with an explicit evil Origin.
  const badOrigin = await fetch(`${brokerBase}/operations`, {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(badOrigin.status, 403, "evil origin must be refused (403)");
  assert.ok((await badOrigin.text()).includes("Origin not allowed"));
  console.log("[S9.18-001-ops] bad origin -> 403 PASS");

  // A valid-origin request ALSO gets the CORS echo (browser-readable).
  const corsEcho = await fetch(`${brokerBase}/operations`, {
    headers: { origin: `http://127.0.0.1:${vitePort}` },
  });
  assert.equal(corsEcho.status, 200);
  assert.equal(
    corsEcho.headers.get("access-control-allow-origin"),
    `http://127.0.0.1:${vitePort}`,
    "CORS allow-list echoes THIS vite origin (strict, no wildcard)",
  );
  console.log("[S9.18-001-ops] CORS allow-list echo PASS");

  await page.close();
  console.log("[S9.18-001-ops] broker-operations.e2e.mjs PASS");
} catch (error) {
  console.error(`[S9.18-001-ops] broker-operations.e2e.mjs FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (browser) {
    for (const openPage of await browser.pages()) {
      try {
        await openPage.close();
      } catch {}
    }
    await browser.close();
  }
  // Cleanup kills ONLY what this file spawned.
  if (viteChild) {
    await killChild(viteChild);
    viteChild = null;
  }
  if (brokerChild) {
    await killChild(brokerChild);
    brokerChild = null;
  }
  for (const child of spawned) await killChild(child);
  process.exit(process.exitCode ?? 0);
}
