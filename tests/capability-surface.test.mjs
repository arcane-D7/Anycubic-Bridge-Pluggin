import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(ROOT, "apps", "editor", "src", "state", "capability-surface.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("surface is valid: unique actions, reads + writes present", async () => {
  const core = await corePromise;
  assert.equal(core.surfaceIsValid(core.READ_ACTIONS, core.WRITE_ACTIONS), true);
  assert.ok(core.READ_ACTIONS.length >= 5);
  assert.ok(core.WRITE_ACTIONS.length >= 10);
  assert.equal(core.CAPABILITY_SURFACE.byAction["snapshot.get"].kind, "read");
});

test("duplicate action makes the surface invalid", async () => {
  const core = await corePromise;
  const dup = [
    { action: "x", capabilityKey: "a", kind: "read", requiresApproval: "never" },
    { action: "x", capabilityKey: "b", kind: "read", requiresApproval: "never" },
  ];
  assert.equal(core.surfaceIsValid(dup, []), false);
});

test("reads are direct for user and agent, never need approval", async () => {
  const core = await corePromise;
  const read = core.CAPABILITY_SURFACE.byAction["snapshot.get"];
  assert.equal(core.allowedFor("user", read), true);
  assert.equal(core.allowedFor("agent", read), true);
  assert.equal(core.needsApproval("agent", read), false);
});

test("user writes are direct; agent writes require approval", async () => {
  const core = await corePromise;
  const fans = core.CAPABILITY_SURFACE.byAction["fans.setPart"];
  const pause = core.CAPABILITY_SURFACE.byAction["print.pause"];
  assert.equal(core.allowedFor("user", fans), true);
  assert.equal(core.needsApproval("user", fans), false);
  assert.equal(core.allowedFor("agent", fans), true);
  assert.equal(core.needsApproval("agent", fans), true);
  assert.equal(core.allowedFor("agent", pause), true);
  assert.equal(core.needsApproval("agent", pause), true);
});

test("raw hidden command is user+DevTools only, Agent blocked by policy", async () => {
  const core = await corePromise;
  const raw = core.CAPABILITY_SURFACE.byAction["raw.command"];
  assert.equal(raw.kind, "raw");
  assert.equal(raw.agentBlocked, true);
  assert.equal(core.allowedFor("user", raw), true);
  assert.equal(core.allowedFor("agent", raw), false);
  assert.equal(core.needsApproval("agent", raw), false);
});

test("buildSurface indexes and splits writes/reads/raw", async () => {
  const core = await corePromise;
  const s = core.buildSurface(core.READ_ACTIONS, core.WRITE_ACTIONS);
  const runs = s.writes.every((e) => e.kind === "write");
  const rawOnly = s.raw.every((e) => e.kind === "raw");
  assert.equal(runs, true);
  assert.equal(rawOnly, true);
  assert.ok(s.raw.some((e) => e.action === "raw.command"));
  assert.equal(s.byAction["temps.setNozzle"].capabilityKey, "tempature");
});

test("entryFor lookups work; unknown returns undefined", async () => {
  const core = await corePromise;
  assert.equal(core.entryFor(core.CAPABILITY_SURFACE, "ace.dry")?.action, "ace.dry");
  assert.equal(core.entryFor(core.CAPABILITY_SURFACE, "nope"), undefined);
});

test("all write actions declared have a sound classification", async () => {
  const core = await corePromise;
  for (const e of core.WRITE_ACTIONS) {
    assert.ok(e.kind === "write" || e.kind === "raw");
    assert.ok(["never", "user", "agent"].includes(e.requiresApproval));
    if (e.agentBlocked) assert.equal(e.kind, "raw");
  }
});
