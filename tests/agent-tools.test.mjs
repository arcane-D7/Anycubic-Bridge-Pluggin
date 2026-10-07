/**
 * S9.12-003 — Agent parity tool policy tests (headless, fixture-free).
 *
 * The write-tool approval gate is policy-driven: every Agent write MUST exist
 * in the editor capability surface, be marked writable and NOT agent-blocked,
 * and the safety class (motion/job) must demand the EXECUTE word. These tests
 * assert the agent-tools module itself stays consistent with the policy —
 * without any cloud session, printer or actual MCP round-trip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Load a pure TS editor module via Node 24 type-stripping (cache-busted). */
async function loadCore(relPath) {
  const url =
    pathToFileURL(path.join(ROOT, "apps", "editor", "src", relPath)).href + `?key=${Date.now()}`;
  return import(url);
}

/** Load a plain .mjs script module (cache-busted). */
async function loadScript(relPath) {
  const url = pathToFileURL(path.join(ROOT, relPath)).href + `?key=${Date.now()}`;
  return import(url);
}

/** Load the agent-tools script module. */
function loadAgentTools() {
  return loadScript("scripts/printer-agent-tools.mjs");
}

test("agent write actions are all writable policy entries (never raw)", async () => {
  const [
    { AGENT_WRITE_ACTIONS, assertAgentApproval },
    { CAPABILITY_SURFACE, allowedFor },
    { COMMANDS },
  ] = await Promise.all([
    loadAgentTools(),
    loadCore("state/capability-surface.ts"),
    loadScript("scripts/printer-command-bus-catalog.mjs"),
  ]);
  const names = Object.keys(AGENT_WRITE_ACTIONS);
  assert.ok(names.length >= 8, "expected the 8 agent write tools");
  for (const name of names) {
    const spec = AGENT_WRITE_ACTIONS[name];
    // Every action must exist in the policy…
    const entry = CAPABILITY_SURFACE.byAction[spec.action];
    assert.ok(entry, `${name} → policy entry for ${spec.action} missing`);
    // …be a write (not a read), and not be agent-blocked or raw.
    assert.notEqual(entry.kind, "read", `${name} must be a write action`);
    assert.ok(!entry.agentBlocked, `${name} must not be agent-blocked`);
    assert.ok(allowedFor("agent", entry), `${name} must be allowed for the agent`);
    // The command it routes must exist in the catalog with a safety class.
    const cmd = COMMANDS[spec.command];
    assert.ok(cmd, `${name} → command ${spec.command} missing from catalog`);
    assert.ok(
      ["read", "state", "thermal", "motion", "job"].includes(cmd.safety),
      `${name} → ${spec.command} safety ${cmd.safety} unknown`,
    );
  }
});

test("agent write gate requires confirm:true (S9-006 approval)", async () => {
  const { AGENT_WRITE_ACTIONS, assertAgentApproval } = await loadAgentTools();
  const name = "set_temperature";
  const spec = AGENT_WRITE_ACTIONS[name];
  await assert.rejects(
    assertAgentApproval(spec.action, false, undefined, spec.command),
    /confirm:true/,
  );
  await assert.rejects(
    assertAgentApproval(spec.action, "yes", undefined, spec.command),
    /confirm:true/,
  );
});

test("agent write gate demands EXECUTE word for motion/job safety", async () => {
  const { AGENT_WRITE_ACTIONS, assertAgentApproval } = await loadAgentTools();
  const { COMMANDS } = await loadScript("scripts/printer-command-bus-catalog.mjs");
  const job = Object.values(AGENT_WRITE_ACTIONS).find(
    (s) => COMMANDS[s.command] && COMMANDS[s.command].safety === "job",
  );
  assert.ok(job, "expected at least one job-class command");
  await assert.rejects(assertAgentApproval(job.action, true, undefined, job.command), /EXECUTE/);
  await assert.rejects(assertAgentApproval(job.action, true, "CONFIRM", job.command), /EXECUTE/);
  // With the word + confirm the gate resolves (no network involved).
  await assertAgentApproval(job.action, true, "EXECUTE", job.command);
});

test("agent write gate rejects unknown or read-only actions", async () => {
  const { assertAgentApproval } = await loadAgentTools();
  await assert.rejects(() => assertAgentApproval("nonexistent.action", true, "EXECUTE", "x"));
  await assert.rejects(
    () => assertAgentApproval("snapshot.get", true, "EXECUTE", "print_query"),
    /not a writable policy entry|write/,
  );
});

test("raw hidden commands are blocked for the agent by policy", async () => {
  const { CAPABILITY_SURFACE, allowedFor } = await loadCore("state/capability-surface.ts");
  const raw = CAPABILITY_SURFACE.byAction["raw.command"];
  assert.ok(raw, "raw.command must exist in the surface");
  assert.equal(raw.agentBlocked, true);
  assert.equal(allowedFor("agent", raw), false);
  assert.equal(allowedFor("user", raw), true);
});

test("printer_get_snapshot is registered read-only (no network present)", async () => {
  // The module registers tools only via registerAgentTools; this asserts the
  // tool-name/documentation contract is stable without spawning a server:
  // 9.9-001 snapshot schema is versioned and read-only for the agent.
  const { AGENT_WRITE_ACTIONS } = await loadAgentTools();
  assert.ok(!("printer_get_snapshot" in AGENT_WRITE_ACTIONS));
  // The snapshot exists as a separate tool family; write tools never include it.
});
