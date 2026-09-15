import { test } from "node:test";
import assert from "node:assert/strict";
import z from "zod";

import { COMMANDS, COMMAND_SAFETY } from "../scripts/printer-command-bus-catalog.mjs";
import {
  CloudConnectionManager,
  assertConfirm,
  assertIdle,
  buildCloudStartPrintBody,
  cloudPrintStart,
  createManager,
  executeCloudCommand,
  resolveCloudGcode,
  verifyStartedTask,
} from "../scripts/printer-command-bus.mjs";
import { registerPrinterCommands } from "../scripts/printer-command-tools.mjs";

// --- catalog -----------------------------------------------------------------

test("the command catalog covers every mechanism class", () => {
  const safetyClasses = new Set(Object.values(COMMANDS).map((command) => command.safety));
  for (const expected of ["read", "state", "thermal", "motion", "job"]) {
    assert.ok(safetyClasses.has(expected), `missing safety class ${expected}`);
  }
  // Every mechanism surface the user asked for must exist.
  for (const required of [
    "light_control",
    "temperature_set",
    "fan_set",
    "print_pause",
    "print_resume",
    "print_stop",
    "print_start",
    "ace_dry",
    "ace_feed",
    "ace_auto_feed",
    "ace_set_slot",
    "axis_move",
    "ai_settings_set",
  ]) {
    assert.ok(COMMANDS[required], `missing command ${required}`);
  }
  assert.deepEqual([...COMMAND_SAFETY.EXECUTE_WORD].sort(), ["job", "motion"]);
});

// --- confirm gates ------------------------------------------------------------

test("non-read commands refuse to run without confirm and confirm_word", () => {
  assert.throws(() => assertConfirm("light_control", {}), /requires confirm: true/);
  assert.throws(() => assertConfirm("light_control", { confirm: false }), /requires confirm: true/);
  assert.doesNotThrow(() => assertConfirm("light_control", { confirm: true }));

  // motion/job need the extra EXECUTE word
  assert.throws(() => assertConfirm("print_stop", { confirm: true }), /confirm_word: "EXECUTE"/);
  assert.throws(
    () => assertConfirm("axis_move", { confirm: true, confirm_word: "yes" }),
    /confirm_word: "EXECUTE"/,
  );
  assert.doesNotThrow(() =>
    assertConfirm("print_stop", { confirm: true, confirm_word: "EXECUTE" }),
  );
  assert.doesNotThrow(() => assertConfirm("axis_move", { confirm: true, confirm_word: "EXECUTE" }));

  // read commands never require confirmation
  assert.doesNotThrow(() => assertConfirm("print_query", {}));
  assert.throws(() => assertConfirm("does_not_exist", { confirm: true }), /Unknown command/);
});

test("assertIdle refuses busy printers before any order is built", () => {
  assert.doesNotThrow(() => assertIdle({ reason: "free" }));
  assert.doesNotThrow(() => assertIdle({}));
  for (const busy of [
    "busy",
    "paused",
    "leveling",
    "preheat",
    "vibrating",
    "calibrating",
    "printing",
    "resuming",
  ]) {
    assert.throws(() => assertIdle({ reason: busy }), /refusing to start a new print/, busy);
  }
});

// --- connection manager ---------------------------------------------------------

function fakeMqttClient() {
  return {
    disconnected: false,
    disconnecting: false,
    endAsync: async () => {},
    on: () => {},
    publish: (_topic, _payload, cb) => cb(null),
  };
}

test("the manager reuses one persistent connection across acquisitions", async () => {
  let connects = 0;
  const cloud = {
    connectMqtt: async () => {
      connects += 1;
      return fakeMqttClient();
    },
  };
  const manager = new CloudConnectionManager({ cloud });
  const printer = { machine_type: "20025", key: "abc123" };
  await manager.acquire(printer);
  await manager.acquire(printer);
  await manager.acquire(printer);
  assert.equal(connects, 1, "must not reconnect while the session is healthy");
  assert.equal(manager.health().connected, true);
  await manager.release();
  assert.equal(manager.health().connected, false);
});

test("the manager reconnects after the client errors or closes", async () => {
  let clients = [];
  const cloud = {
    connectMqtt: async () => {
      const client = fakeMqttClient();
      clients.push(client);
      return client;
    },
  };
  const manager = new CloudConnectionManager({ cloud });
  const printer = { machine_type: "20025", key: "abc123" };
  await manager.acquire(printer);
  clients[0].disconnected = true; // simulate a dropped socket
  await manager.acquire(printer);
  assert.equal(clients.length, 2, "a dead session must be replaced");
  await manager.release();
});

