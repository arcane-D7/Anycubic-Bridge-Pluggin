import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.5-005 — printjob machine transition + error-path coverage.
 *
 * Complements printjob-core.test.mjs (happy path, cancel while slicing,
 * stale stage re-base, send flow) with the guarded transitions that file
 * does NOT cover: cancel from idle, out-of-range stage indices, preflight
 * clearing a prior block, start blocked by non-watertight objects, send
 * events outside sending, error guards from ready/sent, the full send retry
 * cycle, and the deterministic slice lane contract (revision never advances,
 * identical slices produce identical stats). Every machine decision is
 * mirrored by the real pipeline contract — never forced.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "printjob-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

async function loadMock() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  return import(`${url.href}?key=${Date.now() + 1}`);
}

const corePromise = loadCore();
const mockPromise = loadMock();

/** Accumulates rejected reasons while replaying events over the state. */
function run(core, events) {
  let state = core.initialPrintJobState();
  const rejected = [];
  for (const event of events) {
    const outcome = core.reducePrintJob(state, event);
    if (outcome.rejected) rejected.push(...outcome.rejected);
    state = outcome.state;
  }
  return { state, rejected };
}

const stats = {
  layers: 3,
  estimatedMinutes: 2,
  materialGrams: 1,
  volumeMm3: 1,
  perObjectMm3: {},
};

const watertight = [{ name: "cone", watertight: true }];
const dirty = [
  { name: "cone", watertight: true },
  { name: "sphere", watertight: false },
];

test("printjob: cancel from idle reaches cancelled", async () => {
  const core = await corePromise;
  const { state } = run(core, [{ kind: "cancel" }]);
  assert.equal(state.status, "cancelled");
});

test("printjob: stage index beyond total rejected (out-of-range)", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "stage", index: 9, total: 5, label: "bogus" },
  ]);
  assert.equal(state.status, "slicing");
  assert.equal(state.stage, 0); // unchanged
  assert.ok(rejected.some((r) => r.includes("stale")));
});

test("printjob: stage event outside slicing rejected", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [{ kind: "stage", index: 0, total: 5, label: "prepare" }]);
  assert.equal(state.status, "idle");
  assert.ok(rejected.some((r) => r.includes("slicing")));
});

test("printjob: preflight with watertight objects clears prior block", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: dirty },
    { kind: "preflight", objects: watertight },
    { kind: "start" },
  ]);
  assert.equal(state.status, "slicing"); // repair unblocked the start
  assert.deepEqual(state.blockedBy, []);
  assert.ok(rejected.length === 0);
});

test("printjob: start blocked while blockedBy is non-empty", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [{ kind: "preflight", objects: dirty }, { kind: "start" }]);
  assert.equal(state.status, "idle");
  assert.deepEqual(state.blockedBy, ["sphere"]);
  assert.ok(rejected.some((r) => r.includes("blocked by non-watertight")));
  assert.ok(rejected.includes("sphere"));
});

test("printjob: finish requires slicing", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "finish", stats },
  ]);
  assert.equal(state.status, "idle");
  assert.ok(rejected.some((r) => r.includes("finish requires slicing")));
});

test("printjob: send-stage without sending rejected", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "send-stage", stage: "upload", progress: 0.5 },
  ]);
  assert.equal(state.status, "slicing");
  assert.equal(state.sendProgress, null);
  assert.ok(rejected.some((r) => r.includes("send-stage only while sending")));
});

test("printjob: send-finished without sending rejected", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "send-finished" },
  ]);
  assert.equal(state.status, "slicing");
  assert.ok(rejected.some((r) => r.includes("send-finished requires sending")));
});

test("printjob: send-error without sending rejected", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "send-error", reason: "printer offline" },
  ]);
  assert.equal(state.status, "slicing");
  assert.equal(state.error, null);
  assert.ok(rejected.some((r) => r.includes("send-error requires sending")));
});

