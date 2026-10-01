import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.8-004 dirty state + local persistence — pure core behavior
 * (`state/dirty-core.ts`) under Node 24. Covers:
 * - `unsavedOpsDelta` / `dirtyChip` (chip reflects unsaved revision delta)
 * - `serializeScene` / `parseSceneBackup` round-trip (save/restore works)
 * - corrupted / foreign / wrong-version payloads rejected deterministically
 * - `lastCommitLabel` (mono time, "never" when absent)
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "dirty-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

/** Minimal object stub (the core only structurally validates names). */
function obj(name) {
  return {
    name,
    visible: true,
    locked: false,
    watertight: true,
    transform: { x: 1, y: 2, z: 3 },
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    volumeMm3: 100,
  };
}

test("unsavedOpsDelta: revision delta (clamped ≥ 0)", async () => {
  const { unsavedOpsDelta } = await corePromise;
  assert.equal(unsavedOpsDelta(7, 3), 4);
  assert.equal(unsavedOpsDelta(5, 5), 0);
  assert.equal(unsavedOpsDelta(2, 10), 0); // behind saved point — clean
});

test("dirtyChip: button-state derivation (isDirty + time)", async () => {
  const { dirtyChip } = await corePromise;
  const clean = dirtyChip(5, 5, "2026-10-02T10:00:00.000Z");
  assert.equal(clean.isDirty, false);
  assert.equal(clean.unsavedOps, 0);
  assert.equal(clean.lastCommitTime, "2026-10-02T10:00:00.000Z");

  const dirty = dirtyChip(9, 5, "2026-10-02T10:00:00.000Z");
  assert.equal(dirty.isDirty, true);
  assert.equal(dirty.unsavedOps, 4);

  const never = dirtyChip(1, 0, null);
  assert.equal(never.isDirty, true);
  assert.equal(never.lastCommitTime, null);
});

test("serializeScene/parseSceneBackup: round-trip preserves revision + objects", async () => {
  const { serializeScene, parseSceneBackup } = await corePromise;
  const objects = [obj("cone"), obj("cube"), obj("sphere")];
  const envelope = serializeScene(9, objects, "2026-10-02T12:00:00.000Z");
  assert.equal(envelope.revision, 9);
  assert.equal(envelope.objects.length, 3);
  assert.equal(envelope.kind, "anycubic:scene-backup");

  const parsed = parseSceneBackup(JSON.stringify(envelope));
  assert.ok(parsed, "valid envelope parses");
  assert.equal(parsed.revision, 9);
  assert.deepEqual(
    parsed.objects.map((o) => o.name),
    ["cone", "cube", "sphere"],
  );
  assert.equal(parsed.savedAt, "2026-10-02T12:00:00.000Z");
});

test("parseSceneBackup: garbage / empty / wrong kind / wrong version → null (never crash)", async () => {
  const { parseSceneBackup, DIRTY_BACKUP_KIND, DIRTY_BACKUP_VERSION } = await corePromise;
  assert.equal(parseSceneBackup(null), null);
  assert.equal(parseSceneBackup(undefined), null);
  assert.equal(parseSceneBackup(""), null);
  assert.equal(parseSceneBackup("{not json"), null);
  assert.equal(parseSceneBackup("42"), null);
  assert.equal(parseSceneBackup(JSON.stringify({ hello: "world" })), null); // wrong kind
  const foreign = {
    kind: "other:payload",
    version: DIRTY_BACKUP_VERSION,
    savedAt: "2026-10-02T12:00:00.000Z",
    revision: 3,
    objects: [],
  };
  assert.equal(parseSceneBackup(JSON.stringify(foreign)), null);
  const wrongVersion = {
    kind: DIRTY_BACKUP_KIND,
    version: DIRTY_BACKUP_VERSION + 1,
    savedAt: "2026-10-02T12:00:00.000Z",
    revision: 3,
    objects: [],
  };
  assert.equal(parseSceneBackup(JSON.stringify(wrongVersion)), null);
});

test("parseSceneBackup: malformed revision / savedAt / objects rejected", async () => {
  const { parseSceneBackup, DIRTY_BACKUP_KIND, DIRTY_BACKUP_VERSION } = await corePromise;
  const base = {
    kind: DIRTY_BACKUP_KIND,
    version: DIRTY_BACKUP_VERSION,
    savedAt: "2026-10-02T12:00:00.000Z",
    revision: 3,
    objects: [obj("x")],
  };
  assert.ok(parseSceneBackup(JSON.stringify(base)), "well-formed payload accepted");
  assert.equal(parseSceneBackup(JSON.stringify({ ...base, revision: "3" })), null);
  assert.equal(parseSceneBackup(JSON.stringify({ ...base, revision: -1 })), null);
  assert.equal(parseSceneBackup(JSON.stringify({ ...base, savedAt: "not-a-date" })), null);
  assert.equal(parseSceneBackup(JSON.stringify({ ...base, objects: "nope" })), null);
  // Object without a name string → rejected.
  assert.equal(parseSceneBackup(JSON.stringify({ ...base, objects: [{ visible: true }] })), null);
});

test("lastCommitLabel: mono HH:MM label, NEVER_SAVED when absent/invalid", async () => {
  const { lastCommitLabel, NEVER_SAVED } = await corePromise;
  assert.equal(lastCommitLabel(null), NEVER_SAVED);
  assert.equal(lastCommitLabel(undefined), NEVER_SAVED);
  assert.equal(lastCommitLabel("garbage"), NEVER_SAVED);
  const d = new Date("2026-10-02T09:05:00.000Z"); // local timezone-dependent but parseable
  const label = lastCommitLabel(d.toISOString());
  assert.match(label, /^\d{2}:\d{2}$/);
});
