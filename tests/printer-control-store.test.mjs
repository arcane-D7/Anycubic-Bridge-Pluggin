/**
 * S9.10-002 — printer control STORE tests (zustand, headless).
 *
 * The store is a thin glue over the pure core + the mock lane; under Node
 * zustand loads fine (no DOM access in this module). We exercise the FULL
 * sendControl path with a stub lane + a spy toast so the outcome mapping
 * (accepted → success; refused/timeout → distinct warnings; invalid → error)
 * is verified headless — this is the AC "no silent failures" contract.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadStore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-control.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}
const storePromise = loadStore();

const selectedPrinterId = "printer-test";
const initialCapturedAt = Date.now();
const selectedTarget = {
  printerId: selectedPrinterId,
  source: "cloud",
  snapshotCapturedAt: initialCapturedAt,
  capabilities: { tempature: true, fans: true, print: true, light: true, multiColorBox: true },
};

function providerStub(result, observed) {
  const currentContext = {
    target: selectedTarget,
    selectedPrinterId,
    currentCapturedAt: initialCapturedAt,
    capabilityKey: "tempature",
  };
  return {
    currentContext: () => currentContext,
    authorize: async () => ({ ok: true, reference: "synthetic-approval" }),
    execute: async () => {
      if (observed) {
        currentContext.currentCapturedAt = observed.capturedAt;
      }
      return { ...result, ...(observed ? { observed } : {}) };
    },
  };
}

function request(action, payload, provider) {
  const capabilityKey = {
    "temps.setNozzle": "tempature",
    "lights.setEnabled": "light",
    "speed.setMode": "print",
  }[action];
  const currentContext = provider.currentContext();
  return {
    action,
    payload,
    target: selectedTarget,
    selectedPrinterId,
    currentCapturedAt: initialCapturedAt,
    provider: {
      ...provider,
      currentContext: () => ({ ...currentContext, capabilityKey }),
    },
  };
}
function toastSpy() {
  const calls = [];
  return { calls, toast: (t) => calls.push(t) };
}
function i18nStub() {
  return (k, vars) => k + (vars ? `|${Object.values(vars).join(",")}` : "");
}

test("store: accepted → success toast + envelope recorded", async () => {
  const { usePrinterControl } = await storePromise;
  usePrinterControl.getState().reset();
  const spy = toastSpy();
  await usePrinterControl.getState().sendControl({
    ...request(
      "temps.setNozzle",
      { action: "temps.setNozzle", targetC: 220 },
      providerStub(
        { ok: true, command: "temperature_set" },
        {
          printerId: selectedPrinterId,
          capturedAt: initialCapturedAt + 1,
          temps: { nozzle: { targetC: 220 }, bed: { targetC: null } },
        },
      ),
    ),
    toast: spy.toast,
    t: i18nStub(),
  });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].kind, "success");
  assert.equal(spy.calls[0].title, "control.observed.title");
  const s = usePrinterControl.getState();
  assert.equal(s.busy, false);
  assert.equal(s.lastError, null);
  assert.deepEqual(s.lastEnvelope?.command, "temperature_set");
  assert.equal(s.lastOutcome?.kind, "observed");
  assert.equal(s.lastOutcome?.snapshotCapturedAt, initialCapturedAt + 1);
});

test("store: refused → warning toast (distinct from timeout)", async () => {
  const { usePrinterControl } = await storePromise;
  usePrinterControl.getState().reset();
  const spy = toastSpy();
  await usePrinterControl.getState().sendControl({
    ...request(
      "lights.setEnabled",
      { action: "lights.setEnabled", enabled: true },
      providerStub({ ok: false, kind: "refused", error: "printer refused light_control" }),
    ),
    toast: spy.toast,
    t: i18nStub(),
  });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].kind, "warning");
  assert.equal(spy.calls[0].title, "control.refused.title");
  assert.match(spy.calls[0].message ?? "", /printer refused light_control/);
});

test("store: timeout → warning toast (distinct text from refused)", async () => {
  const { usePrinterControl } = await storePromise;
  usePrinterControl.getState().reset();
  const spy = toastSpy();
  await usePrinterControl.getState().sendControl({
    ...request(
      "speed.setMode",
      { action: "speed.setMode", mode: "sport" },
      providerStub({ ok: false, kind: "timeout", error: "no reply from printer-test" }),
    ),
    toast: spy.toast,
    t: i18nStub(),
  });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].kind, "warning");
  assert.equal(spy.calls[0].title, "control.timeout.title");
  assert.match(spy.calls[0].message ?? "", /no reply/);
});

test("store: invalid envelope → error toast, lane NEVER called", async () => {
  const { usePrinterControl } = await storePromise;
  usePrinterControl.getState().reset();
  const spy = toastSpy();
  let laneCalled = false;
  const provider = providerStub({ ok: true, command: "temperature_set" });
  const guardedProvider = {
    ...provider,
    authorize: async (...args) => {
      laneCalled = true;
      return provider.authorize(...args);
    },
    execute: async (...args) => {
      laneCalled = true;
      return provider.execute(...args);
    },
  };
  await usePrinterControl.getState().sendControl({
    ...request(
      "temps.setNozzle",
      // Out of the schema window — the core refuses, so nothing reaches the lane.
      { action: "temps.setNozzle", targetC: 500 },
      guardedProvider,
    ),
    toast: spy.toast,
    t: i18nStub(),
  });
  assert.equal(laneCalled, false);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].kind, "error");
  assert.equal(spy.calls[0].title, "control.invalid.title");
  assert.match(spy.calls[0].message ?? "", /outside/);
});
