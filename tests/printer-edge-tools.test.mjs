import { test } from "node:test";
import assert from "node:assert/strict";
import z from "zod";

import {
  EDGE_ORDER_IDS,
  decodeTagRecord,
  spoolRegistry,
  diffSnapshots,
  snapshotSignature,
  collectEventWatch,
  renamePrinter,
  checkFirmwareUpdate,
  executeEdgeCommand,
} from "../scripts/printer-edge-tools.mjs";
import { CloudConnectionManager } from "../scripts/printer-command-bus.mjs";
import { registerEdgeTools } from "../scripts/printer-edge-tools.mjs";

// --- offline helpers ---------------------------------------------------------

function fakeManager(cloud = {}) {
  return new CloudConnectionManager({ cloud });
}

function fakeCloud(router) {
  return {
    xxToken: "tok",
    async rawApi(method, endpoint, { params, query } = {}) {
      const handler = router[`${method} ${endpoint}`];
      if (!handler)
        throw Object.assign(new Error(`no mock for ${method} ${endpoint}`), { status: 404 });
      return handler({ params, query });
    },
    async listPrinters() {
      return [{ id: 688972, machine_type: "20025", key: "abc" }];
    },
  };
}

function fakeMqttClient() {
  return {
    disconnected: false,
    disconnecting: false,
    endAsync: async () => {},
    on: () => {},
    publish: (_topic, payload, cb) => cb(null),
  };
}

// --- EDGE_ORDER_IDS ----------------------------------------------------------

test("edge order ids match the reference vocabulary", () => {
  assert.equal(EDGE_ORDER_IDS.STOP_PRINT, 4);
  assert.equal(EDGE_ORDER_IDS.STOP_PRINT_FORCE, 44);
  assert.equal(EDGE_ORDER_IDS.SET_PRINT_STATUS_FREE, 901);
  assert.equal(EDGE_ORDER_IDS.FEED_FILAMENT_FINISH, 1209);
  assert.equal(EDGE_ORDER_IDS.MULTI_COLOR_BOX_REFRESH_SLOT, 1210);
});

// --- rename ------------------------------------------------------------------

test("renamePrinter calls the cloud edit endpoint with the new name", async () => {
  const seen = [];
  const cloud = fakeCloud({
    "POST /work/printer/edit": ({ params }) => {
      seen.push(params);
      return { code: 1, data: {} };
    },
  });
  const res = await renamePrinter(cloud, { printerId: 688972, newName: "Kobra-S1-Test" });
  assert.equal(res.printer_id, 688972);
  assert.equal(res.requested_name, "Kobra-S1-Test");
  assert.equal(seen[0].id, 688972);
  assert.equal(seen[0].name, "Kobra-S1-Test");
});

test("renamePrinter refuses empty names", async () => {
  const cloud = fakeCloud({});
  await assert.rejects(() => renamePrinter(cloud, { newName: "   " }), /newName is required/);
});

// --- OTA check ---------------------------------------------------------------

test("checkFirmwareUpdate maps current/latest and detects update availability", async () => {
  const cloud = fakeCloud({
    "GET /work/printer/getPrinterUpdateVersion": () => ({
      code: 1,
      data: { current_version: "2.7.2.7", latest_version: "2.8.0.0" },
    }),
  });
  const res = await checkFirmwareUpdate(cloud, { printerId: 688972 });
  assert.equal(res.read_only, true);
  assert.equal(res.ota.current, "2.7.2.7");
  assert.equal(res.ota.latest, "2.8.0.0");
  assert.equal(res.ota.has_update, true);
});

test("checkFirmwareUpdate degrades gracefully when the endpoint is unavailable", async () => {
  const cloud = fakeCloud({});
  const res = await checkFirmwareUpdate(cloud, { printerId: 688972 });
  assert.equal(res.ota.state, "unavailable");
});

// --- event watch (N14) -------------------------------------------------------

function statusPayload(overrides = {}) {
  return {
    code: 1,
    data: [
      {
        id: 688972,
        print_count: 67,
        material_used: "2.97kg",
        print_totaltime: "129hour35min",
        parameter: { curr_nozzle_temp: 34, curr_hotbed_temp: 31 },
        multi_color_box: [
          {
            id: 0,
            drying_status: { status: 0 },
            slots: [{ index: 0, status: 5, consumables_percent: 13 }],
          },
        ],
        ...overrides,
      },
    ],
  };
}

