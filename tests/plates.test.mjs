import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.4-003 plate state — pure core behavior (`state/plates-core.ts`).
 * Headless under Node 24.
 *
 * AC-1: multiple plates create/switch/duplicate/rename + per-plate object
 *       visibility (membership filter).
 * AC-2: cross-plate object move (membership reassignment) — the PlateTabs
 *       context menu / drag-drop route through the scene mutation lane; the
 *       pure reassignment (`assignObjectPlate`) is asserted here.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "plates-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("plates-core: default state is a single active plate named 'Plate 1'", async () => {
  const core = await corePromise;
  const s = core.defaultPlates();
  assert.equal(s.plates.length, 1);
  assert.equal(s.activeId, core.DEFAULT_PLATE_ID);
  assert.equal(s.plates[0].name, "Plate 1");
  assert.equal(s.plates[0].dirty, false);
});

test("plates-core: addPlate appends a unique id + label and activates it", async () => {
  const core = await corePromise;
  const s = core.addPlate(core.defaultPlates(), "Support");
  assert.equal(s.plates.length, 2);
  assert.equal(s.activeId, s.plates[1].id);
  assert.equal(s.plates[1].name, "Support");
  assert.notEqual(s.plates[0].id, s.plates[1].id);
});

test("plates-core: addPlate with no label auto-names 'Plate N' with no collision", async () => {
  const core = await corePromise;
  let s = core.defaultPlates("Plate 1");
  s = core.addPlate(s);
  assert.equal(s.plates[1].name, "Plate 2");
  s = core.renamePlate(s, s.plates[1].id, "Bom");
  s = core.addPlate(s);
  // no collision with "Plate 2" (used) nor "Plate 3" (free)
  assert.equal(s.plates[2].name, "Plate 3");
});

test("plates-core: switchPlate activates an existing plate, no-op on unknown", async () => {
  const core = await corePromise;
  let s = core.defaultPlates();
  s = core.addPlate(s, "Two");
  s = core.switchPlate(s, s.plates[0].id);
  assert.equal(s.activeId, s.plates[0].id);
  const same = core.switchPlate(s, "nope");
  assert.equal(same, s); // identity preserved on unknown
});

test("plates-core: duplicatePlate copies the label and activates the copy", async () => {
  const core = await corePromise;
  let s = core.defaultPlates("Main");
  s = core.duplicatePlate(s, core.DEFAULT_PLATE_ID);
  assert.equal(s.plates.length, 2);
  assert.equal(s.plates[1].name, "Main copy");
  assert.equal(s.activeId, s.plates[1].id);
});

test("plates-core: renamePlate trims, rejects empty/same, renames otherwise", async () => {
  const core = await corePromise;
  let s = core.defaultPlates();
  // same name → identity
  assert.equal(core.renamePlate(s, core.DEFAULT_PLATE_ID, "Plate 1"), s);
  // empty/whitespace → identity
  assert.equal(core.renamePlate(s, core.DEFAULT_PLATE_ID, "   "), s);
  s = core.renamePlate(s, core.DEFAULT_PLATE_ID, "  Main  ");
  assert.equal(s.plates[0].name, "Main");
});

test("plates-core: markPlateDirty flips dirty without touching other plates", async () => {
  const core = await corePromise;
  let s = core.defaultPlates();
  s = core.addPlate(s, "Two");
  s = core.markPlateDirty(s, core.DEFAULT_PLATE_ID, true);
  assert.equal(s.plates[0].dirty, true);
  assert.equal(s.plates[1].dirty, false);
});

test("plates-core: activePlate falls back to first plate defensively", async () => {
  const core = await corePromise;
  const s = core.defaultPlates();
  assert.equal(core.activePlate(s).name, "Plate 1");
  // unknown active → first plate
  const broken = { plates: s.plates, activeId: "ghost" };
  assert.equal(core.activePlate(broken).id, core.DEFAULT_PLATE_ID);
});

test("plates-core: plateIdFor defaults absent plateId to default plate", async () => {
  const core = await corePromise;
  assert.equal(core.plateIdFor({}), core.DEFAULT_PLATE_ID);
  assert.equal(core.plateIdFor({ plateId: "plate-x" }), "plate-x");
});

test("plates-core: objectsOnPlate filters membership incl. default plate", async () => {
  const core = await corePromise;
  const objs = [
    { name: "a", plateId: "plate-1" },
    { name: "b" }, // default plate
    { name: "c", plateId: "plate-2" },
  ];
  const p1 = core.objectsOnPlate(objs, "plate-1");
  assert.deepEqual(
    p1.map((o) => o.name),
    ["a", "b"],
  );
  const p2 = core.objectsOnPlate(objs, "plate-2");
  assert.deepEqual(
    p2.map((o) => o.name),
    ["c"],
  );
});

test("plates-core: assignObjectPlate reassigns named objects to a plate", async () => {
  const core = await corePromise;
  const objs = [
    { name: "a", plateId: "plate-1" },
    { name: "b", plateId: "plate-1" },
  ];
  const moved = core.assignObjectPlate(objs, ["a"], "plate-2");
  assert.equal(moved[0].plateId, "plate-2");
  assert.equal(moved[1].plateId, "plate-1");
  // empty target → identity
  assert.equal(core.assignObjectPlate(objs, [], "plate-2"), objs);
});

test("plates-core: hasOrphanObjects detects unknown plate refs", async () => {
  const core = await corePromise;
  const plates = core.defaultPlates().plates;
  assert.equal(core.hasOrphanObjects([{ plateId: "plate-1" }], plates), false);
  assert.equal(core.hasOrphanObjects([{ plateId: "ghost" }], plates), true);
});
