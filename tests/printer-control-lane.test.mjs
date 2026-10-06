/**
 * S9.10-002 — printer control LANE tests (mock bridge, deterministic seams).
 *
 * Exercises the mock `printerControl` lane end-to-end WITHOUT network: the
 * envelope is built through the pure core, then submitted to the lane, with
 * refused/timeout seams driving the distinct failure kinds. The React toast
 * mapping (accepted → success, refused/timeout → distinct warnings) is
 * exercised at the store/view layer, not here.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadMock() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}
async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "state", "printer-control-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const mockPromise = loadMock();
const corePromise = loadCore();

/* ------------------------------------------------------------------ */
/* Lane: accepted path                                                 */
/* ------------------------------------------------------------------ */

test("lane: valid envelope accepted with confirm true and command echo", async () => {
  const [{ fetchSceneSnapshot }, { buildCommandEnvelope }] = await Promise.all([
    mockPromise,
    corePromise,
  ]);
  const handle = await fetchSceneSnapshot();
  const envelope = buildCommandEnvelope({ action: "temps.setNozzle", targetC: 220 });
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  const res = await handle.printerControl({ printerId: "printer-1", envelope: envelope.envelope });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.command, "temperature_set");
});

test("lane: ACE dryer envelope accepted over the lane", async () => {
  const [{ fetchSceneSnapshot }, { buildCommandEnvelope }] = await Promise.all([
    mockPromise,
    corePromise,
  ]);
  const handle = await fetchSceneSnapshot();
  const envelope = buildCommandEnvelope({ action: "ace.dry", boxId: 1, active: true });
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  const res = await handle.printerControl({ printerId: "printer-1", envelope: envelope.envelope });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.command, "ace_dry");
});

test("lane: confirm missing → invalid (never accepted)", async () => {
  const { fetchSceneSnapshot } = await mockPromise;
  const handle = await fetchSceneSnapshot();
  // Deliberately stripped confirm flag — a programming error case.
  const res = await handle.printerControl({
    printerId: "printer-1",
    envelope: { command: "light_control", args: { on: true }, confirm: false },
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.kind, "invalid");
    assert.match(res.error, /confirm:true/);
  }
});

/* ------------------------------------------------------------------ */
/* Lane: refused / timeout paths (seams)                               */
/* ------------------------------------------------------------------ */

test("lane: refused surface is distinct from timeout", async () => {
  const [
    { fetchSceneSnapshot, setMockControlResults, setMockControlRefused, setMockControlTimeout },
    { buildCommandEnvelope },
  ] = await Promise.all([mockPromise, corePromise]);
  setMockControlRefused(true);
  const handle = await fetchSceneSnapshot();
  const envelope = buildCommandEnvelope({ action: "lights.setEnabled", enabled: true });
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  const refused = await handle.printerControl({
    printerId: "printer-1",
    envelope: envelope.envelope,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.kind, "refused");
    assert.match(refused.error, /refused/);
  }
  setMockControlRefused(false);
  setMockControlTimeout(true);
  const timeout = await handle.printerControl({
    printerId: "printer-1",
    envelope: envelope.envelope,
  });
  assert.equal(timeout.ok, false);
  if (!timeout.ok) {
    assert.equal(timeout.kind, "timeout");
    assert.match(timeout.error, /no reply/);
  }
  setMockControlTimeout(false);
});

test("lane: per-printer forced failure map (printer-scoped seams)", async () => {
  const [{ fetchSceneSnapshot, setMockControlResults }] = await Promise.all([mockPromise]);
  setMockControlResults(
    new Map([["printer-bad", { kind: "timeout", error: "no reply from printer-bad" }]]),
  );
  const handle = await fetchSceneSnapshot();
  const bad = await handle.printerControl({
    printerId: "printer-bad",
    envelope: { command: "fan_set", args: { fan: "part", speed_pct: 50 }, confirm: true },
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.kind, "timeout");
  // Another printer (no seam) still accepts.
  const good = await handle.printerControl({
    printerId: "printer-2",
    envelope: { command: "fan_set", args: { fan: "part", speed_pct: 50 }, confirm: true },
  });
  assert.equal(good.ok, true);
  setMockControlResults(new Map());
});
