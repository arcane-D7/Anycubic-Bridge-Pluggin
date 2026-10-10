#!/usr/bin/env node
/**
 * S9.18-001 E2E — provider bootstrap transport (REAL, not mock).
 *
 * Runs the real editor (ephemeral Vite port), the real Rust broker binary
 * (ephemeral loopback port via ANYCUBIC_BROKER_PORT=0), and a real local
 * fake HTTP provider on an ephemeral port. Four legs:
 *
 *   D  (demo):        vite WITHOUT ANYCUBIC_BROKER_URL → the editor shows the
 *                     offline Demo lane (banner + offline-mock provider attr),
 *                     sending a message calls the offline mock transport (an
 *                     assistant reply appears, NO alert). Proves the
 *                     unconfigured default is an honest demo — never a fake
 *                     configured lane.
 *   C  (configured):  broker-server.exe spawned with a real fake provider
 *                     model URL on the ephemeral broker port + the vite
 *                     origin on the CORS allowlist → banner "provider
 *                     Configured"; sending a message MUST reach the provider
 *                     exactly ONCE over POST /v1/chat/completions with the
 *                     key and model, and the assistant shows the FIXED
 *                     provider text — NOT an echo, NOT a fallback.
 *   U  (unavailable): broker with an INVALID (non-loopback http) MODEL_URL →
 *                     /provider/status mode "unavailable"; banner flips to
 *                     "provider unavailable" and sending a message surfaces
 *                     the chat alert with the provider count STILL ZERO.
 *   IB (invalid broker URL): vite with an INVALID FRONTEND ANYCUBIC_BROKER_URL
 *                     (external host — never a loopback). Distinct from leg U
 *                     (invalid BACKEND model URL): here the webview itself
 *                     must NOT fire ANY outgoing request (no /provider/status
 *                     fetch, no /chat, nothing); the chat lane is
 *                     "broker-invalid" → banner "provider unavailable",
 *                     send REJECTS with a typed error (alert, no assistant
 *                     message). This pins the AI-01 guard: an invalid env
 *                     value NEVER silently falls back to the offline demo
 *                     mock.
 *
 * Hardening rules (all enforced):
 *   - NO SKIP paths: the broker binary is BUILT HERE (spawnSync cargo build
 *     -p broker-server, cargo path from %USERPROFILE%\.cargo\bin) — any build
 *     or port failure is a FAIL, not a silent exit 0.
 *   - Dynamic ports everywhere: broker binds :0 (ephemeral, prints its bound
 *     address), Vite picks a free port via a net probe, the broker's CORS
 *     allowlist pins the ACTUAL vite origin (no wildcard), prod origin stays
 *     fixed by the Rust binary.
 *   - The broker never inherits ambient ANYCUBIC_MODEL_* values (scrubbed) —
 *     no unintended paid-model request can leak in from the host env.
 *   - Cleanup kills ONLY the servers this file spawned; the final exit code
 *     is the real verdict (1 on any failure — never a forced success).
 *
 * Real interactions only (page.click/page.type + Enter). Never contacts a
 * printer or cloud. Everything is loopback + fake fixtures.
 */
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
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
const PROVIDER_REPLY = "FAKE PROVIDER REPLY";
// Fictional LAN fixture (tests/ is a sanitizer SKIP_DIR) — the webview must
// NEVER contact it; legs assert zero requests to it.
const EXTERNAL_BROKER_URL = "http://192.168.3.50:18181";

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

// ---------------------------------------------------------------------------
// MANDATORY: build the CURRENT broker source into the binary this E2E runs.
// A missing/stale binary is a build FAILURE here, never a skip.
// ---------------------------------------------------------------------------
console.log(
  `[S9.18-001] building broker-server: ${cargoPath} build -p broker-server (cwd ${cratesDir})`,
);
{
  const build = spawnSync(cargoPath, ["build", "-p", "broker-server"], {
    cwd: cratesDir,
    env: scrubAmbientModel(process.env),
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error(
      `[S9.18-001] FATAL: cargo build -p broker-server failed (status ${build.status})`,
    );
    process.exit(1);
  }
}
assert.ok(fs.existsSync(brokerExe), `broker binary still missing after build: ${brokerExe}`);

const projects = [{ id: "home-project-a", name: "TestLocalGateway", updated_ms: 1 }];
const snapshotOf = (project) => ({
  project: { id: project.id, name: project.name, objects: [] },
  revision: 3,
});
const snapshots = Object.fromEntries(projects.map((project) => [project.id, snapshotOf(project)]));

/** Strip every ambient ANYCUBIC_MODEL_* var — any child this file spawns must
 * NEVER pick up a real paid-model URL from the host environment. */
function scrubAmbientModel(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("ANYCUBIC_MODEL_")) delete clean[key];
  }
  return clean;
}

