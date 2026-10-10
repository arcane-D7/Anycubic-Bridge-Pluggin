/**
 * S9.10-002 — control envelope core unit tests (no network).
 *
 * Pure command-grammar checks: window bounds, bus command names, confirm
 * flags, capability-surface policy join. The mock bridge lane tests (the
 * accept/refuse/timeout paths) live with the lane, not here — this suite
 * never touches a network.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-control-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}
const corePromise = loadCore();

/* ------------------------------------------------------------------ */
/* Envelope grammar                                                     */
/* ------------------------------------------------------------------ */

test("envelope: nozzle target maps to temperature_set with confirm true", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const r = buildCommandEnvelope({ action: "temps.setNozzle", targetC: 220 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.envelope.command, "temperature_set");
  assert.equal(r.envelope.args.nozzle, 220);
  assert.equal(r.envelope.confirm, true);
});

test("observed control outcome requires the matching printer snapshot value", async () => {
  const { controlEffectObserved } = await corePromise;
  const envelope = {
    command: "temperature_set",
    args: { nozzle: 200 },
    confirm: true,
  };
  const snapshot = {
    printerId: "printer-test",
    capturedAt: 12,
    temps: { nozzle: { targetC: 200 }, bed: { targetC: null } },
  };
  assert.equal(
    controlEffectObserved(envelope, snapshot, { printerId: "printer-test" }, 10, 12),
    true,
  );
  assert.equal(
    controlEffectObserved(
      envelope,
      { ...snapshot, temps: { ...snapshot.temps, nozzle: { targetC: 199 } } },
      { printerId: "printer-test" },
      10,
      12,
    ),
    false,
  );
  assert.equal(
    controlEffectObserved(envelope, undefined, { printerId: "printer-test" }, 10, 12),
    false,
  );
});

test("observation requires every requested field and compares speed modes by name", async () => {
  const { controlEffectObserved } = await corePromise;
  const snapshot = {
    printerId: "printer-test",
    capturedAt: 12,
    temps: { nozzle: { targetC: 200 }, bed: { targetC: 60 } },
    lights: { enabled: true, brightnessPct: 80 },
    print: { speedMode: "sport" },
  };
  assert.equal(
    controlEffectObserved(
      { command: "temperature_set", args: { nozzle: 200, bed: 60 }, confirm: true },
      snapshot,
      { printerId: "printer-test" },
      10,
      12,
    ),
    true,
  );
  assert.equal(
    controlEffectObserved(
      { command: "temperature_set", args: { nozzle: 200, bed: 70 }, confirm: true },
      snapshot,
      { printerId: "printer-test" },
      10,
      12,
    ),
    false,
  );
  assert.equal(
    controlEffectObserved(
      { command: "light_control", args: { on: false, brightness: 80 }, confirm: true },
      snapshot,
      { printerId: "printer-test" },
      10,
      12,
    ),
    false,
  );
  assert.equal(
    controlEffectObserved(
      { command: "print_update", args: { print_speed_mode: 3 }, confirm: true },
      snapshot,
      { printerId: "printer-test" },
      10,
      12,
    ),
    true,
  );
});

test("observed control requires a complete command match", async () => {
  const { controlEffectObserved } = await corePromise;
  const snapshot = {
    printerId: "printer-test",
    capturedAt: 12,
    temps: { nozzle: { targetC: 200 }, bed: { targetC: 60 } },
  };
  assert.equal(
    controlEffectObserved(
      { command: "temperature_set", args: { nozzle: 200 }, confirm: true },
      snapshot,
      { printerId: "printer-test" },
      10,
      12,
    ),
    true,
  );
  assert.equal(
    controlEffectObserved(
      { command: "temperature_set", args: { nozzle: 200, bed: undefined }, confirm: true },
      snapshot,
      { printerId: "printer-test" },
      10,
      12,
    ),
    false,
  );
});

