// S7-004 integration harness — viewport modal lifecycle run END-TO-END through
// a stub contract server (mirrors the S7-002 SessionManager over the IPC
// frame). Proves the editor's gizmo/numeric gestures issue the right ordered
// contract calls begin → update* → commit | cancel, that stale expected
// revisions are refused instead of forced, that numeric issues ZERO updates,
// and that selection highlights derive only from the authoritative snapshot.
//
// The core under test is deliberately dependency-free (no React, no zustand,
// no three.js): `apps/editor/src/state/viewport-core.ts` is imported directly
// under Node 24's native TS support.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const coreUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "state", "viewport-core.ts"),
);

const core = await import(coreUrl.href);
const {
  initialViewportState,
  reduceViewport,
  runModalFlow,
  checkRendererSnapshotConsistency,
  EMPTY_SELECTION,
} = core;

// --- Stub contract server (mirrors the S7-002 SessionManager contract) -----
// Behaves like Blender: revisions advance only via commit, update() is
// provisional and does not advance, begin()/cancel() bounds the session.
function createContractServer() {
  let currentRevision = 0;
  const selection = { ...EMPTY_SELECTION, objectModeNames: ["print-bed-block"] };
  const trace = [];

  return {
    trace,
    get currentRevision() {
      return currentRevision;
    },
    advance() {
      currentRevision += 1;
      return currentRevision;
    },
    async begin(revision) {
      trace.push(`begin(${revision})`);
      return { ok: true };
    },
    async update(revision) {
      trace.push(`update(${revision})`);
      return { ok: true };
    },
    async commit(expectedRevision) {
      trace.push(`commit(${expectedRevision})`);
      if (expectedRevision !== currentRevision) {
        // Stale commit: refuse, report actual.
        throw new core.StaleCommitError(expectedRevision, currentRevision);
      }
      currentRevision += 1;
      return { newRevision: currentRevision, selection };
    },
    async cancel(beginRevision) {
      trace.push(`cancel(${beginRevision})`);
      return { ok: true };
    },
  };
}

// --- AC-2: gizmo begin → update → commit (end-to-end order + state) ---------
async function testGizmoFlowBeginsUpdatesCommits() {
  const server = createContractServer();
  let state = initialViewportState();

  const out = await runModalFlow(server, "gizmo", state);
  assert.deepEqual(server.trace, ["begin(0)", "update(0)", "commit(0)"]);
  assert.equal(out.state.sessionStatus, "committed");
  assert.equal(out.state.revision, 1);
  assert.deepEqual(out.state.selection?.objectModeNames, ["print-bed-block"]);
  assert.equal(out.calls.length, 3);
  assert.equal(out.selection?.objectModeNames[0], "print-bed-block");
  assert.equal(out.staleRejected, undefined);
}

// --- AC-2: numeric begin → ZERO updates → commit ----------------------------
async function testNumericFlowIssuesZeroUpdates() {
  const server = createContractServer();
  server.advance(); // match the local state's revision (1)
  // A prior gizmo commit took us to revision 1; numeric begins at it.
  const state = reduceViewport(initialViewportState(), {
    kind: "commit-event",
    revision: 1,
    selection: { ...EMPTY_SELECTION, objectModeNames: ["print-bed-block"] },
  }).state;

  const out = await runModalFlow(server, "numeric", state);
  assert.deepEqual(server.trace, ["begin(1)", "commit(1)"], "numeric must issue 0 updates");
  assert.equal(out.state.revision, 2);
  assert.equal(out.calls[1], "commit(1)");
}

// --- AC-2: cancel rolls back to begin-revision ------------------------------
async function testCancelRollsBackToBeginRevision() {
  const server = createContractServer();
  const state = reduceViewport(initialViewportState(), {
    kind: "commit-event",
    revision: 7,
    selection: { ...EMPTY_SELECTION, objectModeNames: [] },
  }).state;

  const out = await runModalFlow(server, "cancel", state);
  assert.deepEqual(server.trace, ["begin(7)", "cancel(7)"]);
  assert.equal(out.state.sessionStatus, "cancelled");
  assert.equal(out.state.revision, 7, "cancel rolls back to the begin revision");
  assert.equal(out.state.beginRevision, null);
  assert.equal(out.selection, null, "cancel yields no committed selection");
}

