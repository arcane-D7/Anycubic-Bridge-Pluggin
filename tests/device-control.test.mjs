// S9.18-004 follow-up — strict availability/TS-response normalization for the
// device-control Tauri bridge (unit, Node type-stripping — no TS toolchain).
//
// Loads the real `device-control.ts` and `device-availability-core.ts` modules.
// The Tauri runtime is faked at call-time (modules never read `window` at
// import time), and the `invoke` seam is injected so no `@tauri-apps/api`
// module is ever imported. The tests prove:
//   - ALL THREE availability sections must be well-shaped (boolean + reason
//     string|null); a missing/malformed `capability`/`writer` sections cannot
//     pass the structural guard → blocked (never throws, never partial).
//   - snake_case backend keys (`snapshot_captured_at_ms`, `claimed_project_id`)
//     are normalized to the camelCase TS contract on every reference; unknown
//     keys (e.g. an echoed secret) are discarded.
//   - unknown/invalid preflight statuses and malformed effect/draft shapes are
//     refused as `unavailable("malformed-reply")`.
//   - a nonexistent writer can never make the UI ready, even when the other
//     two sections report true.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = (rel) => pathToFileURL(path.join(root, "apps", "editor", "src", rel)).href;

const bridge = await import(`${moduleUrl("bridge/device-control.ts")}?key=${Date.now()}`);
const core = await import(`${moduleUrl("state/device-availability-core.ts")}?key=${Date.now()}`);

// Fake Tauri runtime: `isTauriRuntime()` is evaluated per-call, so a global
// `window` with the Tauri internals marker flips it on for the injected tests.
beforeEach(() => {
  globalThis.window = { __TAURI_INTERNALS__: {} };
});
afterEach(() => {
  delete globalThis.window;
});

function invokeReturning(payload) {
  return async function fakeInvoke(_command, _args) {
    return payload;
  };
}

function serializedPreflight() {
  // Exact wire shape of `DeviceControlPreflightReply` (Rust serialization).
  return {
    status: "ready",
    action: "nozzle",
    target: "device-test",
    effect: {
      action: "nozzle",
      summary: "set nozzle temperature",
      device: "device-test",
      project: "project-test",
      args: { nozzle: 210 },
      snapshot_captured_at_ms: 1234567890,
    },
    reason: null,
    draft: {
      claimed_project_id: "project-test",
      revision: 4,
      artifact: "artifact-test",
      material: "pla",
    },
  };
}

test("availability normalizer requires ALL THREE sections well-formed", () => {
  const valid = {
    session: { established: false, reason: "login-required" },
    capability: { defined: false, reason: "resolver-unavailable" },
    writer: { available: false, reason: "session-unestablished" },
  };
  assert.deepEqual(bridge.normalizeDeviceAvailability(valid), valid);

  // `capability` missing / `writer.available` missing (the old guard would
  // only check `session.established`) → refused, not partial.
  for (const malformed of [
    { session: { established: false, reason: null } },
    { session: { established: false, reason: null }, capability: { defined: false } },
    {
      session: { established: false, reason: null },
      capability: { defined: false, reason: null },
    },
    {
      session: { established: "yes", reason: null },
      capability: { defined: false, reason: null },
      writer: { available: false, reason: null },
    },
    {
      session: { established: false, reason: 4 },
      capability: { defined: false, reason: null },
      writer: { available: false, reason: null },
    },
  ]) {
    assert.equal(bridge.normalizeDeviceAvailability(malformed), null);
  }
});

test("availability normalizer discards unknown keys (no secret echo)", () => {
  const payload = {
    session: { established: false, reason: "login-required" },
    capability: { defined: false, reason: "resolver-unavailable" },
    writer: { available: false, reason: "session-unestablished" },
    session_token: "top-secret",
    user_id: "attacker",
  };
  const normalized = bridge.normalizeDeviceAvailability(payload);
  assert.equal("session_token" in normalized, false);
  assert.equal("user_id" in normalized, false);
});

test("fetchDeviceControlAvailability blocks on malformed or thrown replies", async () => {
  // Malformed capability section → BLOCKED (never a partial descriptor).
  const malformed = await bridge.fetchDeviceControlAvailability(
    invokeReturning({
      session: { established: false, reason: "login-required" },
      capability: { defined: undefined, reason: null },
      writer: { available: false, reason: null },
    }),
  );
  assert.equal(malformed, bridge.BLOCKED_DEVICE_CONTROL);

  // Throwing invoke → BLOCKED, no throw.
  const thrown = await bridge.fetchDeviceControlAvailability(async () => {
    throw new Error("transport unavailable");
  });
  assert.equal(thrown, bridge.BLOCKED_DEVICE_CONTROL);

  // Valid reply survives untouched.
  const valid = {
    session: { established: false, reason: "login-required" },
    capability: { defined: false, reason: "resolver-unavailable" },
    writer: { available: false, reason: "session-unestablished" },
  };
  const ok = await bridge.fetchDeviceControlAvailability(invokeReturning(valid));
  assert.deepEqual(ok, valid);
});