test("provider executor requires authorization reference and executes exactly once", async () => {
  const { executeControl } = await corePromise;
  const request = {
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { tempature: true },
    },
    envelope: {
      command: "temperature_set",
      args: { nozzle: 200 },
      confirm: true,
    },
  };
  let executions = 0;
  const denied = await executeControl(
    {
      currentContext: () => ({
        target: request.target,
        selectedPrinterId: "printer-test",
        currentCapturedAt: request.target.snapshotCapturedAt,
        capabilityKey: "tempature",
      }),
      authorize: async () => ({ ok: false, reason: "approval unavailable" }),
      execute: async () => {
        executions += 1;
        return { ok: true, command: "temperature_set" };
      },
    },
    request,
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.kind, "unavailable");
  assert.equal(executions, 0);

  const accepted = await executeControl(
    {
      currentContext: () => ({
        target: request.target,
        selectedPrinterId: "printer-test",
        currentCapturedAt: request.target.snapshotCapturedAt,
        capabilityKey: "tempature",
      }),
      authorize: async () => ({ ok: true, reference: "opaque-approval" }),
      execute: async (_request, reference) => {
        executions += 1;
        assert.equal(reference, "opaque-approval");
        return { ok: true, command: "temperature_set", reference };
      },
    },
    request,
  );
  assert.equal(accepted.ok, true);
  assert.equal(executions, 1);
});

test("provider executor revalidates the live target after authorization", async () => {
  const { executeControl } = await corePromise;
  let selectedPrinterId = "printer-test";
  let executions = 0;
  const request = {
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { tempature: true },
    },
    envelope: { command: "temperature_set", args: { nozzle: 200 }, confirm: true },
  };
  const result = await executeControl(
    {
      currentContext: () => ({
        target: request.target,
        selectedPrinterId,
        currentCapturedAt: 10,
        capabilityKey: "tempature",
      }),
      authorize: async () => {
        selectedPrinterId = "printer-other";
        return { ok: true, reference: "opaque-approval" };
      },
      execute: async () => {
        executions += 1;
        return { ok: true, command: "temperature_set" };
      },
    },
    request,
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
  assert.equal(executions, 0);
});

test("provider executor revalidates live capability and target binding after authorization", async () => {
  const { executeControl } = await corePromise;
  const request = {
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { tempature: true, fans: true },
    },
    envelope: { command: "temperature_set", args: { nozzle: 200 }, confirm: true },
  };
  for (const context of [
    {
      target: request.target,
      selectedPrinterId: "printer-other",
      currentCapturedAt: request.target.snapshotCapturedAt,
      capabilityKey: "tempature",
    },
    {
      target: request.target,
      selectedPrinterId: "printer-test",
      currentCapturedAt: request.target.snapshotCapturedAt,
      capabilityKey: "fans",
    },
    {
      target: { ...request.target, source: "cloud" },
      selectedPrinterId: "printer-test",
      currentCapturedAt: request.target.snapshotCapturedAt,
      capabilityKey: "tempature",
    },
    {
      target: { ...request.target, capabilities: { tempature: false, fans: true } },
      selectedPrinterId: "printer-test",
      currentCapturedAt: request.target.snapshotCapturedAt,
      capabilityKey: "tempature",
    },
    {
      target: { ...request.target, snapshotCapturedAt: request.target.snapshotCapturedAt + 1 },
      selectedPrinterId: "printer-test",
      currentCapturedAt: request.target.snapshotCapturedAt,
      capabilityKey: "tempature",
    },
    {
      target: request.target,
      selectedPrinterId: "printer-test",
      currentCapturedAt: Date.now() - 60_001,
      capabilityKey: "tempature",
    },
    {
      target: { ...request.target, snapshotCapturedAt: Date.now() + 60_000 },
      selectedPrinterId: "printer-test",
      currentCapturedAt: Date.now() + 60_000,
      capabilityKey: "tempature",
    },
  ]) {
    let executions = 0;
    const result = await executeControl(
      {
        currentContext: () => context,
        authorize: async () => ({ ok: true, reference: "opaque-approval" }),
        execute: async () => {
          executions += 1;
          return { ok: true, command: "temperature_set" };
        },
      },
      request,
    );
    assert.equal(result.ok, false);
    assert.equal(executions, 0);
  }
  let executions = 0;
  const current = await executeControl(
    {
      currentContext: () => ({
        target: request.target,
        selectedPrinterId: "printer-test",
        currentCapturedAt: request.target.snapshotCapturedAt,
        capabilityKey: "tempature",
      }),
      authorize: async () => ({ ok: true, reference: "opaque-approval" }),
      execute: async () => {
        executions += 1;
        return { ok: true, command: "temperature_set" };
      },
    },
    request,
  );
  assert.equal(current.ok, true);
  assert.equal(executions, 1);
});

