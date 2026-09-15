import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "zod";

import { COMMANDS } from "../scripts/printer-command-bus-catalog.mjs";
import { CloudConnectionManager, executeCloudCommand } from "../scripts/printer-command-bus.mjs";
import { registerPrinterCommands } from "../scripts/printer-command-tools.mjs";
import {
  recordLanSnapshot,
  registerAuditGapTools,
  uploadFileToCloud,
} from "../scripts/audit-gap-tools.mjs";

// --- new bus commands ---------------------------------------------------------

test("the audit-gap commands exist in the bus catalog with correct safety", () => {
  for (const [id, safety] of [
    ["print_update", "thermal"],
    ["video_start_capture", "state"],
    ["video_stop_capture", "state"],
    ["axis_turn_off", "motion"],
  ]) {
    assert.equal(COMMANDS[id]?.safety, safety, `${id} must be ${safety}`);
  }
});

test("print_update requires at least one setting and builds the subset", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  const seen = [];
  manager.acquire = async () => ({
    publish: (topic, payload, cb) => {
      seen.push({ topic, payload: JSON.parse(payload) });
      cb(null);
    },
  });
  const printer = { machine_type: "20025", key: "k" };

  await assert.rejects(
    executeCloudCommand(
      manager,
      printer,
      "print_update",
      { task_id: "9", confirm: true },
      { replyTimeoutMs: 200 },
    ),
    /at least one setting/,
  );
  // With no reply seeded this times out, but the publish still carries the subset.
  await executeCloudCommand(
    manager,
    printer,
    "print_update",
    {
      task_id: "9",
      nozzle: 215,
      fan: "aux",
      speed_pct: 80,
      print_speed_mode: 2,
      confirm: true,
    },
    { replyTimeoutMs: 200 },
  );
  const printEnvelope = seen.find((s) => s.payload.type === "print").payload;
  assert.equal(printEnvelope.action, "update");
  assert.deepEqual(printEnvelope.data.settings, {
    target_nozzle_temp: 215,
    aux_fan_speed_pct: 80,
    print_speed_mode: 2,
  });
  assert.equal(printEnvelope.data.taskid, "9");
});

test("print_update requires the EXECUTE word (thermal class has confirm only)", async () => {
  // thermal needs confirm:true but NOT the EXECUTE word; motion does.
  const manager = new CloudConnectionManager({ cloud: {} });
  await assert.rejects(
    executeCloudCommand(manager, { machine_type: "20025", key: "k" }, "video_start_capture", {}),
    /requires confirm: true/,
  );
  await assert.rejects(
    executeCloudCommand(manager, { machine_type: "20025", key: "k" }, "axis_turn_off", {
      confirm: true,
    }),
    /confirm_word: "EXECUTE"/,
  );
});

test("video capture and axis turn_off publish null-data envelopes", async () => {
  const manager = new CloudConnectionManager({ cloud: {} });
  const seen = [];
  manager.acquire = async () => ({
    publish: (topic, payload, cb) => {
      seen.push(JSON.parse(payload));
      cb(null);
    },
  });
  const printer = { machine_type: "20025", key: "k" };
  await executeCloudCommand(
    manager,
    printer,
    "video_start_capture",
    { confirm: true },
    { replyTimeoutMs: 200 },
  );
  await executeCloudCommand(
    manager,
    printer,
    "axis_turn_off",
    { confirm: true, confirm_word: "EXECUTE" },
    { replyTimeoutMs: 200 },
  );
  assert.deepEqual(seen[0].data, null);
  assert.equal(seen[0].action, "startCapture");
  assert.deepEqual(seen[1].data, null);
  assert.equal(seen[1].action, "turnOff");
});

// --- cloud upload flow ----------------------------------------------------------

