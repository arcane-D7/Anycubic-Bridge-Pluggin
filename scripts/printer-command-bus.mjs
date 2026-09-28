/**
 * Persistent cloud MQTT connection manager + full command bus.
 *
 * Fixes two audit findings:
 *  1. Every tool call used to create and tear down a fresh cloud MQTT
 *     connection. Concurrent clients sharing the deterministic identity can
 *     DISPLACE each other (CONNACK loop), so a shared persistent session is
 *     both the stability fix and the correct usage of the broker.
 *  2. No registered MCP tool exposed the validated cloud control surface
 *     (light, temperature, fans, speed, pause/resume/stop, ACE dry/feed/
 *     auto-feed/slot, axis move). This module is that surface.
 *
 * Safety model:
 *  - `confirm: true` is REQUIRED for every non-read command. The handler
 *    refuses otherwise — a schema default can never trigger an action.
 *  - Commands are classified: read / state / thermal / motion / job.
 *  - Motion and job commands additionally require `confirm_word: "EXECUTE"`.
 *  - `printer_print_start` (cloud order 1, filetype 0) implements the
 *    corrected contract validated LIVE on 2026-09-11 (task <TASK_ID> made
 *    the device preheat and start): START_PRINT is order id 1 (int), the
 *    body carries slice_param, and ams_info is set from an explicit ACE
 *    mapping. It resolves gcode_id -> cloud file id via /work/gcode/infoFdm
 *    FIRST, refuses to start while the printer is busy, requires an explicit
 *    ACE mapping when use_ams is set, and only reports success after the
 *    created task is observed to preserve model/gcode_id/slice metadata AND
 *    the device enters an active preparation state. HTTP acceptance alone is
 *    never success.
 */
import crypto from "node:crypto";
import { AnycubicCloud } from "./anycubic-cloud.mjs";
import { redact } from "./cloud-readonly-diagnostics.mjs";
import { COMMANDS, COMMAND_SAFETY } from "./printer-command-bus-catalog.mjs";

export { COMMANDS, COMMAND_SAFETY };

const CMD_TOPICS = Object.freeze({
  command: (machineType, key, type) =>
    `anycubic/anycubicCloud/v1/pc/printer/${machineType}/${key}/${type}`,
});

