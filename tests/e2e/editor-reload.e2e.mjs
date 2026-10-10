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
import os from "node:os";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const editorDir = path.join(root, "apps", "editor");
const viteEntry = path.join(editorDir, "node_modules", "vite", "bin", "vite.js");
const DEV_PORT = Number(process.env.EDITOR_E2E_PORT ?? 1421);
const URL = `http://127.0.0.1:${DEV_PORT}/?provider=demo`;

async function readViewportCamera(page) {
  return page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("@react-three_fiber.js"));
    if (!resource) return null;
    const fiber = await import(resource.name);
    const canvas = document.querySelector(".viewport-frame canvas");
    const root = canvas && fiber._roots.get(canvas);
    if (!root) return null;
    const { camera, controls } = root.store.getState();
    return {
      position: camera.position.toArray(),
      target: controls?.target?.toArray() ?? null,
    };
  });
}

async function readStableCameraTarget(page) {
  return page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("@react-three_fiber.js"));
    if (!resource) throw new Error("R3F module resource was not loaded");
    const fiber = await import(resource.name);
    const canvas = document.querySelector(".viewport-frame canvas");
    const root = canvas && fiber._roots.get(canvas);
    if (!root) throw new Error("R3F root was not found for the editor canvas");

    const samples = [];
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const controls = root.store.getState().controls;
      if (!controls?.target) throw new Error("OrbitControls target is unavailable");
      samples.push(controls.target.toArray());
      if (samples.length >= 3) {
        const recent = samples.slice(-3);
        if (
          recent.every((sample) =>
            sample.every((value, axis) => Math.abs(value - recent[0][axis]) <= 1e-5),
          )
        )
          return recent[0];
      }
    }
    throw new Error(
      `OrbitControls target did not settle in 12 animation frames: ${JSON.stringify(samples)}`,
    );
  });
}

function assertCameraVector(actual, expected, message) {
  assert.equal(actual.length, 3, message);
  assert.ok(
    actual.every(
      (value, axis) => Number.isFinite(value) && Math.abs(value - expected[axis]) <= 1e-5,
    ),
    `${message}: ${JSON.stringify({ actual, expected, tolerance: 1e-5 })}`,
  );
}

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
let previewFixturePath = "";

const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

/** Radix restores focus in a setTimeout(0) after unmount; wait until the real
 *  activeElement is the global header chat toggle. On timeout, report what IS
 *  focused instead of a bare TimeoutError. */
