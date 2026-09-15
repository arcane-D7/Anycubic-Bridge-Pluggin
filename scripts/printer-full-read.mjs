/**
 * Exhaustive printer property reader (cloud + native LAN) and hidden command map.
 *
 * Adds the maximum read surface on top of the existing diagnostics module:
 *  - every discovered MQTT read source (info, tempature, fan, light, peripherie,
 *    aiSettings, multiColorBox, axis, extfilbox, print, file, status)
 *  - the full cloud HTTP endpoint catalog (printer_info alone returns 128 fields)
 *  - a native LAN-mode path (signed handshake + AES + local MQTT 9883)
 *  - per-source reconciliation against `printer-property-catalog.mjs`, so fields
 *    that are NOT in the catalog are surfaced as `extra` (unmapped discoveries)
 *
 * READ-ONLY BY CONSTRUCTION. Every operation performed here is a query, a GET or
 * a subscription. No motion, homing, heating, feeding, upload, print start/stop,
 * file delete, camera start or settings write is ever published. The command map
 * tool only *describes* writable channels; it cannot execute them.
 */
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { redact } from "./cloud-readonly-diagnostics.mjs";
import {
  COMMAND_MAP,
  CLOUD_HTTP_ENDPOINTS,
  CLOUD_TOPICS,
  DEFAULT_PORT_SCAN,
  LAN_TOPICS,
  LEGACY_ORDER_IDS,
  LIFECYCLE_STATES,
  PRINTER_HTTP_ENDPOINTS,
  PRINTER_MODEL,
  READ_ONLY_ACTIONS,
  READ_SOURCES,
  VALIDATED_HTTP_READ_ORDER_IDS,
  catalogStats,
  httpCatalog,
  matchHttpProperties,
  matchProperties,
  sourceById,
} from "./printer-property-catalog.mjs";

/**
 * MQTT sources that answer a read action. `multiColorBox` needs `getInfo` and
 * `file` needs `listLocal`; `status` is push-only and is never published to,
 * but it is included so captured reports can still be reconciled.
 *
 * Loaded through a lazy dynamic import so the pure offline parts of this module
 * (catalog, command map, reconciliation) can be used without side effects.
 */
export const QUERYABLE_SOURCES = Object.freeze(
  READ_SOURCES.filter(
    (source) =>
      source.action && READ_ONLY_ACTIONS.includes(source.action) && source.action !== "report",
  ).map((source) => source.id),
);

/** Sources whose read reply needs an explicit non-default action. */
export const SOURCE_ACTIONS = Object.freeze(
  Object.fromEntries(
    READ_SOURCES.filter((source) => source.action).map((source) => [source.id, source.action]),
  ),
);

const LAN_PREFIX = "anycubic/anycubicCloud/v1";
const LAN_INFO_PORT = 18910;
const LAN_MQTT_PORT = 9883;

/** Cloud diagnostic endpoint id -> generated HTTP property catalog kind. */
const HTTP_CATALOG_KIND = Object.freeze({
  printer_status: "printer_status",
  printer_info: "printer_info",
  printer_tool: "printer_tool",
  printer_functions: "printer_functions",
  multi_color_box_info: "ace",
  project_info: "project_info",
  project_monitor: "project_monitor",
  print_history_detail: "history_detail",
  gcode_info_fdm: "gcode_info_fdm",
});

const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");
const lanSign = (token, ts, nonce) => md5(`${md5(token.slice(0, 16))}${ts}${nonce}`);
const randomAlpha = (length, upper = false) => {
  const alphabet = upper
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join(
    "",
  );
};

// ---------------------------------------------------------------------------
// Native LAN-mode transport (signed handshake + AES credentials + local MQTT)
// ---------------------------------------------------------------------------