test("preflight normalizes snake_case reply keys to the camelCase contract", async () => {
  const reply = await bridge.previewDeviceControlEffect(
    {
      action: "nozzle",
      target: "device-test",
      payload: { nozzle: 210 },
      claimedProjectId: "project-test",
      revision: 4,
      artifact: "artifact-test",
      material: "pla",
    },
    invokeReturning(serializedPreflight()),
  );
  assert.equal(reply.status, "ready");
  assert.equal(reply.reason, null);
  assert.equal(reply.effect.device, "device-test");
  assert.equal(reply.effect.project, "project-test");
  assert.equal(reply.effect.snapshotCapturedAtMs, 1234567890);
  assert.equal("snapshot_captured_at_ms" in reply.effect, false);
  assert.equal(reply.draft.claimedProjectId, "project-test");
  assert.equal(reply.draft.revision, 4);
  assert.equal(reply.draft.artifact, "artifact-test");
  assert.equal(reply.draft.material, "pla");
});

test("preflight sends snake_case request keys to the backend", async () => {
  let sent = null;
  const reply = await bridge.previewDeviceControlEffect(
    {
      action: "nozzle",
      target: "device-test",
      payload: { nozzle: 210 },
      claimedProjectId: "project-test",
      revision: 4,
      material: "pla",
    },
    async (_command, args) => {
      sent = args;
      return serializedPreflight();
    },
  );
  assert.equal(reply.status, "ready");
  assert.deepEqual(sent.request, {
    action: "nozzle",
    target: "device-test",
    payload: { nozzle: 210 },
    claimed_project_id: "project-test",
    revision: 4,
    artifact: null,
    material: "pla",
  });
});

test("preflight discards unknown reply keys and refuses malformed shapes", async () => {
  const withSecret = { ...serializedPreflight(), session_token: "leaked-token" };
  const reply = await bridge.previewDeviceControlEffect(
    { action: "nozzle", target: "device-test", payload: { nozzle: 210 } },
    invokeReturning(withSecret),
  );
  assert.equal("session_token" in reply, false);
  assert.equal(reply.status, "ready");

  // Unknown status → malformed → unavailable, not a partial draft.
  const unknownStatus = await bridge.previewDeviceControlEffect(
    { action: "nozzle", target: "device-test", payload: { nozzle: 210 } },
    invokeReturning({ ...serializedPreflight(), status: "granted" }),
  );
  assert.deepEqual(unknownStatus, {
    status: "unavailable",
    action: null,
    target: null,
    effect: null,
    reason: "malformed-reply",
    draft: null,
  });

  // Non-object args → malformed.
  const badArgs = await bridge.previewDeviceControlEffect(
    { action: "nozzle", target: "device-test", payload: { nozzle: 210 } },
    invokeReturning({
      ...serializedPreflight(),
      effect: { ...serializedPreflight().effect, args: null },
    }),
  );
  assert.equal(badArgs.reason, "malformed-reply");

  // A non-ready status with an effect object is malformed.
  const nonReadyWithEffect = await bridge.previewDeviceControlEffect(
    { action: "nozzle", target: "device-test", payload: { nozzle: 210 } },
    invokeReturning({ ...serializedPreflight(), status: "invalid" }),
  );
  assert.equal(nonReadyWithEffect.reason, "malformed-reply");
});

test("invalid preflight status with a fixed reason string is preserved", async () => {
  const reply = await bridge.previewDeviceControlEffect(
    { action: "nozzle", target: "device-test", payload: { nozzle: 210 } },
    invokeReturning({
      status: "invalid",
      action: null,
      target: null,
      effect: null,
      reason: "revision-mismatch",
      draft: null,
    }),
  );
  assert.deepEqual(reply, {
    status: "invalid",
    action: null,
    target: null,
    effect: null,
    reason: "revision-mismatch",
    draft: null,
  });
});

test("a nonexistent writer can never make the UI ready", () => {
  const noWriter = {
    session: { established: true, reason: null },
    capability: { defined: true, reason: null },
    writer: { available: false, reason: "transport-unavailable" },
  };
  assert.equal(core.backendControlBootstrapUsable(noWriter), false);

  const allReady = {
    session: { established: true, reason: null },
    capability: { defined: true, reason: null },
    writer: { available: true, reason: null },
  };
  assert.equal(core.backendControlBootstrapUsable(allReady), true);

  // Production shape: session not established → never usable.
  assert.equal(
    core.backendControlBootstrapUsable({
      session: { established: false, reason: "session-unverified" },
      capability: { defined: false, reason: "resolver-unavailable" },
      writer: { available: false, reason: "session-unestablished" },
    }),
    false,
  );

  // Defensive: a malformed descriptor (missing writer) is never usable.
  assert.equal(
    core.backendControlBootstrapUsable({
      session: { established: true, reason: null },
      capability: { defined: true, reason: null },
    }),
    false,
  );
});