test("diffSnapshots reports state/temp/lifetime changes as events", () => {
  const a = snapshotSignature({
    selected: {
      current: { nozzle_temp_c: 34 },
      lifetime: { print_count: 67 },
      project: { state: "printing" },
      multi_color_box: [],
    },
  });
  const b = snapshotSignature({
    selected: {
      current: { nozzle_temp_c: 41 },
      lifetime: { print_count: 67 },
      project: { state: "printing" },
      multi_color_box: [],
    },
  });
  const diff = diffSnapshots(a, b);
  assert.equal(diff.changed, true);
  assert.ok(diff.events.some((e) => e.type === "nozzle" && e.from === 34 && e.to === 41));
});

test("collectEventWatch returns first_snapshot then delta (state change)", async () => {
  const router = { "GET /work/printer/printersStatus": () => statusPayload() };
  const cloud = fakeCloud(router);
  // collectEventWatch also calls /work/printer/getPrinters first
  router["GET /work/printer/getPrinters"] = () => ({ code: 1, data: [] });
  const first = await collectEventWatch(cloud, { printerId: 688972 });
  assert.equal(first.since, "first");
  assert.ok(first.events.some((e) => e.type === "first_snapshot"));
  // same sample again -> no events: the module baseline for this printer id
  // was already stored by the first call
  const smartCloud = fakeCloud(router);
  const second = await collectEventWatch(smartCloud, { printerId: 688972 });
  assert.equal(second.events.length, 0);
});

// --- NFC decode (N13) --------------------------------------------------------

test("decodeTagRecord detects Creality ASCII", () => {
  const blocks = Array.from(Buffer.from("2024-05-01,Blue,PLA", "utf8"));
  const r = decodeTagRecord(blocks);
  assert.equal(r.ok, true);
  assert.equal(r.vendor, "creality");
  assert.equal(r.material, "PLA");
  assert.equal(r.color, "Blue");
});

test("decodeTagRecord detects Anycubic SKU", () => {
  const blocks = Array.from(Buffer.from("AHPLBW-103-A30001", "utf8"));
  const r = decodeTagRecord(blocks);
  assert.equal(r.ok, true);
  assert.equal(r.vendor, "anycubic");
  assert.match(r.sku, /AHPLBW-103-A30001/);
});

test("decodeTagRecord accepts {blocks:[...]} shape and rejects garbage", () => {
  const r = decodeTagRecord({ blocks: Array.from(Buffer.from("123", "utf8")) });
  assert.equal(r.ok, false); // "123" too short, no separators
  assert.equal(decodeTagRecord(null).ok, false);
  assert.equal(decodeTagRecord({}).ok, false);
});

test("spoolRegistry answers offline and is read-only", () => {
  const reg = spoolRegistry();
  assert.equal(reg.read_only, true);
  assert.equal(reg.vendors.length, 3);
});

// --- MCP registration gates --------------------------------------------------

test("edge tools register with correct annotations", () => {
  const registered = new Map();
  registerEdgeTools(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    {
      manager: fakeManager(),
      resolvePrinter: async () => ({ id: 688972, machine_type: "20025", key: "abc" }),
    },
  );
  assert.deepEqual([...registered.keys()].sort(), [
    "ace_feed_finish",
    "ace_refresh_slot",
    "camera_cloud_info",
    "firmware_update_check",
    "nfc_tag_decode",
    "nfc_tag_plan",
    "printer_edge_stop",
    "printer_event_watch",
    "printer_rename",
    "spool_bind",
    "spool_consume_from_slice",
    "spool_register",
    "spool_resolve",
    "spool_status",
    "spool_usage",
  ]);
  for (const name of ["printer_edge_stop", "ace_feed_finish", "ace_refresh_slot"]) {
    assert.equal(registered.get(name).config.annotations.readOnlyHint, false, `${name} writes`);
    assert.equal(
      registered.get(name).config.annotations.destructiveHint,
      true,
      `${name} destructive`,
    );
  }
  // printer_rename writes but is idempotent / non-destructive
  assert.equal(registered.get("printer_rename").config.annotations.readOnlyHint, false);
  assert.equal(registered.get("printer_rename").config.annotations.destructiveHint, false);
  assert.equal(registered.get("printer_rename").config.annotations.idempotentHint, true);
  for (const name of [
    "firmware_update_check",
    "printer_event_watch",
    "nfc_tag_decode",
    "spool_resolve",
    "camera_cloud_info",
  ]) {
    assert.equal(registered.get(name).config.annotations.readOnlyHint, true, `${name} read-only`);
  }
});

