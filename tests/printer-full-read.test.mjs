import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "zod";

import {
  COMMAND_MAP,
  CLOUD_HTTP_ENDPOINTS,
  DEFAULT_PORT_SCAN,
  HTTP_PROPERTY_CATALOG,
  LEGACY_ORDER_IDS,
  PRINTER_HTTP_ENDPOINTS,
  READ_ONLY_ACTIONS,
  READ_SOURCES,
  VALIDATED_HTTP_READ_ORDER_IDS,
  catalogStats,
  commandByTypeAction,
  flattenProperties,
  matchHttpProperties,
  matchProperties,
  sourceById,
} from "../scripts/printer-property-catalog.mjs";

import {
  HTTP_CATALOG_KIND_KEYS,
  QUERYABLE_SOURCES,
  collectFullReadings,
  collectCloudSourceReadings,
  collectLanReadings,
  hiddenCommandMap,
  propertyCatalog,
  reconcilePayload,
  registerFullPrinterReads,
} from "../scripts/printer-full-read.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const EVIDENCE = path.join(root, "docs", "evidence");

function readEvidence(name) {
  return JSON.parse(fs.readFileSync(path.join(EVIDENCE, name), "utf8"));
}

function livePayloads() {
  const payloads = [];
  const files = fs
    .readdirSync(EVIDENCE)
    .filter((f) => f.startsWith("cloud-") && f.endsWith(".json"));
  for (const file of files) {
    const capture = JSON.parse(fs.readFileSync(path.join(EVIDENCE, file), "utf8"));
    for (const event of capture.events ?? []) {
      const type = event.topic?.split("/")[0];
      if (type && event.data?.data) payloads.push({ file, type, payload: event.data.data });
    }
  }
  // Sweep events were archived under poc-output/_archive-screenshots; fall back
  // to the original root location for checkouts that still have it.
  const sweepPath = ["poc-output/_archive-screenshots/.sweep-events.json", ".sweep-events.json"]
    .map((p) => path.join(root, p))
    .find((p) => fs.existsSync(p));
  if (sweepPath) {
    const sweep = JSON.parse(fs.readFileSync(sweepPath, "utf8"));
    for (const event of sweep) {
      const type = event.topic?.split("/")[0];
      if (type && event.data?.data)
        payloads.push({ file: path.basename(sweepPath), type, payload: event.data.data });
    }
  }
  return payloads;
}

// --- catalog integrity ------------------------------------------------------

test("catalog identifiers are unique and every property is fully described", () => {
  const ids = READ_SOURCES.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate read source id");
  assert.equal(new Set(CLOUD_HTTP_ENDPOINTS.map((e) => e.id)).size, CLOUD_HTTP_ENDPOINTS.length);
  assert.equal(
    new Set(PRINTER_HTTP_ENDPOINTS.map((e) => e.path)).size,
    PRINTER_HTTP_ENDPOINTS.length,
  );

  const allowedEvidence = new Set(["live", "mapping", "reference", "hypothesis"]);
  const allowedTypes = new Set(["number", "string", "boolean", "array", "object", "object|null"]);
  for (const source of READ_SOURCES) {
    assert.ok(
      allowedEvidence.has(source.evidence),
      `${source.id}: bad evidence ${source.evidence}`,
    );
    assert.ok(source.properties.length > 0, `${source.id}: no properties`);
    const paths = new Set();
    for (const property of source.properties) {
      assert.ok(property.path?.length, `${source.id}: property without a path`);
      assert.ok(!paths.has(property.path), `${source.id}: duplicate path ${property.path}`);
      paths.add(property.path);
      assert.ok(
        allowedTypes.has(property.type),
        `${source.id}/${property.path}: bad type ${property.type}`,
      );
      assert.ok(property.group?.length, `${source.id}/${property.path}: missing group`);
    }
    for (const derived of ["cloud_publish", "lan_publish"]) {
      if (source[derived] === null) continue;
      assert.match(
        String(source[derived]),
        /\{model_id\}/,
        `${source.id}: ${derived} must be a topic template`,
      );
    }
  }
});