/** Payload builders for each executable command (grammar documented in the catalog). */
const COMMAND_BUILDERS = Object.freeze({
  light_control: (a) => ({
    type: a.light_type ?? 2,
    status: a.on ? 1 : 0,
    brightness: a.on ? (a.brightness ?? 100) : 0,
  }),
  fan_set: (a) => {
    if (a.fan === "aux") return { aux_fan_speed_pct: a.speed_pct };
    if (a.fan === "box") return { box_fan_level: a.speed_pct };
    return { fan_speed_pct: a.speed_pct };
  },
  ace_auto_feed: (a) => ({
    multi_color_box: [{ id: a.box_id ?? 0, auto_feed: a.enabled ? 1 : 0 }],
  }),
  ace_set_slot: (a) => ({
    multi_color_box: [
      {
        id: a.box_id ?? 0,
        slots: [{ index: a.slot_index, type: a.material_type, color: a.color }],
      },
    ],
  }),
  ai_settings_set: (a) => ({
    ai_settings: {
      status: a.enabled ? 3 : 0,
      type: a.type ?? 2,
      count: a.count ?? 60,
      sensitivity_level: a.sensitivity_level ?? [1, 1],
      notice_type: a.notice_type ?? [0, 1],
    },
  }),
  temperature_set: (a) => ({
    type: a.nozzle !== undefined && a.bed !== undefined ? 2 : a.bed !== undefined ? 1 : 0,
    target_nozzle_temp: a.nozzle ?? 0,
    target_hotbed_temp: a.bed ?? 0,
  }),
  ace_dry: (a) => ({
    multi_color_box: [
      {
        id: a.box_id ?? 0,
        drying_status: {
          status: a.stop ? 0 : 1,
          target_temp: a.target_temp ?? 45,
          duration: a.duration_min ?? 240,
          remain_time: 0,
        },
      },
    ],
  }),
  print_update: (a) => {
    // Any subset of running-job settings; taskid identifies the live job.
    const settings = {};
    if (a.nozzle !== undefined) settings.target_nozzle_temp = a.nozzle;
    if (a.bed !== undefined) settings.target_hotbed_temp = a.bed;
    if (a.fan !== undefined && a.speed_pct !== undefined) {
      settings[
        a.fan === "aux" ? "aux_fan_speed_pct" : a.fan === "box" ? "box_fan_level" : "fan_speed_pct"
      ] = a.speed_pct;
    }
    if (a.print_speed_mode !== undefined) settings.print_speed_mode = a.print_speed_mode;
    if (!Object.keys(settings).length)
      throw new Error(
        "print_update requires at least one setting (nozzle, bed, fan+speed_pct or print_speed_mode)",
      );
    return { taskid: a.task_id, settings };
  },
  video_start_capture: () => null,
  video_stop_capture: () => null,
  axis_turn_off: () => null,
  axis_move: (a) => ({ axis: a.axis, move_type: a.move_type, distance: a.distance_mm ?? 0 }),
  ace_feed: (a) => ({
    multi_color_box: [
      { id: a.box_id ?? 0, feed_status: { slot_index: a.slot_index, type: a.feed_type ?? 1 } },
    ],
  }),
  print_pause: (a) => ({ taskid: a.task_id }),
  print_resume: (a) => ({ taskid: a.task_id }),
  print_stop: () => ({ taskid: "-1" }),
  print_start: (a) => ({
    filetype: 1,
    file_name: a.file_name,
    file_key: "",
    filename: a.file_name,
    filepath: a.file_path ?? `/${a.file_name}`,
    task_settings: { ai_detect: a.ai_detect ? 1 : 0, camera_timelapse: a.camera_timelapse ? 1 : 0 },
  }),
  print_query: () => null,
});

/** Commands that need the extra EXECUTE word on top of confirm:true. */
const EXECUTE_WORD_SAFETY = COMMAND_SAFETY.EXECUTE_WORD;

// ---------------------------------------------------------------------------
// Persistent connection manager
// ---------------------------------------------------------------------------

export class CloudConnectionManager {
  constructor({ cloud, log } = {}) {
    this.cloud = cloud;
    this.log = log ?? (() => {});
    this.client = null;
    this.printerKey = null;
    this.events = [];
    this.maxEvents = 500;
    this.eventWaiters = new Set();
    this.connecting = null;
    this.lastActivity = 0;
    this.stats = { connects: 0, published: 0, received: 0, reconnects: 0 };
  }