test("edge tools gate the confirmations before any network access", async () => {
  const registered = new Map();
  const manager = fakeManager();
  registerEdgeTools(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager, resolvePrinter: async () => ({ id: 688972, machine_type: "20025", key: "abc" }) },
  );
  const stopNoConfirm = await registered.get("printer_edge_stop").handler({ mode: "force" });
  assert.equal(stopNoConfirm.isError, true);
  assert.match(stopNoConfirm.content[0].text, /requires confirm: true/);
  const stopNoWord = await registered
    .get("printer_edge_stop")
    .handler({ mode: "force", confirm: true });
  assert.equal(stopNoWord.isError, true);
  assert.match(stopNoWord.content[0].text, /confirm_word: "EXECUTE"/);
  const feedNoConfirm = await registered.get("ace_feed_finish").handler({});
  assert.equal(feedNoConfirm.isError, true);
  assert.match(feedNoConfirm.content[0].text, /requires confirm: true/);
  const renameNoConfirm = await registered.get("printer_rename").handler({ new_name: "X" });
  assert.equal(renameNoConfirm.isError, true);
  assert.match(renameNoConfirm.content[0].text, /requires confirm: true/);
});

test("executeEdgeCommand gates before any publish", async () => {
  const manager = fakeManager();
  const cloud = fakeCloud({});
  const printer = { id: 688972, machine_type: "20025", key: "abc" };
  await assert.rejects(
    () => executeEdgeCommand(manager, cloud, printer, "printer_edge_stop", {}),
    /requires confirm: true/,
  );
});

test("nfc and spool tools answer offline through the MCP handler", async () => {
  const registered = new Map();
  registerEdgeTools(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager: fakeManager(), resolvePrinter: async () => ({}) },
  );
  const sku = await registered.get("nfc_tag_decode").handler({
    record: Array.from(Buffer.from("AHPLBW-103-A30001", "utf8")),
  });
  assert.equal(sku.structuredContent.ok, true);
  assert.equal(sku.structuredContent.vendor, "anycubic");
  const spool = await registered.get("spool_resolve").handler({ uid: "AHPLBW-103-A30001" });
  assert.equal(spool.structuredContent.read_only, true);
  assert.equal(spool.structuredContent.query.uid, "AHPLBW-103-A30001");
});

// --- Spool registry (Opção A) + NFC tag plan (Opção B) ----------------------

import {
  loadRegistry,
  saveRegistry,
  upsertSpool,
  pushSpoolEvent,
  computeRemaining,
  applyTaskUsage,
  summarizeRegistry,
  defaultRegistryFile,
} from "../scripts/spool-registry.mjs";
import { planAnycubicTagWrite, planSpoolFromDecoded } from "../scripts/nfc-tag-writer.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";

function tempRegistryFile() {
  const dir = mkdtempSync(join(tmpdir(), "spool-registry-"));
  return join(dir, "spool-registry.json");
}