test("provider executor refuses dispatch when snapshot capture changes after authorization", async () => {
  const { executeControl } = await corePromise;
  const request = {
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { tempature: true },
    },
    envelope: { command: "temperature_set", args: { nozzle: 200 }, confirm: true },
  };
  let executions = 0;
  const result = await executeControl(
    {
      currentContext: () => ({
        target: { ...request.target, snapshotCapturedAt: request.target.snapshotCapturedAt + 1 },
        selectedPrinterId: "printer-test",
        currentCapturedAt: request.target.snapshotCapturedAt + 1,
        capabilityKey: "tempature",
      }),
      authorize: async () => ({ ok: true, reference: "opaque-approval" }),
      execute: async () => {
        executions += 1;
        return { ok: true, command: "temperature_set" };
      },
    },
    request,
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
  assert.equal(executions, 0);
});

test("provider executor dispatches a frozen copy of the authorized request", async () => {
  const { executeControl } = await corePromise;
  const request = {
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { test: true, light: true },
    },
    envelope: { command: "light_control", args: { on: true }, confirm: true },
  };
  let dispatched;
  const result = await executeControl(
    {
      currentContext: () => ({
        target: request.target,
        selectedPrinterId: "printer-test",
        currentCapturedAt: request.target.snapshotCapturedAt,
        capabilityKey: "light",
      }),
      authorize: async (authorized) => {
        assert.equal(Object.isFrozen(authorized.envelope.args), true);
        assert.throws(() => {
          authorized.envelope.args.on = false;
        }, TypeError);
        return { ok: true, reference: "opaque-approval" };
      },
      execute: async (actual) => {
        dispatched = actual;
        return { ok: true, command: "light_control" };
      },
    },
    request,
  );
  assert.equal(result.ok, true);
  assert.equal(dispatched.envelope.args.on, true);
  assert.equal(Object.isFrozen(dispatched.envelope.args), true);
});

test("store rejects overlapping sends without releasing the active busy lock", async () => {
  const moduleUrl = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-control.ts"),
  );
  const { usePrinterControl } = await import(`${moduleUrl.href}?key=${Date.now()}`);
  usePrinterControl.getState().reset();
  let releaseAuthorization;
  let authorizations = 0;
  let executions = 0;
  const provider = {
    currentContext: () => ({
      target: req.target,
      selectedPrinterId: "printer-test",
      currentCapturedAt: req.target.snapshotCapturedAt,
      capabilityKey: "tempature",
    }),
    authorize: () => {
      authorizations += 1;
      return new Promise((resolve) => {
        releaseAuthorization = () => resolve({ ok: true, reference: "opaque-approval" });
      });
    },
    execute: async () => {
      executions += 1;
      return { ok: true, command: "temperature_set" };
    },
  };
  const req = {
    action: "temps.setNozzle",
    payload: { action: "temps.setNozzle", targetC: 200 },
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { tempature: true },
    },
    selectedPrinterId: "printer-test",
    currentCapturedAt: Date.now(),
    provider,
    toast() {},
    t: (key) => key,
  };
  const first = usePrinterControl.getState().sendControl(req);
  assert.equal(usePrinterControl.getState().busy, true);
  await usePrinterControl.getState().sendControl(req);
  assert.equal(authorizations, 1);
  assert.equal(usePrinterControl.getState().busy, true);
  releaseAuthorization();
  await first;
  assert.equal(executions, 1);
  assert.equal(usePrinterControl.getState().busy, false);
  usePrinterControl.getState().reset();
});

