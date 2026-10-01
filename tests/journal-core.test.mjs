import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.6-004 — journal undo/redo core.
 *
 * AC: journal strip lists real events with delta chips; click-to-seek
 * restores the revision; Ctrl+Z/Y step the journal; redo works until head;
 * seek on the strip syncs undo state.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "journal-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

function headObjects() {
  return [
    {
      name: "cube",
      transform: { x: 40, y: 0, z: 10, rx: 0, ry: 0, rz: 0, sx: 2, sy: 2, sz: 2 },
      sizeMm: [20, 20, 20],
      volumeMm3: 8000,
      watertight: true,
    },
    {
      name: "cone",
      transform: { x: 0, y: -13, z: 14, rx: 0, ry: 0, rz: 45, sx: 1, sy: 1, sz: 1 },
      sizeMm: [28, 28, 26],
      volumeMm3: 5012,
      watertight: true,
    },
  ];
}

function events() {
  // rev 1: cube +move (from x=0 to x=40)
  // rev 2: cone +rotate (rz 0→45), cube +scale (sx 1→2)
  return [
    {
      kind: "+move",
      name: "cube",
      revision: 1,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 40, y: 0, z: 10 },
    },
    {
      kind: "+rotate",
      name: "cone",
      revision: 2,
      from: { rx: 0, ry: 0, rz: 0 },
      to: { rx: 0, ry: 0, rz: 45 },
    },
    {
      kind: "+scale",
      name: "cube",
      revision: 2,
      from: { sx: 1, sy: 1, sz: 1 },
      to: { sx: 2, sy: 2, sz: 2 },
    },
  ];
}

test("journal-core: revisions are distinct + ascending", async () => {
  const core = await corePromise;
  assert.deepEqual(core.journalRevisions(events()), [1, 2]);
  assert.equal(core.journalHeadRevision(events()), 2);
  assert.equal(core.journalHeadRevision([]), 0);
});

test("journal-core: delta chip labels are the event kinds", async () => {
  const core = await corePromise;
  const [e1, e2] = events();
  assert.equal(core.journalDeltaLabel(e1), "+move");
  assert.equal(core.journalDeltaLabel(e2), "+rotate");
  assert.equal(core.journalEventLabel(e1), "+move cube");
});

test("journal-core: undo/redo targets respect the cursor", async () => {
  const core = await corePromise;
  // cursor 2 (head) → undo → 1; redo → null
  assert.equal(core.journalSeekTarget(events(), 2, "undo"), 1);
  assert.equal(core.journalSeekTarget(events(), 2, "redo"), null);
  // cursor 1 → undo → 0 (base), redo → 2
  assert.equal(core.journalSeekTarget(events(), 1, "undo"), 0);
  assert.equal(core.journalSeekTarget(events(), 1, "redo"), 2);
  // cursor 0 (base) → undo → 0 (no-op), redo → 1
  assert.equal(core.journalSeekTarget(events(), 0, "undo"), 0);
  assert.equal(core.journalSeekTarget(events(), 0, "redo"), 1);
});

test("journal-core: seek at head = current transforms (no undo applied)", async () => {
  const core = await corePromise;
  const map = core.seekTransformsAt(events(), headObjects(), 2);
  assert.deepEqual(map.get("cube"), {
    x: 40,
    y: 0,
    z: 10,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 2,
    sy: 2,
    sz: 2,
  });
  assert.deepEqual(map.get("cone"), {
    x: 0,
    y: -13,
    z: 14,
    rx: 0,
    ry: 0,
    rz: 45,
    sx: 1,
    sy: 1,
    sz: 1,
  });
});

test("journal-core: seek at base restores pre-journal transforms", async () => {
  const core = await corePromise;
  const map = core.seekTransformsAt(events(), headObjects(), 0);
  assert.deepEqual(map.get("cube"), { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  assert.deepEqual(map.get("cone"), {
    x: 0,
    y: -13,
    z: 14,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
  });
});

test("journal-core: partial seek at rev 1 applies only earlier events", async () => {
  const core = await corePromise;
  const map = core.seekTransformsAt(events(), headObjects(), 1);
  assert.deepEqual(map.get("cube"), {
    x: 40,
    y: 0,
    z: 10,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
  });
  // cone unchanged (its event is rev 2 > 1 → undone)
  assert.deepEqual(map.get("cone"), {
    x: 0,
    y: -13,
    z: 14,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
  });
});

test("journal-core: events grouped by revision for the strip", async () => {
  const core = await corePromise;
  const byRev = core.journalEventsByRevision(events());
  assert.equal(byRev.get(1)?.length, 1);
  assert.equal(byRev.get(2)?.length, 2);
  const rev2 = byRev.get(2) ?? [];
  assert.deepEqual(
    rev2.map((e) => e.kind),
    ["+rotate", "+scale"],
  );
});

test("journal-core: at-head / at-base helpers", async () => {
  const core = await corePromise;
  assert.equal(core.isAtHead(events(), 2), true);
  assert.equal(core.isAtHead(events(), 1), false);
  assert.equal(core.isAtBase(events(), 0), true);
  assert.equal(core.isAtBase(events(), 1), false);
  assert.equal(core.isAtBase([], 0), true);
});