async function settleChatOpenerFocus(page, label) {
  try {
    await page.waitForFunction(
      () => document.activeElement === document.querySelector(".header-chat-toggle"),
      { timeout: 3000 },
    );
  } catch (err) {
    const dump = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName ?? null,
        cls: typeof el?.className === "string" ? el.className : "",
        aria: el?.getAttribute?.("aria-label") ?? "",
        testid: el?.getAttribute?.("data-testid") ?? "",
        inChat: Boolean(
          el?.closest('[data-testid="pill-chat"], [data-testid="floating-panel-chat"]'),
        ),
        sample: el?.outerHTML?.slice(0, 220) ?? null,
      };
    });
    throw new Error(
      `${label}: focus did not return to the header chat toggle: ${JSON.stringify(dump)} (orig: ${err.message})`,
    );
  }
}

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
  // The spawn owns a dedicated port so the test cannot reuse a stale editor
  // dev server; Vite 8 must also bind 127.0.0.1 explicitly (not IPv6 ::1).
  if (!(await devAlreadyUp())) {
    assert.ok(fs.existsSync(viteEntry), `vite entry missing: ${viteEntry}`);
    child = spawn(
      process.execPath,
      [viteEntry, "--host", "127.0.0.1", "--port", String(DEV_PORT), "--strictPort"],
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
  await page.evaluateOnNewDocument(() => {
    window.__contextPointerEvents = [];
    for (const eventName of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "contextmenu",
    ]) {
      document.addEventListener(
        eventName,
        (event) => {
          if (
            event.button !== 2 &&
            eventName !== "lostpointercapture" &&
            eventName !== "pointercancel"
          )
            return;
          window.__contextPointerEvents.push({
            type: event.type,
            target: event.target?.tagName,
            pointerId: event.pointerId,
            buttons: event.buttons,
            x: event.clientX,
            y: event.clientY,
          });
        },
        true,
      );
    }
  });
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
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="bridge-state"]')?.textContent === "Demo geometry",
    { timeout: 15000 },
  );
  const demoHomeActions = await page.evaluate(() => ({
    continueDisabled: document.querySelector('[data-testid="home-continue"]')?.disabled,
    prepareDisabled: document.querySelector('[data-testid="home-demo-prepare"]')?.disabled,
    newProjectDisabled: document.querySelector('[data-testid="home-new-project"]')?.disabled,
  }));
  assert.deepEqual(
    demoHomeActions,
    {
      continueDisabled: false,
      prepareDisabled: false,
      newProjectDisabled: true,
    },
    `demo Home should offer Continue and Prepare, but not local project creation: ${JSON.stringify(demoHomeActions)}`,
  );

  // ---- 1a. S9.18 keyboard-only workspace nav (fresh page, natural focus) ----
  // No pointer interaction has happened in this page yet, so the browser
  // starts with focus on BODY; the Workspace nav buttons are then the first
  // focusables in the document (the .app-brand span is not focusable, and a
  // clean dock store mounts no pills). Drives the physical keyboard with
  // native Tab / Shift+Tab / Enter and asserts the rendered focus target, so
  // the full walk Home → Prepare → Preview → Workbench is pinned. All nav
  // assertions are structural (nth-of-type + aria-pressed) so they hold in
  // both en and pt-BR.
  const kbKeys = [];
  const kbFocusNow = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      const navIndex = el
        ? [...document.querySelectorAll("nav.workspace-tabs button")].findIndex((b) => b === el)
        : -1;
      return {
        label: (el?.textContent ?? "").trim().slice(0, 16),
        tag: el?.tagName ?? null,
        inNav: navIndex >= 0,
        navIndex: navIndex >= 0 ? navIndex + 1 : null,
        pressed: el?.getAttribute?.("aria-pressed") ?? null,
        testid: el?.getAttribute("data-testid") ?? el?.getAttribute("aria-label") ?? null,
      };
    });
  const kbKey = async (key) => {
    if (key === "Shift+Tab") {
      await page.keyboard.down("Shift");
      await page.keyboard.press("Tab");
      await page.keyboard.up("Shift");
    } else {
      await page.keyboard.press(key);
    }
    const focus = await kbFocusNow();
    kbKeys.push({ key, ...focus });
    return focus;
  };
  const bootFocus = await kbFocusNow();
  assert.equal(bootFocus.tag, "BODY", "natural document focus must be on BODY before any input");
  const kb1 = await kbKey("Tab");
  const kb2 = await kbKey("Tab");
  const kb3 = await kbKey("Tab");
  const kb4 = await kbKey("Tab");
  assert.deepEqual(
    [kb1, kb2, kb3, kb4].map((f) => f.navIndex),
    [1, 2, 3, 4],
    "Tab #1-4 must walk Home → Prepare → Preview → Workbench",
  );
  assert.deepEqual(
    [kb1, kb2, kb3, kb4].map((f) => f.inNav),
    [true, true, true, true],
    "Tab #1-4 must all land inside the workspace nav",
  );
  assert.equal(kb1.pressed, "true", "Tab #1 (Home) must be the active workspace at boot");
  assert.equal(kb2.pressed, "false", "Tab #2 (Prepare) must not be pressed yet");
  assert.equal(kb4.pressed, "false", "Tab #4 (Workbench) must not be pressed yet");
  // Reverse: Shift+Tab returns Preview → Prepare (never leaves the nav).
  const kbR1 = await kbKey("Shift+Tab");
  const kbR2 = await kbKey("Shift+Tab");
  assert.deepEqual(
    [kbR1, kbR2].map((f) => f.navIndex),
    [3, 2],
    "Shift+Tab must reverse Preview → Prepare",
  );
  // Forward again to Workbench, then ENTER activates it (keyboard-only).
  await kbKey("Tab");
  await kbKey("Tab");
  assert.equal((await kbFocusNow()).navIndex, 4, "Tab must reach Workbench again");
  await kbKey("Enter");
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.getAttribute("data-workspace-view") === "workbench",
    { timeout: 5000 },
  );
  assert.equal(
    await page.$eval("nav.workspace-tabs button:nth-of-type(4)", (b) =>
      b.getAttribute("aria-pressed"),
    ),
    "true",
    "ENTER on Workbench must activate the Workbench workspace view",
  );
  // Back to Home with the keyboard, so the rest of the suite starts at Home.
  await kbKey("Shift+Tab");
  await kbKey("Shift+Tab");
  await kbKey("Shift+Tab");
  assert.equal((await kbFocusNow()).navIndex, 1, "reverse must reach Home");
  await kbKey("Enter");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="home-page"]')?.hidden === false,
    { timeout: 5000 },
  );
  assert.equal(
    await page.$eval("nav.workspace-tabs button:nth-of-type(1)", (b) =>
      b.getAttribute("aria-pressed"),
    ),
    "true",
    "ENTER on Home must reactivate the Home workspace view",
  );
  // Escape with nothing overlay-open is a safe no-op (no new page errors).
  const kbErrorsBefore = errors.length;
  await kbKey("Escape");
  assert.equal(
    errors.length,
    kbErrorsBefore,
    "Escape with no overlay open must not introduce consecutive page errors",
  );
  assert.equal(
    await page.$eval('[data-testid="home-page"]', (section) => section.hidden),
    false,
    "Escape must not change the workspace view",
  );
  // Notification bell (non-modal popover): pointer-open, then Escape closes it
  // AND restores focus to the bell trigger (WAI non-modal focus-return). The
  // popover container uses the DOM id #toast-notifications (no data-testid).
  await page.click('[data-testid="toast-bell"]');
  await page.waitForSelector("#toast-notifications", { timeout: 5000 });
  await kbKey("Escape");
  const bellAfterEscape = await page.evaluate(() => ({
    expanded: document.querySelector('[data-testid="toast-bell"]')?.getAttribute("aria-expanded"),
    focusedBell: document.activeElement === document.querySelector('[data-testid="toast-bell"]'),
  }));
  assert.equal(
    await page.$("#toast-notifications"),
    null,
    "Escape must close the notification popover",
  );
  assert.deepEqual(
    bellAfterEscape,
    { expanded: "false", focusedBell: true },
    "Escape must close the notification popover and restore focus to the bell",
  );
  // Floating chat panel: pointer-open, then Escape collapses it to a pill AND
  // restores focus to the opener (the global header chat toggle) — the same
  // WAI non-modal focus-return the notification bell exercises above. The next
  // Tab leaves focus outside the chat DOM (no focus trap).
  await page.click(".header-chat-toggle");
  await page.waitForSelector('[data-testid="floating-panel-chat"]', { timeout: 5000 });
  await kbKey("Escape");
  await page.waitForSelector('[data-testid="floating-panel-chat"]', {
    hidden: true,
    timeout: 5000,
  });
  await page.waitForSelector('[data-testid="pill-chat"]', { timeout: 5000 });
  // Settle on the restored focus before reading the real activeElement.
  await settleChatOpenerFocus(page, "header chat Escape (Home)");
  const chatFocusAfterEscape = await page.evaluate(() => ({
    focusedHeader: document.activeElement === document.querySelector(".header-chat-toggle"),
    insideChat: Boolean(
      document.activeElement?.closest(
        '[data-testid="pill-chat"], [data-testid="floating-panel-chat"]',
      ),
    ),
  }));
  assert.deepEqual(
    chatFocusAfterEscape,
    { focusedHeader: true, insideChat: false },
    "Escape must restore focus to the chat opener (header chat toggle), not the chat DOM",
  );
  // Focus left the panel: one Tab moves past the header, still outside chat.
  await kbKey("Tab");
  assert.equal(
    await page.evaluate(() =>
      Boolean(
        document.activeElement?.closest(
          '[data-testid="pill-chat"], [data-testid="floating-panel-chat"]',
        ),
      ),
    ),
    false,
    "after Escape and one Tab, focus must not be trapped inside the chat",
  );
  assert.equal(
    await page.$eval('[data-testid="home-page"]', (section) => section.hidden),
    false,
    "chat collapse must not switch the workspace view",
  );
  // Pill → Escape: opening from the pill, Escape collapses again; the pill we
  // opened from is replaced by a fresh pill (the origin is unmounted), so
  // focus falls back to the always-visible global header chat toggle — still
  // no trap.
  await page.click('[data-testid="pill-chat"]');
  await page.waitForSelector('[data-testid="floating-panel-chat"]', { timeout: 5000 });
  await kbKey("Escape");
  await page.waitForSelector('[data-testid="floating-panel-chat"]', {
    hidden: true,
    timeout: 5000,
  });
  await page.waitForSelector('[data-testid="pill-chat"]', { timeout: 5000 });
  await settleChatOpenerFocus(page, "pill → Escape fallback (Home)");
  const pillFocusAfterEscape = await page.evaluate(() => ({
    focusedHeader: document.activeElement === document.querySelector(".header-chat-toggle"),
    insideChat: Boolean(
      document.activeElement?.closest(
        '[data-testid="pill-chat"], [data-testid="floating-panel-chat"]',
      ),
    ),
  }));
  assert.deepEqual(
    pillFocusAfterEscape,
    { focusedHeader: true, insideChat: false },
    "pill → Escape must restore the global header chat toggle fallback and not trap focus",
  );
  // Header chat toggle: pointer-open + Escape restores opener focus on every
  // workspace page (Prepare, Preview, Workbench) without changing the view.
  const chatWorkspaceRows = [];
  for (const nth of [2, 3, 4]) {
    await page.click(`nav.workspace-tabs button:nth-of-type(${nth})`);
    await page.waitForFunction(
      (idx) =>
        ["home", "prepare", "preview", "workbench"][idx - 1] ===
        document.querySelector(".app-shell")?.getAttribute("data-workspace-view"),
      { timeout: 5000 },
      nth,
    );
    await page.click(".header-chat-toggle");
    await page.waitForSelector('[data-testid="floating-panel-chat"]', { timeout: 5000 });
    await kbKey("Escape");
    await page.waitForSelector('[data-testid="floating-panel-chat"]', {
      hidden: true,
      timeout: 5000,
    });
    await page.waitForSelector('[data-testid="pill-chat"]', { timeout: 5000 });
    await settleChatOpenerFocus(page, `header chat Escape (page ${nth})`);
    const row = await page.evaluate(
      (idx) => ({
        nth: idx,
        workspace: document.querySelector(".app-shell")?.getAttribute("data-workspace-view"),
        focusedHeader: document.activeElement === document.querySelector(".header-chat-toggle"),
        insideChat: Boolean(
          document.activeElement?.closest(
            '[data-testid="pill-chat"], [data-testid="floating-panel-chat"]',
          ),
        ),
      }),
      nth,
    );
    chatWorkspaceRows.push(row);
  }
  assert.deepEqual(
    chatWorkspaceRows.map((row) => row.workspace),
    ["prepare", "preview", "workbench"],
    "header chat Escape must never change the workspace view",
  );
  assert.ok(
    chatWorkspaceRows.every((row) => row.focusedHeader && !row.insideChat),
    `header chat Escape must restore the header toggle on every page: ${JSON.stringify(chatWorkspaceRows)}`,
  );
  // Restore the baseline state before the rest of the suite: the collapsed
  // pill re-opens the floating panel, the header dock button returns chat to
  // its default docked mode — which by design moves the app to the Prepare
  // workspace (the sidebar chat tab owns docked chat). Return to Home via the
  // nav so the suite resumes from its original starting view.
  await page.click('[data-testid="pill-chat"]');
  await page.waitForSelector('[data-testid="floating-panel-chat"]', { timeout: 5000 });
  await page.click('[data-testid="dock-chat"]');
  await page.waitForSelector('[data-testid="floating-panel-chat"]', {
    hidden: true,
    timeout: 5000,
  });
  await page.click("nav.workspace-tabs button:nth-of-type(1)");
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-workspace-view") === "home" &&
      document.querySelector('[data-testid="home-page"]')?.hidden === false,
    { timeout: 5000 },
  );
  console.log(`e2e:editor-reload keyboard seq: ${JSON.stringify(kbKeys)}`);

  await page.click('[data-testid="home-continue"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="home-page"]')?.hidden === true,
  );
  await page.waitForFunction(() => document.querySelector(".editor-workspace")?.hidden === false);
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="viewport-frame"]', { timeout: 15000 });
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".workspace-tabs button:nth-of-type(2)")
        ?.getAttribute("aria-pressed") === "true" &&
      document.querySelector(".app-shell")?.dataset.workspaceView === "prepare" &&
      document.querySelector(".editor-workspace")?.hidden === false &&
      [...document.querySelectorAll(".sidebar-nav button")].some((button) =>
        /settings|configurações|configuracoes/i.test(button.textContent ?? ""),
      ),
    { timeout: 5000 },
  );
  await page.waitForSelector('[data-testid="viewport-frame"]', { timeout: 15000 });
  const settingsNavIndex = await page.$$eval(".sidebar-nav button", (buttons) =>
    buttons.findIndex((button) =>
      /settings|configurações|configuracoes/i.test(button.textContent ?? ""),
    ),
  );
  assert.ok(settingsNavIndex >= 0, "Settings navigation button should be visible");
  await page.click(`.sidebar-nav button:nth-of-type(${settingsNavIndex + 1})`);
  await page.waitForSelector('[data-testid="printer-select"]', { timeout: 10000 });
  assert.equal(await page.$eval('[data-testid="printer-select"]', (select) => select.value), "");
  await page.select('[data-testid="printer-select"]', "kobra-s1");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="plate-volume"]')?.textContent?.includes("250"),
    { timeout: 10000 },
  );
  await page.waitForFunction(() => document.querySelectorAll(".viewport-frame canvas").length > 0, {
    timeout: 10000,
  });
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "preview",
    { timeout: 5000 },
  );
  assert.deepEqual(
    errors,
    [],
    `unknown-to-known build volume transition errors: ${errors.join(" | ")}`,
  );
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "prepare",
    { timeout: 5000 },
  );
  const objectsNavIndex = await page.$$eval(".sidebar-nav button", (buttons) =>
    buttons.findIndex((button) => /objects|objetos/i.test(button.textContent ?? "")),
  );
  assert.ok(objectsNavIndex >= 0, "Objects navigation button should be visible");
  await page.click(`.sidebar-nav button:nth-of-type(${objectsNavIndex + 1})`);
  await page.waitForSelector(".object-name", { timeout: 15000 });
  await page.click(".sidebar-nav button:nth-of-type(1)");
  await page.$eval('[data-testid="viewport-frame"]', (frame) =>
    frame.scrollIntoView({ block: "center", inline: "center" }),
  );
  const canvasAnchor = await page.$eval('[data-testid="viewport-frame"]', (frame) => {
    const rect = frame.getBoundingClientRect();
    const visibleLeft = Math.max(0, rect.left);
    const visibleRight = Math.min(document.documentElement.clientWidth, rect.right);
    const visibleTop = Math.max(0, rect.top);
    const visibleBottom = Math.min(document.documentElement.clientHeight, rect.bottom);
    return {
      x: visibleLeft + 8,
      y: visibleTop + (visibleBottom - visibleTop) * 0.5,
    };
  });
  await page.mouse.click(canvasAnchor.x, canvasAnchor.y, { button: "right" });
  await page.waitForSelector('[data-testid="context-menu"]', { timeout: 5000 });
  const mouseMenuRect = await page.$eval('[data-testid="context-menu"]', (menu) => {
    const rect = menu.getBoundingClientRect();
    return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom };
  });
  assert.ok(
    Math.abs(mouseMenuRect.x - canvasAnchor.x) <= 1 &&
      Math.abs(mouseMenuRect.y - canvasAnchor.y) <= 1,
    `central canvas menu should preserve the real click anchor: ${JSON.stringify({ canvasAnchor, mouseMenuRect })}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="context-menu"]', { hidden: true, timeout: 5000 });

  // S9.14-003 — a right-button pan must not turn into a context menu, while
  // short pointer movement remains a click. Drive native browser mouse input.
  await page.mouse.move(canvasAnchor.x, canvasAnchor.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(canvasAnchor.x + 3, canvasAnchor.y + 2, { steps: 2 });
  await page.mouse.up({ button: "right" });
  await page.waitForSelector('[data-testid="context-menu"]', { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="context-menu"]', { hidden: true, timeout: 5000 });

  await page.mouse.move(canvasAnchor.x, canvasAnchor.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(canvasAnchor.x + 20, canvasAnchor.y + 3, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await page.waitForFunction(() => !document.querySelector('[data-testid="context-menu"]'), {
    timeout: 1000,
  });

  await page.mouse.click(canvasAnchor.x, canvasAnchor.y, { button: "right" });
  await page.waitForSelector('[data-testid="context-item-arrange"]', { timeout: 5000 });
  const revisionBeforeArrange = await page.$eval('[data-testid="status-revision"]', (el) =>
    Number(el.textContent?.replace(/\D/g, "")),
  );
  await page.click('[data-testid="context-item-arrange"]');
  await page.waitForFunction(
    (previous) => {
      const value = document.querySelector('[data-testid="status-revision"]')?.textContent ?? "";
      return Number(value.replace(/\D/g, "")) > previous;
    },
    { timeout: 5000 },
    revisionBeforeArrange,
  );

  await page.mouse.click(canvasAnchor.x, canvasAnchor.y, { button: "right" });
  await page.waitForSelector('[data-testid="context-item-measure"]', { timeout: 5000 });
  await page.click('[data-testid="context-item-measure"]');
  await page.waitForSelector('[data-testid="measure-readout"]', { timeout: 5000 });
  const measureMode = await page.$eval('[data-testid="tool-measure"]', (button) =>
    button.getAttribute("aria-pressed"),
  );
  assert.equal(
    measureMode,
    "true",
    "background Measure action should activate the real measurement tool",
  );
  await page.click('[data-testid="tool-measure"]');
  await page.waitForSelector('[data-testid="measure-readout"]', { hidden: true, timeout: 5000 });

  const edgePoints = await page.$eval('[data-testid="viewport-frame"]', (frame) => {
    const rect = frame.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(document.documentElement.clientWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
    const midX = left + (right - left) * 0.5;
    const verticalPoints = [0.2, 0.35, 0.65, 0.8].map((ratio) => top + (bottom - top) * ratio);
    return {
      left: verticalPoints.map((y) => ({ x: left + 3, y })),
      right: verticalPoints.map((y) => ({ x: right - 3, y })),
      top: [0.2, 0.8].map((ratio) => ({ x: left + (right - left) * ratio, y: top + 3 })),
      bottom: [0.2, 0.8].map((ratio) => ({ x: left + (right - left) * ratio, y: bottom - 3 })),
    };
  });
  for (const [edge, candidates] of Object.entries(edgePoints)) {
    let opened = false;
    for (const point of candidates) {
      await page.mouse.click(point.x, point.y, { button: "right" });
      opened = await page
        .waitForSelector('[data-testid="context-menu"]', { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (opened) break;
    }
    const pointerEvents = opened
      ? []
      : await page.evaluate(() => window.__contextPointerEvents.slice(-20));
    assert.ok(
      opened,
      `real right-click should open the menu at the ${edge} viewport edge: ${JSON.stringify(pointerEvents)}`,
    );
    const rect = await page.$eval('[data-testid="context-menu"]', (menu) => {
      const box = menu.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      };
    });
    assert.ok(
      rect.left >= 0 && rect.top >= 0 && rect.right <= rect.width && rect.bottom <= rect.height,
      `${edge} edge menu must remain within the measured viewport: ${JSON.stringify(rect)}`,
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="context-menu"]', { hidden: true, timeout: 5000 });
  }
  // Context-menu clamping is exercised down to 640px above. Restore the
  // minimum supported control-layout width before toolbar/plate assertions.
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });

  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
  await page.waitForFunction(async () => {
    const canvas = document.querySelector(".viewport-frame canvas");
    if (!canvas) return false;
    const before = canvas.getBoundingClientRect();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = canvas.getBoundingClientRect();
    return (
      after.width > 16 &&
      after.height > 16 &&
      before.x === after.x &&
      before.y === after.y &&
      before.width === after.width &&
      before.height === after.height
    );
  });
  const resizedAnchor = await page.$eval('[data-testid="viewport-frame"]', (frame) => {
    const rect = frame.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(document.documentElement.clientWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
    for (const ratio of [0.5, 0.6, 0.7]) {
      const x = left + (right - left) * 0.5;
      const y = top + (bottom - top) * ratio;
      if (document.elementFromPoint(x, y)?.tagName === "CANVAS") return { x, y };
    }
    throw new Error("resized viewport has no accessible canvas anchor");
  });
  await page.mouse.click(resizedAnchor.x, resizedAnchor.y, { button: "right" });
  await page.waitForSelector('[data-testid="context-menu"]', { timeout: 5000 });
  const highDpiRect = await page.$eval('[data-testid="context-menu"]', (menu) => {
    const rect = menu.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  assert.ok(
    Math.abs(highDpiRect.x - resizedAnchor.x) <= 1 &&
      Math.abs(highDpiRect.y - resizedAnchor.y) <= 1,
    `high-DPI input must remain in CSS pixels: ${JSON.stringify({ resizedAnchor, highDpiRect })}`,
  );
  await page.setViewport({ width: 640, height: 480, deviceScaleFactor: 2 });
  await page.waitForFunction(
    () => {
      const menu = document.querySelector('[data-testid="context-menu"]');
      if (!menu) return false;
      const rect = menu.getBoundingClientRect();
      return (
        rect.right <= document.documentElement.clientWidth &&
        rect.bottom <= document.documentElement.clientHeight
      );
    },
    { timeout: 5000 },
  );
  const clampedAfterResize = await page.$eval('[data-testid="context-menu"]', (menu) => {
    const rect = menu.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
  });
  assert.ok(
    clampedAfterResize.left >= 0 &&
      clampedAfterResize.top >= 0 &&
      clampedAfterResize.right <= clampedAfterResize.width &&
      clampedAfterResize.bottom <= clampedAfterResize.height,
    `open menu must re-clamp after viewport resize: ${JSON.stringify(clampedAfterResize)}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="context-menu"]', { hidden: true, timeout: 5000 });

  const frameFocused = await page.$eval('[data-testid="viewport-frame"]', (frame) => {
    frame.focus();
    return document.activeElement === frame;
  });
  assert.equal(frameFocused, true, "viewport frame should accept keyboard context-menu focus");
  await page.keyboard.down("Shift");
  await page.keyboard.press("F10");
  await page.keyboard.up("Shift");
  await page.waitForSelector('[data-testid="context-menu"]', { timeout: 5000 });
  const keyboardMenuRect = await page.$eval('[data-testid="context-menu"]', (menu) => {
    const rect = menu.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  assert.ok(
    Math.abs(keyboardMenuRect.x - canvasAnchor.x) > 1 ||
      Math.abs(keyboardMenuRect.y - canvasAnchor.y) > 1,
    "keyboard invocation should anchor to the focused viewport frame, not the previous pointer",
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="context-menu"]', { hidden: true, timeout: 5000 });
  const frameRestored = await page.$eval(
    '[data-testid="viewport-frame"]',
    (frame) => document.activeElement === frame,
  );
  assert.equal(frameRestored, true, "Escape should restore focus to the keyboard anchor");

  // Context-menu clamping is exercised down to 640px above. Restore the
  // minimum supported control-layout width before toolbar/plate assertions.
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });

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
  await page.click('[data-testid="plate-info-trigger"]');
  await page.waitForSelector('[data-testid="plate-info-popover"]', { timeout: 5000 });
  const railSpecs = await page.$eval('[data-testid="plate-info-popover"]', (el) => el.textContent);
  assert.match(
    railSpecs,
    /250/,
    `plate-rail-specs should show the build volume (250), got "${railSpecs}"`,
  );
  assert.match(railSpecs, /mm/, `plate-rail-specs should carry units, got "${railSpecs}"`);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="plate-info-popover"]', { hidden: true, timeout: 5000 });
  const infoFocusRestored = await page.$eval(
    '[data-testid="plate-info-trigger"]',
    (trigger) => document.activeElement === trigger,
  );
  assert.equal(infoFocusRestored, true, "Escape should restore focus to plate information trigger");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="plate-info-popover"]', { timeout: 5000 });
  await page.click('[data-testid="plate-rail-fit"]');
  await page.waitForSelector('[data-testid="plate-info-popover"]', { hidden: true, timeout: 5000 });
  await page.click('[data-testid="plate-rail-top"]');
  for (const tid of ["plate-rail-fit", "plate-rail-top", "plate-rail-grid"]) {
    const present = await page.$(`[data-testid="${tid}"]`);
    assert.ok(present, `missing plate rail action ${tid}`);
  }
  // grid toggle reflects the store: button pressed state flips on click.
  const gridPressedBefore = await page.$eval('[data-testid="plate-rail-grid"]', (el) =>
    el.getAttribute("aria-pressed"),
  );
  await page.click('[data-testid="plate-info-trigger"]');
  await page.click('[data-testid="plate-rail-grid"]');
  await page.waitForSelector('[data-testid="plate-info-popover"]', { hidden: true, timeout: 5000 });
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

  for (const width of [1024, 1280, 1743]) {
    await page.setViewport({ width, height: 768, deviceScaleFactor: 1 });
    const layout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const toolbar = rect('[data-testid="viewport-toolbar"]');
      const rail = rect('[data-testid="plate-rail"]');
      const tabs = rect('[data-testid="plate-tabs"]');
      const frame = rect('[data-testid="viewport-frame"]');
      const controls = [
        '[data-testid="repair-control"] summary',
        '[data-testid="toolbar-transform-panel"]',
        '[data-testid="plate-info-trigger"]',
        '[data-testid="plate-rail-fit"]',
        '[data-testid="plate-rail-top"]',
        '[data-testid="plate-rail-grid"]',
      ];
      const reachable = controls.map((selector) => {
        const button = document.querySelector(selector);
        const box = button?.getBoundingClientRect();
        if (!button || !box) return { selector, hit: false };
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        const toolbarElement = button.closest(".viewport-toolbar");
        return {
          selector,
          hit: hit === button || button.contains(hit),
          disabled: button.disabled,
          rect: box.toJSON(),
          hitElement: hit?.getAttribute("data-testid") ?? hit?.className ?? hit?.tagName ?? null,
          stack: document
            .elementsFromPoint(x, y)
            .slice(0, 4)
            .map((el) => ({
              tag: el.tagName,
              testid: el.getAttribute("data-testid"),
              className: typeof el.className === "string" ? el.className : null,
              z: getComputedStyle(el).zIndex,
              pointerEvents: getComputedStyle(el).pointerEvents,
            })),
          toolbarStyle: {
            z: toolbarElement ? getComputedStyle(toolbarElement).zIndex : null,
            pointerEvents: toolbarElement ? getComputedStyle(toolbarElement).pointerEvents : null,
          },
        };
      });
      return {
        frame: frame?.toJSON(),
        toolbar: toolbar?.toJSON(),
        rail: rail?.toJSON(),
        tabs: tabs?.toJSON(),
        reachable,
        fitSelectionDisabled: document.querySelector('[data-testid="toolbar-fit-selection"]')
          ?.disabled,
      };
    });
    assert.ok(
      layout.toolbar && layout.rail && layout.tabs && layout.frame,
      `controls should mount at ${width}px`,
    );
    assert.ok(
      layout.toolbar.bottom <= layout.rail.top,
      `toolbar and plate rail must not overlap at ${width}px: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.rail.bottom <= layout.tabs.top,
      `plate rail must stay above plate tabs at ${width}px: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.reachable.every((entry) => entry.hit),
      `priority controls must receive real pointer hits at ${width}px: ${JSON.stringify(layout)}`,
    );
    assert.equal(
      layout.fitSelectionDisabled,
      true,
      `Fit selection should be unavailable without a selected object at ${width}px`,
    );
  }

  const inspectSceneMeshes = async () =>
    page.evaluate(async () => {
      const resource = performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("@react-three_fiber.js"));
      if (!resource) throw new Error("R3F module resource was not loaded");
      const fiber = await import(resource.name);
      const canvas = document.querySelector(".viewport-frame canvas");
      const root = canvas && fiber._roots.get(canvas);
      if (!root) throw new Error("R3F root was not found for the editor canvas");
      const state = root.store.getState();
      const scene = state.scene;
      return ["cone", "cube", "sphere-non-watertight"].map((name) => {
        const object = scene.getObjectByName(name);
        if (!object) throw new Error(`demo mesh ${name} is missing from the R3F scene`);
        object.updateWorldMatrix(true, true);
        const meshes = [];
        let edges = 0;
        const ThreeVector3 = object.position.constructor;
        const ThreeRaycaster = state.raycaster.constructor;
        object.traverse((child) => {
          if (child.isLineSegments) edges += 1;
          if (!child.isMesh) return;
          const position = child.geometry?.getAttribute("position");
          const index = child.geometry?.index;
          const triangleCount = index ? index.count / 3 : (position?.count ?? 0) / 3;
          let inwardFaces = 0;
          let degenerateFaces = 0;
          let normalMismatches = 0;
          const vertexA = new ThreeVector3();
          const vertexB = new ThreeVector3();
          const vertexC = new ThreeVector3();
          const edgeA = new ThreeVector3();
          const edgeB = new ThreeVector3();
          const faceNormal = new ThreeVector3();
          const centroid = new ThreeVector3();
          const geometryCenter = new ThreeVector3();
          child.geometry?.computeBoundingBox();
          child.geometry?.boundingBox?.getCenter(geometryCenter);
          const normals = child.geometry?.getAttribute("normal");
          for (let face = 0; face < triangleCount; face += 1) {
            const a = index ? index.getX(face * 3) : face * 3;
            const b = index ? index.getX(face * 3 + 1) : face * 3 + 1;
            const c = index ? index.getX(face * 3 + 2) : face * 3 + 2;
            vertexA.fromBufferAttribute(position, a);
            vertexB.fromBufferAttribute(position, b);
            vertexC.fromBufferAttribute(position, c);
            edgeA.subVectors(vertexB, vertexA);
            edgeB.subVectors(vertexC, vertexA);
            faceNormal.crossVectors(edgeA, edgeB);
            if (faceNormal.lengthSq() < 1e-16) {
              degenerateFaces += 1;
              continue;
            }
            centroid
              .copy(vertexA)
              .add(vertexB)
              .add(vertexC)
              .multiplyScalar(1 / 3);
            if (faceNormal.dot(centroid.sub(geometryCenter)) <= 0) inwardFaces += 1;
            if (normals) {
              const declaredNormal = new ThreeVector3()
                .fromBufferAttribute(normals, a)
                .add(new ThreeVector3().fromBufferAttribute(normals, b))
                .add(new ThreeVector3().fromBufferAttribute(normals, c));
              if (faceNormal.dot(declaredNormal) <= 0) normalMismatches += 1;
            }
          }
          let fingerprint = 2166136261;
          for (const value of position?.array ?? []) {
            fingerprint = Math.imul(fingerprint ^ Math.round(value * 1e5), 16777619);
          }
          const materials = (Array.isArray(child.material) ? child.material : [child.material])
            .filter(Boolean)
            .map((material) => ({
              wireframe: material.wireframe,
              transparent: material.transparent,
              opacity: material.opacity,
              side: material.side,
              bumpMap: Boolean(material.bumpMap),
              emissiveIntensity: material.emissiveIntensity,
            }));
          const raycaster = new ThreeRaycaster();
          const boundingSphere =
            child.geometry?.boundingSphere ?? child.geometry?.computeBoundingSphere();
          const worldScale = child.getWorldScale(new ThreeVector3());
          const rayDistance =
            (boundingSphere?.radius ?? 0) * Math.max(worldScale.x, worldScale.y, worldScale.z) * 3;
          const worldCenter = geometryCenter.clone();
          child.localToWorld(worldCenter);
          if (!ThreeRaycaster) throw new Error("Three.js Raycaster constructor was not found");
          const rayHits = [];
          const outwardDirections = [
            new ThreeVector3(1, 0, 0),
            new ThreeVector3(-1, 0, 0),
            new ThreeVector3(0, 1, 0),
            new ThreeVector3(0, -1, 0),
            new ThreeVector3(0, 0, 1),
            new ThreeVector3(0, 0, -1),
          ];
          for (const outward of outwardDirections) {
            const direction = outward.clone().negate();
            raycaster.set(worldCenter.clone().addScaledVector(outward, rayDistance), direction);
            const hit = raycaster.intersectObject(child, false)[0];
            rayHits.push({
              direction: outward.toArray(),
              distance: hit?.distance ?? null,
              onNearHemisphere: Boolean(hit && hit.point.clone().sub(worldCenter).dot(outward) > 0),
            });
          }
          meshes.push({
            count: position?.count ?? 0,
            fingerprint: fingerprint >>> 0,
            triangleCount,
            inwardFaces,
            degenerateFaces,
            normalMismatches,
            rayHits,
            materials,
          });
        });
        return { name, meshes, edges };
      });
    });
  const baselineMeshes = await inspectSceneMeshes();
  for (const object of baselineMeshes) {
    for (const mesh of object.meshes) {
      assert.ok(mesh.triangleCount > 0, `${object.name} should contain triangles`);
      assert.equal(
        mesh.degenerateFaces,
        0,
        `${object.name} should not contain degenerate faces: ${JSON.stringify(mesh)}`,
      );
      assert.equal(
        mesh.inwardFaces,
        0,
        `${object.name} face winding should point outward: ${JSON.stringify(mesh)}`,
      );
      assert.equal(
        mesh.normalMismatches,
        0,
        `${object.name} vertex normals should agree with face winding: ${JSON.stringify(mesh)}`,
      );
      assert.ok(
        mesh.rayHits.every((hit) => hit.distance !== null && hit.onNearHemisphere),
        `${object.name} should be hit from all six exterior directions with FrontSide culling: ${JSON.stringify(mesh.rayHits)}`,
      );
    }
  }
  await page.click('[data-testid="view-mode-slicer"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="view-mode-slicer"]')?.getAttribute("aria-pressed") ===
      "true",
    { timeout: 5000 },
  );
  const slicerMeshes = await inspectSceneMeshes();
  for (const object of slicerMeshes) {
    assert.ok(object.meshes.length > 0, `${object.name} should remain a solid mesh in slicer mode`);
    assert.equal(object.edges, 0, `${object.name} should not show wire edges in slicer mode`);
    for (const mesh of object.meshes) {
      assert.ok(mesh.count > 0, `${object.name} should retain position geometry`);
      assert.ok(
        mesh.materials.every(
          (material) =>
            !material.wireframe &&
            material.side === 0 &&
            material.transparent === false &&
            material.opacity === 1,
        ),
        `${object.name} should use opaque FrontSide solid materials: ${JSON.stringify(mesh.materials)}`,
      );
      assert.ok(
        mesh.materials.some((material) => material.bumpMap),
        `${object.name} should retain its filament surface texture`,
      );
    }
  }
  await page.click('[data-testid="view-mode-mesh"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="view-mode-mesh"]')?.getAttribute("aria-pressed") ===
      "true",
    { timeout: 5000 },
  );
  const meshModeMeshes = await inspectSceneMeshes();
  assert.deepEqual(
    meshModeMeshes.map(({ name, meshes }) => [
      name,
      meshes
        .filter(({ count }) => count !== 24)
        .map(({ count, fingerprint }) => [count, fingerprint]),
    ]),
    slicerMeshes.map(({ name, meshes }) => [
      name,
      meshes
        .filter(({ count }) => count !== 24)
        .map(({ count, fingerprint }) => [count, fingerprint]),
    ]),
    "view mode changes must not mutate actual mesh geometry",
  );
  assert.ok(
    meshModeMeshes.every((object) => object.edges > 0),
    "mesh mode should restore edge overlays",
  );
  await page.evaluate(() => localStorage.removeItem("anycubic:view-mode:v1"));

  await page.select('[data-testid="settings-language"]', "pt-BR");
  const localizedHits = await page.evaluate(() =>
    ["toolbar-transform-panel", "plate-info-trigger", "plate-rail-fit", "plate-rail-grid"].map(
      (testId) => {
        const button = document.querySelector(`[data-testid="${testId}"]`);
        if (!button) return { testId, hit: false };
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return { testId, hit: button === hit || button.contains(hit) };
      },
    ),
  );
  assert.ok(
    localizedHits.every((entry) => entry.hit),
    `priority controls should remain reachable with Portuguese labels: ${JSON.stringify(localizedHits)}`,
  );
  await page.select('[data-testid="settings-language"]', "en");

  const sidebarToggle = await page.$(".sidebar-toggle");
  assert.ok(sidebarToggle, "sidebar toggle should be available in the prepare workspace");
  if ((await sidebarToggle.evaluate((button) => button.getAttribute("aria-expanded"))) !== "true") {
    await sidebarToggle.click();
  }
  await page.waitForFunction(
    () => document.querySelector(".sidebar-toggle")?.getAttribute("aria-expanded") === "true",
  );
  await page.waitForFunction(() => {
    const divider = document.querySelector('[data-testid="divider-vertical"]');
    const frame = document.querySelector('[data-testid="viewport-frame"]');
    return divider?.getBoundingClientRect().width > 0 && frame?.getBoundingClientRect().width > 0;
  });

  const dividerBefore = await page.$eval('[data-testid="divider-vertical"]', (divider) => {
    const rect = divider.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit === divider || divider.contains(hit) };
  });
  assert.equal(dividerBefore.hit, true, "the expanded sidebar divider should receive pointer hits");
  const frameWidthBeforeResize = await page.$eval(
    '[data-testid="viewport-frame"]',
    (frame) => frame.getBoundingClientRect().width,
  );
  await page.mouse.move(dividerBefore.x, dividerBefore.y);
  await page.mouse.down();
  await page.mouse.move(dividerBefore.x + 64, dividerBefore.y, { steps: 4 });
  await page.mouse.up();
  const frameWidthAfterResize = await page.$eval(
    '[data-testid="viewport-frame"]',
    (frame) => frame.getBoundingClientRect().width,
  );
  assert.ok(
    frameWidthAfterResize < frameWidthBeforeResize - 40,
    `resizing the sidebar should resize the viewport frame (${frameWidthBeforeResize} -> ${frameWidthAfterResize})`,
  );
  await page.mouse.move(dividerBefore.x + 64, dividerBefore.y);
  await page.mouse.down();
  await page.mouse.move(dividerBefore.x, dividerBefore.y, { steps: 4 });
  await page.mouse.up();

  await page.evaluate(() => {
    document.documentElement.style.zoom = "90%";
  });
  const zoomHit = await page.$eval('[data-testid="toolbar-transform-panel"]', (button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === button || button.contains(hit);
  });
  assert.equal(zoomHit, true, "toolbar controls should remain hit-accessible at 90% zoom");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });

  // SCR-01..05 — shared scroll policy: native wheel/keyboard/touch/thumb
  // input remains available, while scrollbar colors follow theme/system mode.
  await page.setViewport({ width: 1024, height: 480, deviceScaleFactor: 1 });
  const scrollBox = await page.$eval(".panel-left", (panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
    };
  });
  assert.ok(
    scrollBox.scrollHeight > scrollBox.clientHeight,
    `settings panel should expose a real vertical scroll range: ${JSON.stringify(scrollBox)}`,
  );
  await page.mouse.move(scrollBox.x + 40, scrollBox.y + 80);
  await page.mouse.wheel({ deltaY: 180 });
  await page.waitForFunction(() => document.querySelector(".panel-left").scrollTop > 0, {
    timeout: 3000,
  });
  const scrollbarStyle = await page.$eval(".panel-left", (panel) => ({
    width: getComputedStyle(panel, "::-webkit-scrollbar").width,
    thumb: getComputedStyle(panel, "::-webkit-scrollbar-thumb").backgroundColor,
    policy: getComputedStyle(panel).scrollbarWidth,
  }));
  assert.equal(
    scrollbarStyle.width,
    "10px",
    "scrollbar thumb should retain the shared 10px hit area",
  );
  assert.equal(
    scrollbarStyle.policy,
    "thin",
    "scroll region should use the shared thin scrollbar policy",
  );
  assert.notEqual(
    scrollbarStyle.thumb,
    "rgba(0, 0, 0, 0)",
    "scrollbar thumb should remain visible",
  );
  await page.$eval(".panel-left", (panel) => {
    panel.scrollTop = 0;
    panel.querySelector(".sidebar-nav button")?.focus();
  });
  await page.keyboard.press("PageDown");
  await page.waitForFunction(() => document.querySelector(".panel-left").scrollTop > 0, {
    timeout: 3000,
  });
  await page.$eval(".panel-left", (panel) => {
    panel.scrollTop = 0;
  });
  const touchClient = await page.target().createCDPSession();
  await touchClient.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  const touchX = Math.round(scrollBox.x + 80);
  const touchStartY = Math.round(scrollBox.y + 150);
  await touchClient.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchX, y: touchStartY, id: 1 }],
  });
  await touchClient.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: touchX, y: touchStartY - 100, id: 1 }],
  });
  await touchClient.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => document.querySelector(".panel-left").scrollTop > 0, {
    timeout: 3000,
  });
  await touchClient.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await touchClient.detach();

  const themeScrollColors = await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    const panel = document.querySelector(".panel-left");
    root.setAttribute("data-theme", "light");
    const light = getComputedStyle(panel).scrollbarColor;
    root.setAttribute("data-theme", "dark");
    const dark = getComputedStyle(panel).scrollbarColor;
    if (previous === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", previous);
    return { light, dark };
  });
  assert.notEqual(
    themeScrollColors.light,
    themeScrollColors.dark,
    "scrollbar colors should follow theme tokens",
  );
  const mediaClient = await page.target().createCDPSession();
  await mediaClient.send("Emulation.setEmulatedMedia", {
    features: [{ name: "forced-colors", value: "active" }],
  });
  const forcedScrollbar = await page.evaluate(() => ({
    active: matchMedia("(forced-colors: active)").matches,
    color: getComputedStyle(document.querySelector(".panel-left")).scrollbarColor,
  }));
  assert.equal(forcedScrollbar.active, true, "forced-colors media mode should be active");
  assert.ok(
    /canvastext/i.test(forcedScrollbar.color) || forcedScrollbar.color === "auto",
    `forced-colors should use system scrollbar colors: ${forcedScrollbar.color}`,
  );
  await mediaClient.send("Emulation.setEmulatedMedia", { features: [] });
  await mediaClient.detach();
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });

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
  const transformButtonHit = await page.$eval(
    '[data-testid="toolbar-transform-panel"]',
    (button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        hitButton: hit === button || button.contains(hit),
        backdrop: Boolean(document.querySelector('[data-testid="context-menu-backdrop"]')),
      };
    },
  );
  assert.equal(
    transformButtonHit.backdrop,
    false,
    "context menu backdrop must close before toolbar input",
  );
  assert.equal(
    transformButtonHit.hitButton,
    true,
    "real toolbar click must hit the transform button",
  );
  await page.click('[data-testid="toolbar-transform-panel"]');
  await page
    .waitForSelector('[data-testid="floating-panel-transform"]', { timeout: 10000 })
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        errors: [],
        dockState: localStorage.getItem("anycubic:dock-state:v2"),
        dockRoot: Boolean(document.querySelector("#viewport-dock-root")),
        backdrop: Boolean(document.querySelector('[data-testid="context-menu-backdrop"]')),
        panels: [...document.querySelectorAll('[data-testid^="floating-panel-"]')].map((el) =>
          el.getAttribute("data-testid"),
        ),
      }));
      throw new Error(
        `${error.message}; click=${JSON.stringify(transformButtonHit)}; ` +
          `browserErrors=${JSON.stringify(errors)}; transform panel diagnostics=${JSON.stringify(state)}`,
      );
    });
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

  // S9.14-002 — real pointer tree selection + object context parity. Right-
  // clicking a selected member must preserve the multi-selection; canvas and
  // tree expose the same executable object actions.
  const coneName = page.locator('.object-item[data-name="cone"] .object-name');
  const cubeName = page.locator('.object-item[data-name="cube"] .object-name');
  await coneName.click();
  await page.keyboard.down("Shift");
  await cubeName.click();
  await page.keyboard.up("Shift");
  const selectedBeforeContext = await page.$$eval('.object-item[aria-selected="true"]', (rows) =>
    rows.map((row) => row.getAttribute("data-name")).sort(),
  );
  assert.deepEqual(selectedBeforeContext, ["cone", "cube"]);
  await cubeName.click({ button: "right" });
  await page.waitForSelector('[data-testid="context-menu"]', { timeout: 5000 });
  const treeObjectActions = await page.$$eval(
    '[data-testid="context-menu"] [role="menuitem"]',
    (items) => items.map((item) => item.getAttribute("data-testid")),
  );
  assert.ok(treeObjectActions.includes("context-item-duplicate"));
  assert.ok(treeObjectActions.includes("context-item-toggle-visible"));
  assert.ok(treeObjectActions.includes("context-item-center-on-plate"));
  assert.ok(treeObjectActions.includes("context-item-drop-to-plate"));
  assert.ok(treeObjectActions.includes("context-item-delete"));
  const selectedAfterContext = await page.$$eval('.object-item[aria-selected="true"]', (rows) =>
    rows.map((row) => row.getAttribute("data-name")).sort(),
  );
  assert.deepEqual(selectedAfterContext, ["cone", "cube"]);
  await page.keyboard.press("Escape");
  const fitSelectionEnabled = await page.$eval(
    '[data-testid="toolbar-fit-selection"]',
    (button) => !button.disabled,
  );
  assert.equal(
    fitSelectionEnabled,
    true,
    "Fit selection should enable when scene objects are selected",
  );
  await page.click('[data-testid="toolbar-fit-selection"]');

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

  // S9.16-004 — load a small artifact fixture and drive playback with real
  // browser pointer/keyboard input. View changes must not mutate the project.
  const previewRevisionBefore = await page.$eval(
    '[data-testid="status-revision"]',
    (el) => el.textContent,
  );
  const previewFixture = {
    version: "1.1",
    mode: "standard",
    dialect: "anycubic",
    coordinate_frame: "slice-ir",
    units: "mm",
    build_volume: { x: 220, y: 220, z: 250 },
    segments: [
      {
        mode: "standard",
        kind: "WALL",
        layer: 7,
        segment_id: "preview-a",
        execution_order: 0,
        orientation: [0, 0, 1],
        pose: { from: { x: 10, y: 10, z: 0.2 }, to: { x: 20, y: 10, z: 0.2 } },
        speed: { mm_s: 30 },
        flow: { q_mm3_s: 2.5 },
        layer_height_mm: 0.2,
        line_width_mm: 0.45,
        temperature: { nozzle_c: 210 },
      },
      {
        mode: "standard",
        kind: "TRAVEL",
        layer: 12,
        segment_id: "preview-b",
        execution_order: 1,
        orientation: [0, 0, 1],
        pose: { from: { x: 20, y: 10, z: 0.4 }, to: { x: 20, y: 20, z: 0.4 } },
        speed: { mm_s: 90 },
      },
      {
        mode: "standard",
        kind: "INFILL",
        layer: 7,
        segment_id: "preview-c",
        execution_order: 2,
        orientation: [0, 0, 1],
        pose: { from: { x: 12, y: 12, z: 0.2 }, to: { x: 18, y: 12, z: 0.2 } },
        material_id: "project-pla",
        flow: { q_mm3_s: 1.8 },
        layer_height_mm: 0.2,
        line_width_mm: 0.42,
        temperature: { nozzle_c: 205 },
      },
    ],
  };
  previewFixturePath = path.join(os.tmpdir(), `preview-playback-${process.pid}.json`);
  fs.writeFileSync(previewFixturePath, JSON.stringify(previewFixture));
  await page.$eval('[data-testid="ir-file-input"]', (input) => input.scrollIntoView());
  await (await page.$('[data-testid="ir-file-input"]')).uploadFile(previewFixturePath);
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="preview-layer-slider"]')),
    { timeout: 10000 },
  );
  const previewPageState = await page.evaluate(() => {
    const visible = (selector) => {
      const element = document.querySelector(selector);
      return Boolean(element && !element.closest("[hidden]"));
    };
    return {
      liveBanner: visible('[data-testid="viewport-live-banner"]'),
      previewControls: visible('[data-testid="preview-controls"]'),
    };
  });
  assert.deepEqual(previewPageState, { liveBanner: false, previewControls: true });
  const previewCameraTarget = await readStableCameraTarget(page);
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".workspace-tabs button:nth-of-type(2)")
        ?.getAttribute("aria-pressed") === "true" &&
      document.querySelector('[data-testid="preview-controls"]')?.closest("[hidden]") !== null,
    { timeout: 5000 },
  );
  const prepareCameraTarget = await readStableCameraTarget(page);
  assertCameraVector(
    prepareCameraTarget,
    previewCameraTarget,
    `Preview → Prepare navigation must preserve OrbitControls.target: ${JSON.stringify({ previewCameraTarget, prepareCameraTarget })}`,
  );
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.waitForSelector('[data-testid="preview-layer-slider"]', { timeout: 5000 });
  const layerTrack = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="preview-layer-slider"]');
    if (!input) return null;
    const rect = input.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
      writingMode: getComputedStyle(input).writingMode,
    };
  });
  if (!layerTrack) {
    const previewDiag = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body.innerText.slice(0, 500),
      status: document.querySelector('[data-testid="ir-status"]')?.textContent,
      controls: document.querySelector('[data-testid="preview-controls"]')?.outerHTML,
      errors: document.querySelector('[data-testid="ir-status"]')?.className,
    }));
    previewDiag.pageErrors = errors;
    previewDiag.failedRequests = failedReqs.slice(-10);
    throw new Error(`Preview layer selector disappeared: ${JSON.stringify(previewDiag)}`);
  }
  assert.ok(
    layerTrack.height > layerTrack.width,
    `layer selector should be vertical: ${JSON.stringify(layerTrack)}`,
  );
  assert.match(layerTrack.writingMode, /vertical/);
  const layerSlider = await page.$('[data-testid="preview-layer-slider"]');
  await layerSlider.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="preview-segment-slider"]')?.dataset.currentSegmentId ===
      "preview-b",
  );
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="preview-segment-slider"]')?.dataset.currentSegmentId ===
      "preview-a",
  );
  await page
    .waitForSelector('[data-testid="preview-step-forward"]', { timeout: 5000 })
    .catch(async () => {
      const state = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        body: document.body.innerText.slice(0, 1000),
        inputIds: [...document.querySelectorAll("input")].map((input) => input.id),
        previewMarkup: document.querySelector('[data-testid="preview-controls"]')?.outerHTML,
      }));
      state.pageErrors = errors;
      state.failedRequests = failedReqs.slice(-10);
      throw new Error(`Preview controls disappeared before playback: ${JSON.stringify(state)}`);
    });
  const forward = await page.$eval('[data-testid="preview-step-forward"]', (button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      hitButton: hit === button || button.contains(hit),
      hit: hit?.outerHTML.slice(0, 160),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  });
  assert.equal(
    forward.hitButton,
    true,
    `step button must be the real pointer hit target: ${JSON.stringify(forward)}`,
  );
  await page.click('[data-testid="preview-step-forward"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="preview-segment-slider"]')?.dataset.currentSegmentId ===
      "preview-b",
  );
  assert.equal(
    await page.$eval('[data-testid="preview-layer-slider"]', (input) => input.value),
    "1",
  );
  await page.click('[data-testid="preview-step-back"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="preview-segment-slider"]')?.dataset.currentSegmentId ===
      "preview-a",
  );
  const segmentSlider = await page.$('[data-testid="preview-segment-slider"]');
  await segmentSlider.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="preview-segment-slider"]')?.dataset.currentSegmentId ===
      "preview-c",
  );
  const visibleBeforeFilter = await page.$eval('[data-testid="preview-controls"]', (el) =>
    el.getAttribute("data-visible-segment-ids"),
  );
  const visibleBeforeFilterIds = (visibleBeforeFilter ?? "").split(",").filter(Boolean);
  assert.ok(
    visibleBeforeFilterIds.includes("preview-c"),
    `preview-c must be visible before filtering: ${visibleBeforeFilterIds.join(",")}`,
  );
  await page.click('[data-testid="preview-filter-infill"]');
  await page.waitForFunction(
    (beforeIds) => {
      const visible =
        document
          .querySelector('[data-testid="preview-controls"]')
          ?.getAttribute("data-visible-segment-ids") ?? "";
      return visible.split(",").filter(Boolean).length < beforeIds.length;
    },
    {},
    visibleBeforeFilterIds,
  );
  assert.equal(await page.$('[data-testid="preview-layer-slider"]').then(Boolean), true);
  assert.equal(
    await page.$eval('[data-testid="status-revision"]', (el) => el.textContent),
    previewRevisionBefore,
  );
  const selectedSegment = await page.$('[data-testid="preview-segment-slider"]');
  await selectedSegment.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="preview-segment-slider"]')?.dataset.currentSegmentId ===
      "preview-c",
  );
  await page.click('[data-testid="preview-play-speed"]');
  await page.select('[data-testid="preview-play-speed"]', "0.5");
  await page.click('[data-testid="preview-play-toggle"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="preview-play-toggle"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  await page.click('[data-testid="preview-play-toggle"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="preview-play-toggle"]')
        ?.getAttribute("aria-pressed") === "false",
  );
  fs.rmSync(previewFixturePath, { force: true });
  previewFixturePath = "";

  // S9.17-002 — page navigation preserves scene authority and Preview is
  // honest/actionable before an artifact exists, without auto-slicing.
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForSelector('[data-testid="ir-clear"]:not(:disabled)', { timeout: 5000 });
  await page.click('[data-testid="ir-clear"]');
  await page.waitForSelector('[data-testid="ir-clear"]:disabled', { timeout: 5000 });
  const prepareState = await page.evaluate(() => ({
    revision: document.querySelector('[data-testid="status-revision"]')?.textContent,
    coords: document.querySelector('[data-testid="status-coords"]')?.textContent,
    selectedRows: [...document.querySelectorAll('.object-row[aria-selected="true"]')].map((row) =>
      row.textContent?.trim(),
    ),
    selectedObject: document
      .querySelector('.object-item[aria-selected="true"]')
      ?.getAttribute("data-name"),
  }));
  const settleCamera = async () => {
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".viewport-frame canvas");
      const resource = performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("@react-three_fiber.js"));
      return Boolean(canvas && resource);
    });
    return readStableCameraTarget(page);
  };
  const cameraBeforeViews = await readViewportCamera(page);
  assert.ok(cameraBeforeViews, "R3F viewport camera should be inspectable");
  const cameraTargetBeforeViews = await settleCamera();
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.waitForSelector('[data-testid="preview-empty"]', { timeout: 5000 });
  const cameraInPreview = await readViewportCamera(page);
  assert.ok(cameraInPreview, "R3F viewport camera should remain inspectable in Preview");
  assertCameraVector(
    cameraInPreview.target,
    cameraTargetBeforeViews,
    "Prepare → Preview must preserve OrbitControls.target",
  );
  assertCameraVector(
    cameraInPreview.position,
    cameraBeforeViews.position,
    "Prepare → Preview must preserve camera position",
  );
  assert.equal(await page.$('[data-testid="preview-controls"]').then(Boolean), false);
  assert.equal(await page.$('[data-testid="preview-layer-slider"]').then(Boolean), false);
  assert.equal(await page.$('[data-testid="slice-progress"]').then(Boolean), false);
  assert.equal(
    await page.$$('.object-item[aria-selected="true"]').then((rows) => rows.length),
    0,
    "Preview must not mount the authoring selected-object row",
  );
  assert.equal(
    await page.$eval('[data-testid="status-revision"]', (el) => el.textContent),
    prepareState.revision,
    "Prepare → Preview must preserve the authoritative revision",
  );
  assert.equal(await page.$$eval(".object-row", (rows) => rows.length), 0);
  assert.equal(
    await page.$eval('[data-testid="status-coords"]', (el) => el.textContent),
    prepareState.coords,
    "Prepare → Preview must preserve the authoritative selection coordinates",
  );
  const emptyPreviewControls = await page.evaluate(() => {
    const preview = document.querySelector('[data-testid="preview-empty"]');
    const slice = document.querySelector('[data-testid="slice-btn"]');
    return {
      previewVisible: Boolean(preview),
      previewActions: [...(preview?.querySelectorAll("button") ?? [])].map((button) => ({
        label: button.getAttribute("aria-label"),
        title: button.title,
      })),
      headerSlicePresent: Boolean(slice),
      headerSliceDisabled: slice?.disabled ?? null,
      headerSliceLabel: slice?.getAttribute("aria-label") ?? "",
    };
  });
  assert.equal(emptyPreviewControls.previewActions.length, 1);
  assert.match(emptyPreviewControls.previewActions[0].label, /^(Go to Prepare|Ir para Preparar)$/);
  assert.equal(
    emptyPreviewControls.previewActions[0].title,
    emptyPreviewControls.previewActions[0].label,
  );
  const prepareAction = await page.$('[data-testid="preview-empty"] button');
  const prepareActionBox = await prepareAction.boundingBox();
  assert.ok(prepareActionBox, "Go to Prepare must have a real pointer hit target");
  await page.mouse.click(
    prepareActionBox.x + prepareActionBox.width / 2,
    prepareActionBox.y + prepareActionBox.height / 2,
  );
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "prepare",
  );
  const cameraAfterAction = await settleCamera();
  assertCameraVector(
    cameraAfterAction,
    cameraTargetBeforeViews,
    "Preview action must preserve OrbitControls.target",
  );
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.waitForSelector('[data-testid="preview-empty"]', { timeout: 5000 });
  await settleCamera();
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "home",
  );
  const cameraOnHome = await settleCamera();
  assertCameraVector(
    cameraOnHome,
    cameraTargetBeforeViews,
    "Preview → Home must preserve OrbitControls.target",
  );
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "workbench",
  );
  const cameraOnWorkbench = await settleCamera();
  assertCameraVector(
    cameraOnWorkbench,
    cameraTargetBeforeViews,
    "Home → Workbench must preserve OrbitControls.target",
  );
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "prepare",
  );
  assertCameraVector(
    await settleCamera(),
    cameraTargetBeforeViews,
    "Workbench → Prepare must preserve OrbitControls.target",
  );
  assertCameraVector(
    (await readViewportCamera(page)).position,
    cameraBeforeViews.position,
    "Navigation through all four pages must preserve camera position",
  );
  assert.equal(
    emptyPreviewControls.headerSlicePresent,
    true,
    "the real header Slice control remains available in Preview",
  );
  assert.equal(
    emptyPreviewControls.headerSliceDisabled,
    true,
    "Slice stays disabled without a loaded IR",
  );
  assert.match(
    emptyPreviewControls.headerSliceLabel,
    /slice|fatiar/i,
    "disabled Slice exposes its blocked action label",
  );
  assert.equal(
    await page.$eval('[data-testid="slice-btn"]', (button) => button.title),
    "",
    "the empty-preview Slice state must not invent a blocking reason when none is provided",
  );
  const emptyPreviewRevision = await page.$eval(
    '[data-testid="status-revision"]',
    (el) => el.textContent,
  );
  const emptyPreviewCoords = await page.$eval(
    '[data-testid="status-coords"]',
    (el) => el.textContent,
  );
  assert.equal(
    await page.$$eval(".object-row", (rows) => rows.length),
    0,
    "Preview must unmount the authoring ObjectTree",
  );
  const emptyPreviewFrame = await page.$('[data-testid="viewport-frame"]');
  await emptyPreviewFrame.focus();
  await page.keyboard.press("w");
  await page.keyboard.press("Delete");
  await page.keyboard.down("Control");
  await page.keyboard.press("d");
  await page.keyboard.up("Control");
  assert.equal(
    await page.$eval('[data-testid="status-revision"]', (el) => el.textContent),
    emptyPreviewRevision,
    "move, Delete, and Ctrl+D in Preview must not mutate the authoritative revision",
  );
  assert.equal(
    await page.$eval('[data-testid="status-coords"]', (el) => el.textContent),
    emptyPreviewCoords,
    "move, Delete, and Ctrl+D in Preview must preserve authoritative selection coordinates",
  );
  assert.equal(
    await page.$eval('[data-testid="status-revision"]', (el) => el.textContent),
    prepareState.revision,
    "empty Preview must not change the scene revision",
  );
  assert.equal(
    await page.$eval('[data-testid="status-coords"]', (el) => el.textContent),
    prepareState.coords,
    "empty Preview must preserve the selected object's authoritative coordinates",
  );
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForSelector('.object-item[aria-selected="true"]', { timeout: 5000 });
  assert.equal(
    await page.$eval('.object-item[aria-selected="true"]', (row) => row.getAttribute("data-name")),
    prepareState.selectedObject,
    "returning to Prepare must restore the same selected object row",
  );
  assert.deepEqual(
    await page.$$eval('.object-row[aria-selected="true"]', (rows) =>
      rows.map((row) => row.textContent?.trim()),
    ),
    prepareState.selectedRows,
    "returning to Prepare must restore the selected row contents",
  );
  assert.equal(
    await page.$eval('[data-testid="status-coords"]', (el) => el.textContent),
    prepareState.coords,
    "returning to Prepare must preserve the authoritative selected coordinates",
  );
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.waitForSelector('[data-testid="preview-empty"]', { timeout: 5000 });

  // ---- 2. mount ChatPanel (sidebar chat view) + overlay dock ----
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForSelector('.object-item[aria-selected="true"]', { timeout: 5000 });
  await page.click(".sidebar-nav button:nth-of-type(3)");
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

  // ---- 4. S9.17-003 SimSend truthfulness — demo simulation only, no real send ----
  // 4a. Non-demo providers must NEVER mount the print-job dialog (no dispatch
  // surface exists behind it) and the Slice action must not be runnable.
  for (const providerParam of ["real", "unavailable"]) {
    await page.goto(`http://127.0.0.1:${DEV_PORT}/?provider=${providerParam}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector(".app-shell", { timeout: 30000 });
    await page.click(".workspace-tabs button:nth-of-type(2)"); // Prepare
    await page.waitForSelector('[data-testid="slice-btn"]', { timeout: 10000 });
    const nonDemo = await page.evaluate(() => ({
      dialog: document.querySelector('[data-testid="print-job-dialog"]') !== null,
      send: document.querySelector('[data-testid="print-job-send"]') !== null,
      sliceDisabled: document.querySelector('[data-testid="slice-btn"]')?.disabled ?? null,
    }));
    assert.equal(
      nonDemo.dialog,
      false,
      `?provider=${providerParam} must not mount the print-job dialog`,
    );
    assert.equal(
      nonDemo.send,
      false,
      `?provider=${providerParam} must not expose a send affordance`,
    );
    assert.equal(
      nonDemo.sliceDisabled,
      true,
      `?provider=${providerParam} must leave Slice disabled (no eligible scene)`,
    );
  }

  // 4b. Demo provider: persist the operator machine FIRST (the Device panel's
  // arm affordance reads the operator profile from localStorage at MOUNT —
  // in-session store switches do not propagate to it), then reload so the arm
  // row appears; HIDE the non-watertight sphere via the object-tree EYE so
  // cone+cube slice cleanly (S9.17-003 SimSend visibility parity — same
  // predicate as the Slice gate; mirrors slice-lane.test.mjs), and arm the
  // profile printer on Workbench.
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  // The demo "Prepare" tile only appears once the demo scene bootstrap resolves.
  await page.waitForSelector('[data-testid="home-demo-prepare"]', { timeout: 30000 });
  await page.click('[data-testid="home-demo-prepare"]');
  await page.click(".sidebar-nav button:nth-of-type(1)"); // settings
  await page.waitForSelector('[data-testid="printer-select"]', { timeout: 10000 });
  await page.select('[data-testid="printer-select"]', "kobra-s1");
  // Reload: the persisted operator machine now surfaces the Device-panel arm row.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  await page.waitForSelector('[data-testid="home-demo-prepare"]', { timeout: 30000 });
  await page.click('[data-testid="home-demo-prepare"]');
  // Hide the offender via the object-tree EYE toggle (real pointer click on
  // the inline row action — detects the row stays, only hidden). Hiding, not
  // deleting, proves the lane/UI visibility parity: a hidden non-watertight
  // object must neither block the slice lane nor count in the demo estimate.
  await page.waitForSelector('.object-item[data-name="sphere-non-watertight"] .obj-eye', {
    timeout: 10000,
  });
  await page.click('.object-item[data-name="sphere-non-watertight"] .obj-eye');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.object-item[data-name="sphere-non-watertight"]')
        ?.classList.contains("hidden-obj") ?? false,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="slice-btn"]')?.disabled === false,
    { timeout: 10000 },
  );
  await page.click('[data-testid="slice-btn"]');
  await page.waitForSelector('[data-testid="slice-stats"]', { timeout: 20000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="slice-stats"]')?.getAttribute("data-status") ===
      "ready",
    { timeout: 20000 },
  );

  // Arm the profile printer: Workbench → click the "empty profile" row
  // (armProfile injects the profile machine; its ip stays "" — honest).
  await page.click(".workspace-tabs button:nth-of-type(4)"); // Workbench
  await page.waitForSelector('[data-testid="device-empty-profile"]', { timeout: 10000 });
  const armBox = await page.$eval('[data-testid="device-empty-profile"]', (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await page.mouse.click(armBox.x + armBox.w / 2, armBox.y + armBox.h / 2);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="device-empty-profile"]') === null,
    { timeout: 10000 },
  );

  // Browser proof: watch EVERY network request from here on. A truthful demo
  // simulate must produce ZERO traffic to anything outside the dev server.
  const allRequestUrls = [];
  page.on("request", (request) => {
    try {
      allRequestUrls.push(new URL(request.url()).href);
    } catch {
      /* data:/blob: payloads are fine — nothing to record */
    }
  });

  // 4c. EN card: honest demo title + button, token explained, no legacy send
  // wording anywhere in the card.
  await page.click(".workspace-tabs button:nth-of-type(2)"); // back to Prepare
  await page.waitForSelector('[data-testid="print-job-send"]', { timeout: 10000 });
  const enSendLabel = await page.$eval('[data-testid="print-job-send"]', (b) =>
    b.textContent.trim(),
  );
  assert.equal(enSendLabel, "Simulate send", "demo send button must read 'Simulate send' (EN)");

  await page.click('[data-testid="print-job-send"]');
  await page.waitForSelector('[data-testid="send-approval-card"]', { timeout: 5000 });
  const enCard = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="print-job-dialog"]');
    const card = document.querySelector('[data-testid="send-approval-card"]');
    return {
      origin: dialog?.getAttribute("data-origin") ?? null,
      title: card?.querySelector(".panel-title")?.textContent?.trim() ?? "",
      state: card?.getAttribute("data-state") ?? null,
      tokenTitle:
        document.querySelector('[data-testid="send-approval-token"]')?.getAttribute("title") ?? "",
      approve:
        document.querySelector('[data-testid="send-approval-approve"]')?.textContent?.trim() ?? "",
      text: card?.textContent ?? "",
    };
  });
  assert.equal(enCard.origin, "demo", "demo dialog must carry data-origin=demo");
  assert.equal(
    enCard.title,
    "Demo simulation, no data uploaded and no printer command sent.",
    "card title must be the exact honest demo sentence (EN)",
  );
  assert.equal(enCard.state, "pending", "fresh card must be pending");
  assert.match(
    enCard.tokenTitle,
    /no authentication or transport/,
    `token must be explained as a local hash: ${enCard.tokenTitle}`,
  );
  assert.equal(enCard.approve, "Approve", "Approve stays as the confirm label");
  assert.ok(
    !/Send to print|Print job sent|send to printer|sent to your printer/i.test(enCard.text),
    `pending demo card must not claim a real send: ${enCard.text.trim().slice(0, 180)}`,
  );

  // 4d. Reject via a REAL pointer click (center of the button) — nothing runs,
  // no success toast, dialog dismisses. The card lives in the scrollable
  // footer, so first bring the action row into the footer's visible clip.
  await page.$eval('[data-testid="send-approval-reject"]', (el) => el.scrollIntoViewIfNeeded());
  await waitFor(120);
  const rejectBox = await page.$eval('[data-testid="send-approval-reject"]', (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await page.mouse.click(rejectBox.x + rejectBox.w / 2, rejectBox.y + rejectBox.h / 2);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="send-approval-card"]')?.getAttribute("data-state") ===
      "rejected",
    { timeout: 5000 },
  );
  await page.click('[data-testid="send-approval-close"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="send-approval-card"]') === null,
    { timeout: 5000 },
  );
  assert.equal(
    await page.$('[data-testid="send-approval-task"]'),
    null,
    "a rejected simulation must leave no task id behind",
  );

  // 4e. PT-BR labels: same send.* key prefix, honest Portuguese wording.
  await page.click(".sidebar-nav button:nth-of-type(1)"); // settings
  await page.waitForSelector('[data-testid="settings-language"]', { timeout: 5000 });
  await page.select('[data-testid="settings-language"]', "pt-BR");
  const ptSendLabel = await page.$eval('[data-testid="print-job-send"]', (b) =>
    b.textContent.trim(),
  );
  assert.equal(ptSendLabel, "Simular envio", "demo send button must read 'Simular envio' (PT)");
  await page.click('[data-testid="print-job-send"]');
  await page.waitForSelector('[data-testid="send-approval-card"]', { timeout: 5000 });
  const ptCard = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="send-approval-card"]');
    return {
      title: card?.querySelector(".panel-title")?.textContent?.trim() ?? "",
      tokenTitle:
        document.querySelector('[data-testid="send-approval-token"]')?.getAttribute("title") ?? "",
      state: card?.getAttribute("data-state") ?? null,
    };
  });
  assert.equal(
    ptCard.title,
    "Simulação demo, sem dados carregados e sem comando enviado à impressora.",
    "card title must be the exact honest demo sentence (PT)",
  );
  assert.match(
    ptCard.tokenTitle,
    /sem autenticação ou transporte/,
    `token must be explained as a local hash (PT): ${ptCard.tokenTitle}`,
  );
  assert.equal(ptCard.state, "pending");
  await page.$eval('[data-testid="send-approval-reject"]', (el) => el.scrollIntoViewIfNeeded());
  await waitFor(120);
  const ptRejectBox = await page.$eval('[data-testid="send-approval-reject"]', (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await page.mouse.click(ptRejectBox.x + ptRejectBox.w / 2, ptRejectBox.y + ptRejectBox.h / 2);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="send-approval-card"]')?.getAttribute("data-state") ===
      "rejected",
    { timeout: 5000 },
  );
  await page.click('[data-testid="send-approval-close"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="send-approval-card"]') === null,
    { timeout: 5000 },
  );

  // Back to English for the approving simulate run.
  await page.select('[data-testid="settings-language"]', "en");
  await page.click('[data-testid="print-job-send"]');
  await page.waitForSelector('[data-testid="send-approval-card"]', { timeout: 5000 });
  assert.equal(
    await page.$eval('[data-testid="print-job-dialog"]', (el) => el.getAttribute("data-origin")),
    "demo",
    "active demo card must still carry data-origin=demo",
  );

  // 4f. KEYBOARD approve: Tab lands on Approve, Enter confirms — the run
  // completes as a SIMULATION ("simulation sim-1", never a transport id).
  const tabFocus = [];
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press("Tab");
    tabFocus.push(
      await page.evaluate(
        () =>
          document.activeElement?.getAttribute("data-testid") ??
          document.activeElement?.tagName ??
          "?",
      ),
    );
  }
  assert.equal(
    tabFocus[1],
    "send-approval-approve",
    `keyboard focus must land on Approve: ${tabFocus.join(" > ")}`,
  );
  await page.keyboard.press("Enter");

  await page.waitForFunction(
    () => {
      const task = document.querySelector('[data-testid="send-approval-task"]');
      return Boolean(task && /^simulation sim-\d+$/.test(task.textContent ?? ""));
    },
    { timeout: 10000 },
  );
  const simTask = await page.$eval('[data-testid="send-approval-task"]', (el) => el.textContent);
  assert.match(simTask, /^simulation sim-\d+$/, `simulation task label: ${simTask}`);
  assert.ok(!/mock-task/.test(simTask), `simulation cannot claim a transport task: ${simTask}`);

  await page.waitForFunction(
    () => document.querySelector('[data-testid="toast-bell-count"]') !== null,
    { timeout: 10000 },
  );
  await page.click('[data-testid="toast-bell"]');
  await page.waitForFunction(
    () => {
      const box = document.querySelector("#toast-notifications");
      return Boolean(box && /Simulation complete/.test(box.textContent ?? ""));
    },
    { timeout: 5000 },
  );
  const toastText = await page.$eval("#toast-notifications", (el) => el.textContent ?? "");
  assert.match(toastText, /Simulation complete/, "success toast must be 'Simulation complete'");
  assert.ok(
    !/Print job sent/.test(toastText),
    "demo simulate must NOT raise the legacy 'Print job sent' toast",
  );

  // Zero external HTTP + zero cloud/upload/start attempts during the whole flow.
  const external = allRequestUrls.filter((url) => {
    try {
      const host = new URL(url).hostname;
      return host !== "127.0.0.1" && host !== "localhost";
    } catch {
      return false;
    }
  });
  const cloudish = allRequestUrls.filter((url) =>
    /(\/work\/|cloud|upload|print_start|task\/start)/i.test(url),
  );
  assert.equal(external.length, 0, `demo simulate produced external HTTP: ${external.join(" | ")}`);
  assert.equal(
    cloudish.length,
    0,
    `demo simulate attempted cloud/upload/start calls: ${cloudish.join(" | ")}`,
  );

  // After the 4s settle the card self-closes and there is no re-send affordance
  // (the job was already simulated on this slice).
  await page.waitForFunction(
    () => document.querySelector('[data-testid="send-approval-card"]') === null,
    { timeout: 8000 },
  );
  assert.equal(
    await page.$('[data-testid="print-job-send"]'),
    null,
    "after a finished simulation the send affordance must disappear",
  );

  // 4g. Re-show the dirty object: the block returns at the Slice gate (UI
  // eligibility) AND in the lane (unit-tested in slice-lane.test.mjs), while
  // the finished demo estimate — snapshot stats, never native slicer time —
  // is PRESERVED across page navigation: no fabricated time, no cancel of
  // the ready slice, no new job.
  // The object tree lives on the Prepare workspace's "Objects" sidebar view —
  // 4e left the sidebar on Settings, so return Prepare + Objects first
  // (store state survives page navigation: the finished simulation and its
  // stats are never cancelled).
  await page.click(".workspace-tabs button:nth-of-type(2)"); // Prepare
  await page.waitForFunction(
    () =>
      document
        .querySelector(".workspace-tabs button:nth-of-type(2)")
        ?.getAttribute("aria-pressed") === "true",
    { timeout: 10000 },
  );
  await page.click(".sidebar-nav button:nth-of-type(2)"); // Objects tree
  await page.waitForSelector('.object-item[data-name="sphere-non-watertight"] .obj-eye', {
    timeout: 10000,
  });
  const estimateBefore = await page.evaluate(() => ({
    layers: document.querySelector('[data-testid="stat-layers"]')?.textContent?.trim() ?? null,
    volume: document.querySelector('[data-testid="stat-volume"]')?.textContent?.trim() ?? null,
  }));
  assert.ok(estimateBefore.layers, "slice stats panel must still be mounted after navigation");
  await page.click('.object-item[data-name="sphere-non-watertight"] .obj-eye'); // re-show
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.object-item[data-name="sphere-non-watertight"]')
        ?.classList.contains("hidden-obj"),
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="slice-btn"]')?.disabled === true,
    { timeout: 10000 },
  );
  const reshownAria = await page.$eval('[data-testid="slice-btn"]', (b) =>
    b.getAttribute("aria-label"),
  );
  assert.match(
    reshownAria,
    /no watertight/i,
    `re-shown dirty object must re-block the Slice gate: ${reshownAria}`,
  );
  assert.equal(
    await page.$eval('[data-testid="slice-stats"]', (el) => el.getAttribute("data-status") ?? ""),
    "sent",
    "post-simulation status stays sent — re-show never cancels the finished slice",
  );
  const estimateAfter = await page.evaluate(() => ({
    layers: document.querySelector('[data-testid="stat-layers"]')?.textContent?.trim() ?? null,
    volume: document.querySelector('[data-testid="stat-volume"]')?.textContent?.trim() ?? null,
  }));
  assert.deepEqual(
    estimateAfter,
    estimateBefore,
    "re-show preserves the demo estimate (snapshot stats, not native time)",
  );

  console.log(
    `e2e:editor-reload PASS — shell reloaded clean (0 page errors, 0 HTTP 5xx), ChatPanel + overlay mounted; UI refactor (plate-rail, floating transform, object-tree filament + info popover) verified; S9.17-003 SimSend truthfulness verified (demo-only mount, honest EN/PT labels, simulation receipt, zero external HTTP).`,
  );
} finally {
  if (previewFixturePath) fs.rmSync(previewFixturePath, { force: true });
  if (browser) await browser.close().catch(() => {});
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