test("store keeps accepted, observed, unavailable, invalid, timeout, and indeterminate outcomes distinct", async () => {
  const moduleUrl = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-control.ts"),
  );
  const { usePrinterControl, initialControlState } = await import(
    `${moduleUrl.href}?outcomes=${Date.now()}`
  );
  const request = {
    action: "temps.setNozzle",
    payload: { action: "temps.setNozzle", targetC: 200 },
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { tempature: true, temperature: true },
    },
    selectedPrinterId: "printer-test",
    currentCapturedAt: Date.now(),
    toast: (toast) => toasts.push(toast),
    t: (key) => key,
  };
  const toasts = [];
  const baseProvider = {
    currentContext: () => ({
      target: request.target,
      selectedPrinterId: "printer-test",
      currentCapturedAt: request.target.snapshotCapturedAt,
      capabilityKey: "tempature",
    }),
    authorize: async () => ({ ok: true, reference: "opaque-approval" }),
  };
  const sendResult = async (result) => {
    usePrinterControl.getState().reset();
    await usePrinterControl
      .getState()
      .sendControl({ ...request, provider: { ...baseProvider, execute: async () => result } });
    return usePrinterControl.getState().lastOutcome;
  };

  assert.equal((await sendResult({ ok: true, command: "temperature_set" })).kind, "accepted");
  assert.equal(toasts.at(-1).kind, "info");
  assert.equal(toasts.at(-1).title, "control.accepted.title");

  usePrinterControl.getState().reset();
  await usePrinterControl.getState().sendControl({
    ...request,
    observationMatcher: () => true,
    provider: {
      ...baseProvider,
      execute: async () => ({
        ok: true,
        kind: "observed",
        command: "temperature_set",
        observed: {
          printerId: "printer-test",
          capturedAt: 12,
          temps: { nozzle: { targetC: 200 } },
        },
      }),
    },
  });
  assert.equal(usePrinterControl.getState().lastOutcome.kind, "observed");
  assert.equal(toasts.at(-1).kind, "success");
  assert.equal(toasts.at(-1).title, "control.observed.title");

  for (const kind of ["unavailable", "invalid", "timeout", "indeterminate"]) {
    const outcome = await sendResult({ ok: false, kind, error: "controlled test reason" });
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.reason, "controlled test reason");
  }
  assert.equal(toasts.at(-4).title, "control.unavailable.title");
  assert.equal(toasts.at(-3).title, "control.invalid.title");
  assert.equal(toasts.at(-2).title, "control.timeout.title");
  assert.equal(toasts.at(-1).title, "control.indeterminate.title");
  assert.equal(toasts.at(-1).message, "control.indeterminate.message");
  assert.deepEqual(initialControlState().lastOutcome, null);
  usePrinterControl.getState().reset();
  assert.equal(usePrinterControl.getState().lastOutcome, null);
});

test("provider executor rejects missing reference and classifies post-dispatch throw indeterminate", async () => {
  const { executeControl } = await corePromise;
  const request = {
    target: {
      printerId: "printer-test",
      source: "lan",
      snapshotCapturedAt: Date.now(),
      capabilities: { light: true },
    },
    envelope: { command: "light_control", args: { on: true }, confirm: true },
  };
  let executions = 0;
  const noReference = await executeControl(
    {
      currentContext: () => ({
        target: request.target,
        selectedPrinterId: "printer-test",
        currentCapturedAt: request.target.snapshotCapturedAt,
        capabilityKey: "light",
      }),
      authorize: async () => ({ ok: true, reference: " " }),
      execute: async () => {
        executions += 1;
        return { ok: true, command: "light_control" };
      },
    },
    request,
  );
  assert.equal(noReference.ok, false);
  assert.equal(noReference.kind, "invalid");
  assert.equal(executions, 0);

  const ambiguous = await executeControl(
    {
      currentContext: () => ({
        target: request.target,
        selectedPrinterId: "printer-test",
        currentCapturedAt: request.target.snapshotCapturedAt,
        capabilityKey: "light",
      }),
      authorize: async () => ({ ok: true, reference: "opaque-approval" }),
      execute: async () => {
        executions += 1;
        throw new Error("connection lost after dispatch");
      },
    },
    request,
  );
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.kind, "indeterminate");
  assert.equal(executions, 1);
});

