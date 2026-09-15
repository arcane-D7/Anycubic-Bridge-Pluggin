import { test } from "node:test";
import assert from "node:assert/strict";
import {
  num,
  parseJsonField,
  parseDurationHours,
  mapPrinterStatusEntry,
  orderRegistry,
  collectCloudStore,
  collectCloudFiles,
  collectErrorList,
  collectFilePreview,
  collectPrintHistory,
  collectPrinterStatusSnapshot,
  collectCloudProjects,
  collectPrintMetrics,
  collectMetricsExpose,
  failureReasonLabel,
} from "../scripts/printer-expansion-tools.mjs";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("num parses defensive numeric forms without throwing", () => {
  assert.equal(num("68.64"), 68.64);
  assert.equal(num("12px"), 12);
  assert.equal(num("abc"), null);
  assert.equal(num(null), null);
  assert.equal(num(Infinity), null);
});

test("parseJsonField unwraps JSON strings and passes objects through", () => {
  assert.deepEqual(parseJsonField('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonField({ a: 1 }), { a: 1 });
  assert.equal(parseJsonField("not-json"), null);
  assert.equal(parseJsonField(undefined), null);
});

test('parseDurationHours normalizes "129hour35min" to ~129.58h', () => {
  assert.equal(parseDurationHours("129hour35min"), 129 + 35 / 60);
  assert.equal(parseDurationHours("1h 13min"), 1 + 13 / 60);
  assert.equal(parseDurationHours("2h 32m 25s"), 2 + 32 / 60 + 25 / 3600);
  assert.equal(parseDurationHours(5), 5);
  assert.equal(parseDurationHours("garbage"), null);
  assert.equal(parseDurationHours(null), null);
});

test("mapPrinterStatusEntry extracts stable fields, lifetime and ACE slots", () => {
  const entry = {
    id: 688972,
    name: "Kobra S1 ",
    model: "Anycubic Kobra S1",
    machine_type: 20025,
    status: 1,
    is_printing: 1,
    print_count: 67,
    material_used: "2.97kg",
    material_gram_used: 0,
    print_totaltime: "129hour35min",
    machine_mac: "B0-8C-B3-51-B0-96",
    video_taskid: 0,
    parameter: { curr_nozzle_temp: 36, curr_hotbed_temp: 31 },
    version: { firmware_version: "2.7.2.7", need_update: 0 },
    machine_data: {
      size_x: 250,
      size_y: 250,
      size_z: 260,
      res_x: 11520,
      res_y: 5120,
      pixel: 34.4,
      suffix: "gcode",
    },
    multi_color_box: [
      {
        id: 1,
        model_id: 40002,
        loaded_slot: 1,
        auto_feed: 0,
        humidity: 40,
        drying_status: 0,
        feed_status: 0,
        slots: [
          {
            index: 1,
            status: 5,
            edit_status: 0,
            type: "PLA High Speed",
            sku: "AHHSGY-107",
            color: "red",
            color_group: "red",
            consumables_percent: 13,
          },
        ],
      },
    ],
    features: [{ name: "camera_timelapse_support", value: true }],
  };
  const m = mapPrinterStatusEntry(entry);
  assert.equal(m.printer_id, 688972);
  assert.equal(m.lifetime.print_count, 67);
  assert.equal(m.lifetime.material_used_kg, 2.97);
  assert.equal(m.lifetime.print_totaltime_hours, 129 + 35 / 60);
  assert.equal(m.machine.size_mm[0], 250);
  assert.equal(m.current.nozzle_temp_c, 36);
  assert.equal(m.multi_color_box.length, 1);
  assert.equal(m.multi_color_box[0].slots[0].sku, "AHHSGY-107");
  assert.equal(m.multi_color_box[0].slots[0].edit_status, 0);
  assert.equal(m.features[0].name, "camera_timelapse_support");
});

// ---------------------------------------------------------------------------
// Offline registry
// ---------------------------------------------------------------------------

test("orderRegistry is complete and read-only", () => {
  const r = orderRegistry();
  assert.equal(r.read_only, true);
  assert.equal(r.validated_live.START_PRINT, 1);
  assert.equal(r.validated_live.STOP_PRINT, 4);
  assert.equal(r.validated_live.MULTI_COLOR_BOX_GET_INFO, 1206);
  // Mutating ids are documented in the reference, never in validated_live.
  assert.equal(r.validated_live.STOP_PRINT_FORCE, undefined);
  assert.equal(r.from_reference_AnycubicOrderID_IntEnum.STOP_PRINT_FORCE, 44);
  assert.equal(r.from_reference_AnycubicOrderID_IntEnum.SET_PRINT_STATUS_FREE, 901);
  assert.equal(r.from_reference_AnycubicOrderID_IntEnum.SET_TEMPERATURE, 1214);
  // The famous collision must stay visible — semantics must never be inferred from an id alone.
  assert.equal(
    r.from_reference_AnycubicOrderID_IntEnum.SET_TEMPERATURE,
    r.validated_live.QUERY_AXIS_POSITION,
  );
});

// ---------------------------------------------------------------------------
// Cloud collectors (mocked rawApi/cloud)
// ---------------------------------------------------------------------------

function fakeApi(router) {
  return {
    async rawApi(method, path, { query } = {}) {
      const handler = router[`${method} ${path}`];
      if (!handler)
        throw Object.assign(new Error(`no mock for ${method} ${path}`), { status: 404 });
      return handler(query);
    },
  };
}

test("collectCloudStore maps quota fields (server-shaped data)", async () => {
  const cloud = fakeApi({
    ["GET /work/index/getUserStore"]: () => ({
      code: 1,
      data: {
        used_bytes: 77551220,
        total_bytes: 2147483648,
        used: "73.96MB",
        total: "2.00GB",
        user_file_exists: true,
      },
    }),
  });
  const r = await collectCloudStore(cloud);
  assert.equal(r.used_bytes, 77551220);
  assert.equal(r.total_bytes, 2147483648);
  assert.equal(r.read_only, true);
});

test("collectCloudFiles filters by file_type and projects stable metadata", async () => {
  const entries = [
    {
      id: 90025056,
      gcode_id: 120193034,
      file_type: 1,
      file_extension: "gcode.3mf",
      old_filename: "a.gcode.3mf",
      size: 11023229,
      md5: "c75…",
      thumbnail: "http://x/th.png",
      path: "/p",
      region: "us-east-2",
      status: 1,
      is_parse: 1,
      img_status: 1,
    },
    {
      id: 2,
      gcode_id: null,
      file_type: 2,
      file_extension: "stl",
      old_filename: "b.stl",
      size: 10,
      is_parse: 0,
      img_status: 0,
    },
  ];
  const cloud = fakeApi({ ["GET /work/index/userFiles"]: () => ({ code: 1, data: entries }) });
  const all = await collectCloudFiles(cloud);
  assert.equal(all.count, 2);
  assert.equal(all.files[0].gcode_id, 120193034);
  assert.equal(all.files[0].has_thumbnail, true);
  const gcodeOnly = await collectCloudFiles(cloud, { fileType: 1 });
  assert.equal(gcodeOnly.count, 1);
});

test("collectErrorList returns platform error catalog and incident codes", async () => {
  const cloud = fakeApi({
    ["GET /v3/work_project/getErrorList"]: () => ({
      code: 1,
      data: [{ id: 1, title: "The model has layer separation." }],
    }),
  });
  const r = await collectErrorList(cloud, { printerId: 688972 });
  assert.equal(r.printer_id, 688972);
  assert.equal(r.errors[0].title, "The model has layer separation.");
  assert.ok(r.failure_reason_codes[11520]);
  assert.ok(r.failure_reason_codes[11801]);
});

test("collectFilePreview resolves gcode via infoFdm and unwraps slice metadata", async () => {
  const cloud = fakeApi({
    ["GET /work/gcode/infoFdm"]: (query) => {
      assert.equal(query.id, 120193034);
      return {
        code: 1,
        data: {
          name: "recovery-remainder-v3.gcode",
          status: 2,
          size: 11023229,
          slice_param: JSON.stringify({
            extruder_colour: [
              [117, 120, 123],
              [212, 185, 150],
            ],
            paint_infos: [
              {
                paint_index: 1,
                material_type: "PLA",
                paint_color: [212, 185, 150],
                filament_used: 68.64,
              },
            ],
          }),
          slice_result: JSON.stringify({
            total_layers: 92,
            size_x: 200,
            size_y: 250,
            size_z: 18.4,
            print_time: "1h 34m 34s",
            used_filament: 27.97,
            "filament used [g]": [0, 68.64, 0, 0],
            sliced_md5: "deadbeef",
          }),
        },
      };
    },
  });
  const r = await collectFilePreview(cloud, { gcodeId: 120193034 });
  assert.equal(r.layers, 92);
  assert.equal(r.used_filament_g, 27.97);
  assert.equal(r.per_color[0].filament_used_g, 68.64);
  assert.equal(r.per_color[0].material_type, "PLA");
  assert.equal(r.dimensions.z, 18.4);
  assert.equal(r.md5, "deadbeef");
  assert.equal(r.read_only, true);
});

test("collectFilePreview rejects when neither gcode_id nor file_id is given", async () => {
  const cloud = fakeApi({});
  await assert.rejects(collectFilePreview(cloud, {}), /gcode_id or file_id is required/);
});

test("collectPrintHistory projects recent entries with reason labels", async () => {
  const cloud = fakeApi({
    ["GET /v2/project/printHistory"]: (query) => {
      assert.equal(query.limit, 5);
      return {
        code: 1,
        data: {
          pageData: { page: 1, page_count: 1, total: 2 },
          list: [
            {
              task_id: 120800420,
              gcode_name: "a.gcode",
              printer_name: "Kobra S1",
              create_time: 1789131228,
              print_status: 2,
              reason: null,
            },
            {
              task_id: 120799976,
              gcode_name: "b.gcode",
              printer_name: "Kobra S1",
              create_time: 1789131000,
              print_status: 3,
              reason: 10101,
            },
          ],
        },
      };
    },
  });
  const r = await collectPrintHistory(cloud, { limit: 5 });
  assert.equal(r.total, 2);
  assert.equal(r.recent[0].status_label, "success/finished");
  assert.ok(r.recent[1].reason_label.includes("Print task already exists"));
});

test("collectPrinterStatusSnapshot merges ACE slots from getPrinters", async () => {
  const cloud = fakeApi({
    ["GET /work/printer/printersStatus"]: () => ({
      code: 1,
      data: [
        {
          id: 688972,
          name: "Kobra S1",
          machine_data: { size_x: 250, size_y: 250, size_z: 260 },
          parameter: {},
          version: {},
        },
      ],
    }),
    ["GET /work/printer/getPrinters"]: () => ({
      code: 1,
      data: [
        {
          id: 688972,
          multi_color_box: [
            {
              id: 1,
              slots: [
                { index: 1, status: 5, edit_status: 0, type: "PLA High Speed", sku: "AHHSGY-107" },
              ],
            },
          ],
          features: [{ name: "fod_support", value: true }],
        },
      ],
    }),
  });
  const r = await collectPrinterStatusSnapshot(cloud, { printerId: 688972 });
  assert.equal(r.count, 1);
  assert.equal(r.selected.printer_id, 688972);
  assert.equal(r.selected.multi_color_box[0].slots[0].sku, "AHHSGY-107");
  assert.equal(r.selected.features[0].name, "fod_support");
});

// ---------------------------------------------------------------------------
// Batch 2 additions: projects, print metrics, Prometheus expose
// ---------------------------------------------------------------------------

test("collectCloudProjects projects id/name/size and handles list shapes", async () => {
  const cloud = fakeApi({
    ["GET /work/project/getProjects"]: () => ({
      code: 1,
      data: [
        { id: 120800420, machine_name: "Anycubic Kobra S1", create_time: 1789131228, status: 0 },
        { id: 120799976, machine_name: "Anycubic Kobra S1", create_time: 1789131000, status: 0 },
      ],
    }),
  });
  const r = await collectCloudProjects(cloud, {});
  assert.equal(r.count, 2);
  assert.equal(r.projects[0].id, 120800420);
  assert.equal(r.projects[0].machine_name, "Anycubic Kobra S1");
  assert.equal(r.read_only, true);
});

test("collectPrintMetrics aggregates outcomes and maps reason strings to labels", async () => {
  const entries = [
    { task_id: 1, print_status: 2, reason: null },
    { task_id: 2, print_status: 2, reason: null },
    { task_id: 3, print_status: 3, reason: 10101 },
    { task_id: 4, print_status: 3, reason: "The printer cannot parse the file" },
    { task_id: 5, print_status: 3, reason: "User initiated" },
    { task_id: 6, print_status: 3, reason: "Feed timeout" },
    { task_id: 7, print_status: 4, reason: null },
    { task_id: 8, print_status: 5, reason: null },
  ];
  const cloud = fakeApi({
    ["GET /v2/project/printHistory"]: () => ({
      code: 1,
      data: {
        pageData: { page: 1, page_count: 1, total: entries.length },
        list: entries,
      },
    }),
  });
  const r = await collectPrintMetrics(cloud, { limit: 100 });
  assert.equal(r.outcomes.finished, 2);
  assert.equal(r.outcomes.failed, 4);
  assert.equal(r.outcomes.cancelled, 1);
  assert.equal(r.outcomes.paused, 1);
  // Numeric 10101 -> full vocabulary label; text "The printer cannot parse the file" -> 10115 label
  assert.equal(r.failure_breakdown["Print task already exists (residual task on the printer)"], 1);
  assert.equal(r.failure_breakdown["Cannot parse the print task"], 1);
  // Unmapped text passes through verbatim
  assert.equal(r.failure_breakdown["User initiated"], 1);
  assert.equal(r.failure_breakdown["Feed timeout"], 1);
  assert.equal(r.failure_rate_pct, 50);
  assert.equal(r.success_rate_pct, 25);
});

test("failureReasonLabel maps numeric codes, descriptive text and unknown values", () => {
  assert.equal(failureReasonLabel(10101), "Print task already exists (residual task on the printer)");
  assert.equal(failureReasonLabel(11520), "Out of material");
  // Descriptive text -> reverse-matched code label (10115 -> its vocabulary label)
  assert.equal(
    failureReasonLabel("The printer cannot parse the file"),
    "Cannot parse the print task",
  );
  assert.equal(failureReasonLabel("Out of material"), "Out of material");
  // Unmapped descriptive text passes through untouched
  assert.equal(failureReasonLabel("User initiated"), "User initiated");
  assert.equal(failureReasonLabel("Feed timeout"), "Feed timeout");
  assert.equal(failureReasonLabel(9999), "code_9999");
  assert.equal(failureReasonLabel(null), "unknown");
  assert.equal(failureReasonLabel(undefined), "unknown");
});

test("collectMetricsExpose renders Prometheus text from a snapshot", () => {
  const snapshot = {
    selected: {
      printer_id: 688972,
      lifetime: { print_count: 67, material_used_kg: 2.97, print_totaltime_hours: 129.58 },
      current: { nozzle_temp_c: 34, hotbed_temp_c: 31 },
      multi_color_box: [
        {
          drying_status: { isDrying: 1, remain_time: 900 },
          slots: [
            { index: 0, consumables_percent: 13 },
            { index: 1, consumables_percent: 89 },
          ],
        },
      ],
    },
  };
  const r = collectMetricsExpose(snapshot, { printerId: 688972 });
  assert.equal(r.metrics_present, true);
  assert.equal(r.format, "prometheus_text_0_0_4");
  assert.match(r.text, /printer_print_count_total\{printer_id="688972"\} 67/);
  assert.match(r.text, /printer_material_used_kg\{printer_id="688972"\} 2\.97/);
  assert.match(r.text, /printer_temperature_c\{printer_id="688972",sensor="nozzle"\} 34/);
  assert.match(r.text, /printer_consumables_percent\{printer_id="688972",slot="0"\} 13/);
  assert.match(r.text, /printer_ace_drying_status\{printer_id="688972",box="0"\} 1/);
  assert.match(r.text, /printer_ace_drying_remain_seconds\{printer_id="688972",box="0"\} 900/);
  // Must never render [object Object]
  assert.ok(!r.text.includes("[object Object]"));
});

test("collectMetricsExpose handles empty snapshots gracefully", () => {
  const r = collectMetricsExpose({ selected: null }, { printerId: 1 });
  assert.equal(r.metrics_present, false);
  assert.equal(r.printer_id, 1);
  assert.equal(r.read_only, true);
});