function fakeCloud({ failPut = false, noGcode = false, storeBytes = null } = {}) {
  const calls = [];
  return {
    calls,
    rawApi: async (method, endpoint, { params = {}, query } = {}) => {
      calls.push({ method, endpoint, params });
      if (endpoint === "/work/index/getUserStore") {
        if (storeBytes === null)
          throw Object.assign(new Error(`unexpected getUserStore`), { status: 404 });
        return {
          data: {
            used_bytes: storeBytes.used,
            total_bytes: storeBytes.total,
          },
        };
      }
      if (endpoint === "/v2/cloud_storage/lockStorageSpace") {
        return { data: { id: 42, preSignUrl: "https://s3.example/put" } };
      }
      if (endpoint === "/v2/profile/newUploadFile") return { data: { id: 88637611 } };
      if (endpoint === "/v2/cloud_storage/unlockStorageSpace") return { data: {} };
      if (endpoint === "/work/index/userFiles") {
        return {
          data: noGcode
            ? []
            : [{ id: 88637611, old_filename: "cube.gcode", gcode_id: 120029158, file_key: "fk" }],
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", endpoint: url });
      if (failPut) return { ok: false, status: 403 };
      return { ok: true, status: 200 };
    },
  };
}

test("uploadFileToCloud runs the lock/PUT/claim/unlock flow and reconciles gcode_id", async () => {
  const cloud = fakeCloud({ storeBytes: { total: 2 * 1024 ** 3, used: 50 * 1024 ** 2 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
  const file = path.join(dir, "cube.gcode");
  fs.writeFileSync(file, "; gcode\ngoto(0,0)\n");
  const result = await uploadFileToCloud(cloud, { local_file: file, fetchImpl: cloud.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.cloud_file_id, 88637611);
  assert.equal(result.gcode_id, 120029158);
  assert.deepEqual(
    cloud.calls.map((c) => c.endpoint),
    [
      "/work/index/getUserStore",
      "/v2/cloud_storage/lockStorageSpace",
      "https://s3.example/put",
      "/v2/profile/newUploadFile",
      "/v2/cloud_storage/unlockStorageSpace",
      "/work/index/userFiles",
    ],
  );
  assert.equal(cloud.calls[1].params.is_temp_file, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failed PUT deletes the reservation instead of orphaning the lock", async () => {
  const cloud = fakeCloud({ failPut: true, storeBytes: { total: 2 * 1024 ** 3, used: 50 * 1024 ** 2 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
  const file = path.join(dir, "cube.gcode");
  fs.writeFileSync(file, "x");
  await assert.rejects(
    uploadFileToCloud(cloud, { local_file: file, fetchImpl: cloud.fetchImpl }),
    /HTTP 403/,
  );
  const unlocks = cloud.calls.filter((c) => c.endpoint === "/v2/cloud_storage/unlockStorageSpace");
  assert.equal(unlocks.length, 1);
  assert.equal(unlocks[0].params.is_delete_cos, 1, "failed claim must delete the reservation");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a quota preflight aborts the upload when free space is insufficient", async () => {
  const cloud = fakeCloud({ storeBytes: { total: 2 * 1024 ** 3, used: 2 * 1024 ** 3 - 10 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
  const file = path.join(dir, "big.gcode");
  fs.writeFileSync(file, "y".repeat(100));
  await assert.rejects(
    uploadFileToCloud(cloud, { local_file: file, fetchImpl: cloud.fetchImpl }),
    /preflight failed: file needs 100 bytes but only 10 bytes free/,
  );
  assert.equal(
    cloud.calls.filter((c) => c.endpoint === "/v2/cloud_storage/lockStorageSpace").length,
    0,
    "no lock may be taken when the preflight fails",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});;

test("uploadFileToCloud rejects empty files before touching the cloud", async () => {
  const cloud = fakeCloud();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
  const file = path.join(dir, "empty.gcode");
  fs.writeFileSync(file, "");
  await assert.rejects(uploadFileToCloud(cloud, { local_file: file }), /empty file/);
  assert.equal(cloud.calls.length, 0, "no request may be sent");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- LAN camera snapshot ----------------------------------------------------------

test("recordLanSnapshot validates the IP and uses a fixed ffmpeg argv", async () => {
  await assert.rejects(recordLanSnapshot({ ip: "example.com", output_path: "x.jpg" }), /IPv4/);
  await assert.rejects(recordLanSnapshot({ ip: "192.168.3.110" }), /output_path/);
  const runs = [];
  const result = await recordLanSnapshot({
    ip: "192.168.3.110",
    output_path: "snap.jpg",
    duration_s: 2,
    run: async (cmd, argv) => {
      runs.push({ cmd, argv });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cmd, "ffmpeg");
  assert.match(runs[0].argv.at(-1), /snap\.jpg$/);
  assert.ok(runs[0].argv.includes("http://192.168.3.110:18088/flv"));
  assert.ok(!runs[0].argv.some((arg) => /&&|;|\|/.test(String(arg))), "no shell metacharacters");
});

// --- MCP registration --------------------------------------------------------------

function fakeManager() {
  const manager = new CloudConnectionManager({ cloud: { xxToken: "tok" } });
  return manager;
}

test("audit-gap tools register with correct annotations", () => {
  const registered = new Map();
  const server = {
    registerTool: (name, config, handler) => registered.set(name, { config, handler }),
  };
  registerAuditGapTools(server, z, { manager: fakeManager() });
  assert.deepEqual([...registered.keys()].sort(), [
    "account_file_upload",
    "account_print_local",
    "camera_watch",
    "printer_connection_close",
    "printer_lan_camera",
    "printer_material_catalog",
  ]);
  assert.equal(registered.get("account_file_upload").config.annotations.destructiveHint, false);
  assert.equal(registered.get("account_print_local").config.annotations.destructiveHint, true);
  for (const name of [
    "printer_connection_close",
    "printer_material_catalog",
    "printer_lan_camera",
  ]) {
    assert.equal(
      registered.get(name).config.annotations.readOnlyHint,
      true,
      `${name} must be read-only`,
    );
  }
  // camera_watch writes snapshots to disk → NOT read-only, and must require confirm.
  assert.equal(registered.get("camera_watch").config.annotations.readOnlyHint, false);
  const confirmField = registered.get("camera_watch").config.inputSchema.confirm;
  assert.ok(confirmField, "camera_watch must expose a confirm field");
  assert.equal(confirmField.def?.defaultValue, false, "confirm defaults to false");
});

test("upload and print-local tools gate confirmations before any cloud access", async () => {
  const registered = new Map();
  const manager = fakeManager();
  registerAuditGapTools(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager },
  );
  const noConfirm = await registered.get("account_file_upload").handler({ local_file: "x.gcode" });
  assert.match(noConfirm.content[0].text, /requires confirm: true/);
  const noWord = await registered
    .get("account_print_local")
    .handler({ local_file: "x.gcode", confirm: true });
  assert.match(noWord.content[0].text, /confirm_word: "EXECUTE"/);
  const ams = await registered.get("account_print_local").handler({
    local_file: "x.gcode",
    confirm: true,
    confirm_word: "EXECUTE",
    use_ams: true,
  });
  assert.match(ams.content[0].text, /ams_box_mapping/);
});

test("printer_material_catalog and connection_close answer offline", async () => {
  const registered = new Map();
  registerAuditGapTools(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager: fakeManager() },
  );
  const materials = await registered.get("printer_material_catalog").handler({});
  assert.ok(materials.structuredContent.materials.includes("PLA"));
  const closed = await registered.get("printer_connection_close").handler({});
  assert.equal(closed.structuredContent.closed, true);
});

test("the bus catalog counts grew and the full command set is exposed", async () => {
  const registered = new Map();
  registerPrinterCommands(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
    { manager: fakeManager(), resolvePrinter: async () => ({}) },
  );
  const catalog = await registered.get("printer_command_catalog").handler({});
  assert.equal(catalog.structuredContent.total, Object.keys(COMMANDS).length);
  assert.ok(
    catalog.structuredContent.total >= 18,
    `bus grew, got ${catalog.structuredContent.total}`,
  );
  const ids = catalog.structuredContent.commands.map((c) => c.id);
  for (const required of [
    "print_update",
    "video_start_capture",
    "video_stop_capture",
    "axis_turn_off",
  ]) {
    assert.ok(ids.includes(required), `${required} must be exposed`);
  }
});
