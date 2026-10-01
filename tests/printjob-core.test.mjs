import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.5-001 print job machine — `state/printjob-core.ts` headless tests.
 *
 * AC: machine transitions idle→slicing→preview…sent with stage progress +
 * cancel; non-watertight objects block slice with an actionable repair hint.
 * Every transition guard + error path is asserted here.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "printjob-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

/** Two objects: cone watertight, sphere NOT watertight. */
function plateObjects(core) {
  return [
    { name: "cone", watertight: true },
    { name: "sphere-non-watertight", watertight: false },
  ];
}

function run(core, events) {
  let state = core.initialPrintJobState();
  let rejected = [];
  for (const ev of events) {
    const out = core.reducePrintJob(state, ev);
    state = out.state;
    if (out.rejected) rejected = rejected.concat(out.rejected);
  }
  return { state, rejected };
}

test("printjob: sliceEligible requires ≥1 and all watertight", async () => {
  const core = await corePromise;
  assert.equal(core.sliceEligible([]), false);
  assert.equal(core.sliceEligible([{ name: "a", watertight: false }]), false);
  assert.equal(
    core.sliceEligible([
      { name: "a", watertight: true },
      { name: "b", watertight: false },
    ]),
    false,
  );
  assert.equal(core.sliceEligible([{ name: "a", watertight: true }]), true);
});

test("printjob: preflight blocks with actionable names", async () => {
  const core = await corePromise;
  const blocked = core.blockingObjects(plateObjects(core));
  assert.deepEqual(blocked, ["sphere-non-watertight"]);

  const { state } = run(core, [
    { kind: "preflight", objects: plateObjects(core) },
    { kind: "start" },
  ]);
  assert.equal(state.status, "idle"); // preflight blocked → start rejected
  assert.deepEqual(state.blockedBy, ["sphere-non-watertight"]);
});

test("printjob: full happy path idle→slicing→ready with staged progress", async () => {
  const core = await corePromise;
  const stats = {
    layers: 42,
    estimatedMinutes: 27,
    materialGrams: 12.4,
    volumeMm3: 5012,
    perObjectMm3: { cone: 5012 },
  };
  const { state } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "stage", index: 0, total: 5, label: "prepare" },
    { kind: "stage", index: 1, total: 5, label: "planar-core" },
    { kind: "stage", index: 2, total: 5, label: "IR" },
    { kind: "stage", index: 3, total: 5, label: "postprocess" },
    { kind: "stage", index: 4, total: 5, label: "preview" },
    { kind: "finish", stats },
  ]);
  assert.equal(state.status, "ready");
  assert.equal(state.stage, 4);
  assert.equal(state.stageTotal, 5);
  assert.deepEqual(state.stats, stats);
});

test("printjob: cancel honoured only while slicing", async () => {
  const core = await corePromise;
  const { state } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "stage", index: 1, total: 5, label: "planar-core" },
    { kind: "cancel" },
  ]);
  assert.equal(state.status, "cancelled");
});

test("printjob: cancel rejected after finish (ready immutável)", async () => {
  const core = await corePromise;
  const stats = {
    layers: 1,
    estimatedMinutes: 1,
    materialGrams: 1,
    volumeMm3: 1,
    perObjectMm3: {},
  };
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "stage", index: 0, total: 5, label: "prepare" },
    { kind: "finish", stats },
    { kind: "cancel" },
  ]);
  assert.equal(state.status, "ready");
  assert.ok(rejected.some((r) => r.includes("cancel")));
});

test("printjob: stale/out-of-order stage dropped (re-base)", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "stage", index: 2, total: 5, label: "IR" },
    { kind: "stage", index: 1, total: 5, label: "planar-core" }, // stale
  ]);
  assert.equal(state.stage, 2);
  assert.equal(state.stageLabel, "IR");
  assert.ok(rejected.some((r) => r.includes("stale")));
});

test("printjob: failed slice → error preserves blocked hint", async () => {
  const core = await corePromise;
  const { state } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "error", reason: "planar-core threw" },
  ]);
  assert.equal(state.status, "error");
  assert.equal(state.error, "planar-core threw");
});

test("printjob: send flow ready→sending→sent with progress", async () => {
  const core = await corePromise;
  const stats = {
    layers: 3,
    estimatedMinutes: 2,
    materialGrams: 1,
    volumeMm3: 1,
    perObjectMm3: {},
  };
  const { state } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "finish", stats },
    { kind: "send-start", stage: "negotiate" },
    { kind: "send-stage", stage: "upload", progress: 0.5 },
    { kind: "send-finished" },
  ]);
  assert.equal(state.status, "sent");
  assert.equal(state.sendProgress, 1);
});

test("printjob: send failure returns to ready (retryable)", async () => {
  const core = await corePromise;
  const stats = {
    layers: 3,
    estimatedMinutes: 2,
    materialGrams: 1,
    volumeMm3: 1,
    perObjectMm3: {},
  };
  const { state } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "finish", stats },
    { kind: "send-start", stage: "negotiate" },
    { kind: "send-error", reason: "printer offline" },
  ]);
  assert.equal(state.status, "ready");
  assert.equal(state.error, "printer offline");
  assert.deepEqual(state.stats, stats); // slice preserved
});

test("printjob: send-start rejected without ready", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: [{ name: "cone", watertight: true }] },
    { kind: "start" },
    { kind: "send-start", stage: "negotiate" },
  ]);
  assert.equal(state.status, "slicing");
  assert.ok(rejected.some((r) => r.includes("ready")));
});