test("every command declares a safety class and an evidence level", () => {
  const allowedSafety = new Set(["read", "state", "thermal", "motion", "job"]);
  const allowedEvidence = new Set(["live", "mapping", "reference", "hypothesis"]);
  for (const command of COMMAND_MAP) {
    assert.ok(command.type?.length, "command without type");
    assert.ok(command.action?.length, "command without action");
    assert.ok(
      allowedSafety.has(command.safety),
      `${command.type}/${command.action}: bad safety ${command.safety}`,
    );
    assert.ok(
      allowedEvidence.has(command.evidence),
      `${command.type}/${command.action}: bad evidence`,
    );
  }
  const readOnly = COMMAND_MAP.filter((command) => command.safety === "read");
  assert.ok(readOnly.length > 0, "read-only commands must exist");
  assert.ok(
    COMMAND_MAP.some((command) => command.safety === "job"),
    "job commands must be classified",
  );
  assert.equal(commandByTypeAction("light", "control")?.evidence, "live");
});

test("catalog stats stay consistent with the source list", () => {
  const stats = catalogStats();
  const manual = READ_SOURCES.reduce((sum, source) => sum + source.properties.length, 0);
  const httpManual = Object.values(HTTP_PROPERTY_CATALOG).reduce(
    (sum, entry) => sum + entry.properties.length,
    0,
  );
  assert.equal(stats.sources, READ_SOURCES.length);
  assert.equal(stats.total_properties, manual);
  assert.equal(stats.http_properties, httpManual);
  assert.equal(stats.grand_total_properties, manual + httpManual);
  assert.equal(stats.commands, COMMAND_MAP.length);
  assert.equal(stats.cloud_http_endpoints, CLOUD_HTTP_ENDPOINTS.length);
  assert.equal(stats.printer_http_endpoints, PRINTER_HTTP_ENDPOINTS.length);
  assert.ok(
    stats.total_properties >= 110,
    `expected a broad MQTT catalog, got ${stats.total_properties}`,
  );
  assert.ok(
    stats.http_properties >= 400,
    `expected a broad HTTP catalog, got ${stats.http_properties}`,
  );
  assert.ok(
    stats.grand_total_properties >= 500,
    `expected a broad total catalog, got ${stats.grand_total_properties}`,
  );
});

test("generated HTTP catalog covers the richest live endpoints", () => {
  assert.equal(HTTP_PROPERTY_CATALOG.printer_info.properties.length, 128);
  assert.equal(HTTP_PROPERTY_CATALOG.project_info.properties.length, 126);
  assert.equal(HTTP_PROPERTY_CATALOG.gcode_info_fdm.properties.length, 63);
  assert.equal(HTTP_PROPERTY_CATALOG.history_detail.properties.length, 50);
  assert.equal(HTTP_PROPERTY_CATALOG.ace.properties.length, 33);
  assert.equal(HTTP_PROPERTY_CATALOG.printer_info.path, "/v2/printer/info");
  for (const entry of Object.values(HTTP_PROPERTY_CATALOG)) {
    assert.equal(
      entry.evidence,
      "live",
      "every generated HTTP endpoint must come from live evidence",
    );
    assert.ok(
      new Set(entry.properties.map((p) => p.path)).size === entry.properties.length,
      "duplicate HTTP path",
    );
    assert.ok(
      entry.properties.every((p) => p.group?.length),
      "every HTTP property needs a group",
    );
  }
});

