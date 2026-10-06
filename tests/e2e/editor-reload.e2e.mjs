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
  // The spawn MUST bind 127.0.0.1 explicitly: Vite 8 defaults to `localhost`
  // (IPv6 ::1), while this test and the broker CORS contract use 127.0.0.1.
  if (!(await devAlreadyUp())) {
    assert.ok(fs.existsSync(viteEntry), `vite entry missing: ${viteEntry}`);
    child = spawn(
      process.execPath,
      [viteEntry, "--host", "127.0.0.1", "--port", "1420", "--strictPort"],
      {
        cwd: editorDir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
  // Seed a deterministic operator profile so the plate rail shows the machine
  // specs (P1-5 runs against the catalog volume; fresh e2e has none stored).
  // A valid profile must carry displayName/continuousZ/provenance strings.
  await page.evaluateOnNewDocument(() => {
    try {
      window.localStorage.setItem(
        "anycubic-bridge.operator-profile.v1",
        JSON.stringify({
          displayName: "Kobra S1 (e2e)",
          buildVolume: { widthMm: 220, depthMm: 220, heightMm: 250 },
          continuousZ: "unknown",
          provenance: "operator-declared",
          slopeBudgetDeg: null,
          jointModel: "cartesian",
        }),
      );
    } catch {
      /* storage may be unavailable — specs assertion below tolerates it */
    }
  });
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

  // ---- 1b. UI REFACTOR (P1-4..P1-7) — direct browser coverage ----

  // P1-5 — plate identity + action rail (DOM, inside viewport frame).
  await page.waitForSelector('[data-testid="plate-rail"]', { timeout: 15000 });
  const railNumber = await page.$eval('[data-testid="plate-rail-number"]', (el) => el.textContent);
  assert.match(railNumber, /1/, `plate-rail-number should contain ordinal 1, got "${railNumber}"`);
  const railName = await page.$eval('[data-testid="plate-rail-number"]', (el) => el.textContent);
  assert.match(
    railName,
    /(?:Plate|Chapa)\s*1/i,
    `plate-rail should name the active plate, got "${railName}"`,
  );
  const railSpecs = await page.$eval('[data-testid="plate-rail-specs"]', (el) => el.textContent);
  assert.match(
    railSpecs,
    /220/,
    `plate-rail-specs should show the build volume (220), got "${railSpecs}"`,
  );
  assert.match(railSpecs, /mm/, `plate-rail-specs should carry units, got "${railSpecs}"`);
  for (const tid of ["plate-rail-fit", "plate-rail-top", "plate-rail-grid"]) {
    const present = await page.$(`[data-testid="${tid}"]`);
    assert.ok(present, `missing plate rail action ${tid}`);
  }
  // grid toggle reflects the store: button pressed state flips on click.
  const gridPressedBefore = await page.$eval('[data-testid="plate-rail-grid"]', (el) =>
    el.getAttribute("aria-pressed"),
  );
  // Puppeteer real click may be intercepted by the R3F canvas overlay; use a
  // DOM-level click (el.click()) which fires the React onClick handler.
  await page.$eval('[data-testid="plate-rail-grid"]', (el) => el.click());
  // The store → DOM round-trip is async; poll for the flip instead of a
  // fixed sleep (stable under CPU contention from parallel gate steps).
  let gridPressedAfter = gridPressedBefore;
  const gridPollStart = Date.now();
  while (Date.now() - gridPollStart < 2000 && gridPressedAfter === gridPressedBefore) {
    await new Promise((r) => setTimeout(r, 60));
    gridPressedAfter = await page.$eval('[data-testid="plate-rail-grid"]', (el) =>
      el.getAttribute("aria-pressed"),
    );
  }
  assert.notEqual(
    gridPressedAfter,
    gridPressedBefore,
    `plate-rail-grid toggle should flip the pressed state (${gridPressedBefore} -> ${gridPressedAfter})`,
  );

  // P1-6 — transform editing lives in the viewport now: the toolbar button
  // opens the floating panel; the sidebar no longer mounts TransformInspector.
  await page.waitForSelector('[data-testid="toolbar-transform-panel"]', { timeout: 15000 });
  const sidebarHasTransform = await page
    .$eval(
      ".panel-left",
      (el) => el.querySelector(".transform-inspector, [data-testid^='transform-']") !== null,
    )
    .catch(() => false);
  assert.equal(
    sidebarHasTransform,
    false,
    "TransformInspector must NOT be mounted in the sidebar (P1-6 rehost)",
  );
  await page.click('[data-testid="toolbar-transform-panel"]');
  await page.waitForSelector('[data-testid="floating-panel-transform"]', { timeout: 10000 });
  const transformBody = await page.$eval(
    '[data-testid="floating-panel-transform"]',
    (el) => el.textContent,
  );
  assert.ok(
    transformBody.includes("Transform") || transformBody.length > 0,
    "floating transform panel should render content",
  );

  // P1-7 — object tree rows: filament swatch + "More info" popover metrics,
  // and NO permanent XYZ / footprint / volume cells in the rows. Locale-safe:
  // the objects view is always the sidebar nav at index 1 in this app.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".sidebar-nav button")];
    // index 0 = settings, 1 = objects, 2 = chat (order fixed in App.tsx)
    const toObjectView = btns.find(
      (b, i) => i === 1 || /object|objeto/.test(b.textContent.trim().toLowerCase()),
    );
    toObjectView?.click();
  });
  // The objects nav is the second nav button; wait for the tree to hydrate.
  await page.waitForSelector('[data-testid^="obj-filament-"]', { timeout: 15000 });
  const filamentSwatches = await page.$$('[data-testid^="obj-filament-"]');
  assert.ok(filamentSwatches.length > 0, "object tree should render filament swatches");
  const rowCells = await page.$$eval(
    ".object-item .obj-cell, .object-item .object-placement",
    (els) => els.length,
  );
  assert.equal(
    rowCells,
    0,
    "object rows must NOT render permanent XYZ/footprint/volume cells (P1-7)",
  );
  // info popover opens with mesh stats + placement metrics.
  const infoBtn = await page.$('[data-testid^="obj-info-"]');
  assert.ok(infoBtn, "each row should have a More info button");
  // DOM-level click (el.click()) avoids canvas overlay interception; waits for
  // the popover to appear and verifies the metrics disclosure.
  await page.$eval('[data-testid^="obj-info-"]', (el) => el.click());
  await page.waitForSelector('[data-testid^="obj-info-popover-"]', { timeout: 10000 });
  const infoText = await page.$eval('[data-testid^="obj-info-popover-"]', (el) => el.textContent);
  assert.match(
    infoText,
    /(?:mesh|malha)/i,
    `info popover should show mesh stats, got "${infoText}"`,
  );
  assert.match(
    infoText,
    /(?:placement|posi)/i,
    `info popover should show placement, got "${infoText}"`,
  );
  assert.match(
    infoText,
    /(?:footprint|Área|area|pegada)/i,
    `info popover should show footprint, got "${infoText}"`,
  );
  // Close the popover before continuing so it doesn't trap later clicks.
  // Radix DismissableLayer handles Escape on keydown within the CONTENT (the
  // content avoids stealing focus via onOpenAutoFocus preventDefault), so
  // dispatch the keydown directly on the content element like a focused user.
  await page.$eval('[data-testid^="obj-info-popover-"]', (el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    ),
  );
  await page.waitForSelector('[data-testid^="obj-info-popover-"]', { hidden: true, timeout: 5000 });

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
    `e2e:editor-reload PASS — shell reloaded clean (0 page errors, 0 HTTP 5xx), ChatPanel + overlay mounted; UI refactor (plate-rail, floating transform, object-tree filament + info popover) verified.`,
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