test("printjob: error rejected once ready (finished slice immutable)", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "finish", stats },
    { kind: "error", reason: "post-slice panic" },
  ]);
  assert.equal(state.status, "ready");
  assert.equal(state.error, null);
  assert.ok(rejected.some((r) => r.includes("error not allowed from ready/sent")));
});

test("printjob: error rejected from sent", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "finish", stats },
    { kind: "send-start", stage: "negotiate" },
    { kind: "send-finished" },
    { kind: "error", reason: "late failure" },
  ]);
  assert.equal(state.status, "sent");
  assert.ok(rejected.some((r) => r.includes("error not allowed from ready/sent")));
});

test("printjob: error allowed from idle", async () => {
  const core = await corePromise;
  const { state } = run(core, [{ kind: "error", reason: "preflight exploded" }]);
  assert.equal(state.status, "error");
  assert.equal(state.error, "preflight exploded");
});

test("printjob: start rejected from error (recovery via preflight)", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "error", reason: "planar-core threw" },
    { kind: "start" },
  ]);
  assert.equal(state.status, "error");
  assert.ok(rejected.some((r) => r.includes("start requires idle")));
});

test("printjob: full send retry cycle preserves slice and reaches sent", async () => {
  const core = await corePromise;
  const { state, rejected } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "finish", stats },
    { kind: "send-start", stage: "negotiate" },
    { kind: "send-stage", stage: "upload", progress: 0.5 },
    { kind: "send-error", reason: "printer offline" }, // → ready, retryable
    { kind: "send-start", stage: "negotiate" },
    { kind: "send-stage", stage: "queue", progress: 0.85 },
    { kind: "send-finished" },
  ]);
  assert.equal(state.status, "sent");
  assert.equal(state.sendProgress, 1);
  assert.equal(state.sendStage, null);
  assert.deepEqual(state.stats, stats); // preserved across the retry
  assert.ok(rejected.length === 0);
});

test("printjob: send stage progression is monotonic within a send", async () => {
  const core = await corePromise;
  const { state } = run(core, [
    { kind: "preflight", objects: watertight },
    { kind: "start" },
    { kind: "finish", stats },
    { kind: "send-start", stage: "negotiate" },
    { kind: "send-stage", stage: "upload", progress: 0.4 },
    { kind: "send-stage", stage: "queue", progress: 0.9 },
  ]);
  assert.equal(state.status, "sending");
  assert.equal(state.sendStage, "queue");
  assert.equal(state.sendProgress, 0.9);
});

// --- deterministic slice lane contract (revision is never advanced) -------

test("slice-lane: repeated slices are deterministic and never advance revision", async () => {
  const mock = await mockPromise;
  const handle = await mock.fetchSceneSnapshot();
  await handle.mutateObject({ kind: "remove", name: "sphere-non-watertight" });
  const before = handle.revision;
  const first = await handle.slice({ plateId: "plate-1" });
  const second = await handle.slice({ plateId: "plate-1" });
  assert.equal(first.ok, true);
  if (first.ok && second.ok) {
    assert.deepEqual(second.stats, first.stats); // identical inputs → identical stats
    assert.equal(second.stats.layers, first.stats.layers);
  }
  assert.equal(handle.revision, before); // slicing never mutates the scene
});

test("slice-lane: custom layerHeightMm flows through the lane deterministically", async () => {
  const mock = await mockPromise;
  const handle = await mock.fetchSceneSnapshot();
  const result = await handle.slice({ plateId: "plate-1", layerHeightMm: 0.3 });
  assert.equal(result.ok, true);
  if (result.ok) {
    // The cone base circle spans Z ±14 → sizeMm[2] = 28; cube Z = 20.
    // Max stack height on plate-1 = 28mm → ceil(28/0.3) = 94.
    assert.equal(result.stats.layers, 94);
    assert.equal(result.blockedBy.length, 0);
  }
});

test("slice-lane: stats revision reflects the snapshot that produced them", async () => {
  const mock = await mockPromise;
  const handle = await mock.fetchSceneSnapshot();
  const result = await handle.slice({ plateId: "plate-1" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.revision, handle.revision);
  }
});