test("validated HTTP read order ids match the corrected live values", () => {
  assert.equal(VALIDATED_HTTP_READ_ORDER_IDS.axis, 1214);
  assert.equal(VALIDATED_HTTP_READ_ORDER_IDS.peripherie, 1231);
  assert.equal(VALIDATED_HTTP_READ_ORDER_IDS.light, 1232);
  assert.equal(VALIDATED_HTTP_READ_ORDER_IDS.multiColorBox, 1206);
  assert.equal(VALIDATED_HTTP_READ_ORDER_IDS.local_files, 103);
  assert.equal(VALIDATED_HTTP_READ_ORDER_IDS.usb_files, 101);
  // The legacy map is descriptive only and must keep documenting the collision.
  assert.equal(LEGACY_ORDER_IDS.SET_TEMPERATURE, LEGACY_ORDER_IDS.QUERY_AXIS_POSITION);
});

// --- flattening / matching --------------------------------------------------

test("flattenProperties normalises arrays, nesting and empty containers", () => {
  const flat = flattenProperties({
    a: 1,
    b: { c: "x", d: null },
    e: [{ f: 2 }, { f: 3 }],
    g: [],
    h: { i: { j: true } },
  });
  assert.equal(flat.a, 1);
  assert.equal(flat["b.c"], "x");
  assert.equal(flat["b.d"], null);
  assert.equal(flat["e[].f"], 2, "the first array element defines the shape");
  assert.deepEqual(flat.g, []);
  assert.equal(flat["h.i.j"], true);
  // Repeated array entries must not multiply the flattened key count.
  assert.equal(Object.keys(flat).filter((key) => key === "e[].f").length, 1);
});

test("matchProperties separates matched, missing and unmapped extra paths", () => {
  const source = sourceById("fan");
  const result = matchProperties(
    { fan_speed_pct: 100, box_fan_level: 2, unmapped_field: 7 },
    source.properties,
  );
  assert.equal(result.catalog_count, 3);
  assert.equal(result.observed_count, 2);
  assert.deepEqual(result.matched.map((m) => m.path).sort(), ["box_fan_level", "fan_speed_pct"]);
  assert.deepEqual(result.missing, ["aux_fan_speed_pct"]);
  assert.deepEqual(result.extra, ["unmapped_field"]);
});

test("matchProperties resolves indexed array paths through nested objects", () => {
  const source = sourceById("multiColorBox");
  const payload = JSON.parse(
    JSON.stringify({
      multi_color_box: [
        {
          id: 0,
          status: 1,
          model_id: 40002,
          auto_feed: 0,
          loaded_slot: -1,
          temp: 41,
          humidity: 25,
          feed_status: { code: 200, type: -1, current_status: -1, slot_index: -1 },
          drying_status: { status: 0, target_temp: 0, duration: 0, remain_time: 0 },
          slots: [
            {
              index: 0,
              sku: "AHHSGY-107",
              type: "PLA High Speed",
              color: [117, 120, 123],
              edit_status: 0,
              status: 5,
              color_group: [[117, 120, 123, 255]],
              icon_type: 0,
              consumables_percent: 13,
            },
          ],
        },
      ],
      head_tools_model: 0,
    }),
  );
  const result = matchProperties(payload, source.properties);
  assert.deepEqual(result.extra, [], `unmapped ACE fields: ${result.extra.join(", ")}`);
  assert.deepEqual(result.missing, []);
  const sku = result.matched.find((m) => m.path === "multi_color_box[].slots[].sku");
  assert.equal(sku.value, "AHHSGY-107");
  assert.equal(sku.group, "ace");
});

// --- coverage against real captured traffic ---------------------------------

test("every live-captured report field is covered by the catalog", () => {
  const payloads = livePayloads();
  assert.ok(payloads.length >= 10, `expected live payloads, got ${payloads.length}`);
  const unmapped = [];
  const covered = new Set();
  for (const { file, type, payload } of payloads) {
    const source = sourceById(type);
    assert.ok(source, `no catalog source for live type '${type}'`);
    const result = matchProperties(payload, source.properties);
    for (const extra of result.extra) unmapped.push(`${file}:${type}:${extra}`);
    covered.add(type);
  }
  assert.deepEqual(unmapped, [], `unmapped live fields:\n${unmapped.join("\n")}`);
  assert.ok(covered.size >= 9, `expected broad coverage, got ${[...covered].join(", ")}`);
});

