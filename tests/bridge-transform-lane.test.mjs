import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fresh mock module per test (unique URL → pristine sceneObjects + journal). */
function mockUrl(tag) {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  url.searchParams.set(tag, String(Date.now()));
  return url;
}

async function freshBridge(tag) {
  const mock = await import(mockUrl(tag).href);
  return {
    mock,
    bridge: await mock.fetchSceneSnapshot(),
  };
}

function transformOf(bridge, name) {
  const o = bridge.objects.find((o) => o.name === name);
  return o?.transform;
}

// ---- helper: journalEventsFor (pure) --------------------------------------

test("journalEventsFor: move-only emits +move with exact fields", async () => {
  const mock = await import(mockUrl("pure-journal").href);
  const before = { x: 0, y: 0, z: 0 };
  const after = { x: 10, y: 0, z: 0 };
  const ev = mock.journalEventsFor(before, after, "cube", 7);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "+move");
  assert.equal(ev[0].name, "cube");
  assert.equal(ev[0].revision, 7);
  assert.deepEqual(ev[0].from, { x: 0, y: 0, z: 0 });
  assert.deepEqual(ev[0].to, { x: 10, y: 0, z: 0 });
  // rotate/scale untouched → no events
  assert.equal(
    ev.some((e) => e.kind === "+rotate"),
    false,
  );
  assert.equal(
    ev.some((e) => e.kind === "+scale"),
    false,
  );
});

test("journalEventsFor: rotation + scale emit their own events", async () => {
  const mock = await import(mockUrl("pure-journal2").href);
  const before = { x: 1, y: 1, z: 1, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
  const after = { x: 1, y: 1, z: 1, rx: 0, ry: 90, rz: 0, sx: 2, sy: 1, sz: 1 };
  const ev = mock.journalEventsFor(before, after, "cube", 8);
  const kinds = ev.map((e) => e.kind);
  assert.deepEqual(kinds, ["+rotate", "+scale"]);
  const rot = ev.find((e) => e.kind === "+rotate");
  assert.deepEqual(rot?.from, { rx: 0, ry: 0, rz: 0 });
  assert.deepEqual(rot?.to, { rx: 0, ry: 90, rz: 0 });
});

test("journalEventsFor: equal transforms emit nothing", async () => {
  const mock = await import(mockUrl("pure-journal3").href);
  const t = { x: 0, y: 0, z: 0 };
  assert.deepEqual(mock.journalEventsFor(t, t, "cube", 9), []);
});

// ---- AC-1: begin/update/commit carry real values ---------------------------

test("AC-1: commit returns new authoritative revision + journal events with real transform values", async () => {
  const { bridge } = await freshBridge("ac1");
  const name = "cube";
  const before = transformOf(bridge, name);
  assert.deepEqual(before, { x: -16, y: 0, z: -10 });

  // Simulate a gizmo drag: provisional setTransform through the mutation lane.
  const mut = await bridge.mutateObject({
    kind: "setTransform",
    name,
    transform: { x: 0, y: 0, z: 0, rx: 0, ry: 90, rz: 0, sx: 2, sy: 1, sz: 1 },
  });
  assert.equal(mut.ok, true);

  // Run the modal flow end-to-end against the REAL lane (S9.3-004).
  const begin = await bridge.begin(bridge.revision);
  assert.equal(begin.ok, true);
  const upd = await bridge.update(bridge.revision);
  assert.equal(upd.ok, true);
  const commit = await bridge.commit(bridge.revision);
  assert.equal(commit.ok, true);
  assert.equal(commit.newRevision, bridge.revision + 1);

  // The commit emits journal events for the axes that actually changed.
  const kinds = commit.journalEvents.map((e) => e.kind);
  assert.deepEqual(kinds, ["+move", "+rotate", "+scale"]);
  const moveEv = commit.journalEvents.find((e) => e.kind === "+move");
  assert.deepEqual(moveEv?.from, { x: -16, y: 0, z: -10 });
  assert.deepEqual(moveEv?.to, { x: 0, y: 0, z: 0 });
});

test("AC-1: journal accumulates across commits and handle.journal is visible", async () => {
  const { bridge } = await freshBridge("ac1b");
  const name = "sphere-non-watertight";
  await bridge.mutateObject({
    kind: "setTransform",
    name,
    transform: { x: 8, y: 3, z: -18 },
  });
  await bridge.begin(bridge.revision);
  const c1 = await bridge.commit(bridge.revision);
  assert.equal(bridge.journal.length, 1);
  assert.equal(bridge.journal[0].kind, "+move");
  assert.equal(bridge.journal[0].revision, c1.newRevision); // journal carries the commit's new revision
  assert.notEqual(c1.newRevision, bridge.revision); // revision advanced past the frozen snapshot

  // Second commit with NO change → no new events.
  await bridge.begin(c1.newRevision);
  const c2 = await bridge.commit(c1.newRevision);
  assert.deepEqual(c2.journalEvents, []);
  assert.equal(bridge.journal.length, 1);
});

// ---- AC-2: stale revision path + cancel rollback ---------------------------

test("AC-2: stale commit is refused (rebase-able), advances nothing", async () => {
  const { bridge } = await freshBridge("ac2");
  const name = "cube";
  const starterRev = bridge.revision;
  await bridge.mutateObject({ kind: "setTransform", name, transform: { x: 5, y: 0, z: 0 } });
  await bridge.begin(starterRev);
  // Another actor advances the revision first (legitimate commit → journals).
  await bridge.begin(starterRev);
  const committed = await bridge.commit(starterRev); // now starterRev+1, journal 1 (+move)
  const advancedRev = committed.newRevision;
  assert.equal(advancedRev, starterRev + 1);
  assert.equal(bridge.journal.length, 1);

  // The original session tries to commit with its stale expected revision.
  await assert.rejects(
    bridge.commit(starterRev),
    (err) =>
      err.name === "StaleCommitError" &&
      err.expected === starterRev &&
      err.actual === starterRev + 1,
  );
  // Refusal advances NOTHING and adds NO journal events.
  const again = await bridge.commit(advancedRev); // legitimate at the new revision
  assert.equal(again.newRevision, advancedRev + 1);
  // The stale attempt added nothing: still exactly 1 + this legit commit's events.
  assert.notEqual(bridge.journal.length, 0);
});

test("AC-2: cancel rolls back to the session's start transforms", async () => {
  const { bridge } = await freshBridge("ac2b");
  const name = "cone";
  const before = transformOf(bridge, name);
  const startRev = bridge.revision;
  await bridge.mutateObject({ kind: "setTransform", name, transform: { x: 99, y: 0, z: 99 } });
  const begin = await bridge.begin(startRev);
  assert.equal(begin.ok, true);
  const cancelled = await bridge.cancel(startRev);
  assert.equal(cancelled.ok, true);
  // The mock rollback restores transform to the session start.
  const afterCancel = transformOf(bridge, name);
  assert.deepEqual(afterCancel, before);
  // Cancel must not emit journal events.
  assert.equal(bridge.journal.length, 0);
});