// --- AC-2: stale expected revision is refused, never forced ----------------
async function testStaleRevisionRefusedNotForced() {
  const server = createContractServer();
  // Connection state says revision 5; another writer advanced the server to 6.
  for (let i = 0; i < 6; i++) server.advance();
  const state = reduceViewport(initialViewportState(), {
    kind: "commit-event",
    revision: 5,
    selection: { ...EMPTY_SELECTION, objectModeNames: [] },
  }).state;

  const out = await runModalFlow(server, "gizmo", state);
  assert.ok(out.staleRejected, "stale commit must be surfaced, not applied");
  assert.equal(out.staleRejected.expected, 5);
  assert.equal(out.staleRejected.actual, 6);
  assert.equal(
    out.state.revision,
    5,
    "a refused commit must NOT jump local state to the server's actual (6) — re-base offered, never forced",
  );
}

// --- AC-3: selection derives ONLY from authoritative snapshot --------------
async function testSelectionOnlyFromAuthoritativeSnapshot() {
  const s1 = reduceViewport(initialViewportState(), {
    kind: "commit-event",
    revision: 1,
    selection: { ...EMPTY_SELECTION, objectModeNames: ["print-bed-block"] },
  }).state;
  assert.deepEqual(s1.selection?.objectModeNames, ["print-bed-block"]);

  // A NEW commit event replaces, never merges.
  const s2 = reduceViewport(s1, {
    kind: "commit-event",
    revision: 2,
    selection: { ...EMPTY_SELECTION, objectModeNames: ["dup-part", "led-holder"] },
  }).state;
  assert.deepEqual(s2.selection?.objectModeNames, ["dup-part", "led-holder"]);
  assert.ok(
    !s2.selection?.objectModeNames.includes("print-bed-block"),
    "selection is replaced, not merged",
  );
}

// --- AC-4: renderer-vs-snapshot mismatch is a renderer bug (snapshot wins) --
async function testRendererSnapshotMismatchIsRendererBug() {
  // Renderer emitted 12 triangles/object (placeholder unit box); the native
  // snapshot declares 24 (a real object). Disagreement → rendererBug surfaced.
  const mismatch = checkRendererSnapshotConsistency(12, 24);
  assert.ok(mismatch, "mismatch must be detected");
  assert.equal(mismatch.rendererBug, true);
  assert.equal(mismatch.expected, "24");
  assert.equal(mismatch.actual, "12");
}

async function testRendererSnapshotMatchIsSilent() {
  assert.equal(checkRendererSnapshotConsistency(24, 24), null);
  assert.equal(checkRendererSnapshotConsistency(0, 0), null);
}

// --- AC-1: re-render from authoritative snapshot (revision advances) --------
async function testReRendersFromAuthoritativeSnapshot() {
  let state = initialViewportState();
  for (let rev = 1; rev <= 3; rev++) {
    state = reduceViewport(state, {
      kind: "commit-event",
      revision: rev,
      selection: { ...EMPTY_SELECTION, objectModeNames: [`obj-${rev}`] },
    }).state;
    assert.equal(state.revision, rev);
    assert.deepEqual(state.selection?.objectModeNames, [`obj-${rev}`]);
  }
}

const tests = [
  testGizmoFlowBeginsUpdatesCommits,
  testNumericFlowIssuesZeroUpdates,
  testCancelRollsBackToBeginRevision,
  testStaleRevisionRefusedNotForced,
  testSelectionOnlyFromAuthoritativeSnapshot,
  testRendererSnapshotMismatchIsRendererBug,
  testRendererSnapshotMatchIsSilent,
  testReRendersFromAuthoritativeSnapshot,
];

for (const t of tests) {
  await t();
  process.stdout.write(`✓ ${t.name}\n`);
}
process.stdout.write(`\nviewport-modal-flow: ${tests.length} tests passed\n`);
