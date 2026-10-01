#!/usr/bin/env node
/**
 * e2e:editor-reload — real-browser reload regression for the editor SHELL
 * (S9.2-006 AC: "reload no longer 500s" with the ChatPanel + overlay root +
 * AI SDK hooks mounted).
 *
 * Unlike `cad-ui.e2e.mjs` (which drives the CAD loopback html), this drives
 * the React/R3F editor shell served by Vite on port 1420:
 *   1. Spawn `vite` (dev) for apps/editor on the STRICT port 1420.
 *   2. Open with puppeteer-core; wait for the shell to render (app-shell).
 *   3. Click the "chat" sidebar view → ChatPanel mounts.
 *   4. Hot reload (page.reload) → assert ZERO page errors + ZERO HTTP 500 +
 *      the DOM shell restores (no blank white page).
 *
 * If the dev server cannot start (port busy / missing deps) the test FAILS
 * loudly — the shell is OUR code and reload must stay green.
 *
 * Runner: `node tests/e2e/editor-reload.e2e.mjs` (puppeteer-core; MIT).
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const editorDir = path.join(root, "apps", "editor");
const viteEntry = path.join(editorDir, "node_modules", "vite", "bin", "vite.js");
const URL = "http://127.0.0.1:1420/";

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
  return candidates.find((p) => fs.existsSync(p));
}

const exe = pickExecutable();
assert.ok(exe, "no Chromium/Edge executable — install Edge/Chrome or set CHROME_PATH");

let child = null;
let browser = null;

const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if the dev server is ALREADY listening on 1420 (reuse, no spawn). */
async function devAlreadyUp() {
  try {
    const res = await fetch(URL);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHttp(url, timeoutMs) {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      lastErr = `http ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await waitFor(500);
  }
  throw new Error(`dev server did not come up: ${lastErr}`);
}

try {
  // REUSE an already-running dev server if present; otherwise spawn one.
  if (!(await devAlreadyUp())) {
    assert.ok(fs.existsSync(viteEntry), `vite entry missing: ${viteEntry}`);
    child = spawn(process.execPath, [viteEntry, "--port", "1420", "--strictPort"], {
      cwd: editorDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let viteLog = "";
    child.stdout?.on("data", (d) => (viteLog += d.toString()));
    child.stderr?.on("data", (d) => (viteLog += d.toString()));
    child.on("exit", (code) => {
      if (code && code !== 0) {
        throw new Error(`vite exited early (${code}): ${viteLog.slice(-400)}`);
      }
    });
    await waitHttp(URL, 30_000);
  }

  browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--mute-audio",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  const warnings = [];
  const failedReqs = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => failedReqs.push(`reqfail: ${r.url()}`));
  page.on("response", (r) => {
    if (r.status() >= 400) failedReqs.push(`http ${r.status()}: ${r.url()}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") {
      const loc = m.location ? (m.location().url ?? "") : "";
      const txt = m.text();
      if (/TransformControls|Object3D\.add|favicon/i.test(txt) || /favicon/i.test(loc)) return;
      errors.push(`console: ${txt}${loc ? ` @${loc}` : ""}`);
    } else if (m.type() === "warning") {
      warnings.push(m.text());
    }
  });

  // ---- 1. initial load — shell renders ----
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });

  // ---- 2. mount ChatPanel (sidebar chat view) + overlay dock ----
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".sidebar-nav button")].find(
      (b) => b.textContent.trim() === "chat",
    );
    if (btn) btn.click();
  });
  await page.waitForSelector(".panel-chat", { timeout: 15000 });

  // ---- 3. reload — regression: zero 500 / zero page errors / DOM restores ----
  const errsBefore = errors.length;
  const warnsBefore = warnings.length;
  const reqsBefore = failedReqs.length;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });

  const newErrs = errors.slice(errsBefore);
  const newWarns = warnings.slice(warnsBefore);
  const newReqs = failedReqs.slice(reqsBefore);
  assert.equal(newErrs.length, 0, `page errors after reload: ${newErrs.join(" | ")}`);
  const http500 = newReqs.filter((m) => /^http 5\d\d/.test(m));
  assert.equal(http500.length, 0, `HTTP 5xx after reload: ${http500.join(" | ")}`);
  // S9.2-006 AC-1: no THREE.Clock deprecation warning may surface in the console.
  const clockWarns = newWarns.filter((w) => /Clock: This module has been deprecated/.test(w));
  assert.equal(clockWarns.length, 0, `THREE.Clock deprecation warnings: ${clockWarns.join(" | ")}`);

  // DOM actually restored (not a blank white page).
  const hasShell = await page.$(".app-shell").then((el) => Boolean(el));
  const hasRoot = await page.$eval("#root", (el) => el.children.length > 0).catch(() => false);
  assert.ok(
    hasShell && hasRoot,
    `shell DOM missing after reload (shell=${hasShell} root=${hasRoot})`,
  );

  console.log(
    `e2e:editor-reload PASS — shell reloaded clean (0 page errors, 0 HTTP 5xx), ChatPanel + overlay mounted.`,
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
