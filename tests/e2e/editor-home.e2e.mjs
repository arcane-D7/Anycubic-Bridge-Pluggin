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
        id: "synthetic-object-b",
        vertices: 8,
        triangles: 12,
        bounds: { min: [-5, 0, -5], max: [5, 10, 5] },
        sizeMm: [10, 10, 10],
        volumeMm3: 500,
        surfaceAreaMm2: 600,
        watertight: true,
        visible: true,
        locked: false,
        plateId: "plate-1",
        filamentId: "petg-fixture",
        transform: { x: 0, y: 0, z: 0 },
        artifactSha256: "synthetic-recovered-geometry",
        geometry: {
          positions: [
            -5, 0, -5, 5, 0, -5, 5, 10, -5, -5, 0, -5, 5, 10, -5, -5, 10, -5, -5, 0, 5, 5, 10, 5, 5,
            0, 5, -5, 0, 5, -5, 10, 5, 5, 10, 5, -5, 0, -5, -5, 10, 5, -5, 0, 5, -5, 0, -5, -5, 10,
            -5, -5, 10, 5, 5, 0, -5, 5, 0, 5, 5, 10, 5, 5, 0, -5, 5, 10, 5, 5, 10, -5, -5, 10, -5,
            5, 10, -5, 5, 10, 5, -5, 10, -5, 5, 10, 5, -5, 10, 5, -5, 0, -5, 5, 0, 5, 5, 0, -5, -5,
            0, -5, -5, 0, 5, 5, 0, 5,
          ],
          normals: Array(36).fill(0),
          indices: Array.from({ length: 36 }, (_, index) => index),
        },
      },
    ],
  },
  revision: 12,
};
const missingArtifactSnapshot = {
  project: {
    id: projects[1].id,
    name: projects[1].name,
    objects: [],
  },
  revision: 12,
  diagnostics: [
    {
      code: "ARTIFACT_FILE_MISSING",
      object_id: "synthetic-object-missing",
      artifact_sha256: "synthetic-missing-artifact",
    },
  ],
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
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.evaluateOnNewDocument(
    ({ projects: fixtureProjects, initial, recovered, missingArtifact }) => {
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args = {}) => {
          window.__homeInvokeCalls.push({ command, args });
          if (command === "slice_job_cancel") {
            window.__homeCancelCalls = (window.__homeCancelCalls ?? 0) + 1;
            return { status: "cancelled" };
          }
          if (command === "project_authority_read") return window.__homeInitialSnapshot;
          if (command === "slice_job_run") {
            window.__homeSliceRequest = args.request;
            return new Promise((resolve) => {
              window.__resolveHomeSlice = () =>
                resolve({
                  job_id: args.request.job_id,
                  status: "ready",
                  compatibility: "preview-only",
                  source_revision: args.request.expected_revision,
                  target_ids: args.request.target_ids,
                  input_digest: "synthetic-digest",
                  artifact_id: "synthetic-slice-artifact",
                  layer_count: 1,
                  segment_count: 1,
                  stats: {
                    layers: 1,
                    estimated_minutes: 1,
                    material_grams: 1,
                    volume_mm3: 1,
                    per_object_mm3: {},
                  },
                  ir: {
                    version: "1.1",
                    mode: "standard",
                    dialect: "anycubic",
                    coordinate_frame: "slice-ir",
                    units: "mm",
                    segments: [
                      {
                        mode: "standard",
                        kind: "WALL",
                        layer: 0,
                        pose: { from: { x: 0, y: 0, z: 0.2 }, to: { x: 1, y: 0, z: 0.2 } },
                        orientation: [1, 0, 0],
                      },
                    ],
                  },
                  program: "G1 X0 Y0 Z0.2 E0.1 F100",
                });
            });
          }
          if (command === "project_list") return window.__homeProjects;
          if (command === "project_slice_history") {
            return args.projectId === "home-project-a"
              ? [
                  {
                    job_id: "synthetic-job-a",
                    status: "completed",
                    source_revision: 4,
                    artifact_status: "present",
                    artifact_id: "synthetic-artifact-a",
                  },
                ]
              : [
                  {
                    job_id: "synthetic-job-b",
                    status: "completed",
                    source_revision: 12,
                    artifact_status: "present",
                    artifact_id: "synthetic-artifact-b",
                  },
                ];
          }
          if (command === "project_reprint_preflight") {
            if (args.sourceJobId === "synthetic-job-a")
              return {
                status: "proposed",
                proposalId: args.intentId,
                sourceJobId: args.sourceJobId,
                artifactId: "synthetic-artifact-a",
                artifactDigest: "synthetic-digest-a",
                profileFingerprint: "synthetic-profile-a",
                mode: "standard",
                toolBinding: "synthetic-tool-a",
                sourceRevision: 4,
                printerId: "synthetic-printer-a",
                qualification: "qualified",
              };
            return {
              status: "blocked",
              reason: "printer-mismatch",
              sourceJobId: args.sourceJobId,
            };
          }
          if (command === "project_authority_recover") {
            if (args.projectId === "home-project-b" && !window.__homeFailRecover) {
              window.__homeActiveProjectId = args.projectId;
              return window.__homeRecoveredSnapshot;
            }
            throw new Error("synthetic recovery failure");
          }
          if (command === "project_authority_commit") {
            window.__homeCommitProjectIds.push(args.project.id);
            return {
              status: "committed",
              actual_revision: args.expectedRevision + 1,
              snapshot: {
                project: args.project,
                revision: args.expectedRevision + 1,
              },
              diagnostics: [],
            };
          }
          if (command === "project_authority_read") return window.__homeInitialSnapshot;
          if (command === "live_job_binding") return window.__homeLiveBinding ?? null;
          if (command === "live_artifact_read") {
            window.__homeArtifactReadCalls = (window.__homeArtifactReadCalls ?? 0) + 1;
            if (window.__homeArtifactDefer) {
              return new Promise((resolve) => {
                window.__resolveHomeArtifact = () => resolve(window.__homeArtifactReply ?? null);
              });
            }
            if (window.__homeArtifactThrow) throw new Error("synthetic artifact read failure");
            return window.__homeArtifactReply ?? null;
          }
          throw new Error(`unexpected synthetic Tauri command: ${command}`);
        },
      };
      window.__homeProjects = fixtureProjects;
      window.__homeInitialSnapshot = initial;
      window.__homeRecoveredSnapshot = recovered;
      window.__homeMissingArtifactSnapshot = missingArtifact;
      window.__homeInvokeCalls = [];
      window.__homeCommitProjectIds = [];
      window.__homeFailRecover = false;
      window.__homeCancelCalls = 0;
      window.__homeLiveBinding = null;
      window.__homeArtifactReply = null;
      window.__homeArtifactDefer = false;
      window.__homeArtifactThrow = false;
    },
    {
      projects,
      initial: initialSnapshot,
      recovered: recoveredSnapshot,
      missingArtifact: missingArtifactSnapshot,
    },
  );

  await page.goto(`${url}?provider=real`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="home-continue"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 30000 });
  await page.waitForSelector(`[data-testid="home-project-${projects[1].id}"]`, { timeout: 15000 });
  await page.waitForSelector('[data-testid="home-reprint-synthetic-job-a"]', { timeout: 10000 });

  const assertSingleVisibleChat = async (surface, floating = true) => {
    const visibleChats = await page.$$eval(
      '[data-testid="chat-thread"]',
      (threads) =>
        threads.filter((thread) => {
          const rect = thread.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !thread.closest("[hidden]");
        }).length,
    );
    assert.equal(visibleChats, 1, `${surface} should expose exactly one visible chat thread`);
    if (floating) {
      assert.equal(
        await page.$eval('[data-testid="floating-panel-chat"]', (panel) => {
          const rect = panel.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }),
        true,
        `${surface} global chat panel should be visible`,
      );
    } else {
      assert.equal(
        await page.$eval(".editor-workspace", (workspace) => !workspace.hidden),
        true,
        `${surface} should navigate to Prepare`,
      );
      assert.equal(
        await page.$eval('[data-testid="chat-thread"]', (thread) =>
          Boolean(thread.closest(".panel-left")),
        ),
        true,
        `${surface} should dock chat in the Prepare sidebar`,
      );
    }
  };

  // Global chat must remain reachable without leaving each workspace surface.
  await page.mouse.click(
    ...(await page.$eval(".header-chat-toggle", (button) => {
      const rect = button.getBoundingClientRect();
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    })),
  );
  await page.waitForSelector('[data-testid="chat-thread"]', { timeout: 10000 });
  await assertSingleVisibleChat("Home");
  await page.click('[data-testid="collapse-chat"]');
  await page.waitForSelector('[data-testid="pill-chat"]', { timeout: 5000 });
  await page.click('[data-testid="pill-chat"]');
  await assertSingleVisibleChat("Home dock reopen");
  await page.click('[data-testid="collapse-chat"]');
  await page.waitForSelector('[data-testid="pill-chat"]', { timeout: 5000 });
  await page.click('[data-testid="pill-chat"]');
  await page.click('[data-testid="dock-chat"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 10000 });
  await assertSingleVisibleChat("Global dock from Home", false);
  await page.click(".header-chat-toggle");
  await assertSingleVisibleChat("Prepare global chat");
  await page.click('[data-testid="collapse-chat"]');
  await page.waitForSelector('[data-testid="pill-chat"]', { timeout: 5000 });

  await page.click('[data-testid="device-panel-toggle"]');
  await page.waitForSelector(".workbench-page:not([hidden])", { timeout: 10000 });
  const workbenchState = await page.evaluate(() => {
    const workbenchPage = document.querySelector(".workbench-page");
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return rect ? rect.width > 0 && rect.height > 0 : false;
    };
    return {
      text: workbenchPage?.innerText ?? "",
      provider: document
        .querySelector('[data-testid="bridge-state"]')
        ?.getAttribute("data-provider"),
      deviceEmpty: Boolean(document.querySelector('[data-testid="device-empty"]')),
      livePanel: Boolean(document.querySelector('[data-testid="workbench-live"]')),
      tabTriggers: [
        ...document.querySelectorAll('[data-testid="workbench-live"] [role="tab"]'),
      ].map((tab) => ({
        testid: tab.getAttribute("data-testid"),
        disabled: tab.disabled,
        ariaDisabled: tab.getAttribute("aria-disabled"),
      })),
      actionControls: [...(workbenchPage?.querySelectorAll("button,input,select") ?? [])]
        .filter(
          (control) =>
            !control.closest('[role="tablist"]') &&
            control.getAttribute("data-testid") !== "live-refresh",
        )
        .map((control) => ({
          disabled: control.disabled,
          text: control.textContent?.trim() ?? "",
          testid: control.getAttribute("data-testid"),
        })),
      canvasCount: workbenchPage?.querySelectorAll("canvas").length ?? 0,
      cameraMedia: [...(workbenchPage?.querySelectorAll("video,img") ?? [])].map((media) =>
        media.getAttribute("data-testid"),
      ),
      telemetryEmptyVisible: visible(
        document.querySelector('[data-testid="live-telemetry-empty"]'),
      ),
    };
  });
  assert.equal(workbenchState.provider, "real");
  assert.equal(workbenchState.deviceEmpty, true);
  assert.equal(workbenchState.livePanel, true, "Workbench must mount the Live panel");
  assert.match(workbenchState.text, /No printer selected/i);
  assert.equal(
    workbenchState.tabTriggers.length,
    3,
    `Live panel must expose exactly the 3 semantic tabs: ${JSON.stringify(workbenchState.tabTriggers)}`,
  );
  assert.ok(
    workbenchState.tabTriggers.every((tab) => !tab.disabled && tab.ariaDisabled !== "true"),
    `semantic tabs stay enabled for keyboard navigation: ${JSON.stringify(workbenchState.tabTriggers)}`,
  );
  assert.equal(
    workbenchState.telemetryEmptyVisible,
    true,
    "default Telemetry tab reports no printer selected",
  );
  assert.equal(
    workbenchState.canvasCount,
    0,
    "Workbench must not invent a 3D surface when nothing is linked",
  );
  assert.equal(
    workbenchState.cameraMedia.length,
    0,
    "Workbench must not invent camera placeholder frames",
  );
  assert.equal(
    workbenchState.actionControls.length,
    0,
    `synthetic read-only Workbench must expose no write controls: ${JSON.stringify(workbenchState.actionControls)}`,
  );
  assert.ok(
    workbenchState.actionControls.every((control) => control.disabled),
    `read-only Workbench must expose no enabled action controls: ${JSON.stringify(workbenchState.actionControls)}`,
  );

  // Camera tab — actual source is none; activation disabled with a stable
  // reason; zero placeholder media anywhere.
  await page.click('[data-testid="live-tab-camera"]');
  const cameraState = await page.evaluate(() => {
    const activate = document.querySelector('[data-testid="live-camera-activate"]');
    const reason = document.querySelector('[data-testid="live-camera-reason"]');
    const source = document.querySelector('[data-testid="live-camera-source"]');
    const visible = (element) => {
      const rect = element?.getBoundingClientRect();
      return rect ? rect.width > 0 && rect.height > 0 : false;
    };
    return {
      activateVisible: visible(activate),
      activateDisabled: activate?.disabled ?? null,
      activateAria: activate?.getAttribute("aria-disabled") ?? null,
      reason: reason?.textContent?.trim() ?? "",
      source: source?.getAttribute("data-source") ?? "",
      videoCount: document.querySelectorAll(".workbench-page video").length,
      imgCount: document.querySelectorAll(".workbench-page img").length,
      canvasCount: document.querySelectorAll(".workbench-page canvas").length,
    };
  });
  assert.equal(cameraState.activateVisible, true, "camera activation button is rendered");
  assert.equal(cameraState.activateDisabled, true);
  assert.equal(cameraState.activateAria, "true");
  assert.equal(cameraState.source, "none", "actual camera source stays none");
  assert.match(cameraState.reason, /no supported provider|nenhum provider/i);
  assert.equal(cameraState.videoCount, 0, "no invented camera placeholder video");
  assert.equal(cameraState.imgCount, 0, "no invented camera placeholder image");
  assert.equal(cameraState.canvasCount, 0, "no canvas in the camera view either");

  // Artifact tab — backend publishes no binding ⇒ current job has no link.
  await page.click('[data-testid="live-tab-artifact"]');
  const artifactNone = await page.evaluate(() => {
    const status = document.querySelector('[data-testid="live-artifact-status"]');
    const open = document.querySelector('[data-testid="live-artifact-open"]');
    const rect = open?.getBoundingClientRect();
    return {
      linked: status?.getAttribute("data-linked") ?? "",
      reason: status?.getAttribute("data-reason") ?? "",
      text: status?.textContent ?? "",
      openVisible: rect ? rect.width > 0 && rect.height > 0 : false,
    };
  });
  assert.equal(artifactNone.linked, "false");
  assert.equal(artifactNone.reason, "no-job");
  assert.match(artifactNone.text, /no linked artifact|sem artefacto ligado/i);
  assert.equal(artifactNone.openVisible, false, "no binding ⇒ no Preview route button");
  assert.equal(await page.evaluate(() => window.__homeCancelCalls), 0);
  assert.equal(
    await page.evaluate(
      () =>
        window.__homeInvokeCalls.filter(({ command }) =>
          /start|send|upload|control|print/i.test(command),
        ).length,
    ),
    0,
    "Workbench live reads never issue camera/printer orders",
  );
  await page.click(".header-chat-toggle");
  await page.waitForSelector('[data-testid="chat-thread"]', { timeout: 10000 });
  await assertSingleVisibleChat("Workbench");
  await page.click('[data-testid="collapse-chat"]');
  await page.waitForSelector('[data-testid="pill-chat"]', { timeout: 5000 });
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="home-page"]:not([hidden])', { timeout: 10000 });

  const proposedButton = '[data-testid="home-reprint-synthetic-job-a"]';
  assert.equal(await page.$eval(proposedButton, (button) => button.disabled), false);
  await page.click(proposedButton);
  await page.waitForFunction(() =>
    window.__homeInvokeCalls.some(({ command }) => command === "project_reprint_preflight"),
  );
  const preflightCall = await page.evaluate(() =>
    window.__homeInvokeCalls.find(({ command }) => command === "project_reprint_preflight"),
  );
  assert.equal(preflightCall.args.sourceJobId, "synthetic-job-a");
  assert.match(preflightCall.args.intentId, /^reprint-intent-/);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="home-reprint-status-synthetic-job-a"]')
      ?.textContent?.includes("Proposed intent"),
  );
  const proposedText = await page.$eval(
    '[data-testid="home-reprint-status-synthetic-job-a"]',
    (element) => element.textContent,
  );
  assert.match(proposedText, /synthetic-job-a/);
  assert.match(proposedText, /reprint-intent-[\w-]+/);
  assert.notEqual(proposedText.match(/reprint-intent-[\w-]+/)?.[0], "synthetic-job-a");
  assert.equal(
    await page.evaluate(
      () =>
        window.__homeInvokeCalls.filter(
          ({ command }) =>
            command !== "project_reprint_preflight" &&
            /upload|send|start|control|print/i.test(command),
        ).length,
    ),
    0,
  );

  await page.click(`[data-testid="home-project-${projects[1].id}"] .home-project-copy button`);
  await page.waitForSelector('[data-testid="home-reprint-synthetic-job-b"]', { timeout: 10000 });
  assert.equal(
    await page.$eval('[data-testid="home-reprint-synthetic-job-b"]', (button) => button.disabled),
    false,
  );
  await page.click('[data-testid="home-reprint-synthetic-job-b"]');
  await page.waitForFunction(() =>
    window.__homeInvokeCalls.some(
      ({ command, args }) =>
        command === "project_reprint_preflight" && args.sourceJobId === "synthetic-job-b",
    ),
  );
  const blockedText = await page.$eval(
    '[data-testid="home-reprint-status-synthetic-job-b"]',
    (element) => element.textContent,
  );
  assert.match(blockedText, /Blocked/);
  assert.match(blockedText, /printer-mismatch/);
  assert.equal(
    await page.evaluate(
      () =>
        window.__homeInvokeCalls.filter(
          ({ command }) =>
            command !== "project_reprint_preflight" &&
            /upload|send|start|control|print/i.test(command),
        ).length,
    ),
    0,
  );

  assert.equal(await page.$('[data-testid="home-reprint-synthetic-job-a"]'), null);
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
  await page.click(`.sidebar-nav button:nth-of-type(${objectNavIndex + 1})`);
  await page.waitForSelector(".object-name", { timeout: 15000 });
  if (!(await page.$(".object-name"))) {
    const state = await page.evaluate(() => ({
      objectRows: [...document.querySelectorAll(".object-item")].map((row) =>
        row.getAttribute("data-name"),
      ),
      sidebar: document.querySelector(".sidebar")?.textContent?.slice(0, 1200) ?? "",
      selectedTab: [...document.querySelectorAll(".sidebar-nav button")].map((button) => ({
        text: button.textContent,
        pressed: button.getAttribute("aria-pressed"),
      })),
      revision: document.querySelector('[data-testid="status-revision"]')?.textContent ?? "",
    }));
    throw new Error(
      `post-printer-selection object row missing; DOM=${JSON.stringify(state)}; browserErrors=${JSON.stringify(browserErrors)}`,
    );
  }
  const recoveredName = await page.$eval(".object-name", (element) => element.textContent?.trim());
  assert.equal(recoveredName, "Recovered Synthetic Object B");
  await page.click('.object-item[data-name="Recovered Synthetic Object B"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.object-item[data-name="Recovered Synthetic Object B"]')
        ?.getAttribute("aria-selected") === "true",
    { timeout: 5000 },
  );
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
  const eligibleSliceButton = await page.$eval('[data-testid="slice-btn"]', (button) => ({
    disabled: button.disabled,
    title: button.title,
    label: button.getAttribute("aria-label"),
  }));
  assert.equal(
    eligibleSliceButton.disabled,
    false,
    "watertight recovered object should allow slicing",
  );
  assert.equal(eligibleSliceButton.title, "", "eligible Slice should not expose a blocking reason");
  assert.match(eligibleSliceButton.label ?? "", /slice|fatiar/i);
  const initialRevisionText = await page.$eval(
    '[data-testid="status-revision"]',
    (element) => element.textContent,
  );
  const selectedBeforeSlice = await page.$eval(
    '[data-testid="status-coords"]',
    (element) => element.textContent,
  );
  await page.click('[data-testid="slice-btn"]');
  await page.waitForFunction(() => window.__homeSliceRequest && window.__homeSliceRequest.job_id);
  const capturedJobId = await page.evaluate(() => window.__homeSliceRequest.job_id);
  const capturedSliceRequest = await page.evaluate(() => window.__homeSliceRequest);
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.waitForSelector('[data-testid="preview-empty"]');
  const emptyPreviewState = await page.evaluate(() => {
    const preview = document.querySelector('[data-testid="preview-empty"]');
    const slice = document.querySelector('[data-testid="slice-btn"]');
    return {
      previewButtons: [...(preview?.querySelectorAll("button") ?? [])].map((button) => ({
        label: button.getAttribute("aria-label"),
        title: button.title,
      })),
      viewportCanvasCount: document.querySelectorAll('[data-testid="viewport-frame"] canvas')
        .length,
      plateTabs: document.querySelector('[data-testid="plate-tabs"]') !== null,
      dirtyChip: document.querySelector('[data-testid="dirty-chip"]') !== null,
      settingsTabs: document.querySelector('[data-testid="settings-tabs"]') !== null,
      objectTree: document.querySelector(".panel-object-tree") !== null,
      timeline: document.querySelector(".panel-timeline") !== null,
      footerHeight: document.querySelector(".app-footer")?.getBoundingClientRect().height ?? 0,
      footerDividerHidden: document.querySelector(".workspace-footer-divider")?.hidden ?? false,
      irTitle: document.querySelector(".panel-left .panel-title")?.textContent?.trim() ?? "",
      sidebarSelection: [
        ...document.querySelectorAll(".sidebar-nav button[aria-pressed='true']"),
      ].map((button) => button.textContent?.trim()),
      sliceDisabled: slice?.disabled ?? null,
      sliceTitle: slice?.getAttribute("title") ?? "",
      sliceLabel: slice?.getAttribute("aria-label") ?? "",
      revision: document.querySelector('[data-testid="status-revision"]')?.textContent ?? "",
      objectRows: document.querySelectorAll(".object-row").length,
      selectedObjectName: document.querySelector(".object-name")?.textContent?.trim() ?? null,
      selectedCoords: document.querySelector('[data-testid="status-coords"]')?.textContent ?? null,
    };
  });
  assert.equal(emptyPreviewState.previewButtons.length, 1);
  assert.match(emptyPreviewState.previewButtons[0].label, /^(Go to Prepare|Ir para Preparar)$/);
  assert.equal(
    emptyPreviewState.previewButtons[0].title,
    emptyPreviewState.previewButtons[0].label,
  );
  assert.equal(
    emptyPreviewState.viewportCanvasCount,
    1,
    "Preview must retain the mounted viewport",
  );
  assert.equal(
    emptyPreviewState.plateTabs,
    false,
    "Preview must not expose project plate switching",
  );
  assert.equal(emptyPreviewState.dirtyChip, false, "Preview must not expose save/restore actions");
  assert.equal(emptyPreviewState.settingsTabs, false, "Preview must not expose authoring settings");
  assert.equal(emptyPreviewState.objectTree, false, "Preview must not expose object authoring");
  assert.equal(emptyPreviewState.timeline, false, "Preview must not expose authoring timeline");
  assert.equal(
    emptyPreviewState.footerDividerHidden,
    true,
    "Preview must not show an empty resize divider",
  );
  assert.ok(emptyPreviewState.footerHeight < 120, "Preview footer should fit its status content");
  assert.match(emptyPreviewState.irTitle, /preview|pré-visualização/i);
  assert.equal(
    emptyPreviewState.sidebarSelection.length,
    0,
    "Preview must preserve the Settings selection without forcing Chat",
  );
  assert.equal(
    await page.$(".sidebar-nav button[aria-pressed], .sidebar-nav button:not(.sidebar-detach)"),
    null,
    "Preview should not offer Chat when Settings is selected",
  );
  assert.ok(await page.$('[data-testid="theme-toggle"]'), "Theme toggle should remain global");
  assert.equal(
    await page.$('[data-testid="shortcut-help-toggle"]'),
    null,
    "Preview should not expose Prepare shortcuts",
  );
  assert.equal(
    emptyPreviewState.sliceDisabled,
    true,
    "header Slice stays unavailable without loaded IR",
  );
  assert.match(
    emptyPreviewState.sliceLabel,
    /slice|fatiar/i,
    "disabled Slice should retain its accessible action label",
  );
  assert.equal(
    emptyPreviewState.sliceTitle,
    "",
    "eligible Slice should not invent a blocking reason in Preview",
  );
  assert.equal(await page.evaluate(() => window.__homeSliceRequest.job_id), capturedJobId);
  assert.equal(await page.evaluate(() => window.__homeCancelCalls), 0);
  assert.equal(
    emptyPreviewState.revision,
    initialRevisionText,
    "Preview navigation must not mutate the authoritative revision",
  );
  assert.equal(emptyPreviewState.objectRows, 0, "Preview must not mount authoring object rows");
  assert.equal(
    emptyPreviewState.selectedObjectName,
    null,
    "Preview must not mount authoring selection UI",
  );
  assert.equal(
    emptyPreviewState.selectedCoords,
    selectedBeforeSlice,
    "Preview must preserve authoritative selection coordinates",
  );
  const goPrepare = await page.$('[data-testid="preview-empty"] button');
  const goPrepareBox = await goPrepare.boundingBox();
  assert.ok(goPrepareBox, "Go to Prepare must have a real pointer hit target");
  await page.mouse.click(
    goPrepareBox.x + goPrepareBox.width / 2,
    goPrepareBox.y + goPrepareBox.height / 2,
  );
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "prepare",
  );
  await page.click(`.sidebar-nav button:nth-of-type(${objectNavIndex + 1})`);
  assert.equal(await page.evaluate(() => window.__homeSliceRequest.job_id), capturedJobId);
  assert.equal(await page.evaluate(() => window.__homeCancelCalls), 0);
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.workspaceView === "preview",
  );
  const previewFrame = await page.$('[data-testid="viewport-frame"]');
  await previewFrame.focus();
  await page.keyboard.press("Delete");
  await page.keyboard.down("Control");
  await page.keyboard.press("d");
  await page.keyboard.up("Control");
  assert.equal(
    await page.$eval('[data-testid="status-revision"]', (element) => element.textContent),
    initialRevisionText,
    "Delete and Ctrl+D in Preview must not mutate the authoritative revision",
  );
  assert.equal(
    await page.$eval('[data-testid="status-revision"]', (element) => element.textContent),
    initialRevisionText,
  );
  assert.equal(
    await page.evaluate(() => window.__homeMissingArtifactSnapshot.diagnostics[0].code),
    "ARTIFACT_FILE_MISSING",
  );
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="home-page"]:not([hidden])');
  assert.equal(await page.evaluate(() => window.__homeCancelCalls), 0);
  await page.waitForFunction(() => typeof window.__resolveHomeSlice === "function");
  await page.evaluate(() => window.__resolveHomeSlice());
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="slice-preview-only"]') !== null,
    );
  } catch (error) {
    const lateSliceState = await page.evaluate(() => ({
      homeHidden: document.querySelector('[data-testid="home-page"]')?.hidden,
      workspaceHidden: document.querySelector(".editor-workspace")?.hidden,
      previewOnly:
        document.querySelector('[data-testid="slice-preview-only"]')?.textContent ?? null,
      sliceProgress: document.querySelector('[data-testid="slice-progress"]')?.textContent ?? null,
      sliceRequest: window.__homeSliceRequest,
      invokeCalls: window.__homeInvokeCalls,
    }));
    throw new Error(
      `${error.message}; late slice DOM=${JSON.stringify(lateSliceState)}; browserErrors=${JSON.stringify(browserErrors)}`,
    );
  }
  assert.equal(await page.$eval('[data-testid="home-page"]', (element) => element.hidden), false);
  assert.match(
    await page.$eval('[data-testid="slice-preview-only"]', (element) => element.textContent),
    /synthetic-slice-artifact/,
  );
  assert.equal(await page.evaluate(() => window.__homeCancelCalls), 0);
  assert.deepEqual(await page.evaluate(() => window.__homeSliceRequest), capturedSliceRequest);
  assert.equal(
    await page.$eval(".workspace-tabs button:nth-of-type(1)", (button) =>
      button.getAttribute("aria-pressed"),
    ),
    "true",
    "completion from Home must retain Home rather than steal focus",
  );
  assert.equal(
    await page.$eval(".editor-workspace", (element) => element.hidden),
    true,
    "late slice completion from Home must not navigate away from Home",
  );
  const homeReturnState = await page.evaluate(() => ({
    objects: [...document.querySelectorAll(".object-item")].map((row) =>
      row.getAttribute("data-name"),
    ),
    selected: [...document.querySelectorAll(".object-item[aria-selected='true']")].map((row) =>
      row.getAttribute("data-name"),
    ),
  }));
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForSelector(".editor-workspace:not([hidden])", { visible: true });
  await page.click(`.sidebar-nav button:nth-of-type(${objectNavIndex + 1})`);
  try {
    await page.waitForFunction(
      () =>
        document
          .querySelector('.object-item[data-name="Recovered Synthetic Object B"]')
          ?.getAttribute("aria-selected") === "true",
      { timeout: 10000 },
    );
  } catch (error) {
    const selectionState = await page.evaluate(
      (beforeReturn) => ({
        workspaceHidden: document.querySelector(".editor-workspace")?.hidden,
        sidebar: [...document.querySelectorAll(".sidebar-nav button")].map((button) => ({
          text: button.textContent?.trim(),
          pressed: button.getAttribute("aria-pressed"),
        })),
        workspaceText: document.querySelector(".editor-workspace")?.textContent?.slice(0, 500),
        beforeReturn,
        objectRows: [...document.querySelectorAll(".object-item")].map((row) => ({
          name: row.getAttribute("data-name"),
          selected: row.getAttribute("aria-selected"),
        })),
      }),
      homeReturnState,
    );
    throw new Error(
      `${error.message}; return selection diagnostic=${JSON.stringify(selectionState)}; browserErrors=${JSON.stringify(browserErrors)}`,
    );
  }
  assert.equal(
    await page.$eval('.object-item[data-name="Recovered Synthetic Object B"]', (element) =>
      element.getAttribute("aria-selected"),
    ),
    "true",
    "returning to Prepare must restore the same selected object",
  );
  await page.click('[data-testid="object-duplicate"]');
  await page.waitForFunction(() => window.__homeCommitProjectIds.length > 0, { timeout: 10000 });
  assert.equal(
    await page.evaluate(() => window.__homeCommitProjectIds.at(-1)),
    projects[1].id,
    "scene mutation after recovery must persist through project B's bridge",
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

  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 15000 });
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 10000 });
  const narrowState = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const sidebar = document.querySelector(".panel-left");
    const toolbar = document.querySelector('[data-testid="viewport-toolbar"]');
    const rail = document.querySelector('[data-testid="plate-rail"]');
    const buttons = [...(toolbar?.querySelectorAll("button") ?? [])];
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return {
      collapsed: shell?.classList.contains("sidebar-collapsed") ?? false,
      sidebarVisible: sidebar ? visible(sidebar) : false,
      toolbar: toolbar ? toolbar.getBoundingClientRect().toJSON() : null,
      rail: rail ? rail.getBoundingClientRect().toJSON() : null,
      toolbarButtons: buttons.map((button) => ({
        text: button.textContent?.trim() ?? "",
        visible: visible(button),
        left: button.getBoundingClientRect().left,
        right: button.getBoundingClientRect().right,
      })),
    };
  });
  assert.equal(
    narrowState.collapsed,
    true,
    "mobile Prepare should start with the sidebar collapsed",
  );
  assert.equal(narrowState.sidebarVisible, false);
  assert.ok(narrowState.toolbar, "mobile viewport toolbar should be present");
  assert.ok(
    narrowState.toolbarButtons.length > 0 &&
      narrowState.toolbar.width < narrowState.toolbarButtons.at(-1).right,
    `mobile toolbar should expose a horizontally scrollable row: ${JSON.stringify(narrowState)}`,
  );
  assert.ok(
    narrowState.rail && narrowState.rail.top >= narrowState.toolbar.bottom,
    `plate rail must not overlap the toolbar: ${JSON.stringify(narrowState)}`,
  );
  const lastToolbarButton = '[data-testid="viewport-toolbar"] button:last-of-type';
  await page.$eval(lastToolbarButton, (button) =>
    button.scrollIntoView({ inline: "end", block: "nearest" }),
  );
  const lastButtonState = await page.$eval(lastToolbarButton, (button) => {
    const rect = button.getBoundingClientRect();
    const toolbar = button.closest('[data-testid="viewport-toolbar"]');
    const toolbarRect = toolbar.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      withinToolbar: rect.left >= toolbarRect.left && rect.right <= toolbarRect.right,
      receivesHit: hit === button || button.contains(hit),
      left: rect.left,
      right: rect.right,
    };
  });
  assert.equal(
    lastButtonState.withinToolbar,
    true,
    `last toolbar button should scroll into view: ${JSON.stringify(lastButtonState)}`,
  );
  assert.equal(
    lastButtonState.receivesHit,
    true,
    `last toolbar button should receive pointer hit: ${JSON.stringify(lastButtonState)}`,
  );
  await page.click(".sidebar-toggle");
  await page.waitForFunction(
    () => !document.querySelector(".app-shell")?.classList.contains("sidebar-collapsed"),
  );
  assert.equal(
    await page.$eval(".app-shell", (shell) => shell.classList.contains("sidebar-collapsed")),
    false,
    "the sidebar toggle should still open the mobile sidebar",
  );
  await page.click(".sidebar-toggle");
  await page.setViewport({ width: 760, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 15000 });
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 10000 });
  const boundaryState = await page.evaluate(() => ({
    width: window.innerWidth,
    collapsed: document.querySelector(".app-shell")?.classList.contains("sidebar-collapsed"),
    toolbar: document
      .querySelector('[data-testid="viewport-toolbar"]')
      ?.getBoundingClientRect()
      .toJSON(),
    rail: document.querySelector('[data-testid="plate-rail"]')?.getBoundingClientRect().toJSON(),
  }));
  assert.equal(boundaryState.width, 760);
  assert.equal(boundaryState.collapsed, true, "the 760px breakpoint should start collapsed");
  assert.ok(
    boundaryState.rail &&
      boundaryState.toolbar &&
      boundaryState.rail.top >= boundaryState.toolbar.bottom,
    `760px plate rail must not overlap the toolbar: ${JSON.stringify(boundaryState)}`,
  );
  console.log(
    `PASS Home UI: global chat, recovery, and responsive layout at 390px/760px ${JSON.stringify({ narrow: narrowState, boundary: boundaryState })}`,
  );

  // ---- S9.17-004 Workbench Live: controlled fixture flows ------------------
  await page.setViewport({ width: 1440, height: 900 });
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.waitForSelector(".workbench-page:not([hidden])", { timeout: 10000 });
  await page.waitForSelector('[data-testid="workbench-live"]', { timeout: 10000 });
  await page.waitForFunction(() =>
    window.__homeInvokeCalls.some(({ command }) => command === "live_job_binding"),
  );

  // Semantic tabs stay keyboard-navigable (Radix roving tabindex + arrows).
  // NOTE: run this BEFORE any other live-tab click: a mouse redirect (click A
  // then click B) desyncs roving focus in the pinned Radix 1.1.21 build
  // (event.target !== currentTarget after the second click), but on a fresh
  // roving group the arrow handler fires reliably.
  await page.click('[data-testid="live-tab-telemetry"]');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "live-tab-telemetry",
    { timeout: 5000 },
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "live-tab-camera",
    { timeout: 5000 },
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
    "live-tab-camera",
    "ArrowRight must move focus to the camera tab",
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "live-tab-artifact",
    { timeout: 5000 },
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
    "live-tab-artifact",
    "ArrowRight must move focus to the artifact tab",
  );
  // Roving tabstop: exactly one trigger stays keyboard-reachable (tabIndex 0);
  // after the arrows the stop follows focus (camera), the value stays active.
  const rovingTabIndex = await page.$$eval(
    '[data-testid="workbench-live"] [role="tab"]',
    (triggers) =>
      triggers.map((trigger) => ({
        testid: trigger.getAttribute("data-testid"),
        tabindex: trigger.tabIndex,
        state: trigger.getAttribute("data-state"),
      })),
  );
  const tabStopTotal = rovingTabIndex.filter((trigger) => trigger.tabindex === 0).length;
  assert.equal(
    tabStopTotal,
    1,
    `exactly one tab owns the roving tabstop: ${JSON.stringify(rovingTabIndex)}`,
  );
  // Clicking a tab restores the tabstop to the activated tab (mouse redirect still works).
  await page.click('[data-testid="live-tab-telemetry"]');
  const clickStop = await page.$$eval('[data-testid="workbench-live"] [role="tab"]', (triggers) =>
    triggers.map((trigger) => ({
      testid: trigger.getAttribute("data-testid"),
      tabindex: trigger.tabIndex,
      state: trigger.getAttribute("data-state"),
    })),
  );
  const activeStop = clickStop.filter(
    (trigger) => trigger.tabindex === 0 && trigger.state === "active",
  );
  assert.equal(
    activeStop.length,
    1,
    `clicked tab becomes the tabstop and active: ${JSON.stringify(clickStop)}`,
  );

  // Pending/unknown job with a silent backend ⇒ artifact stays unlinked.
  await page.click('[data-testid="live-tab-artifact"]');
  const artifactPending = await page.$eval('[data-testid="live-artifact-status"]', (status) => ({
    linked: status.getAttribute("data-linked"),
    reason: status.getAttribute("data-reason"),
    text: status.textContent ?? "",
  }));
  assert.equal(artifactPending.linked, "false");
  assert.match(artifactPending.text, /no linked artifact|sem artefacto ligado/i);
  assert.equal(await page.evaluate(() => window.__homeCancelCalls), 0);

  // Controlled fixture: exact physical-task-id binding + fresh rev + parsed IR.
  await page.evaluate(() => {
    window.__homeLiveBinding = {
      source: "tauri",
      available: true,
      observedJobId: "physical-task-100",
      observedPrinterId: "cloud-printer-x",
      jobBinding: {
        physicalTaskId: "physical-task-100",
        printerId: "cloud-printer-x",
        projectId: "project-9",
        artifactId: "bracket-ir-42",
        sourceRev: 5,
        currentRev: 5,
        compatibility: "preview-only",
      },
      artifact: {
        artifactId: "bracket-ir-42",
        sourceRev: 5,
        currentRev: 5,
        compatibility: "preview-only",
        irParsed: true,
      },
    };
  });
  await page.click('[data-testid="live-refresh"]');
  await page.click('[data-testid="live-tab-artifact"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-status"]')
        ?.getAttribute("data-linked") === "true",
  );
  const artifactLinked = await page.evaluate(() => {
    const status = document.querySelector('[data-testid="live-artifact-status"]');
    const open = document.querySelector('[data-testid="live-artifact-open"]');
    const rect = open?.getBoundingClientRect();
    return {
      linked: status.getAttribute("data-linked"),
      text: status.textContent ?? "",
      id: document.querySelector('[data-testid="live-artifact-id"]')?.textContent ?? "",
      openVisible: rect ? rect.width > 0 && rect.height > 0 : false,
    };
  });
  assert.equal(artifactLinked.linked, "true");
  assert.match(artifactLinked.text, /linked to the running job|ligado ao trabalho/i);
  assert.match(artifactLinked.id, /bracket-ir-42/);
  assert.match(artifactLinked.id, /rev|revis/i);
  assert.equal(
    artifactLinked.openVisible,
    true,
    "a linked artifact offers the Preview route button",
  );

  // Known-stale artifact: source revision no longer matches the binding.
  await page.evaluate(() => {
    window.__homeLiveBinding.artifact = {
      ...window.__homeLiveBinding.artifact,
      sourceRev: 4,
    };
  });
  await page.click('[data-testid="live-refresh"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-status"]')
        ?.getAttribute("data-reason") === "stale-source-rev",
  );
  const artifactStale = await page.evaluate(() => {
    const status = document.querySelector('[data-testid="live-artifact-status"]');
    const open = document.querySelector('[data-testid="live-artifact-open"]');
    const rect = open?.getBoundingClientRect();
    return {
      linked: status.getAttribute("data-linked"),
      reason: status.getAttribute("data-reason"),
      text: status.textContent ?? "",
      openVisible: rect ? rect.width > 0 && rect.height > 0 : false,
    };
  });
  assert.equal(artifactStale.linked, "false");
  assert.equal(artifactStale.reason, "stale-source-rev");
  assert.match(artifactStale.text, /stale|desatualizad/i);
  assert.equal(artifactStale.openVisible, false, "stale artifact must not offer Preview");

  // Honesty invariants across all states: no invented media/surface, camera
  // stays disabled, and the ONLY live lane command is the read-only binding.
  // Radix unmounts inactive tab content, so bring the camera tab into view
  // first to prove the disabled activation button is really in the DOM.
  await page.click('[data-testid="live-tab-camera"]');
  await page.waitForSelector('[data-testid="live-camera-activate"]', { timeout: 5000 });
  const liveHonesty = await page.evaluate(() => ({
    canvasCount: document.querySelectorAll(".workbench-page canvas").length,
    videoCount: document.querySelectorAll(".workbench-page video").length,
    imgCount: document.querySelectorAll(".workbench-page img").length,
    cameraSource:
      document.querySelector('[data-testid="live-camera-source"]')?.getAttribute("data-source") ??
      null,
    cameraDisabled:
      document.querySelector('[data-testid="live-camera-activate"]')?.disabled ?? null,
    writeCalls: window.__homeInvokeCalls
      .map(({ command }) => command)
      .filter((command) =>
        /start|send|upload|control|print|slice_job_run|slice_job_cancel/i.test(command),
      ),
    bindingCalls: window.__homeInvokeCalls.filter(({ command }) => command === "live_job_binding")
      .length,
    loadError: Boolean(document.querySelector('[data-testid="live-load-error"]')),
  }));
  assert.equal(liveHonesty.canvasCount, 0, "no invented 3D surface anywhere in Workbench");
  assert.equal(liveHonesty.videoCount, 0, "no invented camera frames");
  assert.equal(liveHonesty.imgCount, 0, "no invented placeholder images");
  assert.equal(liveHonesty.cameraSource, "none", "camera source reports none even when mounted");
  assert.equal(liveHonesty.cameraDisabled, true, "camera activation stays disabled");
  assert.deepEqual(liveHonesty.writeCalls, [], "only the read-only lane runs, never an order");
  assert.ok(liveHonesty.bindingCalls >= 1, "the read-only binding lane was queried");
  assert.equal(liveHonesty.loadError, false, "fixture reads never surface a load error");
  assert.equal(await page.evaluate(() => window.__homeCancelCalls), 0);
  console.log(
    "PASS S9.17-004 Workbench Live: camera disabled with reason, artifact none → linked → stale, zero invented media",
  );

  // ---- S9.17-004 AC2/AC3/AC5: Preview loads the REAL artifact IR from the
  // ---- project CAS; stale/mismatched/malformed/late refusals never overwrite
  // ---- the open preview; keyboard tabs still work AFTER mouse clicks.
  // Enter a real project first so the router scope guard matches the binding.
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="home-page"]:not([hidden])', { timeout: 10000 });
  // Select the project that backs the realm's initial snapshot: continue
  // requires localProject == active snapshot, and it gives scope
  // home-project-a (revision 4) that the binding below matches.
  await page.click(`[data-testid="home-project-${projects[0].id}"] .home-project-copy button`);
  // The copy button toggles selectedProjectId; home-continue stays disabled
  // until the row is actually selected (same gate the recovery test uses).
  await page.waitForFunction(
    (projectId) => {
      const row = document.querySelector(`[data-testid="home-project-${projectId}"]`);
      return row?.querySelector("button[aria-pressed='true']") !== null;
    },
    {},
    projects[0].id,
  );
  await page.click('[data-testid="home-continue"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 15000 });
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.waitForSelector('[data-testid="workbench-live"]:not([hidden])', { timeout: 10000 });

  // Binding is scoped to the ACTIVE project (home-project-a, initial snapshot
  // revision 4) so the preview stays fresh; the IR has 2 layers / 3 segments.
  const activeScopeId = projects[0].id;
  const scopeBinding = {
    source: "tauri",
    available: true,
    observedJobId: "physical-task-100",
    observedPrinterId: "cloud-printer-x",
    jobBinding: {
      physicalTaskId: "physical-task-100",
      printerId: "cloud-printer-x",
      projectId: activeScopeId,
      artifactId: "bracket-ir-42",
      sourceRev: 4,
      currentRev: 4,
      compatibility: "preview-only",
    },
    artifact: {
      artifactId: "bracket-ir-42",
      sourceRev: 4,
      currentRev: 4,
      compatibility: "preview-only",
      irParsed: true,
    },
  };
  const validArtifactReply = {
    artifactId: "bracket-ir-42",
    sourceRevision: 4,
    currentRevision: 4,
    ir: {
      version: "1.1",
      mode: "standard",
      dialect: "anycubic",
      coordinate_frame: "slice-ir",
      units: "mm",
      source_revision: 4,
      job_id: "native-job-x",
      target_ids: ["object-b"],
      segments: [
        {
          mode: "standard",
          kind: "WALL",
          layer: 0,
          pose: { from: { x: 0, y: 0, z: 0.2 }, to: { x: 10, y: 0, z: 0.2 } },
          orientation: [1, 0, 0],
          segment_id: "seg-b-l0",
          execution_order: 0,
          object_id: "object-b",
          provenance: { layer: 0 },
          gcode_line_start: 1,
          gcode_line_end: 2,
        },
        {
          mode: "standard",
          kind: "WALL",
          layer: 0,
          pose: { from: { x: 10, y: 0, z: 0.2 }, to: { x: 20, y: 0, z: 0.2 } },
          orientation: [1, 0, 0],
          segment_id: "seg-b-l1",
          execution_order: 1,
          object_id: "object-b",
          provenance: { layer: 0 },
          gcode_line_start: 3,
          gcode_line_end: 4,
        },
        {
          mode: "standard",
          kind: "WALL",
          layer: 1,
          pose: { from: { x: 0, y: 0, z: 1.2 }, to: { x: 10, y: 0, z: 1.2 } },
          orientation: [1, 0, 0],
          segment_id: "seg-b-l2",
          execution_order: 2,
          object_id: "object-b",
          provenance: { layer: 1 },
          gcode_line_start: 5,
          gcode_line_end: 6,
        },
      ],
    },
  };
  await page.evaluate(
    ({ binding, artifactReply }) => {
      window.__homeLiveBinding = binding;
      window.__homeArtifactReply = artifactReply;
      window.__homeArtifactDefer = false;
      window.__homeArtifactThrow = false;
    },
    { binding: scopeBinding, artifactReply: validArtifactReply },
  );
  await page.click('[data-testid="live-refresh"]');
  await page.click('[data-testid="live-tab-artifact"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-status"]')
        ?.getAttribute("data-linked") === "true",
    { timeout: 10000 },
  );

  // AC2 — clicking Open must really parse the IR loaded from the project CAS
  // lane (live_artifact_read), and the Preview must show its segments/ids.
  await page.click('[data-testid="live-artifact-open"]');
  await page.waitForSelector('[data-testid="slice-preview-only"]', { timeout: 15000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="preview-controls"]')
        ?.getAttribute("data-visible-segment-ids")
        ?.includes("seg-b-l0"),
    { timeout: 15000 },
  );
  const openedPreview = await page.evaluate(() => ({
    artifactStatus: document.querySelector('[data-testid="slice-preview-only"]')?.textContent ?? "",
    visibleSegmentIds:
      document
        .querySelector('[data-testid="preview-controls"]')
        ?.getAttribute("data-visible-segment-ids") ?? "",
    currentSegmentId:
      document
        .querySelector('[data-testid="preview-segment-slider"]')
        ?.getAttribute("data-current-segment-id") ?? "",
    layerSliderMax: document.querySelector('[data-testid="preview-layer-slider"]')?.max ?? "",
    irStatus: document.querySelector('[data-testid="ir-status"]')?.textContent?.trim() ?? "",
    artifactLabel: document.querySelector('[data-testid="preview-artifact"]')?.textContent ?? "",
  }));
  assert.match(openedPreview.artifactStatus, /bracket-ir-42/);
  assert.equal(openedPreview.currentSegmentId, "seg-b-l0");
  assert.ok(
    openedPreview.visibleSegmentIds.includes("seg-b-l0"),
    `first layer-0 segment really rendered: ${JSON.stringify(openedPreview)}`,
  );
  assert.equal(openedPreview.layerSliderMax, "1", "2-layer IR exposes a layer slider max of 1");
  assert.match(openedPreview.irStatus, /2/);
  assert.match(openedPreview.irStatus, /layer|camada/i);
  assert.match(openedPreview.artifactLabel, /native-job-x/);
  // Step forward once: the SECOND CAS segment becomes the active one — proof
  // the layer-0 IR segments are really in the preview model, not just the id.
  await page.click('[data-testid="preview-step-forward"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="preview-segment-slider"]')
        ?.getAttribute("data-current-segment-id") === "seg-b-l1",
    { timeout: 5000 },
  );
  assert.ok(
    (
      await page.evaluate(() =>
        document
          .querySelector('[data-testid="preview-controls"]')
          ?.getAttribute("data-visible-segment-ids"),
      )
    )?.includes("seg-b-l1"),
    "stepping exposes the next CAS segment in the visible preview",
  );

  // AC3 — STALE artifact (sourceRev < binding) is refused: no Open offered,
  // and the previous preview is preserved untouched.
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.waitForSelector('[data-testid="live-refresh"]', { timeout: 10000 });
  await page.evaluate(() => {
    window.__homeLiveBinding.artifact = {
      ...window.__homeLiveBinding.artifact,
      sourceRev: 3,
    };
  });
  await page.click('[data-testid="live-refresh"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-status"]')
        ?.getAttribute("data-reason") === "stale-source-rev",
    { timeout: 10000 },
  );
  assert.equal(
    await page.evaluate(() => {
      const open = document.querySelector('[data-testid="live-artifact-open"]');
      return open ? open.getBoundingClientRect().width > 0 : false;
    }),
    false,
    "a stale artifact must never offer Open",
  );
  await page.click(".workspace-tabs button:nth-of-type(3)");
  const preservedAfterStale = await page.evaluate(() => ({
    artifactStatus: document.querySelector('[data-testid="slice-preview-only"]')?.textContent ?? "",
    visibleSegmentIds:
      document
        .querySelector('[data-testid="preview-controls"]')
        ?.getAttribute("data-visible-segment-ids") ?? "",
  }));
  assert.match(preservedAfterStale.artifactStatus, /bracket-ir-42/);
  assert.ok(
    preservedAfterStale.visibleSegmentIds.includes("seg-b-l0"),
    `stale refusal preserved the open preview: ${JSON.stringify(preservedAfterStale)}`,
  );

  // AC3 — a binding for ANOTHER project is refused (project-mismatch) with
  // the same preservation.
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.evaluate(() => {
    window.__homeLiveBinding.jobBinding = {
      ...window.__homeLiveBinding.jobBinding,
      projectId: "project-9", // ≠ active scope home-project-a
    };
    window.__homeLiveBinding.artifact = {
      ...window.__homeLiveBinding.artifact,
      sourceRev: 4,
    };
  });
  await page.click('[data-testid="live-refresh"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-status"]')
        ?.getAttribute("data-reason") === "project-mismatch",
    { timeout: 10000 },
  );
  assert.equal(
    await page.evaluate(() => {
      const open = document.querySelector('[data-testid="live-artifact-open"]');
      return open ? open.getBoundingClientRect().width > 0 : false;
    }),
    false,
    "a foreign project must never offer Open",
  );
  await page.click(".workspace-tabs button:nth-of-type(3)");
  const preservedAfterMismatch = await page.evaluate(() => ({
    artifactStatus: document.querySelector('[data-testid="slice-preview-only"]')?.textContent ?? "",
    visibleSegmentIds:
      document
        .querySelector('[data-testid="preview-controls"]')
        ?.getAttribute("data-visible-segment-ids") ?? "",
  }));
  assert.match(preservedAfterMismatch.artifactStatus, /bracket-ir-42/);
  assert.ok(
    preservedAfterMismatch.visibleSegmentIds.includes("seg-b-l0"),
    `project-mismatch refusal preserved the open preview: ${JSON.stringify(preservedAfterMismatch)}`,
  );

  // AC3 — MALFORMED IR coming back over the CAS lane is rejected with an
  // explicit error and never replaces the open preview.
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.evaluate(() => {
    window.__homeLiveBinding.jobBinding = {
      ...window.__homeLiveBinding.jobBinding,
      projectId: "home-project-a",
    };
    window.__homeArtifactReply = {
      artifactId: "bracket-ir-42",
      sourceRevision: 4,
      currentRevision: 4,
      ir: {
        version: "9.9",
        mode: "standard",
        dialect: "anycubic",
        coordinate_frame: "slice-ir",
        units: "mm",
        segments: [],
      },
    };
  });
  await page.click('[data-testid="live-refresh"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-status"]')
        ?.getAttribute("data-linked") === "true",
    { timeout: 10000 },
  );
  await page.click('[data-testid="live-artifact-open"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-open-status"]')
        ?.getAttribute("data-state") === "error",
    { timeout: 10000 },
  );
  const malformedStatus = await page.evaluate(() => ({
    statusText:
      document.querySelector('[data-testid="live-artifact-open-status"]')?.textContent ?? "",
  }));
  assert.match(malformedStatus.statusText, /version|vers/i);
  // The refusal must NEVER route: back on the preview tab the old IR stays
  // exactly as it was (same artifact id, same visible segments).
  await page.click(".workspace-tabs button:nth-of-type(3)");
  const preservedAfterMalformed = await page.evaluate(() => ({
    previewStill: document.querySelector('[data-testid="slice-preview-only"]')?.textContent ?? "",
    visibleSegmentIds:
      document
        .querySelector('[data-testid="preview-controls"]')
        ?.getAttribute("data-visible-segment-ids") ?? "",
  }));
  assert.match(preservedAfterMalformed.previewStill, /bracket-ir-42/);
  assert.ok(
    preservedAfterMalformed.visibleSegmentIds.includes("seg-b-l0"),
    `malformed IR never overwrote the open preview: ${JSON.stringify(preservedAfterMalformed)}`,
  );

  // AC3 — a DELAYED artifact read landing after the page switched is revoked:
  // never routed, never overwrites the preview, never reports a fake success.
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.evaluate((artifactReply) => {
    window.__homeArtifactReply = artifactReply;
    window.__homeArtifactDefer = true;
  }, validArtifactReply);
  await page.click('[data-testid="live-refresh"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-status"]')
        ?.getAttribute("data-linked") === "true",
    { timeout: 10000 },
  );
  await page.click('[data-testid="live-artifact-open"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="live-artifact-open"]')?.disabled === true,
    { timeout: 10000 },
  );
  // Leave the workbench page while the read is still in flight (project switch).
  await page.click(".workspace-tabs button:nth-of-type(3)");
  await page.evaluate(() => window.__resolveHomeArtifact?.());
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="live-artifact-open-status"]')
        ?.getAttribute("data-state") === "revoked",
    { timeout: 10000 },
  );
  const raceRevoked = await page.evaluate(() => ({
    statusText:
      document.querySelector('[data-testid="live-artifact-open-status"]')?.textContent ?? "",
    previewStill: document.querySelector('[data-testid="slice-preview-only"]')?.textContent ?? "",
    visibleSegmentIds:
      document
        .querySelector('[data-testid="preview-controls"]')
        ?.getAttribute("data-visible-segment-ids") ?? "",
  }));
  assert.match(raceRevoked.statusText, /cancelled|canceled|revoked|revogad|atualiz/i);
  assert.match(raceRevoked.previewStill, /bracket-ir-42/);
  assert.ok(
    raceRevoked.visibleSegmentIds.includes("seg-b-l0"),
    `a late read never routed over the open preview: ${JSON.stringify(raceRevoked)}`,
  );

  // AC5 — keyboard navigation AFTER real mouse redirects (Camera → Artifact →
  // ArrowLeft → ArrowRight) keeps the roving single tabstop working.
  await page.click(".workspace-tabs button:nth-of-type(4)");
  await page.evaluate(() => {
    window.__homeArtifactDefer = false;
  });
  await page.waitForSelector('[data-testid="live-tab-camera"]', { timeout: 10000 });
  await page.click('[data-testid="live-tab-camera"]');
  await page.click('[data-testid="live-tab-artifact"]');
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "live-tab-camera",
    { timeout: 5000 },
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "live-tab-artifact",
    { timeout: 5000 },
  );
  const rovingAfterClicks = await page.$$eval(
    '[data-testid="workbench-live"] [role="tab"]',
    (triggers) =>
      triggers.map((trigger) => ({
        testid: trigger.getAttribute("data-testid"),
        tabindex: trigger.tabIndex,
        state: trigger.getAttribute("data-state"),
      })),
  );
  assert.equal(
    rovingAfterClicks.filter((trigger) => trigger.tabindex === 0).length,
    1,
    `exactly one roving tabstop after mouse→keyboard: ${JSON.stringify(rovingAfterClicks)}`,
  );
  assert.equal(
    rovingAfterClicks.find((trigger) => trigger.tabindex === 0)?.testid,
    "live-tab-artifact",
    `tabstop follows the final arrow focus: ${JSON.stringify(rovingAfterClicks)}`,
  );

  console.log(
    "PASS S9.17-004 Preview: CAS IR rendered with segment ids, refusals keep old preview, mouse→keyboard roving works",
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