function decryptLanCredentials(encryptedInfo, printerToken, localToken) {
  const key = Buffer.from(printerToken.slice(16, 32), "ascii");
  const iv = Buffer.alloc(16);
  Buffer.from(localToken, "ascii").copy(iv, 0, 0, 16);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedInfo, "base64")),
    decipher.final(),
  ]);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (!parsed || typeof parsed !== "object")
    throw new Error("/ctrl decrypted payload was not an object");
  return parsed;
}

async function fetchJson(url, method = "GET", timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`HTTP ${response.status} from ${method} ${new URL(url).pathname}`);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object")
      throw new Error(`unexpected response from ${method} ${new URL(url).pathname}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function lanHandshake(ip, timeoutMs = 6000) {
  const info = await fetchJson(`http://${ip}:${LAN_INFO_PORT}/info`, "GET", timeoutMs);
  if (String(info.ctrlType ?? "").toLowerCase() === "cloud") {
    throw new Error(
      "Printer is in CLOUD mode; enable LAN Mode on the printer to use the LAN transport.",
    );
  }
  const printerToken = typeof info.token === "string" ? info.token : "";
  const modelId = String(info.modelId ?? "");
  if (printerToken.length < 32 || !modelId) {
    throw new Error("Printer did not expose the signed LAN handshake fields (token/modelId).");
  }
  const ts = Date.now();
  const nonce = randomAlpha(6);
  const ctrlUrl = new URL(info.ctrlInfoUrl ?? `http://${ip}:${LAN_INFO_PORT}/ctrl`);
  ctrlUrl.search = new URLSearchParams({
    ts: String(ts),
    nonce,
    sign: lanSign(printerToken, ts, nonce),
    did: randomAlpha(32, true),
  }).toString();
  const ctrl = await fetchJson(ctrlUrl.toString(), "POST", timeoutMs);
  if (Number(ctrl.code) !== 200)
    throw new Error(`/ctrl failed: ${String(ctrl.message ?? "unknown error")}`);
  const localToken = typeof ctrl.data?.token === "string" ? ctrl.data.token : "";
  const encryptedInfo = typeof ctrl.data?.info === "string" ? ctrl.data.info : "";
  if (!localToken || !encryptedInfo)
    throw new Error("/ctrl response did not contain encrypted credentials.");
  const credentials = decryptLanCredentials(encryptedInfo, printerToken, localToken);
  const broker = typeof credentials.broker === "string" ? new URL(credentials.broker) : null;
  if (!broker || !credentials.username || !credentials.password || !credentials.deviceId) {
    throw new Error("/ctrl credentials were incomplete.");
  }
  const mac = String(info.usn ?? "").match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i)?.[0];
  return {
    brokerHost: broker.hostname || ip,
    brokerPort: Number(broker.port || LAN_MQTT_PORT),
    username: String(credentials.username),
    password: String(credentials.password),
    deviceId: String(credentials.deviceId),
    modelId,
    serial: String(info.cn ?? ""),
    modelName: typeof info.modelName === "string" ? info.modelName : undefined,
    firmware: typeof info.version === "string" ? info.version : undefined,
    mac,
    info: redact(info),
  };
}

/**
 * Query every requested source over the native LAN transport and return the raw
 * (redacted) replies keyed by source id.
 */
