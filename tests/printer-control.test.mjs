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
