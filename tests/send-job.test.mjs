/**
 * S9.5-004 send-to-print unit tests (JS pure).
 *
 * Covers the approval-card semantics (pending → approved/rejected, never
 * auto-executed), the FNV-1a token hash that pins the exact approved payload,
 * the pure reduceSendJob reducer, and the mock `sendJob` lane headless via
 * the exported test seams (offline / region / success).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
void require;
const coreUrl = pathToFileURL(require.resolve("../apps/editor/src/state/printjob-core.ts")).href;
const mockUrl = pathToFileURL(require.resolve("../apps/editor/src/bridge/mock.ts")).href;

const STATS = {
  layers: 140,
  estimatedMinutes: 12,
  materialGrams: 35.2,
  volumeMm3: 28384,
  perObjectMm3: { cone: 20384, cube: 8000 },
};

test("tokenHash: deterministic FNV-1a hex for the same token", async () => {
  const mod = await import(`${coreUrl}?key=${Date.now()}`);
  const h1 = mod.tokenHash("192.168.1.10|140|12|28384");
  const h2 = mod.tokenHash("192.168.1.10|140|12|28384");
  assert.ok(/^[0-9a-f]+$/.test(h1));
  assert.equal(h1, h2);
  // A different payload (any field) MUST produce a different hash.
  const h3 = mod.tokenHash("192.168.1.10|141|12|28384");
  assert.notEqual(h1, h3);
});

test("sendTokenFor: exact, stable serialisation of the payload", async () => {
  const mod = await import(`${coreUrl}?key=${Date.now() + 1}`);
  const t1 = mod.sendTokenFor("192.168.1.10", STATS);
  const t2 = mod.sendTokenFor("192.168.1.10", { ...STATS });
  assert.equal(t1, t2);
  assert.match(t1, /^192\.168\.1\.10\|140\|12\|28384$/);
});

test("reduceSendJob: open creates a pending card with a token hash", async () => {
  const mod = await import(`${coreUrl}?key=${Date.now() + 2}`);
  const { sendTokenFor, tokenHash } = mod;
  const out = mod.reduceSendJob(mod.initialSendJobState, {
    kind: "open",
    summary: "140 layers · 12 min",
    printerIp: "192.168.1.10",
    printerName: "Printer @ 192.168.1.10",
    stats: STATS,
  });
  const card = out.state.approval;
  assert.ok(card);
  assert.equal(card.state, "pending");
  assert.equal(card.printerIp, "192.168.1.10");
  assert.equal(card.tokenHashHex, tokenHash(sendTokenFor("192.168.1.10", STATS)));
  assert.equal(out.state.lastApprovedHash, undefined);
});

test("reduceSendJob: approve marks the card approved + records the hash", async () => {
  const mod = await import(`${coreUrl}?key=${Date.now() + 3}`);
  const opened = mod.reduceSendJob(mod.initialSendJobState, {
    kind: "open",
    summary: "x",
    printerIp: "192.168.1.10",
    printerName: "p",
    stats: STATS,
  });
  const card = opened.state.approval;
  assert.ok(card);
  const decided = mod.reduceSendJob(opened.state, {
    kind: "decide",
    id: card.id,
    approved: true,
  });
  assert.equal(decided.state.approval?.state, "approved");
  assert.equal(decided.state.lastApprovedHash, card.tokenHashHex);
});

test("reduceSendJob: reject keeps the card rejected + no approved hash", async () => {
  const mod = await import(`${coreUrl}?key=${Date.now() + 4}`);
  const opened = mod.reduceSendJob(mod.initialSendJobState, {
    kind: "open",
    summary: "x",
    printerIp: "10.0.0.5",
    printerName: "p",
    stats: STATS,
  });
  const card = opened.state.approval;
  assert.ok(card);
  const decided = mod.reduceSendJob(opened.state, {
    kind: "decide",
    id: card.id,
    approved: false,
  });
  assert.equal(decided.state.approval?.state, "rejected");
  assert.equal(decided.state.lastApprovedHash, undefined);
});

test("reduceSendJob: re-deciding or unknown card ids are rejected", async () => {
  const mod = await import(`${coreUrl}?key=${Date.now() + 5}`);
  const opened = mod.reduceSendJob(mod.initialSendJobState, {
    kind: "open",
    summary: "x",
    printerIp: "10.0.0.5",
    printerName: "p",
    stats: STATS,
  });
  const card = opened.state.approval;
  assert.ok(card);
  // Unknown id.
  const unknown = mod.reduceSendJob(opened.state, { kind: "decide", id: "nope", approved: true });
  assert.ok(unknown.rejected?.length);
  assert.equal(unknown.state.approval?.state, "pending");
  // Re-decide after approve.
  const decided = mod.reduceSendJob(opened.state, { kind: "decide", id: card.id, approved: true });
  const again = mod.reduceSendJob(decided.state, { kind: "decide", id: card.id, approved: false });
  assert.ok(again.rejected?.length);
  assert.equal(again.state.approval?.state, "approved");
});

test("reduceSendJob: close clears the card + hash", async () => {
  const mod = await import(`${coreUrl}?key=${Date.now() + 6}`);
  const opened = mod.reduceSendJob(mod.initialSendJobState, {
    kind: "open",
    summary: "x",
    printerIp: "10.0.0.5",
    printerName: "p",
    stats: STATS,
  });
  const closed = mod.reduceSendJob(opened.state, { kind: "close" });
  assert.equal(closed.state.approval, null);
  assert.equal(closed.state.lastApprovedHash, undefined);
});

test("bridge lane: sendJob success mints a deterministic mock task id", async () => {
  const mockUrlKey = `${mockUrl}?key=${Date.now() + 7}`;
  const { fetchSceneSnapshot } = await import(mockUrlKey);
  const handle = await fetchSceneSnapshot();
  const res = await handle.sendJob({
    printerId: "printer-192-168-1-10",
    ip: "192.168.1.10",
    stats: STATS,
    summary: "140 layers",
  });
  assert.ok(res.ok);
  assert.match(res.taskId, /^mock-task-\d+$/);
});

test("bridge lane: offline printer → semantic offline error", async () => {
  const mockUrlKey = `${mockUrl}?key=${Date.now() + 8}`;
  const { fetchSceneSnapshot, setMockOfflinePrinters } = await import(mockUrlKey);
  setMockOfflinePrinters(["printer-192-168-1-10"]);
  const handle = await fetchSceneSnapshot();
  const res = await handle.sendJob({
    printerId: "printer-192-168-1-10",
    ip: "192.168.1.10",
    stats: STATS,
    summary: "x",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.kind, "offline");
    assert.match(res.error, /offline/);
  }
});

test("bridge lane: region blocked → semantic region error", async () => {
  const mockUrlKey = `${mockUrl}?key=${Date.now() + 9}`;
  const { fetchSceneSnapshot, setMockRegionBlocked } = await import(mockUrlKey);
  setMockRegionBlocked(true);
  const handle = await fetchSceneSnapshot();
  const res = await handle.sendJob({
    printerId: "printer-192-168-1-11",
    ip: "192.168.1.11",
    stats: STATS,
    summary: "x",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.kind, "region");
  }
});