export async function collectLanReadings({
  ip,
  sources = QUERYABLE_SOURCES,
  timeoutMs = 12000,
  mqttPort,
} = {}) {
  if (typeof ip !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(ip))
    throw new Error("IPv4 address required for the LAN transport");
  const unknown = sources.filter((id) => !sourceById(id));
  if (unknown.length) throw new Error(`Unknown read source(s): ${unknown.join(", ")}`);
  const credentials = await lanHandshake(ip, Math.min(timeoutMs, 6000));
  const mqtt = await import("mqtt");
  const connect = mqtt.default?.connect ?? mqtt.connect;
  const port = mqttPort ?? credentials.brokerPort;

  return await new Promise((resolve) => {
    const replies = {};
    const published = {};
    const client = connect({
      host: credentials.brokerHost,
      port,
      protocol: "mqtts",
      username: credentials.username,
      password: credentials.password,
      clientId: `mcp_fullread_${process.pid}_${crypto.randomUUID().slice(0, 8)}`,
      connectTimeout: 6000,
      reconnectPeriod: 0,
      clean: true,
      // The printer uses a self-signed local certificate; hostname verification
      // is meaningless for a LAN peer addressed by IP.
      rejectUnauthorized: false,
      protocolVersion: 4,
    });
    let settled = false;
    const reportPrefix = `${LAN_PREFIX}/printer/public/${credentials.modelId}/${credentials.deviceId}`;
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
      try {
        client.end(true);
      } catch {
        /* already closed */
      }
      resolve({
        transport: "lan",
        ip,
        model_id: credentials.modelId,
        mqtt_device_id: credentials.deviceId,
        serial: credentials.serial,
        ...(credentials.modelName ? { model_name: credentials.modelName } : {}),
        ...(credentials.firmware ? { firmware: credentials.firmware } : {}),
        ...(credentials.mac ? { mac: credentials.mac } : {}),
        handshake: { ...credentials.info, username: "[redacted]", password: "[redacted]" },
        published,
        sources: replies,
        ...extra,
      });
    };
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
    let quietTimer;

    client.on("error", (error) => finish({ connection_error: redact(error.message) }));
    client.on("connect", () => {
      client.subscribe(
        [
          `${reportPrefix}/#`,
          `${LAN_PREFIX}/+/public/${credentials.modelId}/${credentials.deviceId}/#`,
        ],
        { qos: 1 },
        (error) => {
          if (error)
            return finish({ connection_error: redact(`subscribe failed: ${error.message}`) });
          for (const id of sources) {
            const source = sourceById(id);
            const payload = JSON.stringify({
              type: source.type,
              action: source.action,
              timestamp: Date.now(),
              msgid: crypto.randomUUID().replace(/-/g, ""),
              data: null,
            });
            published[id] =
              `${LAN_PREFIX}/web/printer/${credentials.modelId}/${credentials.deviceId}/${source.type}`;
            client.publish(published[id], payload, { qos: 1 });
          }
          quietTimer = setTimeout(() => finish(), Math.min(4000, Math.max(1200, timeoutMs - 500)));
        },
      );
    });
    client.on("message", (topic, payload) => {
      let envelope = null;
      try {
        envelope = JSON.parse(payload.toString("utf8"));
      } catch {
        return;
      }
      const type =
        typeof envelope?.type === "string" ? envelope.type : topic.split("/").slice(-2, -1)[0];
      if (!type) return;
      const record = replies[type] ?? { state: "reply", reports: [] };
      record.reports.push(
        redact({
          action: envelope.action,
          code: envelope.code,
          state: envelope.state,
          msgid: envelope.msgid,
          data: envelope.data ?? null,
        }),
      );
      // Merge leaf values so the reconciliation sees a stable shape.
      const merged = record.data && typeof record.data === "object" ? record.data : {};
      if (envelope.data && typeof envelope.data === "object") Object.assign(merged, envelope.data);
      record.data = merged;
      replies[type] = record;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), 500);
    });
  });
}

// ---------------------------------------------------------------------------
// Cloud transport
// ---------------------------------------------------------------------------

export function cloudClient({ accessToken, resourcesDir } = {}) {
  const token =
    accessToken ??
    process.env.ANYCUBIC_CLOUD_TOKEN ??
    findSlicerJwt(process.env.APPDATA ? `${process.env.APPDATA}/AnycubicSlicerNext/log` : "");
  if (!token)
    throw new Error(
      "Anycubic cloud access_token required (env ANYCUBIC_CLOUD_TOKEN, param access_token, or the slicer log).",
    );
  // The MQTT mutual-TLS identity lives in resources/mqtt-tls of the plugin
  // root; default to it when the caller did not wire an explicit path.
  const resolvedResources = resourcesDir ?? fileURLToPath(new URL("../resources", import.meta.url));
  return new AnycubicCloud({ access_token: token, resources_dir: resolvedResources });
}

