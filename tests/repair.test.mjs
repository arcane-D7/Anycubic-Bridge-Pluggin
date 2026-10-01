/**
 * S9.7-003/004 — Watertight repair (Auto-repair) unit tests.
 *
 * Covers the pure `state/repair.ts` core (`RepairMode`, `REPAIR_MODES`,
 * `repairModeLabel`, `repairResultNote`, `isRepairable`, `copyNameFor`) + the
 * S9.7-003 bridge `repair` lane (via a FRESH mock instance — `mock.ts` has
 * module-level mutable state, so each test file gets a unique URL to a
 * brand-new module).
 *
 * Fixtures are deliberately fictitious (AGENTS.md §6): `sphere-non-watertight`
 * is the canonical non-watertight object (watertight: false, tinted
 * `#b36a5e` in the editor); `box-a`/`box-b` are watertight. Never real
 * geometry or device data.
 */

import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fresh module instance per `tag` so module-level mock state is isolated. */
function mockUrl(tag) {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  url.searchParams.set(tag, String(Date.now()));
  return url;
}

/** Pure core URL (state/repair.ts). */
const repairCoreUrl = () =>
  pathToFileURL(path.join(root, "apps", "editor", "src", "state", "repair.ts")).href;

async function freshBridge(tag) {
  const mock = await import(mockUrl(tag).href);
  const bridge = await mock.fetchSceneSnapshot();
  // Watertight box fixture (S9.2 fixture).
  await bridge.mutateObject({
    kind: "add",
    object: {
      name: "box-a",
      vertices: 24,
      triangles: 12,
      bounds: { min: [0, 0, 0], max: [10, 10, 5] },
      sizeMm: [10, 10, 5],
      volumeMm3: 500,
      surfaceAreaMm2: 300,
      watertight: true,
      geometry: {
        positions: new Float32Array(24 * 3),
        normals: new Float32Array(24 * 3),
        indices: new Uint32Array(36),
      },
      visible: true,
      locked: false,
    },
  });
  // Canonical non-watertight object (leftover from an import that failed the
  // watertight closure — the S9.5 slice preflight rejects it). Deliberately
  // NOT `sphere-non-watertight` (that name is the mock's seeded SPHERE — a
  // fresh module instance must not alias the seed fixture; §6 fixtures).
  await bridge.mutateObject({
    kind: "add",
    object: {
      name: "open-shell",
      vertices: 362,
      triangles: 720,
      bounds: { min: [-8, -8, -8], max: [8, 8, 8] },
      sizeMm: [16, 16, 16],
      volumeMm3: 2144,
      surfaceAreaMm2: 804,
      watertight: false,
      geometry: {
        positions: new Float32Array(362 * 3),
        normals: new Float32Array(362 * 3),
        indices: new Uint32Array(720 * 3),
      },
      visible: true,
      locked: false,
      transform: { x: 12, y: 0, z: 10, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
    },
  });
  return { mock, bridge };
}

// --- pure state/repair.ts core ---------------------------------------------

test("repair core: REPAIR_MODES + labels", async () => {
  const core = await import(repairCoreUrl());
  assert.deepEqual(Array.from(core.REPAIR_MODES), ["replace", "copy"]);
  assert.equal(core.repairModeLabel("replace"), "Replace");
  assert.equal(core.repairModeLabel("copy"), "Replace-as-copy");
});

test("repair core: repairResultNote stamps `+repair <mode>` provenance", async () => {
  const core = await import(repairCoreUrl());
  assert.equal(core.repairResultNote("replace"), "+repair replace");
  assert.equal(core.repairResultNote("copy"), "+repair copy");
});

test("repair core: isRepairable only true for existing non-watertight", async () => {
  const core = await import(repairCoreUrl());
  assert.equal(core.isRepairable({ watertight: false }), true);
  assert.equal(core.isRepairable({ watertight: true }), false);
  assert.equal(core.isRepairable(undefined), false);
});

test("repair core: copyNameFor dedupes deterministically", async () => {
  const core = await import(repairCoreUrl());
  const inUse = (n) => n === "part-repair" || n === "part-repair-2";
  assert.equal(core.copyNameFor("part", inUse), "part-repair-3", "skips taken suffixes");
  // Fresh inUse → the base `-repair` name is free.
  assert.equal(
    core.copyNameFor("part", () => false),
    "part-repair",
  );
});

// --- S9.7-003 bridge repair lane -------------------------------------------

test("repair lane: replace mutates in place, keeps name/placement, watertight", async (t) => {
  const { mock, bridge } = await freshBridge(t.name);
  const res = await bridge.repair({ name: "open-shell", mode: "replace" });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "replace");
  assert.equal(res.object, "open-shell", "replace keeps the name");
  assert.equal(res.objectSnapshot.watertight, true);
  assert.equal(res.objectSnapshot.provenance, "+repair replace");
  // The closure welds the manifold — determined by the fixture heuristic.
  assert.equal(res.objectSnapshot.vertices, Math.round(362 * 1.12));
  assert.equal(res.objectSnapshot.triangles, 720);
  // Still the same object set (no copy added), same name in the store. The
  // fresh module carries the 3 canonical seeds (cone/cube/sphere) + the 2
  // fixtures = 5; replace mutates, never adds.
  const list = (await mock.fetchSceneSnapshot()).objects;
  assert.equal(list.length, 5);
  const updated = list.find((o) => o.name === "open-shell");
  assert.equal(updated.watertight, true);
  assert.equal(updated.provenance, "+repair replace");
  // Placement survived.
  assert.equal(updated.transform.x, 12);
  assert.equal(updated.transform.z, 10);
});