  /**
   * Return a live, subscribed MQTT client for the printer. Reuses the existing
   * connection when it is healthy; a health check pings the socket without a
   * full reconnect.
   */
  async acquire(printer, { subscribeReports = true } = {}) {
    const key = `${printer.machine_type}/${printer.key}`;
    if (
      this.client &&
      this.printerKey === key &&
      !this.client.disconnected &&
      !this.client.disconnecting
    ) {
      this.lastActivity = Date.now();
      return this.client;
    }
    if (this.client) await this.release();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.stats.connects += 1;
      const client = await this.cloud.connectMqtt(printer, {
        onEvent: (event) => this.#onEvent(event),
      });
      this.client = client;
      this.printerKey = key;
      this.lastActivity = Date.now();
      client.on("close", () => {
        if (this.client === client) this.client = null;
      });
      client.on("error", (error) => {
        this.log(`mqtt client error: ${redact(error.message)}`);
        // Force the next acquire to reconnect; do not throw from the event.
        if (this.client === client) this.client = null;
      });
      return client;
    })();
    try {
      const client = await this.connecting;
      return client;
    } finally {
      this.connecting = null;
    }
  }

  /** Gracefully end the persistent session. */
  async release() {
    const client = this.client;
    this.client = null;
    this.printerKey = null;
    if (client) {
      try {
        await client.endAsync(true);
      } catch {
        /* already closed */
      }
    }
  }

  #onEvent(event) {
    this.stats.received += 1;
    this.lastActivity = Date.now();
    const record = redact({
      topic: event.topic,
      received_at: new Date().toISOString(),
      data: event.data,
    });
    this.events.push(record);
    if (this.events.length > this.maxEvents)
      this.events.splice(0, this.events.length - this.maxEvents);
    for (const waiter of this.eventWaiters) waiter(record);
  }

  /** Publish a typed command envelope and return the msgid. */
  async publish(printer, commandId, args, client) {
    const command = COMMANDS[commandId];
    if (!command)
      throw new Error(`Unknown command '${commandId}'. Known: ${Object.keys(COMMANDS).join(", ")}`);
    const builder = COMMAND_BUILDERS[commandId];
    if (!builder) throw new Error(`Command '${commandId}' has no payload builder.`);
    const data = builder(args ?? {});
    const topic = CMD_TOPICS.command(printer.machine_type, printer.key, command.type);
    const msgid = crypto.randomUUID();
    await new Promise((resolve, reject) =>
      client.publish(
        topic,
        JSON.stringify({
          type: command.type,
          action: command.action,
          timestamp: Date.now(),
          msgid,
          data,
        }),
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    this.stats.published += 1;
    return { msgid, topic, data };
  }

  /**
   * Wait for a device report that answers a msgid. The device often replies
   * with its own msgid, so both exact and type-scoped matches are accepted;
   * the match mode is reported instead of hidden.
   */
  async waitForReply(type, msgid, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    const scan = () => {
      const typed = this.events.filter((event) => event.data?.type === type);
      const exact = typed.filter((event) => event.data?.msgid === msgid);
      if (exact.length) return { state: "correlated_reply", reports: exact };
      if (typed.length) return { state: "uncorrelated_report", reports: typed };
      return null;
    };
    const existing = scan();
    if (existing) return existing;
    return await new Promise((resolve) => {
      const waiter = () => {
        const found = scan();
        if (found) {
          this.eventWaiters.delete(waiter);
          clearInterval(poll);
          resolve(found);
        }
      };
      const poll = setInterval(waiter, 250);
      this.eventWaiters.add(waiter);
      setTimeout(
        () => {
          this.eventWaiters.delete(waiter);
          clearInterval(poll);
          resolve({ state: "timeout", reports: [] });
        },
        Math.max(250, timeoutMs - (Date.now() - (deadline - timeoutMs))),
      );
    });
  }

  /** Connection health snapshot for diagnostics. */
  health() {
    return {
      connected: Boolean(this.client && !this.client.disconnected && !this.client.disconnecting),
      printer_key_suffix: this.printerKey ? `${this.printerKey.slice(-6)}` : null,
      last_activity_age_ms: this.lastActivity ? Date.now() - this.lastActivity : null,
      buffered_events: this.events.length,
      stats: { ...this.stats },
    };
  }
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

export function assertConfirm(commandId, args) {
  const command = COMMANDS[commandId];
  if (!command) throw new Error(`Unknown command '${commandId}'`);
  if (command.safety === "read") return;
  if (args?.confirm !== true) {
    throw new Error(
      `Command '${commandId}' (safety: ${command.safety}) requires confirm: true. Nothing was sent.`,
    );
  }
  if (EXECUTE_WORD_SAFETY.has(command.safety) && args?.confirm_word !== "EXECUTE") {
    throw new Error(
      `Command '${commandId}' (safety: ${command.safety}) additionally requires confirm_word: "EXECUTE". Nothing was sent.`,
    );
  }
}

/** Busy-guard source: prefer the live MQTT state, fall back to the cloud flag. */
export function assertIdle(printer, { liveState } = {}) {
  const state = (liveState ?? printer?.reason ?? "").toString().toLowerCase();
  const busyStates = [
    "printing",
    "paused",
    "pausing",
    "resuming",
    "preheating",
    "busy",
    "calibrating",
    "leveling",
    "vibrating",
    "preheat",
  ];
  if (busyStates.some((busy) => state.includes(busy))) {
    throw new Error(
      `Printer reports state '${state}' — refusing to start a new print. Stop or finish the active job first.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cloud print start — LIVE-VALIDATED contract (order 1 / filetype 0)
// ---------------------------------------------------------------------------

/**
 * Resolve a gcode_id to the cloud file metadata needed by order 1.
 * The G-code id — not the task id — is the key for /work/gcode/infoFdm.
 */
export async function resolveCloudGcode(cloud, gcodeId) {
  const info = await cloud.rawApi("GET", "/work/gcode/infoFdm", { query: { id: gcodeId } });
  const data = info?.data ?? {};
  const fileId = Number(data.file_id ?? 0);
  if (!fileId) {
    throw new Error(
      `gcode_id ${gcodeId} has no resolved cloud file id (slice info may be missing; the cloud only regenerates it for slicer uploads). Response: ${JSON.stringify(redact(data)).slice(0, 300)}`,
    );
  }
  return {
    file_id: fileId,
    gcode_id: Number(data.gcode_id ?? gcodeId),
    name: data.name ?? null,
    status: Number(data.status ?? 0),
    size: data.size ?? null,
    md5: data.slice_result?.sliced_md5 ?? null,
    total_layers: data.slice_result?.total_layers ?? null,
    print_time_s: data.slice_result?.print_time ?? null,
    slice_param: data.slice_param ?? null,
  };
}

/**
 * Build the corrected START_PRINT body (order 1, filetype 0, cloud file).
 * Mirrors the wire shape validated LIVE 2026-09-11 against the physical
 * printer (tasks <TASK_ID>/<TASK_ID>) and the Nino6689/anycubic-cloud-api
 * reference (AnycubicStartPrintRequestCloud + AnycubicProjectCtrlOrderRequest).
 *
 * Load-bearing details (each one wrong was observed to hang or reject
 * silently on the device):
 *  - `order_id` must be the INTEGER 1 — START_PRINT is AnycubicOrderID.
 *    START_PRINT (reference IntEnum). 1240 is NOT START_PRINT: the server
 *    answers "Operation successful" and never creates a task; order 1
 *    returns data.task_id and the printer starts.
 *  - `file_key` must be the EMPTY STRING (not the cloud file id).
 *  - `data` carries `file_id` (+ slice/matrix fields), NOT gcode_id.
 *  - `slice_param` (full) is required — null slice_param never starts.
 *  - `ams_info` is null when no ACE mapping (not `{use_ams:false}`).
 *  - `settings` is null, `project_id` is 0 at the top level.
 *  - Top-level msgid/timestamp are NOT part of the reference sendOrder params
 *    (only the response carries msgid).
 */
export function buildCloudStartPrintBody({
  printer,
  gcode,
  file_name,
  ai_detect = 1,
  camera_timelapse = 0,
  ams,
}) {
  if (!gcode?.file_id)
    throw new Error(
      "A resolved cloud file id is required (filetype 0). Local-file starts are a separate command.",
    );
  const name = (file_name ?? gcode.name ?? "print").replace(/\.gcode(\.3mf)?$/i, "");
  const amsInfo = ams
    ? {
        ams_box_mapping: ams.ams_box_mapping ?? [],
        use_ams: Boolean(ams.ams_box_mapping?.length),
      }
    : null;
  // START_PRINT is order id 1 (AnycubicOrderID.START_PRINT, validated live
  // 2026-09-11 by creating tasks <TASK_ID>/<TASK_ID>). Earlier builds used
  // 1240, which the server accepts with "Operation successful" but never
  // creates a task. The mobile-app and MCP 10115 evidence both used 1.
  const body = {
    printer_id: printer.id,
    order_id: 1,
    project_id: 0,
    data: {
      filetype: 0,
      file_key: "",
      file_name: name,
      file_id: gcode.file_id,
      hollow_param: null,
      is_delete_file: 0,
      matrix: "",
      project_type: 1,
      punching_param: null,
      // Slice metadata is load-bearing: the silently-swallowed variants sent
      // null and no task appeared; the working live probe passed it through.
      slice_param: gcode.slice_param ?? null,
      slice_size: null,
      template_id: 0,
      task_settings: { ai_detect: ai_detect ? 1 : 0, camera_timelapse: camera_timelapse ? 1 : 0 },
    },
    ams_info: amsInfo,
    settings: null,
  };
  // Guard from the incident: a local-filetype body with an empty filepath.
  if (body.data.filetype === 1 && !body.data.filepath) {
    throw new Error(
      "Refusing to send filetype=1 with an empty filepath (the 10115 malformed order).",
    );
  }
  if (
    ams &&
    ams.use_ams === true &&
    !(Array.isArray(ams.ams_box_mapping) && ams.ams_box_mapping.length)
  ) {
    throw new Error(
      "use_ams requires an explicit ams_box_mapping (slot -> ams_index). paint_index must not be assumed to be a physical slot.",
    );
  }
  return body;
}

/**
 * Verify a freshly created task actually references the requested file and has
 * entered an active state. HTTP acceptance is NOT success.
 */
export function verifyStartedTask(taskInfo, { gcode, taskId }) {
  const data = taskInfo?.data ?? {};
  const observed = {
    task_id: String(data.taskid ?? data.task_id ?? data.id ?? ""),
    model: Number(data.model ?? 0),
    gcode_id: Number(data.gcode_id ?? 0),
    print_status: Number(data.print_status ?? 0),
    state: data.state ?? null,
    slice_param_present: data.slice_param != null,
    slice_result_present: data.slice_result != null,
  };
  const problems = [];
  if (taskId && observed.task_id && observed.task_id !== String(taskId))
    problems.push(`task id mismatch (asked ${taskId}, observed ${observed.task_id})`);
  if (gcode) {
    if (observed.model && gcode.file_id && observed.model !== gcode.file_id)
      problems.push(`model ${observed.model} != requested file id ${gcode.file_id}`);
    if (observed.gcode_id && gcode.gcode_id && observed.gcode_id !== gcode.gcode_id)
      problems.push(`gcode_id ${observed.gcode_id} != requested ${gcode.gcode_id}`);
    if (!observed.slice_param_present)
      problems.push(
        "slice_param missing — the task is malformed and will be rejected by the device (10115)",
      );
  }
  const activeStates = [1, 2, 3, 4, 5, 13];
  const active =
    activeStates.includes(observed.print_status) ||
    ["preheating", "printing", "paused", "auto_leveling", "vibrating", "flow_calibrating"].includes(
      String(observed.state ?? "").toLowerCase(),
    );
  return { observed, active, problems, verified: problems.length === 0 && active };
}

// ---------------------------------------------------------------------------
// Orchestrated command execution
// ---------------------------------------------------------------------------

/**
 * Execute a cloud command end to end on the persistent connection:
 * acquire -> publish -> wait for the device reply -> classify the outcome.
 */
export async function executeCloudCommand(
  manager,
  printer,
  commandId,
  args = {},
  { replyTimeoutMs = 8000 } = {},
) {
  assertConfirm(commandId, args);
  const command = COMMANDS[commandId];
  if (!command)
    throw new Error(`Unknown command '${commandId}'. Known: ${Object.keys(COMMANDS).join(", ")}`);
  const client = await manager.acquire(printer);
  const { msgid, topic, data } = await manager.publish(printer, commandId, args, client);
  const reply = await manager.waitForReply(command.type, msgid, replyTimeoutMs);
  const deviceCodes = reply.reports
    .map((event) => event.data?.code)
    .filter((code) => code !== undefined);
  const deviceError = reply.reports.find((event) => event.data?.code && event.data.code !== 200);
  return {
    ok: reply.state !== "timeout" && !deviceError,
    command: commandId,
    safety: command.safety,
    type: command.type,
    action: command.action,
    msgid,
    topic: redact(topic),
    sent_data: redact(data),
    reply_state: reply.state,
    match_mode:
      reply.state === "correlated_reply"
        ? "msgid"
        : reply.state === "uncorrelated_report"
          ? "type-only"
          : "none",
    device_codes: deviceCodes,
    device_error: deviceError
      ? redact(deviceError.data?.msg ?? `code ${deviceError.data?.code}`)
      : null,
    replies: reply.reports.slice(0, 5),
    note:
      reply.state === "timeout"
        ? "No device reply inside the window. A timeout is not proof of failure or of success; re-check with printer_read_all."
        : deviceError
          ? "The device answered with an error code; the command did not take effect."
          : "Device reply received. HTTP/MQTT acceptance with code 200 confirms transport handling, not always physical execution.",
  };
}

/**
 * Cloud print start with the full LIVE-VALIDATED contract:
 * busy-guard -> resolve gcode -> build order 1 body -> send -> verify the task.
 * (2026-09-11: task <TASK_ID> reached `printing` on the physical Kobra S1.)
 */
export async function cloudPrintStart(
  manager,
  cloud,
  printer,
  args = {},
  { verifyTimeoutMs = 25000 } = {},
) {
  if (args.confirm !== true || args.confirm_word !== "EXECUTE") {
    throw new Error(
      'cloud print start requires confirm: true AND confirm_word: "EXECUTE". Nothing was sent.',
    );
  }
  assertIdle(printer, { liveState: args.live_state });
  if (!args.gcode_id)
    throw new Error("gcode_id is required (a cloud G-code already processed by the slicer/cloud).");
  const gcode = await resolveCloudGcode(cloud, args.gcode_id);
  const body = buildCloudStartPrintBody({
    printer,
    gcode,
    file_name: args.file_name,
    ai_detect: args.ai_detect ?? 1,
    camera_timelapse: args.camera_timelapse ?? 0,
    ams: args.ams ? { ...args.ams } : null,
  });
  // Keep the persistent MQTT session alive so the preparation reports stream in.
  const client = await manager.acquire(printer);
  void client;
  const response = await cloud.rawApi("POST", "/work/operation/sendOrder", { params: body });
  const taskId = response?.data?.task_id ?? response?.data?.id ?? null;
  const verification = {
    http_accepted: Number(response?.code) === 1,
    task_id: taskId ? String(taskId) : null,
    observed: null,
    active: false,
    problems: [],
    verified: false,
  };
  if (verification.http_accepted) {
    // Wait for the device/task to surface state, then confirm the contract.
    const deadline = Date.now() + verifyTimeoutMs;
    while (Date.now() < deadline && !verification.verified) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const printEvents = manager.events.filter(
        (event) => event.data?.type === "print" || event.data?.type === "info",
      );
      const taskEvent = printEvents.find((event) => {
        const payload = event.data?.data ?? {};
        return (
          payload.taskid !== undefined ||
          payload.task_id !== undefined ||
          payload.project !== undefined
        );
      });
      if (taskEvent) {
        const payload = taskEvent.data?.data ?? {};
        const project = payload.project ?? payload;
        const check = verifyStartedTask(
          { data: { ...project, taskid: project.taskid ?? project.task_id ?? taskId } },
          { gcode, taskId },
        );
        verification.observed = check.observed;
        verification.active = check.active;
        verification.problems = check.problems;
        verification.verified = check.verified;
        if (check.observed?.print_status === 3) {
          verification.problems.push(
            "print_status 3 (rejected) — see reason_id on the task; do not retry automatically.",
          );
          break;
        }
      }
    }
  }
  return {
    ok: verification.http_accepted && verification.verified,
    http_accepted: verification.http_accepted,
    task_id: verification.task_id,
    resolved_gcode: redact(gcode),
    verification,
    note: verification.verified
      ? "Task verified: file reference preserved and the device entered an active preparation state."
      : verification.http_accepted
        ? "HTTP accepted but the task was NOT verified. Per the 2026-09-07 incident this is not success; inspect the task with printer_read_all before any retry. Never re-send the order automatically."
        : "The workbench rejected the order.",
  };
}

/** Convenience factory used by the MCP layer. */
export function createManager({ accessToken, resourcesDir, log, cloud } = {}) {
  if (cloud) return new CloudConnectionManager({ cloud, log });
  const token = accessToken ?? process.env.ANYCUBIC_CLOUD_TOKEN ?? null;
  const anycubic = new AnycubicCloud({ access_token: token, resources_dir: resourcesDir, log });
  return new CloudConnectionManager({ cloud: anycubic, log });
}