test("a failed connect propagates and clears the in-flight promise", async () => {
  const cloud = {
    connectMqtt: async () => {
      throw new Error("CONNACK 5");
    },
  };
  const manager = new CloudConnectionManager({ cloud });
  await assert.rejects(manager.acquire({ machine_type: "20025", key: "abc" }), /CONNACK 5/);
  // A retry must attempt again, not return the rejected promise.
  await assert.rejects(manager.acquire({ machine_type: "20025", key: "abc" }), /CONNACK 5/);
});

test("publish builds the correct topic and envelope per command", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  const seen = [];
  const client = {
    publish: (topic, payload, cb) => {
      seen.push({ topic, payload: JSON.parse(payload) });
      cb(null);
    },
  };
  const printer = { machine_type: "20025", key: "abc123" };

  const light = await manager.publish(
    printer,
    "light_control",
    { on: true, brightness: 80 },
    client,
  );
  assert.equal(seen[0].topic, "anycubic/anycubicCloud/v1/pc/printer/20025/abc123/light");
  assert.deepEqual(seen[0].payload.data, { type: 2, status: 1, brightness: 80 });
  assert.equal(light.msgid, seen[0].payload.msgid);

  await manager.publish(printer, "temperature_set", { nozzle: 210, bed: 60 }, client);
  assert.equal(seen[1].topic.endsWith("/tempature"), true);
  assert.deepEqual(seen[1].payload.data, {
    type: 2,
    target_nozzle_temp: 210,
    target_hotbed_temp: 60,
  });

  await manager.publish(printer, "print_stop", {}, client);
  assert.deepEqual(seen[2].payload.data, { taskid: "-1" });

  await manager.publish(printer, "fan_set", { fan: "aux", speed_pct: 70 }, client);
  assert.deepEqual(seen[3].payload.data, { aux_fan_speed_pct: 70 });

  assert.equal(manager.health().stats.published, 4);
  await assert.rejects(manager.publish(printer, "nope", {}, client), /Unknown command/);
});

test("waitForReply correlates by msgid and falls back to type-only", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  manager.events.push({
    topic: "light/report",
    data: { type: "light", msgid: "device-id", code: 200 },
  });
  const exact = await manager.waitForReply("light", "request-id", 50);
  assert.equal(exact.state, "uncorrelated_report");
  assert.equal(exact.reports.length, 1);
  const none = await manager.waitForReply("axis", "x", 50);
  assert.equal(none.state, "timeout");
});

// --- executeCloudCommand ----------------------------------------------------------

test("executeCloudCommand refuses non-read commands without confirmation", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  await assert.rejects(
    executeCloudCommand(manager, { machine_type: "20025", key: "k" }, "light_control", {
      on: true,
    }),
    /requires confirm: true/,
  );
  await assert.rejects(
    executeCloudCommand(manager, { machine_type: "20025", key: "k" }, "print_stop", {
      confirm: true,
    }),
    /confirm_word: "EXECUTE"/,
  );
});

test("executeCloudCommand reports the device outcome without auto-retry", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  const printer = { machine_type: "20025", key: "k" };
  let sent = 0;
  manager.acquire = async () => ({
    publish: (topic, payload, cb) => {
      sent += 1;
      manager.events.push({
        topic: "light/report",
        data: { type: "light", msgid: JSON.parse(payload).msgid, code: 200 },
      });
      cb(null);
    },
  });
  // Seed the reply before execution so waitForReply finds it immediately.
  const result = await executeCloudCommand(
    manager,
    printer,
    "light_control",
    { on: true, confirm: true },
    { replyTimeoutMs: 300 },
  );
  assert.equal(sent, 1, "exactly one publish");
  assert.equal(result.ok, true, "the seeded device reply must count as success");
  assert.equal(result.reply_state, "correlated_reply");
  assert.deepEqual(result.device_codes, [200]);

  // A device error code must flip the outcome to failure.
  manager.events.length = 0;
  manager.acquire = async () => ({
    publish: (topic, payload, cb) => {
      manager.events.push({
        topic: "light/report",
        data: { type: "light", msgid: JSON.parse(payload).msgid, code: 500, msg: "device refused" },
      });
      cb(null);
    },
  });
  const failed = await executeCloudCommand(
    manager,
    printer,
    "light_control",
    { on: false, confirm: true },
    { replyTimeoutMs: 300 },
  );
  assert.equal(failed.ok, false);
  assert.match(failed.device_error, /device refused/);
});