test("spool registry upsert + consumption math", () => {
  const file = tempRegistryFile();
  const reg = loadRegistry(file);
  const rec = upsertSpool(
    reg,
    {
      vendor: "Professional Labs",
      material: "PLA",
      color_hex: "#EBE6E1",
      weight_g: 1000,
      diameter: 1.75,
      sku: "FG-P181-E1",
      box_id: 0,
      slot_index: 0,
    },
    file,
  );
  assert.equal(rec.spool_id.length > 0, true);
  assert.equal(rec.color_hex, "#EBE6E1");
  const app = applyTaskUsage(rec, "task-120800420", 42.5, { ts: "2026-09-14T00:00:00Z" });
  assert.equal(app.applied, true);
  saveRegistry(reg, file);
  const reloaded = loadRegistry(file);
  const remaining = computeRemaining(reloaded.spools[0]);
  assert.equal(remaining.remaining_g, 957.5);
  assert.equal(remaining.remaining_pct, 95.75);
  // idempotent re-apply
  const again = applyTaskUsage(reloaded.spools[0], "task-120800420", 42.5, {});
  assert.equal(again.applied, false, "duplicate task_usage must not double-count");
  rmSync(join(file, ".."), { recursive: true, force: true });
});

test("spool registry sumarize respects archived and events count", () => {
  const file = tempRegistryFile();
  const reg = loadRegistry(file);
  upsertSpool(
    reg,
    { vendor: "A", material: "PETG", weight_g: 750, color_hex: "#000000", sku: "X1" },
    file,
  );
  const summary = summarizeRegistry(reg);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].weight_g, 750);
  assert.equal(summary[0].events, 0);
  rmSync(join(file, ".."), { recursive: true, force: true });
});

test("nfc tag plan requires sku and builds blocks", () => {
  const plan = planAnycubicTagWrite({
    material: "PLA",
    color_hex: "#EBE6E1",
    weight_g: 1000,
    sku: "FG-P181-E1",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.format, "anycubic");
  assert.equal(plan.fields.material, "PLA");
  assert.equal(plan.fields.color[0], 235);
  assert.ok(Array.isArray(plan.payload_blocks) && plan.payload_blocks.length >= 2);
  const missing = planAnycubicTagWrite({ material: "PLA" });
  assert.equal(missing.ok, false);
});

test("planSpoolFromDecoded maps tag record to registry fields", () => {
  const decoded = decodeTagRecord(Array.from(Buffer.from("AHPLBW-103-A30001", "utf8")));
  const plan = planSpoolFromDecoded(decoded, { boxId: 1, slotIndex: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.fields.sku, "AHPLBW-103-A30001");
  assert.equal(plan.fields.box_id, 1);
  assert.equal(plan.fields.slot_index, 2);
  const bad = planSpoolFromDecoded({ ok: false, error: "nope" });
  assert.equal(bad.ok, false);
});

test("spool register/status/usage/plan tools answer offline through MCP handler", async () => {
  const registered = new Map();
  registerEdgeTools(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager: fakeManager(), resolvePrinter: async () => ({}) },
  );
  const regNoConfirm = await registered.get("spool_register").handler({ vendor: "A" });
  assert.equal(regNoConfirm.isError, true);
  assert.match(regNoConfirm.content[0].text, /requires confirm: true/);
  // register (confirm) -> status -> usage (confirm) -> status shows deduction
  const registeredSpool = await registered.get("spool_register").handler({
    vendor: "Professional Labs",
    material: "PLA",
    color_hex: "#EBE6E1",
    weight_g: 1000,
    diameter: 1.75,
    sku: "FG-P181-E1",
    box_id: 0,
    slot_index: 0,
    confirm: true,
  });
  assert.equal(registeredSpool.structuredContent.ok, true);
  const spoolId = registeredSpool.structuredContent.spool.spool_id;
  const usage = await registered
    .get("spool_usage")
    .handler({ spool_id: spoolId, used_g: 12.5, task_id: "t1", confirm: true });
  assert.equal(usage.structuredContent.applied, true);
  const status = await registered.get("spool_status").handler({});
  const matching = status.structuredContent.spools.filter((s) => s.spool_id === spoolId)[0];
  assert.equal(matching.remaining.remaining_g, 987.5);
  const plan = await registered.get("nfc_tag_plan").handler({ spool_id: spoolId });
  assert.equal(plan.structuredContent.ok, true);
  assert.equal(plan.structuredContent.fields.sku, "FG-P181-E1");
  // cleanup the test spool from the real registry
  const file = defaultRegistryFile();
  const registry = loadRegistry(file);
  registry.spools = registry.spools.filter((s) => s.spool_id !== spoolId);
  saveRegistry(registry, file);
});
