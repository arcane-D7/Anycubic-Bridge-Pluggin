#!/usr/bin/env node
/**
 * S9.17-004 NAV-05 E2E — project-scoped chat context isolation.
 *
 * Runs the real editor against a controlled Tauri invoke bridge (fake
 * `__TAURI_INTERNALS__`): continue project A → chat sends a message → back
 * to Home → recover project B → chat is a FRESH scope (A's transcript
 * absent) → send a message in B → back to A → original chat restored with A
 * transcript only. Asserts:
 *   - localized scope label ("Project: <name>") + data-project-scope attr;
 *   - conversation lists (and the active thread) show ONLY the current scope
 *     (1 row, no cross-project leak);
 *   - page-tab switches (Home ↔ Prepare) never create conversations nor
 *     clear messages;
 *   - persisted conversations carry the `projectId` field (flat fake Tauri
 *     lane — the backend bucket-split is a reported TODO) and NO scope's
 *     history is dropped;
 *   - reload (reopen) restores the original per-project chat from
 *     persistence;
 *   - NAV-05 scope-key security: `data-project-scope` carries the NAMESPACED
 *     key ("project:" + URI-encoded id) and a project whose id is literally
 *     "workspace" renders a distinct ChatScope label from the global
 *     workspace scope (no collision).
 *
 * Real interactions only (page.click / page.type + keyboard Enter — no
 * element.click() through evaluate). Never contacts a printer or cloud.
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
const port = Number(process.env.EDITOR_CHAT_SCOPE_E2E_PORT ?? 1438);
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
  // NAV-05 scope-key collision proof: a project whose id is literally
  // "workspace" must be a DISTINCT scope from the global workspace chat.
  { id: "workspace", name: "Synthetic Workspace Project", updated_ms: 0 },
];
// Scope keys are namespaced ("project:" + URI-encoded id) so a project
// named/equal to "workspace" can never collide with the global key.
const PROJECT_SCOPE_PREFIX = "project:";
const snapshotOf = (project) => ({
  project: { id: project.id, name: project.name, objects: [] },
  revision: project.id === projects[0].id ? 4 : project.id === projects[1].id ? 12 : 1,
});
const snapshots = Object.fromEntries(projects.map((project) => [project.id, snapshotOf(project)]));

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
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.evaluateOnNewDocument(
    ({ fixtureProjects, fixtureSnapshots }) => {
      window.isTauri = true;
      // The fake Tauri chat-store lane is backed by REAL localStorage so the
      // "reopen" (reload) leg genuinely re-hydrates from a persistent medium
      // (window properties do not survive a reload; localStorage does).
      const storeKey = "anycubic:e2e:chat-store";
      const loadStore = () => {
        try {
          return JSON.parse(window.localStorage.getItem(storeKey) ?? "{}");
        } catch {
          return {};
        }
      };
      const saveStore = (map) => window.localStorage.setItem(storeKey, JSON.stringify(map));
      window.__chatStore = loadStore();
      window.__chatStoreGetCalls = 0;
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args = {}) => {
          if (command.startsWith("chat_store_")) {
            if (command === "chat_store_dir") return "synthetic-chat-dir";
            if (command === "chat_store_list") return Object.keys(window.__chatStore);
            if (command === "chat_store_get") {
              window.__chatStoreGetCalls += 1;
              return window.__chatStore[args.id] ?? null;
            }
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
          if (command === "project_authority_read") {
            // Always the ACTIVE (initial) project — continue targets A; the
            // recover flow passes its projectId explicitly (same pattern as
            // the editor-home fixture, which returns the initial snapshot).
            return fixtureSnapshots[fixtureProjects[0].id];
          }
          if (command === "project_authority_recover") {
            return fixtureSnapshots[args.projectId];
          }
          if (command === "project_authority_commit") {
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
          throw new Error(`unexpected synthetic Tauri command: ${command}`);
        },
      };
    },
    { fixtureProjects: projects, fixtureSnapshots: snapshots },
  );

  await page.goto(`${url}?provider=real`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="home-continue"]', { timeout: 15000 });
  await page.waitForSelector(`[data-testid="home-project-${projects[0].id}"]`, { timeout: 15000 });

  /** Ensure the chat panel is open and mounted. */
  async function openChat() {
    const visible = await page
      .$eval('[data-testid="chat-thread"]', (thread) => {
        const rect = thread.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !thread.closest("[hidden]");
      })
      .catch(() => false);
    if (!visible) await page.click(".header-chat-toggle");
    await page.waitForSelector('[data-testid="chat-thread"]', { timeout: 10000 });
  }

  /** Visible conversation-list rows (only the CURRENT scope's). */
  const visibleRows = () =>
    page.$$eval(
      '[data-testid="conversation-row"]',
      (rows) =>
        rows.filter((row) => !row.closest("[hidden]") && row.getBoundingClientRect().width > 0)
          .length,
    );

  const scopeLabel = () =>
    page.$eval('[data-testid="chat-scope-label"]', (label) => ({
      text: label.textContent,
      projectScope: label.getAttribute("data-project-scope"),
    }));

  const transcriptText = () =>
    page.$eval('[data-testid="chat-transcript"]', (t) => t.textContent ?? "");

  async function expectTranscriptMissing(text) {
    const content = await transcriptText();
    assert.ok(
      !content.includes(text),
      `transcript must NOT contain "${text}" (cross-project leak). Got: ${content.slice(0, 200)}`,
    );
  }

  async function sendMessage(text) {
    await page.click('[data-testid="chat-input"]');
    await page.type('[data-testid="chat-input"]', text);
    await page.keyboard.press("Enter");
    // The user message must render in the thread (real stream event), then a
    // deterministic mock assistant reply completes and onFinish snapshots the
    // store.
    await page.waitForFunction(
      (needle) =>
        [...document.querySelectorAll(".chat-message.user p")].some((paragraph) =>
          paragraph.textContent?.includes(needle),
        ),
      { timeout: 10000 },
      text,
    );
    await page.waitForSelector(".chat-message.assistant", { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 800)); // debounced writer flush
  }

  // ---- Enter project A and open its scoped chat ----
  await page.click(`[data-testid="home-project-${projects[0].id}"] .home-project-copy button`);
  await page.click('[data-testid="home-continue"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 15000 });
  await openChat();

  let label = await scopeLabel();
  assert.equal(label.text, `Project: ${projects[0].name}`);
  assert.equal(label.projectScope, `${PROJECT_SCOPE_PREFIX}${projects[0].id}`);
  assert.equal(await visibleRows(), 1, "project A chat must show exactly one conversation");

  await sendMessage("scope-a message");
  assert.ok((await transcriptText()).includes("scope-a message"));
  assert.equal(await visibleRows(), 1, "sending must not create a second conversation");

  // ---- Page-tab switch (Home → Prepare) — SAME project, NO new chat ----
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="home-page"]:not([hidden])', { timeout: 10000 });
  await page.click(".workspace-tabs button:nth-of-type(2)");
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 10000 });
  await openChat();
  label = await scopeLabel();
  assert.equal(label.text, `Project: ${projects[0].name}`);
  assert.equal(label.projectScope, `${PROJECT_SCOPE_PREFIX}${projects[0].id}`);
  assert.ok(
    (await transcriptText()).includes("scope-a message"),
    "page-tab switches must NOT clear the conversation",
  );
  assert.equal(await visibleRows(), 1, "page-tab switches must NOT create conversations");

  // ---- Switch to project B (recover) — FRESH scope, A isolated ----
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="home-page"]:not([hidden])', { timeout: 10000 });
  await page.click(`[data-testid="home-project-${projects[1].id}"] .home-project-copy button`);
  await page.click('[data-testid="home-recover"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 15000 });
  await openChat();

  label = await scopeLabel();
  assert.equal(label.text, `Project: ${projects[1].name}`);
  assert.equal(label.projectScope, `${PROJECT_SCOPE_PREFIX}${projects[1].id}`);
  await expectTranscriptMissing("scope-a message");
  assert.equal(await visibleRows(), 1, "project B chat must show exactly one (fresh) conversation");
  assert.match(await transcriptText(), /messages|empty|start/i);

  await sendMessage("scope-b message");
  assert.ok((await transcriptText()).includes("scope-b message"));
  await expectTranscriptMissing("scope-a message");

  // ---- Back to project A — ORIGINAL chat restored, B isolated ----
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="home-page"]:not([hidden])', { timeout: 10000 });
  await page.click(`[data-testid="home-project-${projects[0].id}"] .home-project-copy button`);
  await page.click('[data-testid="home-continue"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 15000 });
  await openChat();

  label = await scopeLabel();
  assert.equal(label.text, `Project: ${projects[0].name}`);
  assert.ok(
    (await transcriptText()).includes("scope-a message"),
    "switching back must restore the original project-A conversation",
  );
  await expectTranscriptMissing("scope-b message");
  assert.equal(await visibleRows(), 1, "project A list must show ONLY its scope");

  // ---- Persistence: flat fake-Tauri lane carries explicit projectId ----
  await new Promise((resolve) => setTimeout(resolve, 600));
  const storeState = await page.evaluate(() => {
    const entries = Object.entries(window.__chatStore).map(([id, convo]) => ({
      id,
      projectId: convo.projectId ?? null,
      text: JSON.stringify(convo),
    }));
    return {
      entries,
      ids: Object.keys(window.__chatStore),
      getCalls: window.__chatStoreGetCalls,
    };
  });
  // The pristine workspace default conversation is never dirty → correctly NOT
  // written; every project conversation must persist with its EXPLICIT
  // projectId, and neither scope may be dropped while the other is active.
  assert.ok(
    storeState.ids.length >= 2,
    `expected A + B conversations persisted, got ${storeState.ids.join(",")}`,
  );
  const aEntry = storeState.entries.find((entry) => entry.projectId === projects[0].id);
  const bEntry = storeState.entries.find((entry) => entry.projectId === projects[1].id);
  assert.ok(aEntry, "project A conversation must persist with its explicit projectId");
  assert.ok(bEntry, "project B conversation must persist with its explicit projectId");
  assert.ok(aEntry.text.includes("scope-a message"), "A transcript must include its message");
  assert.ok(bEntry.text.includes("scope-b message"), "B transcript must include its message");
  assert.ok(
    storeState.entries.every((entry) => "projectId" in JSON.parse(entry.text)),
    "every persisted conversation must carry the explicit project-scope migration field",
  );
  // No accidental AllHistories drop: after returning to A, B's history is
  // still in the store (never deleted by scope switching).
  const stillHasPrevios = storeState.entries.some(
    (entry) => entry.projectId === projects[1].id && entry.text.includes("scope-b message"),
  );
  assert.ok(stillHasPrevios, "switching scopes must never drop another scope's history");

  // ---- Reopen (reload): hydration restores the ORIGINAL per-project chat ----
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('[data-testid="home-page"]', { timeout: 30000 });
  await page.waitForSelector(`[data-testid="home-project-${projects[0].id}"]`, { timeout: 15000 });
  // Wait for boot hydration to read the persisted store (fire-and-forget pod);
  // A + B were persisted, so the reload hydrates exactly those two.
  await page
    .waitForFunction(() => window.__chatStoreGetCalls >= 2, { timeout: 15000 })
    .catch(async (error) => {
      const dump = await page.evaluate(() => ({
        getCalls: window.__chatStoreGetCalls,
        storeIds: Object.keys(window.__chatStore ?? {}),
        storeSample: Object.fromEntries(
          Object.entries(window.__chatStore ?? {}).map(([id, convo]) => [
            id,
            convo.projectId ?? null,
          ]),
        ),
        isTauri: Boolean(window.__TAURI_INTERNALS__),
        homeHidden: document.querySelector('[data-testid="home-page"]')?.hidden ?? "n/a",
      }));
      throw new Error(`${error?.message}; hydration dump=${JSON.stringify(dump)}`);
    });
  // ---- Global-scope label proof (Home, no active project): the chat scope
  // shows the WORKSPACE label with the RAW global key. Later, a project
  // literally id/name "workspace" must render a DIFFERENT label + key.
  // (No persisted workspace conversation exists here → activeId is null and
  // no thread mounts — the scope LABEL still renders, which is all we assert.)
  await page.click(".header-chat-toggle");
  await page.waitForSelector('[data-testid="chat-scope-label"]', { timeout: 10000 });
  const globalLabel = await scopeLabel();
  assert.equal(globalLabel.text, "Workspace", "Home chat must show the global label");
  assert.equal(globalLabel.projectScope, "workspace");
  await page.click(`[data-testid="home-project-${projects[0].id}"] .home-project-copy button`);
  await page.click('[data-testid="home-continue"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 15000 });
  await openChat();

  label = await scopeLabel();
  assert.equal(label.text, `Project: ${projects[0].name}`);
  assert.ok(
    (await transcriptText()).includes("scope-a message"),
    "reopen must restore the project-A conversation from persistence",
  );
  await expectTranscriptMissing("scope-b message");
  assert.equal(await visibleRows(), 1, "reopen must restore the scope, not duplicate histories");

  // ---- NAV-05 scope-key collision proof in the UI: a project whose id is
  // literally "workspace" is a distinct scope from the global workspace —
  // different ChatScope label AND different data-project-scope key, with a
  // fresh conversation and zero cross-project leak.
  await page.click(".workspace-tabs button:nth-of-type(1)");
  await page.waitForSelector('[data-testid="home-page"]:not([hidden])', { timeout: 10000 });
  await page.click(`[data-testid="home-project-${projects[2].id}"] .home-project-copy button`);
  await page.click('[data-testid="home-recover"]');
  await page.waitForSelector(".editor-workspace:not([hidden])", { timeout: 15000 });
  await openChat();

  label = await scopeLabel();
  assert.equal(label.text, "Project: Synthetic Workspace Project");
  assert.notEqual(label.text, "Workspace", "project label must differ from the global label");
  assert.equal(label.projectScope, `${PROJECT_SCOPE_PREFIX}${projects[2].id}`);
  assert.notEqual(label.projectScope, "workspace", "encoded key must differ from the global key");
  await expectTranscriptMissing("scope-a message");
  await expectTranscriptMissing("scope-b message");
  assert.equal(
    await visibleRows(),
    1,
    "workspace-named project shows ONLY its own fresh conversation",
  );

  assert.deepEqual(
    browserErrors.filter((message) => !/Failed to load resource.*404/i.test(message)),
    [],
    `no console/page errors expected: ${JSON.stringify(browserErrors)}`,
  );
  console.log("[S9.17-004 NAV-05] editor-chat-scope.e2e.mjs PASS");
} finally {
  if (browser) await browser.close();
  if (child) {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