// --- cloud print start (order 1 contract) ---------------------------------------------

const GCODE_INFO = {
  data: {
    file_id: 87816937,
    gcode_id: 117442081,
    name: "shelf.gcode",
    status: 2,
    slice_param: { layer_height: 0.2 },
    slice_result: { sliced_md5: "aa11", total_layers: 301, print_time: 25334 },
  },
};

test("resolveCloudGcode rejects an unresolved gcode and demands the right id", async () => {
  const cloud = { rawApi: async () => ({ data: {} }) };
  await assert.rejects(resolveCloudGcode(cloud, 123), /no resolved cloud file id/);
  const ok = await resolveCloudGcode({ rawApi: async () => GCODE_INFO }, 117442081);
  assert.equal(ok.file_id, 87816937);
  assert.equal(ok.total_layers, 301);
});

test("buildCloudStartPrintBody produces the corrected order 1 contract", () => {
  const printer = { id: 688972 };
  const gcode = { file_id: 87816937, gcode_id: 117442081, name: "shelf.gcode" };
  const body = buildCloudStartPrintBody({ printer, gcode, file_name: "shelf.gcode" });
  // START_PRINT is order id 1 (AnycubicOrderID.START_PRINT, validated live
  // 2026-09-11 — tasks 120799976/120800420 started the physical printer).
  // 1240 accepts with "Operation successful" but never creates a task.
  assert.equal(body.order_id, 1);
  assert.equal(typeof body.order_id, "number");
  assert.equal(body.project_id, 0);
  assert.equal(body.data.filetype, 0);
  assert.equal(body.data.file_id, 87816937);
  // Wire contract: file_key is the empty string, not the cloud file id.
  assert.equal(body.data.file_key, "");
  assert.equal(body.data.is_delete_file, 0);
  assert.equal(body.data.project_type, 1);
  assert.equal(body.data.template_id, 0);
  assert.equal(body.data.matrix, "");
  // Slice metadata is load-bearing and passed through from the resolved gcode.
  assert.equal(body.data.slice_param, null);
  const withSlice = buildCloudStartPrintBody({
    printer,
    gcode: { ...gcode, slice_param: { layer_height: 0.2, paint_infos: [{ paint_index: 1 }] } },
    file_name: "shelf.gcode",
  });
  assert.deepEqual(withSlice.data.slice_param, {
    layer_height: 0.2,
    paint_infos: [{ paint_index: 1 }],
  });
  // The gcode_id is NOT part of the request data (it resolves on the server).
  assert.equal("gcode_id" in body.data, false);
  // Without an ACE mapping, ams_info and settings are null on the wire.
  assert.equal(body.ams_info, null);
  assert.equal(body.settings, null);
  // An explicit mapping produces the reference ams_info shape.
  const mapped = buildCloudStartPrintBody({
    printer,
    gcode,
    ams: {
      ams_box_mapping: [
        {
          ams_index: 2,
          filament_used: 34.68,
          material_type: "PLA",
          paint_color: [212, 185, 150],
          paint_index: 1,
        },
      ],
    },
  });
  assert.equal(mapped.ams_info.use_ams, true);
  assert.equal(mapped.ams_info.ams_box_mapping.length, 1);
  assert.equal(mapped.ams_info.ams_box_mapping[0].ams_index, 2);
  // The malformed local-file shape from the incident must be impossible here.
  assert.notEqual(body.data.filetype, 1);
  assert.throws(
    () => buildCloudStartPrintBody({ printer, gcode: { file_id: 0 }, file_name: "x" }),
    /filetype 0/,
  );
  assert.throws(
    () => buildCloudStartPrintBody({ printer, gcode, ams: { use_ams: true } }),
    /ams_box_mapping/,
  );
});

test("verifyStartedTask detects the malformed task before reporting success", () => {
  const gcode = { file_id: 87816937, gcode_id: 117442081 };
  // Malformed: model=0, no slice metadata (the 10115 shape).
  const malformed = verifyStartedTask(
    { data: { taskid: "1", model: 0, gcode_id: 119124838, print_status: 3 } },
    { gcode },
  );
  assert.equal(malformed.verified, false);
  assert.ok(malformed.problems.some((p) => /model/.test(p) || /slice_param/.test(p)));

  // Correct: model preserved, slice metadata present, active status 13.
  const good = verifyStartedTask(
    {
      data: {
        taskid: "9",
        model: 87816937,
        gcode_id: 117442081,
        print_status: 13,
        slice_param: {},
        slice_result: {},
      },
    },
    { gcode },
  );
  assert.equal(good.verified, true);
  assert.equal(good.active, true);
});