export async function collectCloudSourceReadings({
  cloud,
  printer,
  sources = QUERYABLE_SOURCES,
  timeoutMs = 20000,
}) {
  const unknown = sources.filter((id) => !sourceById(id));
  if (unknown.length) throw new Error(`Unknown read source(s): ${unknown.join(", ")}`);
  const events = [];
  const replies = {};
  const published = {};
  let client;
  try {
    client = await cloud.connectMqtt(printer, {
      onEvent: (event) =>
        events.push(
          redact({ topic: event.topic, received_at: new Date().toISOString(), data: event.data }),
        ),
    });
  } catch (error) {
    return {
      connection_error: redact(error.message),
      sources: Object.fromEntries(sources.map((id) => [id, { state: "connection_error" }])),
      events,
    };
  }
  try {
    for (const id of sources) {
      const source = sourceById(id);
      try {
        const msgid = await cloud.publishCommand(printer, source.type, source.action, {}, client);
        published[id] =
          `${CLOUD_TOPICS.command.replace("{model_id}", String(printer.machine_type)).replace("{printer_key}", String(printer.key)).replace("{type}", source.type)}`;
        replies[id] = { state: "awaiting_reply", msgid };
      } catch (error) {
        replies[id] = { state: "publish_error", error: redact(error.message) };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    for (const id of sources) {
      const entry = replies[id];
      if (!entry || entry.state === "publish_error") continue;
      const source = sourceById(id);
      const all = events.filter((event) => event.data?.type === source.type);
      const exact = all.filter((event) => event.data?.msgid === entry.msgid);
      const chosen = exact.length ? exact : all;
      entry.state = exact.length
        ? "correlated_reply"
        : all.length
          ? "uncorrelated_report"
          : "timeout";
      entry.reports = chosen;
      entry.device_codes = chosen.map((event) => event.data?.code);
      const merged = {};
      for (const event of chosen)
        if (event.data?.data && typeof event.data.data === "object")
          Object.assign(merged, event.data.data);
      entry.data = merged;
      entry.reconciliation = reconcile(id, merged);
      delete entry.msgid;
    }
    return { sources: replies, events, published };
  } finally {
    try {
      client.end(true);
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Full HTTP read surface
// ---------------------------------------------------------------------------

function buildCloudQueries({
  printerId,
  projectId,
  taskId,
  fileId,
  gcodeId,
  deviceId,
  modelId,
  typeFunctionId,
  page,
  printStatus,
}) {
  const query = {};
  if (printerId !== undefined) query.id = printerId;
  if (modelId !== undefined) query.model_id = modelId;
  if (typeFunctionId !== undefined) query.type_function_id = typeFunctionId;
  if (fileId !== undefined) query.file_id = fileId;
  if (gcodeId !== undefined) query.gcode_id = gcodeId;
  if (deviceId !== undefined) query.device_id = deviceId;
  if (taskId !== undefined) query.task_id = taskId;
  if (projectId !== undefined) query.project_id = projectId;
  if (page !== undefined) query.page = page;
  if (printStatus !== undefined) query.print_status = printStatus;
  return query;
}

/** Which query keys each endpoint consumes (from the catalog). */
function queryForEndpoint(endpoint, context) {
  const {
    printerId,
    projectId,
    taskId,
    fileId,
    gcodeId,
    deviceId,
    modelId,
    typeFunctionId,
    page,
    printStatus,
  } = context;
  const query = {};
  const has = (name, value) => {
    if (value !== undefined) query[name] = value;
  };
  switch (endpoint.id) {
    case "printers_status":
      return {};
    case "printer_status":
    case "printer_info":
    case "printer_all":
    case "multi_color_box_info":
      has("id", printerId);
      return query;
    case "printer_tool":
      has("id", printerId);
      has("model_id", modelId ?? PRINTER_MODEL.model_id);
      has("type_function_id", typeFunctionId ?? 13);
      return query;
    case "printer_functions":
      has("id", printerId);
      has("model_id", modelId ?? PRINTER_MODEL.model_id);
      return query;
    case "print_history":
      has("page", page ?? 1);
      has("limit", 20);
      has("print_status", printStatus);
      return query;
    case "print_history_detail":
      has("task_id", taskId ?? projectId);
      return query;
    case "project_info":
    case "project_monitor":
    case "work_project_error_list":
      has("id", projectId);
      return query;
    case "project_list":
      has("page", page ?? 1);
      has("limit", 100);
      has("print_status", printStatus);
      return query;
    case "gcode_info":
    case "gcode_info_fdm":
      has("id", gcodeId);
      return query;
    case "cloud_file_info":
    case "model_file_info":
      has("id", fileId);
      return query;
    case "video_thumbnail_list":
      has("device_id", deviceId);
      return query;
    default:
      return buildCloudQueries(context.query ?? {});
  }
}

/**
 * Read the full cloud HTTP endpoint catalog. Each request is independent: a
 * failure on one endpoint never discards another endpoint's result.
 */
export async function collectFullHttpReadings(cloud, context = {}) {
  const results = {};
  for (const endpoint of CLOUD_HTTP_ENDPOINTS) {
    if (
      ["login", "send_order", "user_files", "user_profile", "printer_getPrinters"].includes(
        endpoint.id,
      )
    )
      continue;
    const query = queryForEndpoint(endpoint, context);
    const catalogKind = HTTP_CATALOG_KIND[endpoint.id];
    try {
      const response = await cloud.rawApi(endpoint.method ?? "GET", endpoint.path, { query });
      // The generated HTTP catalog describes the whole JSON envelope
      // (code / msg / data.*), so reconciliation receives the full response.
      results[endpoint.id] = {
        endpoint: endpoint.path,
        query,
        state: "reply",
        evidence: endpoint.evidence,
        catalog_kind: catalogKind ?? null,
        reconciliation: catalogKind ? matchHttpProperties(catalogKind, response) : null,
        response: redact(response),
      };
    } catch (error) {
      results[endpoint.id] = {
        endpoint: endpoint.path,
        query,
        state: "error",
        evidence: endpoint.evidence,
        error: redact(error.message),
      };
    }
  }
  return results;
}

/** Account-level reads (identity, printer list, cloud files). */
export async function collectCloudAccountReadings(cloud) {
  const out = {};
  const attempt = async (id, fn) => {
    try {
      out[id] = { state: "reply", data: redact(await fn()) };
    } catch (error) {
      out[id] = { state: "error", error: redact(error.message) };
    }
  };
  await attempt("user_profile", () => cloud.rawApi("GET", "/user/profile/userInfo"));
  await attempt("printers", () => cloud.listPrinters());
  await attempt("user_files", () => cloud.rawApi("GET", "/work/index/userFiles", { query: {} }));
  return out;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function reconcile(sourceId, data) {
  const source = sourceById(sourceId);
  if (!source) return null;
  const match = matchProperties(data ?? {}, source.properties);
  return {
    catalog_count: match.catalog_count,
    observed_count: match.observed_count,
    coverage_pct: match.catalog_count
      ? Math.round((match.observed_count / match.catalog_count) * 1000) / 10
      : 0,
    matched: match.matched,
    missing: match.missing,
    extra: match.extra,
    evidence: source.evidence,
  };
}

/**
 * Full read across the requested transport. Returns per-source reconciliation,
 * HTTP results, and — when include_catalog is set — the unmapped `extra` fields.
 * Never publishes anything except read queries.
 */
export async function collectFullReadings({
  transport = "cloud",
  printerId,
  ip,
  sources = QUERYABLE_SOURCES,
  timeoutMs,
  includeHttp = false,
  includeAccount = false,
  accessToken,
  resourcesDir,
  projectId,
  taskId,
  fileId,
  gcodeId,
  deviceId,
  modelId,
  typeFunctionId,
  page,
  printStatus,
  mqttPort,
} = {}) {
  if (transport !== "cloud" && transport !== "lan")
    throw new Error("transport must be 'cloud' or 'lan'");
  if (!sources.length) throw new Error("At least one read source is required");
  const unknown = sources.filter((id) => !sourceById(id));
  if (unknown.length) throw new Error(`Unknown read source(s): ${unknown.join(", ")}`);
  for (const value of [printerId, projectId, taskId, fileId, gcodeId, deviceId]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new Error("IDs must be positive safe integers");
  }

  const result = {
    transport,
    collected_at: new Date().toISOString(),
    model: PRINTER_MODEL,
    requested_sources: sources,
    sources: {},
    http: null,
    read_only: true,
    safety: {
      published_actions: `read-only actions only (${READ_ONLY_ACTIONS.join(" / ")})`,
      no_motion_no_heat_no_upload_no_print: true,
    },
  };

  if (transport === "lan") {
    if (!ip) throw new Error("ip is required for the LAN transport");
    const readings = await collectLanReadings({
      ip,
      sources,
      timeoutMs: timeoutMs ?? 12000,
      mqttPort,
    });
    result.connection = {
      transport: "lan",
      ip: readings.ip,
      model_id: readings.model_id,
      mqtt_device_id: readings.mqtt_device_id,
      serial: readings.serial,
      model_name: readings.model_name,
      firmware: readings.firmware,
      mac: readings.mac,
      published: readings.published,
      timeout: readings.timeout,
      connection_error: readings.connection_error,
    };
    for (const id of sources) {
      const reply = readings.sources[id];
      result.sources[id] = reply
        ? {
            state: reply.state,
            device_codes: reply.reports.map((r) => r.code),
            reconciliation: reconcile(id, reply.data),
            raw: reply.data,
          }
        : { state: "timeout", reconciliation: reconcile(id, {}) };
    }
    return result;
  }

  const cloud = cloudClient({ accessToken, resourcesDir });
  await cloud.login();
  result.connection = { transport: "cloud", user_id: cloud.user?.id, user_email: "[redacted]" };
  const printers = await cloud.listPrinters();
  const printer =
    printerId === undefined ? printers[0] : printers.find((p) => Number(p.id) === printerId);
  if (!printer)
    throw new Error(
      printerId === undefined
        ? "No printer bound to this account"
        : "Requested printer is not bound to this account",
    );
  result.connection.printer_id = Number(printer.id);
  result.connection.printer_key_suffix = String(printer.key ?? "").slice(-6);
  result.connection.machine_type = printer.machine_type;

  const sourceReadings = await collectCloudSourceReadings({
    cloud,
    printer,
    sources,
    timeoutMs: timeoutMs ?? 20000,
  });
  result.connection.connection_error = sourceReadings.connection_error;
  result.events = sourceReadings.events;
  result.published_topics = sourceReadings.published ?? {};
  for (const id of sources) {
    result.sources[id] = sourceReadings.sources[id] ?? {
      state: "timeout",
      reconciliation: reconcile(id, {}),
    };
  }
  if (includeHttp) {
    result.http = await collectFullHttpReadings(cloud, {
      printerId: Number(printer.id),
      projectId,
      taskId,
      fileId,
      gcodeId,
      deviceId: deviceId ?? Number(printer.id),
      modelId: modelId ?? printer.machine_type,
      typeFunctionId,
      page,
      printStatus,
    });
  }
  if (includeAccount) result.account = await collectCloudAccountReadings(cloud);
  return result;
}

/** Offline reconciliation: compare a payload against a source catalog entry. */
export function reconcilePayload(sourceId, payload) {
  const httpEntry = HTTP_CATALOG_KIND_KEYS.includes(sourceId);
  if (httpEntry)
    return { source_id: sourceId, transport: "http", ...matchHttpProperties(sourceId, payload) };
  const source = sourceById(sourceId);
  if (!source) {
    throw new Error(
      `Unknown read source '${sourceId}'. Known MQTT: ${READ_SOURCES.map((s) => s.id).join(", ")}; known HTTP: ${HTTP_CATALOG_KIND_KEYS.join(", ")}`,
    );
  }
  return {
    source_id: sourceId,
    transport: "mqtt",
    evidence: source.evidence,
    ...reconcile(sourceId, payload),
  };
}

/** Every catalog key accepted by `reconcilePayload` (MQTT sources + HTTP kinds). */
export const HTTP_CATALOG_KIND_KEYS = Object.freeze(Object.values(HTTP_CATALOG_KIND));

/** Full description of every hidden command, topic and connection point. */
export function hiddenCommandMap() {
  const bySafety = {};
  for (const command of COMMAND_MAP) bySafety[command.safety] = (bySafety[command.safety] ?? 0) + 1;
  const byEvidence = {};
  for (const command of COMMAND_MAP)
    byEvidence[command.evidence] = (byEvidence[command.evidence] ?? 0) + 1;
  return {
    read_only: true,
    executable: false,
    note: "Describes writable channels; it cannot and does not publish any command.",
    cloud_topics: CLOUD_TOPICS,
    lan_topics: LAN_TOPICS,
    envelope: {
      type: "<source type>",
      action: "<action>",
      timestamp: "<ms>",
      msgid: "<uuid>",
      data: "<payload>",
    },
    commands: COMMAND_MAP,
    by_safety: bySafety,
    by_evidence: byEvidence,
    mqtt_read_sources: READ_SOURCES.map((source) => ({
      id: source.id,
      type: source.type,
      action: source.action,
      evidence: source.evidence,
      properties: source.properties.length,
    })),
    cloud_http_endpoints: CLOUD_HTTP_ENDPOINTS,
    printer_http_endpoints: PRINTER_HTTP_ENDPOINTS,
    legacy_http_order_ids: LEGACY_ORDER_IDS,
    validated_http_read_order_ids: VALIDATED_HTTP_READ_ORDER_IDS,
    lifecycle_states: LIFECYCLE_STATES,
    ports: DEFAULT_PORT_SCAN,
    unverified: [
      "LAN start-print payload (project_file equivalent)",
      "LAN aiSettings switch action name",
      "auto-leveler / startup self-test / release-film / residue-clean commands",
      "move-to-absolute-coordinates",
      "local and USB file delete",
      "any legacy HTTP order id whose name was not re-measured (see the 1214 collision)",
    ],
  };
}

/** Full offline catalog (no network access). */
export function propertyCatalog() {
  return {
    read_only: true,
    model: PRINTER_MODEL,
    stats: catalogStats(),
    sources: READ_SOURCES.map((source) => ({
      id: source.id,
      type: source.type,
      action: source.action,
      transport: source.transport,
      evidence: source.evidence,
      cadence_hint: source.cadence_hint ?? null,
      note: source.note ?? null,
      cloud_publish: source.cloud_publish,
      lan_publish: source.lan_publish,
      observed_actions: source.observed_actions ?? [],
      properties: source.properties,
    })),
    http_endpoints: httpCatalog(),
    cloud_http_endpoints: CLOUD_HTTP_ENDPOINTS,
    printer_http_endpoints: PRINTER_HTTP_ENDPOINTS,
    ports: DEFAULT_PORT_SCAN,
  };
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

const SOURCE_IDS = READ_SOURCES.map((source) => source.id);
const RECONCILE_IDS = [...SOURCE_IDS, ...HTTP_CATALOG_KIND_KEYS];

export function registerFullPrinterReads(server, z) {
  server.registerTool(
    "printer_read_all",
    {
      title: "Read every discovered printer property",
      description:
        "Exhaustive READ-ONLY property reader. Queries every discovered MQTT source (info, tempature, fan, light, peripherie, aiSettings, multiColorBox, axis, extfilbox, print, file, status) over the cloud account or the native LAN transport, optionally the full cloud HTTP endpoint catalog (printer_info alone returns 128 fields) and the account reads. Each source reports matched properties, catalog coverage, missing catalog entries and unmapped `extra` fields. It never moves, homes, heats, feeds, uploads, deletes, captures video or starts/stops a print.",
      inputSchema: {
        transport: z.enum(["cloud", "lan"]).default("cloud"),
        sources: z.array(z.enum(SOURCE_IDS)).min(1).optional(),
        printer_id: z.number().int().positive().optional(),
        ip: z.string().max(64).optional(),
        mqtt_port: z.number().int().min(1).max(65535).optional(),
        timeout_ms: z.number().int().min(1000).max(60000).optional(),
        include_http: z.boolean().default(false),
        include_account: z.boolean().default(false),
        access_token: z.string().max(4096).optional(),
        project_id: z.number().int().positive().optional(),
        task_id: z.number().int().positive().optional(),
        file_id: z.number().int().positive().optional(),
        gcode_id: z.number().int().positive().optional(),
        device_id: z.number().int().positive().optional(),
        model_id: z.union([z.number().int().positive(), z.string()]).optional(),
        type_function_id: z.number().int().positive().optional(),
        page: z.number().int().positive().optional(),
        print_status: z.number().int().optional(),
        resources_dir: z.string().max(1024).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await collectFullReadings(args);
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_property_catalog",
    {
      title: "List the full printer property catalog",
      description:
        "Read-only, offline catalog of every discovered printer property, its source, unit, group, evidence level and the exact LAN/cloud publish topic. It never contacts the printer or the account. Use it to decide which sources to read or to see which properties are still unverified.",
      inputSchema: { source: z.enum(SOURCE_IDS).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ source }) => {
      try {
        if (source) {
          const entry = sourceById(source);
          const data = { read_only: true, source: entry };
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          };
        }
        const data = propertyCatalog();
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_hidden_command_map",
    {
      title: "Map every printer command and connection point",
      description:
        "Read-only, offline map of EVERY discovered writable channel: cloud MQTT command topics, native LAN topics, the message envelope, each command type/action with its payload fields, safety class (read/state/thermal/motion/job), evidence level, the cloud HTTP endpoint catalog, printer HTTP endpoints, legacy order ids and the explicitly unverified operations. It only describes channels; it cannot publish anything.",
      inputSchema: { safety: z.enum(["read", "state", "thermal", "motion", "job"]).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ safety }) => {
      try {
        const map = hiddenCommandMap();
        const data = safety
          ? {
              ...map,
              commands: map.commands.filter((command) => command.safety === safety),
              filter: safety,
            }
          : map;
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_property_reconcile",
    {
      title: "Reconcile a captured payload against the property catalog",
      description:
        "Read-only, offline. Compares a previously captured payload against a catalog entry and returns matched, missing and unmapped `extra` property paths. Works for MQTT sources (info, tempature, …) and for the HTTP kinds generated from the live captures (printer_info, project_info, gcode_info_fdm, history_detail, ace, printer_status, printer_tool, printer_functions, project_monitor). Use it to find printer fields that are not yet documented, without touching the printer.",
      inputSchema: {
        source: z.enum(RECONCILE_IDS),
        payload: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ source, payload }) => {
      try {
        const data = { read_only: true, ...reconcilePayload(source, payload) };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );
}