test("live evidence reconciles through the public reconcile helper", () => {
  const capture = readEvidence("cloud-printer-id-1789077239432.json");
  const axis = capture.events.find((event) => event.topic === "axis/report");
  const result = reconcilePayload("axis", axis.data.data);
  assert.equal(result.evidence, "live");
  assert.equal(result.extra.length, 0);
  assert.equal(result.coverage_pct, 100);
  const zCoord = result.matched.find((m) => m.path === "coordinates.z");
  assert.equal(zCoord.unit, "millimeter");
  assert.equal(typeof zCoord.value, "number");
});

test("reconcile rejects an unknown source instead of guessing", () => {
  assert.throws(() => reconcilePayload("not-a-source", {}), /Unknown read source/);
});

// --- read-only guarantees --------------------------------------------------

test("the hidden command map is descriptive only and never executable", () => {
  const map = hiddenCommandMap();
  assert.equal(map.read_only, true);
  assert.equal(map.executable, false);
  assert.equal(map.by_safety.read, COMMAND_MAP.filter((c) => c.safety === "read").length);
  const serialized = JSON.stringify(map);
  assert.doesNotMatch(serialized, /password|client\.key/i);
  assert.deepEqual(map.ports, [...DEFAULT_PORT_SCAN]);
  assert.ok(map.unverified.length >= 5, "unverified operations must stay documented");
  // Command topics must be templates, never concrete printers.
  assert.match(map.cloud_topics.command, /\{printer_key\}/);
  assert.match(map.lan_topics.command, /\{mqtt_device_id\}/);
});