/** Reserve a free loopback port (bind :0, read it, close). The Vite dev
 * server always runs on an ephemeral port — no fixed-port conflicts, no SKIP
 * on "port busy". */
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

const portBusy = (targetPort) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: targetPort });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(700);
  });

/** env WITHOUT the broker lane (leg D needs a guaranteed-unconfigured vite). */
function envWithoutBroker(extra = {}) {
  const env = scrubAmbientModel({ ...process.env });
  delete env.ANYCUBIC_BROKER_URL;
  return Object.assign(env, extra);
}

function spawnVite(port, envExtra) {
  const child = spawn(
    process.execPath,
    [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: editorDir,
      env: envWithoutBroker(envExtra),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let viteLog = "";
  child.stdout?.on("data", (data) => (viteLog += data.toString()));
  child.stderr?.on("data", (data) => (viteLog += data.toString()));
  return { child, viteLog: () => viteLog };
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`vite did not start: ${log().slice(-500)}`);
}

/** Boot broker-server.exe with ANYCUBIC_BROKER_PORT=0 (ephemeral). Returns
 * { child, brokerLog, baseUrl } — the address comes from the binary's OWN
 * "listening on 127.0.0.1:<port>" line (no fixed-port assumption). */
function spawnBroker(env) {
  const child = spawn(brokerExe, [], {
    env: {
      // Windows needs the base environment to load the CRT/network stacks,
      // but ambient ANYCUBIC_MODEL_* vars are scrubbed: the egress lane is
      // authored ENTIRELY by the caller (leg-specific).
      ...scrubAmbientModel(process.env),
      ANYCUBIC_BROKER_PORT: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let brokerLog = "";
  child.stdout?.on("data", (data) => (brokerLog += data.toString()));
  child.stderr?.on("data", (data) => (brokerLog += data.toString()));
  return { child, brokerLog: () => brokerLog };
}

async function waitBrokerAddr(broker, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = broker.brokerLog().match(/listening on (127\.0\.0\.1:\d+)/);
    if (match) return `http://${match[1]}`; // full base URL (fetch needs the scheme)
    if (broker.child.exitCode !== null)
      throw new Error(
        `broker exited early (${broker.child.exitCode}): ${broker.brokerLog().slice(-500)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`broker did not print its bound address: ${broker.brokerLog().slice(-500)}`);
}

async function waitBrokerHealth(baseUrl, broker) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `broker did not answer /health on ${baseUrl}` +
      (broker ? `; broker log: ${broker.brokerLog().slice(-800)}` : ""),
  );
}

/** Fake provider: records hits (count, path, auth header, raw body) and
 * replies with the fixed provider text. Read-only for the printer. */
function bootFakeProvider() {
  const hits = { count: 0, paths: [], auths: [], bodies: [] };
  const server = http.createServer((req, res) => {
    hits.count += 1;
    hits.paths.push(req.url ?? "");
    hits.auths.push(req.headers.authorization ?? null);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits.bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-e2e",
          object: "chat.completion",
          created: 1,
          model: "FAKE_MODEL",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: PROVIDER_REPLY },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, hits, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let browser;
const spawned = [];
let brokerChild = null;
let currentVite = null;

async function bootEditorPage(port, extraViteEnv, onRequest) {
  currentVite = spawnVite(port, extraViteEnv);
  spawned.push(currentVite.child);
  await waitVite(currentVite.child, currentVite.viteLog, port);
  const page = await browser.newPage();
  if (onRequest) page.on("request", onRequest);
  page.on("pageerror", (error) => page.browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") page.browserErrors.push(message.text());
  });
  page.browserErrors = [];

  await page.evaluateOnNewDocument(
    ({ fixtureProjects, fixtureSnapshots }) => {
      window.isTauri = true;
      const storeKey = "anycubic:e2e:broker-provider-chat-store";
      const loadStore = () => {
        try {
          return JSON.parse(window.localStorage.getItem(storeKey) ?? "{}");
        } catch {
          return {};
        }
      };
      const saveStore = (map) => window.localStorage.setItem(storeKey, JSON.stringify(map));
      window.__chatStore = loadStore();
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args = {}) => {
          if (command.startsWith("chat_store_")) {
            if (command === "chat_store_dir") return "synthetic-chat-dir";
            if (command === "chat_store_list") return Object.keys(window.__chatStore);
            if (command === "chat_store_get") return window.__chatStore[args.id] ?? null;
            if (command === "chat_store_put") {
              window.__chatStore[args.id] = args.value;
              saveStore(window.__chatStore);
              return null;
            }
            if (command === "chat_store_delete") {
              delete window.__chatStore[args.id];
              saveStore(window.__chatStore);
              return null;
            }
          }
          if (command === "project_list") return fixtureProjects;
          if (command === "project_slice_history") return [];
          if (command === "project_authority_read") return fixtureSnapshots[fixtureProjects[0].id];
          if (command === "project_authority_recover") return fixtureSnapshots[args.projectId];
          if (command === "project_authority_commit") {
            return {
              status: "committed",
              actual_revision: args.expectedRevision + 1,
              diagnostics: [],
            };
          }
          throw new Error(`unexpected synthetic Tauri command: ${command}`);
        },
      };
    },
    { fixtureProjects: projects, fixtureSnapshots: snapshots },
  );

  await page.goto(`http://127.0.0.1:${port}/?provider=real`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="home-continue"]', { timeout: 15000 });
  await page.waitForSelector(`[data-testid="home-project-${projects[0].id}"]`, { timeout: 15000 });
  await page.click(`[data-testid="home-project-${projects[0].id}"] .home-project-copy button`);
  await page.click('[data-testid="home-continue"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 15000 });
  await openChatOn(page);
  return page;
}

async function openChatOn(page) {
  const visible = await page
    .$eval('[data-testid="chat-thread"]', (thread) => {
      const rect = thread.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !thread.closest("[hidden]");
    })
    .catch(() => false);
  if (!visible) await page.click(".header-chat-toggle");
  await page.waitForSelector('[data-testid="chat-thread"]', { timeout: 10000 });
}

async function sendMessage(page, text) {
  await page.click('[data-testid="chat-input"]');
  await page.type('[data-testid="chat-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (needle) =>
      [...document.querySelectorAll(".chat-message.user p")].some((paragraph) =>
        paragraph.textContent?.includes(needle),
      ),
    { timeout: 10000 },
    text,
  );
}

const sourceText = (page) =>
  page.$eval('[data-testid="chat-source-status"]', (div) => div.textContent ?? "");

const threadAttr = (page, name) =>
  page.$eval('[data-testid="chat-thread"]', (div, attr) => div.getAttribute(attr), name);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killChild(child) {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
  }
}

async function killCurrentVite() {
  const child = currentVite?.child;
  currentVite = null;
  await killChild(child);
}

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

  // Informational only — the legacy fixed ports (18181 broker / 1420 dev
  // origin) are never used by this run (everything is dynamic now).
  const legacyBrokerBusy = await portBusy(18181);
  const legacyDevOriginBusy = await portBusy(1420);
  console.log(
    `[S9.18-001] legacy ports: 18181 ${legacyBrokerBusy ? "busy" : "free"}, ` +
      `1420 ${legacyDevOriginBusy ? "busy" : "free"} (dynamic ports used regardless)`,
  );

  // ================= LEG D — demo (no ANYCUBIC_BROKER_URL) =================
  {
    const vitePort = await freePort();
    const page = await bootEditorPage(vitePort, {}, undefined);
    assert.equal(await threadAttr(page, "data-provider"), "offline-mock");
    const banner = await sourceText(page);
    assert.ok(banner.includes("offline demo transport"), `demo banner, got: ${banner}`);
    await sendMessage(page, "demo leg message");
    await page.waitForSelector(".chat-message.assistant", { timeout: 15000 });
    await sleep(600);
    assert.equal(
      await page.$("[role='alert']").then((element) => element === null),
      true,
      "demo leg must never surface a chat error",
    );
    assert.deepEqual(
      page.browserErrors.filter((message) => !/Failed to load resource.*404/i.test(message)),
      [],
      `demo leg console errors: ${JSON.stringify(page.browserErrors)}`,
    );
    console.log("[S9.18-001 leg D] offline demo lane PASS");
    await page.close();
    await killCurrentVite();
  }

  // ============ LEG C — configured REAL provider through the broker ============
  {
    const fake = await bootFakeProvider();
    const vitePort = await freePort();
    const brokerLane = spawnBroker({
      ANYCUBIC_MODEL_URL: fake.baseUrl,
      ANYCUBIC_MODEL: "FAKE_MODEL",
      ANYCUBIC_MODEL_API_KEY: "e2e-fake-key",
      // Pin the CORS allowlist to THIS run's actual vite origin (strict, no
      // wildcard) — the broker's prod origin remains fixed in the binary.
      ANYCUBIC_BROKER_ALLOWED_ORIGIN: `http://127.0.0.1:${vitePort}`,
    });
    brokerChild = brokerLane.child;
    spawned.push(brokerChild);
    const brokerBase = await waitBrokerAddr(brokerLane);
    await waitBrokerHealth(brokerBase, brokerLane);

    const page = await bootEditorPage(vitePort, { ANYCUBIC_BROKER_URL: brokerBase }, undefined);
    assert.equal(await threadAttr(page, "data-provider"), "broker");
    await page.waitForSelector('[data-testid="chat-thread"][data-provider-mode="configured"]', {
      timeout: 10000,
    });
    const banner = await sourceText(page);
    assert.ok(
      banner.includes("provider Configured"),
      `configured banner must say Configured, got: ${banner}`,
    );

    await sendMessage(page, "configured leg message");
    await page.waitForFunction(
      (needle) =>
        [...document.querySelectorAll(".chat-message.assistant .chat-text")].some((paragraph) =>
          paragraph.textContent?.includes(needle),
        ),
      { timeout: 15000 },
      PROVIDER_REPLY,
    );
    await sleep(400);
    assert.equal(
      await page.$("[role='alert']").then((element) => element === null),
      true,
      "configured leg must not surface a chat error",
    );

    // The provider was called EXACTLY once (the single /chat request).
    assert.equal(
      fake.hits.count,
      1,
      `configured provider must be called exactly once, got ${fake.hits.count}`,
    );
    assert.equal(
      fake.hits.paths[0],
      "/v1/chat/completions",
      "egress must target the chat completions endpoint",
    );
    assert.equal(
      fake.hits.auths[0],
      "Bearer e2e-fake-key",
      "egress must carry the API key in the Authorization header",
    );
    const sentBody = JSON.parse(fake.hits.bodies[0]);
    assert.equal(sentBody.model, "FAKE_MODEL", "egress body must carry the configured model");
    assert.equal(
      sentBody.stream,
      false,
      "egress must be a non-streaming chat call (post-process SSE)",
    );

    console.log("[S9.18-001 leg C] configured provider flows through broker PASS");
    await page.close();
    await new Promise((resolve) => fake.server.close(resolve));
    await killChild(brokerChild);
    brokerChild = null;
    await killCurrentVite();
  }

  // ============ LEG U — configured-but-INVALID → unavailable, ZERO calls ============
  {
    const fake = await bootFakeProvider(); // hit counter must stay 0
    const vitePort = await freePort();
    const brokerLane = spawnBroker({
      // Non-loopback http URL (fictional LAN fixture) → invalid egress by policy.
      ANYCUBIC_MODEL_URL: "http://192.168.3.50:9988",
      ANYCUBIC_MODEL: "FAKE_MODEL",
      ANYCUBIC_BROKER_ALLOWED_ORIGIN: `http://127.0.0.1:${vitePort}`,
    });
    brokerChild = brokerLane.child;
    spawned.push(brokerChild);
    const brokerBase = await waitBrokerAddr(brokerLane);
    await waitBrokerHealth(brokerBase, brokerLane);

    const page = await bootEditorPage(vitePort, { ANYCUBIC_BROKER_URL: brokerBase }, undefined);
    assert.equal(await threadAttr(page, "data-provider"), "broker");
    await page.waitForSelector('[data-testid="chat-thread"][data-provider-mode="unavailable"]', {
      timeout: 10000,
    });
    const banner = await sourceText(page);
    assert.ok(
      banner.includes("provider unavailable"),
      `unavailable banner must say unavailable, got: ${banner}`,
    );

    await sendMessage(page, "unavailable leg message");
    await page.waitForSelector("[role='alert']", { timeout: 15000 });
    assert.equal(fake.hits.count, 0, "invalid egress must NEVER contact the provider");
    assert.deepEqual(
      page.browserErrors.filter((message) => !/Failed to load resource.*404/i.test(message)),
      [],
      `unavailable leg console errors: ${JSON.stringify(page.browserErrors)}`,
    );
    console.log("[S9.18-001 leg U] unavailable egress reports error, zero provider calls PASS");
    await page.close();
    await new Promise((resolve) => fake.server.close(resolve));
    await killChild(brokerChild);
    brokerChild = null;
    await killCurrentVite();
  }

  // ============ LEG IB — INVALID FRONTEND broker URL → broker-invalid ============
  // Distinct from leg U (invalid BACKEND model URL): here the webview's own
  // ANYCUBIC_BROKER_URL is invalid (external host). AI-01 guard: the lane
  // must be "broker-invalid" (NEVER the offline demo mock), NO outgoing
  // request at all (no /provider/status, no /chat, nothing towards the
  // invalid URL), send REJECTS with the typed error (alert) and NO assistant
  // message is ever produced. No broker is even spawned for this leg — the
  // frontend must not try to reach one.
  {
    const vitePort = await freePort();
    const observedRequests = [];
    const page = await bootEditorPage(
      vitePort,
      { ANYCUBIC_BROKER_URL: EXTERNAL_BROKER_URL },
      (request) => observedRequests.push(request.url()),
    );

    assert.equal(
      await threadAttr(page, "data-provider"),
      "broker-invalid",
      "frontend-invalid lane must be broker-invalid, never offline-mock",
    );
    assert.equal(
      await threadAttr(page, "data-provider-mode"),
      "unavailable",
      "frontend-invalid lane banner mode must be unavailable",
    );
    const banner = await sourceText(page);
    assert.ok(
      banner.includes("provider unavailable"),
      `invalid-broker banner must say provider unavailable, got: ${banner}`,
    );
    await sleep(700); // give any (forbidden) status fetch a chance to fire

    // ZERO outgoing requests to the invalid/external URL and ZERO status polls.
    const forbidden = observedRequests.filter(
      (requestUrl) => requestUrl.includes("provider/status") || requestUrl.includes("192.168.3.50"),
    );
    assert.deepEqual(
      forbidden,
      [],
      `invalid-broker leg must fire NO status/external requests, got: ${JSON.stringify(forbidden)}`,
    );

    await sendMessage(page, "invalid broker leg message");
    await page.waitForSelector("[role='alert']", { timeout: 15000 });
    await sleep(800);
    // The rejection surfaces the chat error UI — never an assistant fake reply.
    assert.equal(
      await page.$(".chat-message.assistant").then((element) => element === null),
      true,
      "invalid-broker leg must never produce an assistant message",
    );
    const forbiddenAfterSend = observedRequests.filter(
      (requestUrl) => requestUrl.includes("provider/status") || requestUrl.includes("192.168.3.50"),
    );
    assert.deepEqual(
      forbiddenAfterSend,
      [],
      `invalid-broker leg must make ZERO external requests, got: ${JSON.stringify(observedRequests)}`,
    );
    assert.deepEqual(
      page.browserErrors.filter((message) => !/Failed to load resource.*404/i.test(message)),
      [],
      `invalid-broker leg console errors: ${JSON.stringify(page.browserErrors)}`,
    );
    console.log("[S9.18-001 leg IB] invalid broker URL rejects, zero outgoing requests PASS");
    await page.close();
    await killCurrentVite();
  }

  console.log("[S9.18-001] broker-provider-status.e2e.mjs PASS");
} catch (error) {
  console.error(`[S9.18-001] broker-provider-status.e2e.mjs FAIL: ${error.stack ?? error}`);
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
  // Cleanup kills ONLY what this file spawned — the current vite, the current
  // broker, and any other recorded children.
  await killCurrentVite();
  if (brokerChild) {
    await killChild(brokerChild);
    brokerChild = null;
  }
  for (const child of spawned) await killChild(child);
  // Final verdict: real exit code (1 on any failure) — never a forced
  // success. The forced exit only reaps dangling handles (SSE/HMR sockets).
  process.exit(process.exitCode ?? 0);
}
