#!/usr/bin/env node
/**
 * S9.18-001/002 — shared reversible FRONTEND operation registry E2E.
 *
 * Proves on the REAL app (offline demo lane, `?provider=demo`) that the UI
 * navigation buttons and the registry handler (`window.__anycubicOperationRegistry`)
 * drive the EXACT same observable `data-workspace-view` / object-tree
 * selection state: pointer clicks and handler calls are interchangeable,
 * invalid/pinned/stale invocations are typed denials with zero effects, and
 * Preview stays read-only (no slice progress, selection denied).
 *
 * The DEV-only test bridge installs only when import.meta.env.DEV; it models
 * the invocation shape of the future S9.18-002 AI-tool frontend entry — it is
 * not a model token and never exposes one.
 *
 * Private port 1438 (never 1420/1437/18181) — asserted free at boot and
 * cleaned up with the spawned vite process.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const editorDir = path.join(root, "apps", "editor");
const viteEntry = path.join(editorDir, "node_modules", "vite", "bin", "vite.js");
const port = Number(process.env.EDITOR_OPS_E2E_PORT ?? 1438);
const url = `http://127.0.0.1:${port}/?provider=demo`;

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

// Private port must be free before we own it (never SKIP-if-busy).
function portFree(target) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: target });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.setTimeout(700);
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

let child;
let browser;
let exitCode = 0;
try {
  assert.ok(await portFree(port), `private e2e port ${port} is in use — free it and re-run`);
  child = spawn(
    process.execPath,
    [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: editorDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let viteLog = "";
  child.stdout?.on("data", (data) => (viteLog += data.toString()));
  child.stderr?.on("data", (data) => (viteLog += data.toString()));
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (child.exitCode !== null)
      throw new Error(`vite exited (${child.exitCode}): ${viteLog.slice(-500)}`);
    try {
      const response = await fetch(url);
      if (response.ok && (await response.text()).includes("/src/main.tsx")) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const probe = await fetch(url);
  assert.ok(
    probe.ok && (await probe.text()).includes("/src/main.tsx"),
    `local editor Vite server did not start: ${viteLog.slice(-500)}`,
  );

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
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err.message)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    try {
      const location = msg.location().url ?? "";
      if (location.includes("favicon")) return; // missing favicon is not app state
    } catch {}
    pageErrors.push(msg.text());
  });

  // -------------------------------------------------------------------------
  // Helpers: bridge = the EXACT registry entry the future tool frontend uses.
  // -------------------------------------------------------------------------
  const bridge = (payload) =>
    page.evaluate((invocation) => window.__anycubicOperationRegistry.execute(invocation), payload);
  const bridgeState = () => page.evaluate(() => window.__anycubicOperationRegistry.getState());
  const viewAttr = () => page.$eval(".app-shell", (el) => el.getAttribute("data-workspace-view"));
  const rowSelected = (name) =>
    page.$eval(`[data-name="${name}"]`, (el) => el.getAttribute("aria-selected")).catch(() => null);
  const waitView = async (view) => {
    await page.waitForFunction(
      (needle) =>
        document.querySelector(".app-shell")?.getAttribute("data-workspace-view") === needle,
      { timeout: 10000 },
      view,
    );
  };
  const waitSelected = async (name, selected) => {
    await page.waitForFunction(
      ({ needle, expected }) =>
        document.querySelector(`[data-name="${needle}"]`)?.getAttribute("aria-selected") ===
        expected,
      { timeout: 10000 },
      { needle: name, expected: selected ? "true" : "false" },
    );
  };

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  await waitView("home");

  // 1. DEV test bridge installed — same registry entry as future tool calls.
  const hasBridge = await page.evaluate(
    () => typeof window.__anycubicOperationRegistry === "object",
  );
  assert.equal(hasBridge, true, "DEV operation test bridge must be installed");

  // 2. Handler-driven navigation across all four views (tool-style, no pin).
  for (const view of ["prepare", "preview", "workbench", "home"]) {
    const out = await bridge({ id: "workspace.navigate", args: { view } });
    assert.equal(out.ok, true, `handler nav to ${view} must succeed: ${JSON.stringify(out)}`);
    await waitView(view);
    assert.equal(await viewAttr(), view);
  }

  // 3. Pointer-UI navigation (real mouse) matches the handler exactly.
  await page.click(".workspace-tabs button:nth-of-type(2)"); // prepare tab
  await waitView("prepare");
  assert.equal(await viewAttr(), "prepare");

  // 4. Prepare surface + objects sidebar so the shared selection is visible.
  await page.click(".sidebar-nav button:nth-of-type(2)"); // Objects
  await page.waitForSelector('.object-list li[data-name="cone"]', { timeout: 10000 });

  // 5. Handler selection → same observable tree state (tool origin).
  const coneSelect = await bridge({ id: "scene.select", args: { name: "cone" } });
  assert.equal(coneSelect.ok, true, JSON.stringify(coneSelect));
  assert.equal(coneSelect.outcome.code, "selected");
  await waitSelected("cone", true);
  assert.equal(await rowSelected("cone"), "true");
  assert.deepEqual((await bridgeState()).selectedNames, ["cone"]);
  await waitSelected("cube", false);

  // 6. Pointer-UI selection (real mouse click on the cube row) — UI origin.
  await page.click('.object-list li[data-name="cube"]');
  await waitSelected("cube", true);
  await waitSelected("cone", false);
  assert.deepEqual((await bridgeState()).selectedNames, ["cube"]);
  // Overlapping selection cleared — exactly the shared store semantic.
  assert.equal(await rowSelected("cone"), "false");

  // 7. Handler selection again → sphere (non-watertight object, still eligible).
  const sphereSelect = await bridge({
    id: "scene.select",
    args: { name: "sphere-non-watertight" },
  });
  assert.equal(sphereSelect.ok, true, JSON.stringify(sphereSelect));
  assert.equal(sphereSelect.outcome.watertight, false);
  await waitSelected("sphere-non-watertight", true);

  // 8. Typed denials — zero effects retained.
  const unknownView = await bridge({ id: "workspace.navigate", args: { view: "about" } });
  assert.equal(unknownView.ok, false);
  assert.equal(unknownView.error.code, "invalid-arguments");
  assert.equal(await viewAttr(), "prepare");

  const unknownObject = await bridge({ id: "scene.select", args: { name: "phantom" } });
  assert.equal(unknownObject.ok, false);
  assert.equal(unknownObject.error.code, "unavailable");
  assert.equal(unknownObject.error.reason, "no-such-object");
  const stateAfterDenial = await bridgeState();
  assert.deepEqual(stateAfterDenial.selectedNames, ["sphere-non-watertight"]);

  // Prototype-keyed args forged INSIDE the page (the transport layer would
  // normalize own __proto__ — the validator must see the own-keyed object).
  const protoArgs = await page.evaluate(() =>
    window.__anycubicOperationRegistry.execute({
      id: "scene.select",
      args: JSON.parse('{"name":"cone","__proto__":{}}'),
    }),
  );
  assert.equal(protoArgs.ok, false);
  assert.equal(protoArgs.error.code, "invalid-arguments");
  assert.deepEqual((await bridgeState()).selectedNames, ["sphere-non-watertight"]);

  // 9. Context-alive: a call pinned to a stale project is refused before effect.
  const staleScope = await bridge({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "e2e-stale-1",
    projectScopeId: "some-project-not-active",
    conversationId: null,
  });
  assert.equal(staleScope.ok, false);
  assert.equal(staleScope.error.code, "context-changed");
  assert.equal(await viewAttr(), "prepare");

  // 10. Strict pins: null/null is DENIED while the demo lane has a live
  // conversation (currentProjectId is null, the first conversation is
  // seeded active) — evidence that pins are compared with STRICT equality
  // INCLUDING null. Tool-origin calls must pin the LIVE scope, which the
  // bridge exposes via getState().contextScope.
  const liveScope = (await bridgeState()).contextScope;
  assert.ok(
    liveScope.projectScopeId === null && typeof liveScope.conversationId === "string",
    `demo lane must expose a project-less live conversation scope: ${JSON.stringify(liveScope)}`,
  );
  const nullPinned = await bridge({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "e2e-nav-null-pin",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(nullPinned.ok, false);
  assert.equal(nullPinned.error.code, "context-changed");
  assert.equal(nullPinned.error.reason, "conversation");
  assert.equal(await viewAttr(), "prepare");

  // Tool-origin call pinned to the LIVE scope succeeds...
  const pinnedOnce = await bridge({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "e2e-nav-reuse",
    projectScopeId: liveScope.projectScopeId,
    conversationId: liveScope.conversationId,
  });
  assert.equal(pinnedOnce.ok, true, JSON.stringify(pinnedOnce));
  assert.equal(await viewAttr(), "workbench");
  // ...but reusing the same callId with DIFFERENT args is refused.
  const reused = await bridge({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "e2e-nav-reuse",
    projectScopeId: liveScope.projectScopeId,
    conversationId: liveScope.conversationId,
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, "call-id-reused");
  assert.equal(await viewAttr(), "workbench");

  // 11. Same callId + same args replays the CACHED receipt (no re-apply).
  const replay = await bridge({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "e2e-nav-reuse",
    projectScopeId: liveScope.projectScopeId,
    conversationId: liveScope.conversationId,
  });
  assert.equal(replay.ok, true);
  // The first execution's receipt is returned verbatim (its outcome was
  // "navigated": prepare → workbench) — duplicates never recompute against
  // live state and never produce a second effect.
  assert.equal(replay.outcome.code, "navigated");
  assert.equal(replay.outcome.view, "workbench");
  assert.equal(await viewAttr(), "workbench");

  // 12. Read-only Preview preserved: handler navigate preview shows the empty
  // surface, selection is denied, and no slice/build started.
  const toPreview = await bridge({ id: "workspace.navigate", args: { view: "preview" } });
  assert.equal(toPreview.ok, true);
  await waitView("preview");
  await page.waitForSelector('[data-testid="preview-empty"]', { timeout: 10000 });
  const selectInPreview = await bridge({ id: "scene.select", args: { name: "cone" } });
  assert.equal(selectInPreview.ok, false);
  assert.equal(selectInPreview.error.reason, "selection-only-in-prepare");
  assert.equal((await bridgeState()).view, "preview");
  const sliceActivity = await page
    .$('[data-testid="slice-progress-indeterminate"]')
    .then((handle) => handle !== null);
  assert.equal(sliceActivity, false, "no slice/build progress may start from navigation");

  assert.deepEqual(pageErrors, [], `page errors during operations e2e: ${pageErrors.join(" | ")}`);
  console.log(
    "editor-operations.e2e.mjs: 12 scenarios PASS (handler == UI, denials zero-effect, preview read-only)",
  );
} catch (error) {
  exitCode = 1;
  console.error("editor-operations.e2e.mjs FAILED:", error);
  throw error;
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  process.exit(exitCode);
}