test("envelope: bed target maps to temperature_set with confirm true", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const r = buildCommandEnvelope({ action: "temps.setBed", targetC: 60 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.envelope.command, "temperature_set");
  assert.equal(r.envelope.args.bed, 60);
  assert.equal(r.envelope.confirm, true);
});

test("envelope: part fan maps to fan_set with fan=part + speed_pct", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const r = buildCommandEnvelope({ action: "fans.setPart", speedPct: 55 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.envelope.command, "fan_set");
  assert.equal(r.envelope.args.fan, "part");
  assert.equal(r.envelope.args.speed_pct, 55);
  assert.equal(r.envelope.confirm, true);
});

test("envelope: speed mode maps to print_update print_speed_mode number", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const silent = buildCommandEnvelope({ action: "speed.setMode", mode: "silent" });
  const sport = buildCommandEnvelope({ action: "speed.setMode", mode: "sport" });
  assert.equal(silent.ok, true);
  if (!silent.ok) return;
  assert.equal(silent.envelope.command, "print_update");
  assert.equal(silent.envelope.args.print_speed_mode, 1);
  assert.equal(sport.ok, true);
  if (!sport.ok) return;
  assert.equal(sport.envelope.args.print_speed_mode, 3);
});

test("envelope: lights toggle maps to light_control on field", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const on = buildCommandEnvelope({ action: "lights.setEnabled", enabled: true });
  const off = buildCommandEnvelope({ action: "lights.setEnabled", enabled: false });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.envelope.command, "light_control");
  assert.equal(on.envelope.args.on, true);
  assert.equal(off.ok, true);
  if (!off.ok) return;
  assert.equal(off.envelope.args.on, false);
});

test("envelope: brightness maps to light_control with on + brightness", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const r = buildCommandEnvelope({ action: "lights.setBrightness", brightnessPct: 80 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.envelope.command, "light_control");
  assert.equal(r.envelope.args.on, true);
  assert.equal(r.envelope.args.brightness, 80);
});

/* ------------------------------------------------------------------ */
/* S9.10-003 — ACE writes (dryer, auto-feed, slot bind)                */
/* ------------------------------------------------------------------ */

test("envelope: dryer start maps to ace_dry flat stop=false with defaults", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const r = buildCommandEnvelope({ action: "ace.dry", boxId: 1, active: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.envelope.command, "ace_dry");
  assert.equal(r.envelope.confirm, true);
  assert.equal(r.envelope.args.box_id, 1);
  assert.equal(r.envelope.args.stop, false);
  assert.equal(r.envelope.args.target_temp, 45);
  assert.equal(r.envelope.args.duration_min, 240);
  assert.equal(r.envelope.args.remain_time, 0);
});

test("envelope: dryer stop maps to ace_dry stop=true (overrides targets)", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const r = buildCommandEnvelope({
    action: "ace.dry",
    boxId: 0,
    active: false,
    targetC: 99,
    durationMin: 999,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.envelope.command, "ace_dry");
  assert.equal(r.envelope.args.stop, true);
  // Stop is a state clear — the target/duration fields are not validated.
  assert.equal(r.envelope.args.target_temp, 99);
  assert.equal(r.envelope.args.duration_min, 999);
});

test("envelope: dryer active requires target/duration inside the schema window", async () => {
  const { buildCommandEnvelope } = await corePromise;
  assert.equal(
    buildCommandEnvelope({ action: "ace.dry", boxId: 0, active: true, targetC: 81 }).ok,
    false,
  );
  assert.equal(
    buildCommandEnvelope({ action: "ace.dry", boxId: 0, active: true, targetC: -1 }).ok,
    false,
  );
  assert.equal(
    buildCommandEnvelope({ action: "ace.dry", boxId: 0, active: true, durationMin: 1441 }).ok,
    false,
  );
});

test("envelope: auto-feed maps to ace_auto_feed with enabled 1/0", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const on = buildCommandEnvelope({ action: "ace.autoFeed", boxId: 2, enabled: true });
  const off = buildCommandEnvelope({ action: "ace.autoFeed", boxId: 2, enabled: false });
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.envelope.command, "ace_auto_feed");
  assert.equal(on.envelope.args.box_id, 2);
  assert.equal(on.envelope.args.enabled, true);
  assert.equal(off.ok, true);
  if (!off.ok) return;
  assert.equal(off.envelope.args.enabled, false);
});