test("cloudPrintStart enforces EXECUTE gating and busy-guard before any HTTP call", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  const cloud = {
    rawApi: async () => {
      throw new Error("must not be called");
    },
  };
  const printer = { id: 1, machine_type: "20025", key: "k", reason: "printing" };
  await assert.rejects(
    cloudPrintStart(manager, cloud, printer, {}),
    /confirm: true AND confirm_word/,
  );
  await assert.rejects(
    cloudPrintStart(manager, cloud, printer, {
      confirm: true,
      confirm_word: "EXECUTE",
      gcode_id: 1,
    }),
    /refusing to start a new print/,
  );
});

test("cloudPrintStart reports unverified when the task never confirms", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  manager.acquire = async () => ({ publish: (_t, _p, cb) => cb(null) });
  const cloud = {
    rawApi: async (_method, endpoint) => {
      if (String(endpoint).includes("infoFdm")) return GCODE_INFO;
      return { code: 1, data: { task_id: "777" } };
    },
  };
  const printer = { id: 1, machine_type: "20025", key: "k", reason: "free" };
  const result = await cloudPrintStart(
    manager,
    cloud,
    printer,
    { confirm: true, confirm_word: "EXECUTE", gcode_id: 117442081 },
    { verifyTimeoutMs: 3000 },
  );
  assert.equal(result.http_accepted, true);
  assert.equal(result.verification.verified, false);
  assert.equal(result.ok, false, "HTTP acceptance alone is not success");
  assert.match(result.note, /Never re-send the order automatically/);
});

// --- MCP registration -------------------------------------------------------------

test("command tools register with correct annotations and gating", () => {
  const registered = new Map();
  const server = {
    registerTool: (name, config, handler) => registered.set(name, { config, handler }),
  };
  registerPrinterCommands(server, z, {
    manager: createManager({}),
    resolvePrinter: async () => ({}),
  });
  assert.deepEqual([...registered.keys()].sort(), [
    "printer_command_catalog",
    "printer_command_send",
    "printer_connection_status",
    "printer_gcode_resolve",
    "printer_print_start",
  ]);
  for (const name of ["printer_command_send", "printer_print_start"]) {
    const config = registered.get(name).config;
    assert.equal(config.annotations.readOnlyHint, false, `${name} must be a write tool`);
    assert.equal(config.annotations.destructiveHint, true, `${name} must be destructive-flagged`);
  }
  for (const name of [
    "printer_command_catalog",
    "printer_connection_status",
    "printer_gcode_resolve",
  ]) {
    assert.equal(
      registered.get(name).config.annotations.readOnlyHint,
      true,
      `${name} must be read-only`,
    );
  }
});

test("printer_command_send handler surfaces the confirmation gate as a tool error", async () => {
  const registered = new Map();
  const manager = createManager({ accessToken: "x" });
  registerPrinterCommands(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager, resolvePrinter: async () => ({ id: 1, machine_type: "20025", key: "k" }) },
  );
  const reply = await registered.get("printer_command_send").handler({
    command: "light_control",
    on: true,
  });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /requires confirm: true/);
});

test("printer_print_start handler refuses use_ams without a mapping", async () => {
  const registered = new Map();
  registerPrinterCommands(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    {
      manager: createManager({ accessToken: "x" }),
      resolvePrinter: async () => ({ id: 1, machine_type: "20025", key: "k" }),
    },
  );
  const reply = await registered.get("printer_print_start").handler({
    gcode_id: 1,
    use_ams: true,
    confirm: true,
    confirm_word: "EXECUTE",
  });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /ams_box_mapping/);
});

test("printer_command_catalog handler answers offline", async () => {
  const registered = new Map();
  registerPrinterCommands(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager: createManager({ accessToken: "x" }), resolvePrinter: async () => ({}) },
  );
  const all = await registered.get("printer_command_catalog").handler({});
  assert.equal(all.structuredContent.executable, true);
  assert.equal(all.structuredContent.total, Object.keys(COMMANDS).length);
  const job = await registered.get("printer_command_catalog").handler({ safety: "job" });
  assert.ok(job.structuredContent.commands.every((command) => command.confirm_word_required));
});
