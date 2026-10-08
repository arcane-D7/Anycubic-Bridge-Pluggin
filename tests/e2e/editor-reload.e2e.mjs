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
const DEV_PORT = Number(process.env.EDITOR_E2E_PORT ?? 1421);
const URL = `http://127.0.0.1:${DEV_PORT}/?provider=demo`;

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
  await page.waitForFunction(
    () => document.querySelector('[data-testid="bridge-state"]')?.textContent === "Demo geometry",
    { timeout: 15000 },
  );
  await page.click(".sidebar-nav button:nth-of-type(2)");
  await page.waitForSelector(".object-name", { timeout: 15000 });
  await page.click(".sidebar-nav button:nth-of-type(1)");

  // S9.14-001 — exercise the shared background menu through real browser
  // input without selecting a mesh before later no-selection assertions.
  await page.waitForSelector('[data-testid="viewport-frame"]', { timeout: 15000 });
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
        .waitForSelector('[data-testid="context-menu"]', { timeout: 400 })
        .then(() => true)
        .catch(() => false);
      if (opened) break;
    }
    assert.ok(opened, `real right-click should open the menu at the ${edge} viewport edge`);
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
  const resizedAnchor = await page.$eval('[data-testid="viewport-frame"]', (frame) => {
    const rect = frame.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(document.documentElement.clientWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
    return { x: left + (right - left) * 0.5, y: top + (bottom - top) * 0.45 };
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
    /220/,
    `plate-rail-specs should show the build volume (220), got "${railSpecs}"`,
  );
  assert.match(railSpecs, /mm/, `plate-rail-specs should carry units, got "${railSpecs}"`);
  assert.match(railSpecs, /Kobra S1 \(e2e\)/, "plate information should name the active profile");
  assert.match(
    railSpecs,
    /operator declaration/i,
    "plate information should report profile origin",
  );
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

  const dividerBefore = await page.$eval('[data-testid="divider-vertical"]', (divider) => {
    const rect = divider.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
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