test("envelope: slot bind maps to ace_set_slot with color triple", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const r = buildCommandEnvelope({
    action: "ace.bindSlot",
    boxId: 0,
    slotIndex: 3,
    material: "PLA",
    colorHex: "#4fa8dc",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.envelope.command, "ace_set_slot");
  assert.equal(r.envelope.confirm, true);
  assert.equal(r.envelope.args.box_id, 0);
  assert.equal(r.envelope.args.slot_index, 3);
  assert.equal(r.envelope.args.material_type, "PLA");
  // #4fa8dc → [79,168,220]
  assert.deepEqual(r.envelope.args.color, [79, 168, 220]);
});

test("envelope: slot bind refuses bad color/missing material/box window", async () => {
  const { buildCommandEnvelope } = await corePromise;
  assert.equal(
    buildCommandEnvelope({
      action: "ace.bindSlot",
      boxId: 0,
      slotIndex: 1,
      material: "PLA",
      colorHex: "not-a-color", // invalid hex
    }).ok,
    false,
  );
  assert.equal(
    buildCommandEnvelope({
      action: "ace.bindSlot",
      boxId: 0,
      slotIndex: 1,
      material: "",
      colorHex: "#4fa8dc",
    }).ok,
    false,
  );
  assert.equal(
    buildCommandEnvelope({
      action: "ace.bindSlot",
      boxId: 10,
      slotIndex: 1,
      material: "PLA",
      colorHex: "#4fa8dc",
    }).ok,
    false,
  );
});

test("envelope: ACE writes reject out-of-window box id", async () => {
  const { buildCommandEnvelope } = await corePromise;
  assert.equal(buildCommandEnvelope({ action: "ace.dry", boxId: 10, active: true }).ok, false);
  assert.equal(
    buildCommandEnvelope({ action: "ace.autoFeed", boxId: -1, enabled: true }).ok,
    false,
  );
});

/* ------------------------------------------------------------------ */
/* Window bounds / refusals                                            */
/* ------------------------------------------------------------------ */

test("envelope: out-of-range nozzle/bed targets refuse (ok:false + reason)", async () => {
  const { buildCommandEnvelope } = await corePromise;
  assert.equal(buildCommandEnvelope({ action: "temps.setNozzle", targetC: 400 }).ok, false);
  assert.equal(buildCommandEnvelope({ action: "temps.setNozzle", targetC: -5 }).ok, false);
  assert.equal(buildCommandEnvelope({ action: "temps.setBed", targetC: 300 }).ok, false);
  assert.equal(buildCommandEnvelope({ action: "temps.setBed", targetC: -1 }).ok, false);
});

test("envelope: out-of-range fan / brightness refuse", async () => {
  const { buildCommandEnvelope } = await corePromise;
  assert.equal(buildCommandEnvelope({ action: "fans.setPart", speedPct: 150 }).ok, false);
  assert.equal(buildCommandEnvelope({ action: "fans.setPart", speedPct: -10 }).ok, false);
  assert.equal(
    buildCommandEnvelope({ action: "lights.setBrightness", brightnessPct: 101 }).ok,
    false,
  );
});

test("envelope: raw actions are not buildable (DevTools-only path)", async () => {
  const { buildCommandEnvelope } = await corePromise;
  // raw.command lives in the capability surface but is NOT a grammar action —
  // the core refuses to build it for either actor.
  const raw = buildCommandEnvelope({ action: "raw.command", targetC: 220 });
  assert.equal(raw.ok, false);
  if (!raw.ok) assert.match(raw.reason, /raw actions are not buildable/);
});

test("envelope: agent actor blocked from raw + allowed on standard writes", async () => {
  const { buildCommandEnvelope } = await corePromise;
  const raw = buildCommandEnvelope({ action: "raw.command", targetC: 220 }, "agent");
  assert.equal(raw.ok, false);
  const write = buildCommandEnvelope({ action: "temps.setNozzle", targetC: 220 }, "agent");
  assert.equal(write.ok, true);
});