test("repair lane: copy adds a new deduped object, source untouched", async (t) => {
  const { mock, bridge } = await freshBridge(t.name);
  const res = await bridge.repair({ name: "open-shell", mode: "copy" });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "copy");
  assert.equal(res.object, "open-shell-repair", "copy name is deduped");
  const list = (await mock.fetchSceneSnapshot()).objects;
  assert.equal(list.length, 6); // 3 canonical seeds + box-a + open-shell + copy
  const source = list.find((o) => o.name === "open-shell");
  const copy = list.find((o) => o.name === "open-shell-repair");
  assert.equal(source.watertight, false, "source stays non-watertight (untouched)");
  assert.equal(source.provenance, undefined, "source provenance untouched");
  assert.equal(copy.watertight, true, "copy is watertight");
  assert.equal(copy.provenance, "+repair copy");
});

test("repair lane: rejects unknown objects and already-watertight objects", async (t) => {
  const { bridge } = await freshBridge(t.name);
  const unknown = await bridge.repair({ name: "ghost", mode: "replace" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown object/);
  const wt = await bridge.repair({ name: "box-a", mode: "replace" });
  assert.equal(wt.ok, false);
  assert.match(wt.error, /already watertight/);
});

test("repair lane: revision advances and onCommitEvent fires with the new revision", async (t) => {
  const { bridge } = await freshBridge(t.name);
  const events = [];
  bridge.onCommitEvent = (e) => events.push(e.revision);
  const res = await bridge.repair({ name: "open-shell", mode: "replace" });
  assert.equal(res.ok, true);
  assert.deepEqual(events, [res.revision], "commit event carries the new revision");
  // After the replace the object is watertight → a follow-up repair on the
  // same object is rejected (no revision). The mock's seeded non-watertight
  // SPHERE (canonical §6 fixture) is still repairable → its copy advances.
  const already = await bridge.repair({ name: "open-shell", mode: "replace" });
  assert.equal(already.ok, false);
  assert.match(already.error, /already watertight/);
  const copy = await bridge.repair({ name: "sphere-non-watertight", mode: "copy" });
  assert.equal(copy.ok, true);
  assert.equal(copy.revision, res.revision + 1, "revision advances per repair commit");
});
