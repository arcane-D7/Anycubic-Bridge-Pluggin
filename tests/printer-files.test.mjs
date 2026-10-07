import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.12-001 — printer file listing — pure core normalisation.
 *
 * AC (from sprint-planning/sprint-9-12/sprint.md S9.12-001):
 *   - Files browser (local/USB) with metadata: name, size, date, thumbnail.
 *   - listing normalisation is unit-tested headless with FIXTURE-only ids
 *     (AGENTS.md §6 — never real device ids outside tests/).
 *   - staleness is honest (a list older than the refresh window is flagged,
 *     never silently shown as fresh).
 *
 * The core normalises ANY payload shape seen in the discovery probes:
 * cloud `local_files` (103) / `usb_files` (101), LAN `listLocal`/`listUdisk`.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-files-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

async function loadMock() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();
const mockPromise = loadMock();

/* ------------------------------------------------------------------ */
/* normaliseFileEntry — field spellings + basename + id fallback       */
/* ------------------------------------------------------------------ */

test("files-core: normalises a cloud local_files entry (id/name/size)", async () => {
  const { normaliseFileEntry } = await corePromise;
  const entry = normaliseFileEntry(
    { id: "f-1001", file_name: "/print/Benchy.gcode", file_size: 123456, date: 1700000000 },
    "local",
  );
  assert.equal(entry?.kind, "local");
  assert.equal(entry?.id, "f-1001");
  // basename — the device reports a path
  assert.equal(entry?.name, "Benchy.gcode");
  assert.equal(entry?.sizeBytes, 123456);
  // seconds → ms normalisation
  assert.equal(entry?.modifiedAt, 1700000000000);
  assert.ok(entry?.thumbHint);
});

test("files-core: normalises a usb entry with fileId/file_name spelling", async () => {
  const { normaliseFileEntry } = await corePromise;
  const entry = normaliseFileEntry(
    {
      fileId: "u-77",
      file_name: "spool_holder.3mf",
      file_size: "2048",
      uploadTime: "2024-05-01T10:00:00Z",
    },
    "usb",
  );
  assert.equal(entry?.kind, "usb");
  assert.equal(entry?.id, "u-77");
  assert.equal(entry?.name, "spool_holder.3mf");
  assert.equal(entry?.sizeBytes, 2048);
  assert.equal(entry?.modifiedAt, Date.parse("2024-05-01T10:00:00Z"));
});

test("files-core: id falls back to path then name; nulls for absent size/date", async () => {
  const { normaliseFileEntry } = await corePromise;
  const entry = normaliseFileEntry({ path: "dir/file.gcode" }, "local");
  assert.equal(entry?.id, "dir/file.gcode");
  assert.equal(entry?.name, "file.gcode");
  assert.equal(entry?.sizeBytes, null);
  assert.equal(entry?.modifiedAt, null);
});

test("files-core: bare name still normalises (name-only source)", async () => {
  const { normaliseFileEntry } = await corePromise;
  const entry = normaliseFileEntry({ name: "calib_cube.gcode" }, "local");
  assert.equal(entry?.id, "calib_cube.gcode");
  assert.equal(entry?.name, "calib_cube.gcode");
});

test("files-core: rejects empty/invalid entries (null), drops trailing path sep", async () => {
  const { normaliseFileEntry } = await corePromise;
  assert.equal(normaliseFileEntry(null, "local"), null);
  assert.equal(normaliseFileEntry({}, "local"), null);
  assert.equal(normaliseFileEntry({ name: "  " }, "local"), null);
  // Windows-style path basename
  const entry = normaliseFileEntry({ name: "subdir\\cube.gcode" }, "local");
  assert.equal(entry?.name, "cube.gcode");
});

/* ------------------------------------------------------------------ */
/* normaliseFileListing — payload wrappers + deterministic sort         */
/* ------------------------------------------------------------------ */

test("files-core: array payload normalises + sorts by name", async () => {
  const { normaliseFileListing } = await corePromise;
  const files = await normaliseFileListing(
    [
      { id: "b", name: "z.gcode", size: 100 },
      { id: "a", name: "a.gcode", size: 50 },
      { id: "c", name: "c.3mf" },
    ],
    "local",
  );
  assert.equal(files.length, 3);
  assert.deepEqual(
    files.map((f) => f.name),
    ["a.gcode", "c.3mf", "z.gcode"],
  );
});

test("files-core: files:[] wrapper unwraps; empty payload yields []", async () => {
  const { normaliseFileListing } = await corePromise;
  const files = await normaliseFileListing({ files: [] }, "usb");
  assert.deepEqual(files, []);
  assert.deepEqual(await normaliseFileListing(null, "usb"), []);
  assert.deepEqual(await normaliseFileListing("nope", "usb"), []);
  assert.deepEqual(
    await normaliseFileListing({ data: [{ name: "x.3mf" }] }, "usb").map((f) => f.name),
    ["x.3mf"],
  );
});

test("files-core: drops entries that fail normalisation (nulls)", async () => {
  const { normaliseFileListing } = await corePromise;
  const files = await normaliseFileListing(
    [{ name: "keep.gcode" }, {}, { name: "  " }, { name: "second.stl" }],
    "local",
  );
  assert.equal(files.length, 2);
});

/* ------------------------------------------------------------------ */
/* fileListResult — honest stale flag                                  */
/* ------------------------------------------------------------------ */

test("files-core: never-loaded list is stale (loadedAt null)", async () => {
  const { fileListResult } = await corePromise;
  const result = fileListResult("local", [], { loadedAt: null });
  assert.equal(result.ok, true);
  assert.equal(result.source, "local");
  assert.equal(result.stale, true);
  assert.equal(result.loadedAt, null);
});

test("files-core: old-loaded list within window is NOT stale; beyond is", async () => {
  const { fileListResult } = await corePromise;
  const now = Date.now();
  const fresh = fileListResult("usb", [], { loadedAt: now - 10_000, windowMs: 60_000 });
  assert.equal(fresh.stale, false);
  const old = fileListResult("usb", [], { loadedAt: now - 120_000, windowMs: 60_000 });
  assert.equal(old.stale, true);
});

/* ------------------------------------------------------------------ */
/* mock lane — deterministic fixtures + seams                          */
/* ------------------------------------------------------------------ */

test("files mock lane: listFiles returns fixture files for both storages", async () => {
  const mock = await mockPromise;
  const handle = await mock.fetchSceneSnapshot();
  const local = await handle.listFiles("local");
  assert.equal(local.ok, true);
  assert.equal(local.source, "local");
  assert.ok(local.files.length > 0);
  const usb = await handle.listFiles("usb");
  assert.equal(usb.ok, true);
  assert.equal(usb.source, "usb");
  assert.ok(usb.files.length > 0);
});

test("files mock lane: sendFile offline seam aborts, success mints task id", async () => {
  const mock = await mockPromise;
  mock.setMockOfflinePrinters(["printer-192-168-99-99"]);
  const handle = await mock.fetchSceneSnapshot();
  const offline = await handle.sendFile({
    printerId: "printer-192-168-99-99",
    ip: "192.168.99.99",
    fileId: "f-1",
    name: "x.gcode",
    source: "local",
    storage: { usedBytes: 100, totalBytes: 1000 },
  });
  assert.equal(offline.ok, false);
  if (!offline.ok) assert.equal(offline.kind, "offline");
  const ok = await handle.sendFile({
    printerId: "printer-192-168-1-10",
    ip: "192.168.1.10",
    fileId: "f-1",
    name: "x.gcode",
    source: "local",
    storage: { usedBytes: 100, totalBytes: 1000 },
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.taskId, /^mock-task-/);
});
