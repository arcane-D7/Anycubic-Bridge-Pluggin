#!/usr/bin/env node
/**
 * Home project recovery UI test with a controlled Tauri invoke bridge.
 * Runs the real editor in local Chromium/Edge; it never contacts a printer or cloud service.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const editorDir = path.join(root, "apps", "editor");
const viteEntry = path.join(editorDir, "node_modules", "vite", "bin", "vite.js");
const port = Number(process.env.EDITOR_HOME_E2E_PORT ?? 1437);
const url = `http://127.0.0.1:${port}/`;

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

const projects = [
  { id: "home-project-a", name: "Synthetic Project A", updated_ms: 2 },
  { id: "home-project-b", name: "Synthetic Project B", updated_ms: 1 },
];
const initialSnapshot = {
  project: { id: projects[0].id, name: projects[0].name, objects: [] },
  revision: 4,
};
const recoveredSnapshot = {
  project: {
    id: projects[1].id,
    name: projects[1].name,
    objects: [
      {
        name: "Recovered Synthetic Object B",
        objectId: "synthetic-object-b",
        vertices: 3,
        triangles: 1,
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        sizeMm: [1, 1, 0],
        volumeMm3: 0,
        surfaceAreaMm2: 1,
        watertight: true,
        visible: true,
        locked: false,
        transform: { x: 0, y: 0, z: 0 },
      },
    ],
  },
  revision: 12,
};

let child;
let browser;
try {
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
  const response = await fetch(url);
  assert.ok(
    response.ok && (await response.text()).includes("/src/main.tsx"),
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
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage();
  const calls = [];
  await page.evaluateOnNewDocument(
    ({ projects: fixtureProjects, initial, recovered }) => {
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args = {}) => {
          window.__homeInvokeCalls.push({ command, args });
          if (command === "project_authority_read") return window.__homeInitialSnapshot;
          if (command === "project_list") return window.__homeProjects;
          if (command === "project_slice_history")
            throw new Error("synthetic history read failure");
          if (command === "project_authority_recover") {
            if (args.projectId === "home-project-b" && !window.__homeFailRecover)
              return window.__homeRecoveredSnapshot;
            throw new Error("synthetic recovery failure");
          }
          throw new Error(`unexpected synthetic Tauri command: ${command}`);
        },
      };
      window.__homeProjects = fixtureProjects;
      window.__homeInitialSnapshot = initial;
      window.__homeRecoveredSnapshot = recovered;
      window.__homeInvokeCalls = [];
      window.__homeFailRecover = false;
    },
    { projects, initial: initialSnapshot, recovered: recoveredSnapshot },
  );

  await page.goto(`${url}?provider=real`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 30000 });
  await page.waitForSelector(`[data-testid="home-project-${projects[1].id}"]`, { timeout: 15000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="home-page"]')
        ?.textContent?.includes("Local project history is unavailable."),
    { timeout: 10000 },
  );
  const historyErrorVisible = await page.$eval('[role="alert"]', (element) => element.textContent);
  assert.match(historyErrorVisible, /Local project history is unavailable\./);
  assert.doesNotMatch(historyErrorVisible, /No slice jobs recorded/);

  await page.click(`[data-testid="home-project-${projects[1].id}"] .home-project-copy button`);
  await page.waitForFunction(
    (projectId) => {
      const row = document.querySelector(`[data-testid="home-project-${projectId}"]`);
      return row?.querySelector("button[aria-pressed='true']") !== null;
    },
    {},
    projects[1].id,
  );
  await page.click('[data-testid="home-recover"]');
  await page.waitForSelector('[data-testid="home-page"]', { hidden: true, timeout: 15000 });
  await page.waitForFunction(
    () => {
      const source = [...document.scripts].find((script) => script.type === "module");
      return Boolean(source);
    },
    { timeout: 5000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="home-page"]')?.hidden === true &&
      document.querySelector(".editor-workspace")?.hidden === false,
    { timeout: 5000 },
  );
  const objectNavIndex = await page.$$eval(".sidebar-nav button", (buttons) =>
    buttons.findIndex((button) => /objects|objetos/i.test(button.textContent ?? "")),
  );
  assert.ok(objectNavIndex >= 0, "Objects navigation button should be visible");
  await page.click(`.sidebar-nav button:nth-of-type(${objectNavIndex + 1})`);
  await page.waitForSelector(".object-name", { timeout: 15000 });
  const recoveredName = await page.$eval(".object-name", (element) => element.textContent?.trim());
  assert.equal(recoveredName, "Recovered Synthetic Object B");
  await page.click('.object-item[data-name="Recovered Synthetic Object B"]');
  const recoveredObjectName = await page.$eval(".object-name", (element) => element.textContent);
  assert.match(recoveredObjectName, /Recovered Synthetic Object B/);
  assert.equal(
    await page.$eval('.object-item[data-name="Recovered Synthetic Object B"]', (element) =>
      element.getAttribute("aria-selected"),
    ),
    "true",
  );
  assert.match(
    await page.$eval('[data-testid="status-revision"]', (element) => element.textContent),
    /12/,
  );
  calls.push(...(await page.evaluate(() => window.__homeInvokeCalls)));
  assert.ok(
    calls.some(
      (call) =>
        call.command === "project_authority_recover" && call.args.projectId === projects[1].id,
    ),
    `recover must target selected project B: ${JSON.stringify(calls)}`,
  );
  assert.ok(
    calls.some(
      (call) => call.command === "project_slice_history" && call.args.projectId === projects[1].id,
    ),
    `slice history must be queried for selected project B: ${JSON.stringify(calls)}`,
  );

  await page.goto(`${url}?provider=real`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(`[data-testid="home-project-${projects[1].id}"]`, { timeout: 15000 });
  await page.evaluate(() => {
    window.__homeFailRecover = true;
  });
  await page.click(`[data-testid="home-project-${projects[1].id}"] .home-project-copy button`);
  await page.click('[data-testid="home-recover"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[role="alert"]')?.textContent?.includes("synthetic recovery failure"),
    { timeout: 10000 },
  );
  const failedRecoveryState = await page.evaluate(() => ({
    homeHidden: document.querySelector('[data-testid="home-page"]').hidden,
    workspaceHidden: document.querySelector(".editor-workspace").hidden,
    revision: document.querySelector('[data-testid="status-revision"]')?.textContent ?? "",
    error: document.querySelector('[role="alert"]')?.textContent ?? "",
  }));
  assert.equal(failedRecoveryState.homeHidden, false, "failed recovery must stay on Home");
  assert.equal(
    failedRecoveryState.workspaceHidden,
    true,
    "failed recovery must not switch workspaces",
  );
  assert.match(failedRecoveryState.error, /synthetic recovery failure/);
  console.log(
    "PASS Home UI: selected-project recovery, hydrated snapshot, failed recovery preservation, and history error state",
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
