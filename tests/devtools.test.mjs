import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * S9.12-002 — DevTools pane unit tests (pure core, Node 24 headless).
 *
 * Covers:
 * - catalog + command fixtures deterministic (no real ids/endpoints)
 * - `searchCatalog` / `searchCommands` case-insensitive filtering
 * - `validateRawCommand` (empty/too-long/arg bounds/NaN)
 * - session journal core: append/clear/line formatting
 * - policy: `allowedFor("agent", raw.command) === false` (the 9.10-001 gate)
 * - mock lane: `devtoolsReadModel` returns the fixtures; `rawCommand`
 *   invalid → kind "invalid", refused/timeout seams via the shared
 *   control seams.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore(name) {
  const url = pathToFileURL(path.join(ROOT, "apps", "editor", "src", "state", `${name}.ts`));
  return import(`${url.href}?key=${Date.now()}`);
}

async function loadMock() {
  const url = pathToFileURL(path.join(ROOT, "apps", "editor", "src", "bridge", "mock.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const devtoolsPromise = loadCore("devtools-core");
const journalPromise = loadCore("devtools-journal-core");
const surfacePromise = loadCore("capability-surface");
const mockPromise = loadMock();

test("catalog fixture: deterministic entries with expected fields", async () => {
  const { DEVTOOLS_CATALOG_FIXTURE } = await devtoolsPromise;
  assert.ok(Array.isArray(DEVTOOLS_CATALOG_FIXTURE));
  assert.ok(DEVTOOLS_CATALOG_FIXTURE.length >= 8);
  for (const row of DEVTOOLS_CATALOG_FIXTURE) {
    assert.equal(typeof row.source, "string");
    assert.equal(typeof row.path, "string");
    assert.equal(typeof row.type, "string");
    assert.equal(typeof row.group, "string");
    assert.ok(["string", "number", "boolean"].includes(row.type));
  }
  // Fixture parity: tempature rows exist (temperature group), no account ids.
  const tempRows = DEVTOOLS_CATALOG_FIXTURE.filter((r) => r.source === "tempature");
  assert.ok(tempRows.length >= 1);
  assert.ok(DEVTOOLS_CATALOG_FIXTURE.every((r) => !/\d{6}/.test(r.path)));
});

test("command fixture: safety classes + evidence labels", async () => {
  const { DEVTOOLS_COMMANDS_FIXTURE } = await devtoolsPromise;
  assert.ok(Array.isArray(DEVTOOLS_COMMANDS_FIXTURE));
  assert.ok(DEVTOOLS_COMMANDS_FIXTURE.length >= 10);
  const safeties = new Set(DEVTOOLS_COMMANDS_FIXTURE.map((r) => r.safety));
  for (const s of ["read", "state", "thermal", "motion", "job"]) {
    assert.ok(safeties.has(s), `safety ${s} must be represented`);
  }
  // A hidden command map always includes the raw-dangerous group (axis/job).
  assert.ok(DEVTOOLS_COMMANDS_FIXTURE.some((r) => r.type === "axis" && r.safety === "motion"));
  assert.ok(DEVTOOLS_COMMANDS_FIXTURE.some((r) => r.type === "print" && r.safety === "job"));
});

test("devtoolsReadModel: catalog + commands fixtures exposed as one model", async () => {
  const { devtoolsReadModel } = await devtoolsPromise;
  const model = devtoolsReadModel();
  assert.ok(Array.isArray(model.catalog));
  assert.ok(Array.isArray(model.commands));
  assert.ok(model.catalog.length > 0);
  assert.ok(model.commands.length > 0);
});

test("searchCatalog: case-insensitive path/group/source filter", async () => {
  const { DEVTOOLS_CATALOG_FIXTURE, searchCatalog } = await devtoolsPromise;
  const temp = searchCatalog(DEVTOOLS_CATALOG_FIXTURE, "TEMP");
  assert.ok(temp.length >= 1);
  assert.ok(temp.every((r) => r.group === "temperature" || r.path.toLowerCase().includes("temp")));
  const empty = searchCatalog(DEVTOOLS_CATALOG_FIXTURE, "");
  assert.equal(empty.length, DEVTOOLS_CATALOG_FIXTURE.length);
  const nothing = searchCatalog(DEVTOOLS_CATALOG_FIXTURE, "zzz-nope");
  assert.equal(nothing.length, 0);
});

test("searchCommands: type/safety/evidence filter", async () => {
  const { DEVTOOLS_COMMANDS_FIXTURE, searchCommands } = await devtoolsPromise;
  const motion = searchCommands(DEVTOOLS_COMMANDS_FIXTURE, "motion");
  assert.ok(motion.length >= 1);
  assert.ok(motion.every((r) => r.safety === "motion"));
  const reads = searchCommands(DEVTOOLS_COMMANDS_FIXTURE, "read");
  assert.ok(reads.every((r) => r.safety === "read" || r.evidence === "read"));
});

test("validateRawCommand: empty/too-long/arg bounds/NaN", async () => {
  const { validateRawCommand } = await devtoolsPromise;
  // Invalid (returns a reason string).
  assert.ok(validateRawCommand("", {}));
  assert.ok(validateRawCommand("   ", {}));
  assert.ok(validateRawCommand("x".repeat(65), {}));
  assert.ok(validateRawCommand("ok", { a: "" }));
  assert.ok(validateRawCommand("ok", { a: " " }));
  assert.ok(validateRawCommand("ok", { a: "x".repeat(257) }));
  assert.ok(validateRawCommand("ok", { a: NaN }));
  assert.ok(validateRawCommand("ok", { "": 1 }));
  // Valid (returns null; empty args OK = query-style command).
  assert.equal(validateRawCommand("ok", { a: 1 }), null);
  assert.equal(validateRawCommand("ok", { a: "text" }), null);
  assert.equal(validateRawCommand("query", {}), null);
  assert.equal(validateRawCommand("OK", {}), null);
});

test("journal core: append/clear/line formatting, immutable", async () => {
  const { initialDevtoolsJournal, journalAppend, journalClear, journalLine } = await journalPromise;
  const s0 = initialDevtoolsJournal();
  assert.equal(s0.entries.length, 0);
  const s1 = journalAppend(s0, "devtools.raw.request", "raw light");
  assert.equal(s0.entries.length, 0, "original state must be immutable");
  assert.equal(s1.entries.length, 1);
  assert.equal(s1.entries[0].kind, "devtools.raw.request");
  assert.equal(s1.entries[0].detail, "raw light");
  const s2 = journalAppend(s1, "devtools.raw.accepted", "ok");
  assert.equal(s2.entries.length, 2);
  assert.equal(s2.entries[1].id, 2);
  const cleared = journalClear(s2);
  assert.equal(cleared.entries.length, 0);
  const line = journalLine(s2.entries[0]);
  assert.ok(line.includes("#1"));
  assert.ok(line.includes("devtools.raw.request"));
});

test("policy: raw hidden command is user-only — Agent blocked (9.10-001)", async () => {
  const { CAPABILITY_SURFACE, allowedFor, needsApproval } = await surfacePromise;
  const raw = CAPABILITY_SURFACE.byAction["raw.command"];
  assert.equal(raw.kind, "raw");
  assert.equal(raw.agentBlocked, true);
  assert.equal(allowedFor("user", raw), true);
  assert.equal(allowedFor("agent", raw), false);
  assert.equal(needsApproval("agent", raw), false);
});

test("mock lane: devtoolsReadModel returns fixtures; rawCommand invalid", async () => {
  const mock = await mockPromise;
  const model = await mock.fetchSceneSnapshot();
  const lanes = await model.devtoolsReadModel();
  assert.ok(lanes.catalog.length >= 8);
  assert.ok(lanes.commands.length >= 10);

  const bad = await model.rawCommand({ command: "", args: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, "invalid");

  const valid = await model.rawCommand({ command: "LIGHT", args: { status: 1 } });
  assert.equal(valid.ok, true);
  assert.equal(valid.command, "LIGHT");
});

test("mock lane: rawCommand refused/timeout seams via shared control seams", async () => {
  const mock = await mockPromise;
  mock.setMockControlRefused(true);
  try {
    const model = await mock.fetchSceneSnapshot();
    const refused = await model.rawCommand({ command: "light", args: {} });
    assert.equal(refused.ok, false);
    assert.equal(refused.kind, "refused");
  } finally {
    mock.setMockControlRefused(false);
  }
  mock.setMockControlTimeout(true);
  try {
    const model = await mock.fetchSceneSnapshot();
    const timed = await model.rawCommand({ command: "light", args: {} });
    assert.equal(timed.ok, false);
    assert.equal(timed.kind, "timeout");
  } finally {
    mock.setMockControlTimeout(false);
  }
});