test("the offline property catalog performs no network access", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network access is not allowed here");
  };
  try {
    const catalog = propertyCatalog();
    assert.equal(catalog.read_only, true);
    assert.equal(catalog.sources.length, READ_SOURCES.length);
    assert.ok(catalog.stats.total_properties > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- orchestration validation ----------------------------------------------

test("collectFullReadings rejects unknown transports, sources and identifiers", async () => {
  await assert.rejects(collectFullReadings({ transport: "wifi" }), /transport must be/);
  await assert.rejects(collectFullReadings({ sources: [] }), /At least one read source/);
  await assert.rejects(collectFullReadings({ sources: ["move_axis"] }), /Unknown read source/);
  await assert.rejects(collectFullReadings({ transport: "lan" }), /ip is required/);
  await assert.rejects(collectFullReadings({ printerId: -1 }), /positive safe integers/);
  await assert.rejects(collectFullReadings({ printerId: 1.5 }), /positive safe integers/);
});

test("collectLanReadings refuses non-IPv4 targets and unknown sources", async () => {
  await assert.rejects(collectLanReadings({ ip: "http://example.com" }), /IPv4 address required/);
  await assert.rejects(collectLanReadings({ ip: "192.168.3.110/24" }), /IPv4 address required/);
  await assert.rejects(
    collectLanReadings({ ip: "192.168.3.110", sources: ["nope"] }),
    /Unknown read source/,
  );
});

test("cloud source reads keep timeouts, publish errors and replies independent", async () => {
  let emit;
  let ended = false;
  const published = [];
  const cloud = {
    connectMqtt: async (_printer, options) => {
      emit = options.onEvent;
      return {
        end: () => {
          ended = true;
        },
      };
    },
    publishCommand: async (_printer, type, action) => {
      published.push(`${type}/${action}`);
      if (type === "fan") throw new Error("publish refused");
      const requestId = `${type}-request-id`;
      // Reports arrive after the publish returns, exactly like the broker.
      queueMicrotask(() => {
        if (type === "axis")
          emit({
            topic: "axis/report",
            data: {
              type,
              msgid: requestId,
              code: 200,
              data: { coordinates: { x: 1, y: 2, z: 3 } },
            },
          });
        if (type === "info")
          emit({
            topic: "info/report",
            data: { type, msgid: "device-generated", code: 200, data: { state: "free" } },
          });
      });
      return requestId;
    },
  };
  const result = await collectCloudSourceReadings({
    cloud,
    printer: { id: 688972, machine_type: "20025", key: "abc" },
    sources: ["axis", "info", "print", "fan"],
    timeoutMs: 120,
  });
  assert.equal(result.sources.axis.state, "correlated_reply");
  assert.equal(result.sources.info.state, "uncorrelated_report");
  assert.equal(result.sources.print.state, "timeout");
  assert.equal(result.sources.fan.state, "publish_error");
  assert.equal(result.sources.axis.reconciliation.coverage_pct, 100);
  assert.ok(result.sources.info.reconciliation.coverage_pct > 0);
  assert.deepEqual(published.sort(), ["axis/query", "fan/query", "info/query", "print/query"]);
  assert.ok(ended, "the MQTT client must always be closed");
});

test("every queryable source only ever publishes its read action", async () => {
  const published = [];
  const cloud = {
    connectMqtt: async () => ({ end: () => {} }),
    publishCommand: async (_printer, type, action) => {
      published.push({ type, action });
      return "id";
    },
  };
  await collectCloudSourceReadings({
    cloud,
    printer: { id: 1, machine_type: "20025", key: "k" },
    sources: QUERYABLE_SOURCES,
    timeoutMs: 60,
  });
  assert.equal(
    published.length,
    QUERYABLE_SOURCES.length,
    "every queryable source must be exercised",
  );
  for (const entry of published) {
    assert.ok(
      READ_ONLY_ACTIONS.includes(entry.action),
      `non-read action published: ${entry.type}/${entry.action}`,
    );
  }
  const ace = published.find((entry) => entry.type === "multiColorBox");
  assert.equal(ace.action, "getInfo", "ACE requires the getInfo action");
  const files = published.find((entry) => entry.type === "file");
  assert.equal(files.action, "listLocal", "file listing uses the listLocal action");
  // The push-only status source must never be published to.
  assert.ok(
    !published.some((entry) => entry.type === "status"),
    "status is push-only and must not be queried",
  );
});

// --- MCP registration -------------------------------------------------------

test("the full-read module registers its four tools with read-only annotations", () => {
  const registered = new Map();
  const server = {
    registerTool: (name, config, handler) => registered.set(name, { config, handler }),
  };
  registerFullPrinterReads(server, z);
  assert.deepEqual([...registered.keys()].sort(), [
    "printer_hidden_command_map",
    "printer_property_catalog",
    "printer_property_reconcile",
    "printer_read_all",
  ]);
  for (const [name, { config }] of registered) {
    assert.equal(config.annotations.readOnlyHint, true, `${name} must be read-only`);
    assert.ok(config.description.length > 40, `${name} needs a descriptive description`);
  }
  assert.equal(registered.get("printer_read_all").config.annotations.openWorldHint, true);
  assert.equal(
    registered.get("printer_hidden_command_map").config.annotations.openWorldHint,
    false,
  );
});

test("registered handlers answer offline without contacting a printer", async () => {
  const registered = new Map();
  registerFullPrinterReads(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
  );

  const catalog = await registered.get("printer_property_catalog").handler({});
  assert.equal(catalog.structuredContent.read_only, true);
  assert.ok(catalog.structuredContent.stats.grand_total_properties > 500);
  assert.ok(catalog.structuredContent.http_endpoints.length >= 9);

  const single = await registered.get("printer_property_catalog").handler({ source: "tempature" });
  assert.equal(single.structuredContent.source.id, "tempature");
  assert.ok(
    single.structuredContent.source.properties.some(
      (property) => property.path === "curr_chamber_temp",
    ),
  );

  const map = await registered.get("printer_hidden_command_map").handler({});
  assert.equal(map.structuredContent.executable, false);

  const filtered = await registered.get("printer_hidden_command_map").handler({ safety: "job" });
  assert.ok(filtered.structuredContent.commands.length > 0);
  assert.ok(filtered.structuredContent.commands.every((command) => command.safety === "job"));

  const reconcile = await registered.get("printer_property_reconcile").handler({
    source: "peripherie",
    payload: { camera: 1, multiColorBox: 1, udisk: 1 },
  });
  assert.equal(reconcile.structuredContent.extra.length, 0);
  assert.equal(reconcile.structuredContent.coverage_pct, 100);

  // HTTP kinds are accepted by the same tool.
  const http = await registered.get("printer_property_reconcile").handler({
    source: "printer_status",
    payload: {
      code: 1,
      msg: "ok",
      data: { is_printing: 0, device_status: 1, key: "k", id: 688972, machine_type: "20025" },
    },
  });
  assert.equal(http.structuredContent.transport, "http");
  assert.equal(http.structuredContent.extra.length, 0);
  assert.equal(http.structuredContent.coverage_pct, 100);
});

test("reconciling a live HTTP capture leaves no unmapped field", () => {
  const capture = readEvidence("cloud-printer-id-1789077239432.json");
  const info = capture.http.printer_info;
  assert.equal(info.state, "reply");
  const result = matchHttpProperties("printer_info", info.response);
  assert.deepEqual(result.extra, [], `unmapped printer_info fields: ${result.extra.join(", ")}`);
  assert.equal(result.coverage_pct, 100);
  assert.equal(result.matched.find((m) => m.path === "data.machine_data.size_x").group, "identity");

  const project = matchHttpProperties("project_info", capture.http.project_info.response);
  assert.deepEqual(project.extra, []);
  const gcode = matchHttpProperties("gcode_info_fdm", capture.http.gcode_info_fdm.response);
  assert.deepEqual(gcode.extra, []);
  const history = matchHttpProperties("history_detail", capture.http.history_detail.response);
  assert.deepEqual(history.extra, []);
  const ace = matchHttpProperties("ace", capture.http.ace.response);
  assert.deepEqual(ace.extra, []);
});

test("every generated HTTP catalog kind reconciles its own live capture exactly", () => {
  const captures = ["cloud-printer-id-1789077239432.json", "http-read-orders-1789077058851.json"].map(
    (name) => readEvidence(name),
  );
  const sources = {
    printer_status: "printer_status",
    printer_info: "printer_info",
    printer_tool: "printer_tool",
    printer_functions: "printer_functions",
    ace: "ace",
    project_info: "project_info",
    project_monitor: "project_monitor",
    history_detail: "history_detail",
    gcode_info_fdm: "gcode_info_fdm",
  };
  const checked = new Set();
  for (const capture of captures) {
    for (const [key, entry] of Object.entries(capture.http ?? {})) {
      if (entry.state !== "reply" || !sources[key]) continue;
      const result = matchHttpProperties(key, entry.response);
      assert.deepEqual(result.extra, [], `${key}: unmapped fields ${result.extra.join(", ")}`);
      checked.add(key);
    }
  }
  assert.equal(
    checked.size,
    Object.keys(sources).length,
    `not all endpoints were checked: ${[...checked].join(", ")}`,
  );
});

test("an empty HTTP payload reports every catalog path as missing", () => {
  for (const kind of HTTP_CATALOG_KIND_KEYS) {
    const result = reconcilePayload(kind, {});
    assert.equal(result.transport, "http");
    assert.equal(result.kind, kind);
    assert.equal(result.matched.length, 0);
    assert.equal(result.missing.length, HTTP_PROPERTY_CATALOG[kind].properties.length);
  }
});

test("a handler failure returns an error result without leaking internals", async () => {
  const registered = new Map();
  registerFullPrinterReads(
    { registerTool: (name, config, handler) => registered.set(name, { config, handler }) },
    z,
  );
  const reply = await registered
    .get("printer_property_reconcile")
    .handler({ source: "nope", payload: {} });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /Unknown read source/);
});

