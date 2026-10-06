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

/** Tiny stub with the same shape the view uses. */
function laneStub(result) {
  return { printerControl: async () => result };
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
    action: "temps.setNozzle",
    payload: { action: "temps.setNozzle", targetC: 220 },
    printerId: "printer-1",
    lane: laneStub({ ok: true, command: "temperature_set" }),
    toast: spy.toast,
    t: i18nStub(),
  });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].kind, "success");
  assert.equal(spy.calls[0].title, "control.accepted.title");
  const s = usePrinterControl.getState();
  assert.equal(s.busy, false);
  assert.equal(s.lastError, null);
  assert.deepEqual(s.lastEnvelope?.command, "temperature_set");
});

test("store: refused → warning toast (distinct from timeout)", async () => {
  const { usePrinterControl } = await storePromise;
  usePrinterControl.getState().reset();
  const spy = toastSpy();
  await usePrinterControl.getState().sendControl({
    action: "lights.setEnabled",
    payload: { action: "lights.setEnabled", enabled: true },
    printerId: "printer-1",
    lane: laneStub({ ok: false, kind: "refused", error: "printer refused light_control" }),
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
    action: "speed.setMode",
    payload: { action: "speed.setMode", mode: "sport" },
    printerId: "printer-1",
    lane: laneStub({ ok: false, kind: "timeout", error: "no reply from printer-1" }),
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
  const lane = { printerControl: async () => ((laneCalled = true), { ok: true }) };
  await usePrinterControl.getState().sendControl({
    action: "temps.setNozzle",
    // Out of the schema window — the core refuses, so nothing reaches the lane.
    payload: { action: "temps.setNozzle", targetC: 500 },
    printerId: "printer-1",
    lane,
    toast: spy.toast,
    t: i18nStub(),
  });
  assert.equal(laneCalled, false);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].kind, "error");
  assert.equal(spy.calls[0].title, "control.invalid.title");
  assert.match(spy.calls[0].message ?? "", /outside/);
});
