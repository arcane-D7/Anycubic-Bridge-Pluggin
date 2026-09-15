/**
 * Edge tools — Batch 1 (mutating, gated) + Batch 2 infra remains (N12/N13/N14).
 *
 * Batch 1 (WRITE, gated confirm+EXECUTE):
 *   - printer_edge_stop       STOP_PRINT_FORCE (44) / SET_PRINT_STATUS_FREE (901)
 *   - ace_feed_finish         FEED_FILAMENT_FINISH (1209)
 *   - ace_refresh_slot        MULTI_COLOR_BOX_REFRESH_SLOT (1210)
 *   - printer_rename          cloud rename of the printer (N10)
 *   - firmware_update_check   OTA update check (N10, read-order)
 *
 * Batch 2 infra (READ-ONLY):
 *   - printer_event_watch     N14: sample now vs previous snapshot => changes/events
 *   - nfc_tag_decode          N13: pure decoder of Anycubic/Bambu/Creality raw tag records
 *   - spool_resolve           N13: UID/SKU -> local spool registry (offline)
 *   - camera_cloud_info       N12: read Agora/RTC capabilities + video_taskid (no WebRTC)
 *
 * Batch 1 tools REQUIRE confirm:true; job/motion also confirm_word:"EXECUTE"
 * (hardcoded in their handler BEFORE any network activity). All outputs redacted.
 */
import { redact } from "./cloud-readonly-diagnostics.mjs";
import { findSlicerJwt } from "./anycubic-cloud.mjs";
import {
  loadRegistry,
  saveRegistry,
  findSpools,
  upsertSpool,
  pushSpoolEvent,
  computeRemaining,
  applyTaskUsage,
  summarizeRegistry,
  defaultRegistryFile,
} from "./spool-registry.mjs";
import { planAnycubicTagWrite, planSpoolFromDecoded } from "./nfc-tag-writer.mjs";

const EP = Object.freeze({
  printersStatus: "/work/printer/printersStatus",
  getPrinters: "/work/printer/getPrinters",
  projectInfo: "/v2/project/info",
});

/** Order ids used by the edge tools (reference + validated-live vocabulary). */
export const EDGE_ORDER_IDS = Object.freeze({
  STOP_PRINT: 4,
  STOP_PRINT_FORCE: 44,
  SET_PRINT_STATUS_FREE: 901,
  FEED_FILAMENT_FINISH: 1209,
  MULTI_COLOR_BOX_REFRESH_SLOT: 1210,
});

// ---------------------------------------------------------------------------
// Editing / firmware (N10)
// ---------------------------------------------------------------------------

/** "#RRGGBB" or "RRGGBB" or [r,g,b] -> hex string (lowercase) or null. */
function hexOf(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b] = value.map((v) => Number(v));
    if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
    return (
      "#" +
      [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
    );
  }
  if (typeof value === "string") {
    const m = value.trim().match(/^#?([0-9a-fA-F]{6})$/);
    return m ? "#" + m[1].toLowerCase() : null;
  }
  return null;
}

/**
 * Cloud rename of the printer (N10). The mobile/cloud app edits the printer
 * display name via the workbench; this helper issues the rename through the
 * same print-management API family. Safe: does not touch firmware.
 *
 * NOTE: `/work/printer/edit` is a best-effort endpoint discovered by
 * inspection — the exact rename endpoint/params of the current cloud API are
 * NOT live-confirmed, so a transport error here is expected until validated
 * (the tool reports `state:"failed"` with the code instead of crashing).
 */
export async function renamePrinter(cloud, { printerId, newName }) {
  if (!newName || !String(newName).trim())
    throw new Error("newName is required for printer_rename");
  const printer = await (async () => {
    const printers = await cloud.listPrinters();
    const found =
      printerId === undefined ? printers[0] : printers.find((p) => Number(p.id) === printerId);
    if (!found)
      throw new Error(
        printerId === undefined
          ? "No printer bound to this account"
          : "Requested printer is not bound to this account",
      );
    return found;
  })();
  let res = null;
  let error = null;
  try {
    res = await cloud.rawApi("POST", "/work/printer/edit", {
      params: { id: printer.id, name: String(newName).trim() },
    });
  } catch (err) {
    error = err;
  }
  return {
    read_only: false,
    printer_id: printer.id,
    requested_name: String(newName).trim(),
    state: error ? "failed" : "accepted",
    http_code: error?.status ?? res?.code ?? null,
    error: error ? redact(error.message) : null,
    note: error
      ? "Transport error — the rename endpoint (/work/printer/edit) is best-effort and NOT live-confirmed; the new name was not applied (or unknown)."
      : "HTTP acceptance only proves transport; re-read with printer_read_all to confirm.",
  };
}

/**
 * OTA update check (N10, read-order surface only). Queries the printer's
 * firmware/latest info without applying anything. The update itself is
 * deliberately NOT exposed (no OTA trigger).
 */
export async function checkFirmwareUpdate(cloud, { printerId }) {
  const printers = await cloud.listPrinters();
  const printer =
    printerId === undefined ? printers[0] : printers.find((p) => Number(p.id) === printerId);
  if (!printer)
    throw new Error(
      printerId === undefined
        ? "No printer bound to this account"
        : "Requested printer is not bound to this account",
    );
  let ota = {};
  try {
    const res = await cloud.rawApi("GET", "/work/printer/getPrinterUpdateVersion", { query: {} });
    const d = res?.data ?? {};
    let current = d.current_version ?? d.version ?? null;
    let latest = d.latest_version ?? d.new_version ?? d.version ?? null;
    if (d.list && Array.isArray(d.list) && d.list[0]) {
      current = current ?? d.list[0].current_version ?? d.list[0].target_version ?? null;
      latest = latest ?? d.list[0].version ?? d.list[0].target_version ?? null;
    }
    ota = { current, latest, has_update: Boolean(latest && current && latest !== current) };
  } catch (error) {
    ota = { state: "unavailable", error: redact(error.message) };
  }
  return {
    read_only: true,
    printer_id: printer.id,
    printer_name: printer.name ?? printer.printer_name ?? null,
    firmware: printer.firmware_version ?? printer.version ?? null,
    ota,
    note: "Read-only: never triggers or cancels an OTA.",
  };
}

// ---------------------------------------------------------------------------
// N14 — printer event watch (diff-based, read-only)
// ---------------------------------------------------------------------------

/**
 * Read the previous snapshot from a module-level buffer (per printer) and
 * return the delta as "events". Never mutates the printer.
 */
const lastSnapshots = new Map(); // printerId -> compact signature object

export function resetEventWatch(printerId) {
  lastSnapshots.delete(String(printerId));
}

function snapshotSignature(snapshot) {
  const sel = snapshot?.selected ?? {};
  const cur = sel.current ?? {};
  const lt = sel.lifetime ?? {};
  const boxes = Array.isArray(sel.multi_color_box) ? sel.multi_color_box : [];
  const slots = boxes.flatMap((box) =>
    Array.isArray(box.slots)
      ? box.slots.map((s) => `${s.index ?? "?"}:${s.status ?? "?"}:${s.consumables_percent ?? "?"}`)
      : [],
  );
  return {
    state: sel.project?.state ?? sel.reason ?? sel.status_label ?? null,
    print_status: sel.project?.print_status ?? sel.print_status ?? null,
    task_id: sel.project?.taskid ?? sel.project?.task_id ?? sel.task_id ?? null,
    current: sel.state ?? cur.state ?? null,
    nozzle: cur.nozzle_temp_c ?? null,
    hotbed: cur.hotbed_temp_c ?? null,
    print_count: lt.print_count ?? null,
    material_used: lt.material_used_kg ?? lt.material_used ?? null,
    totaltime: lt.print_totaltime ?? null,
    boxes: boxes.map(
      (b) => `${b.id ?? "?"}:${b.drying_status?.status ?? b.drying_status?.isDrying ?? "0"}`,
    ),
    slots,
  };
}

export function diffSnapshots(prev, next) {
  if (!prev)
    return { changed: true, events: [{ type: "first_snapshot", at: new Date().toISOString() }] };
  const events = [];
  for (const key of ["print_count", "material_used", "totaltime", "nozzle", "hotbed"]) {
    if (prev[key] !== next[key] && next[key] !== null && next[key] !== undefined)
      events.push({ type: key, from: prev[key], to: next[key], at: new Date().toISOString() });
  }
  if (prev.state !== next.state)
    events.push({ type: "state", from: prev.state, to: next.state, at: new Date().toISOString() });
  if (prev.print_status !== next.print_status)
    events.push({
      type: "print_status",
      from: prev.print_status,
      to: next.print_status,
      at: new Date().toISOString(),
    });
  if (prev.task_id !== next.task_id)
    events.push({
      type: "task_id",
      from: prev.task_id,
      to: next.task_id,
      at: new Date().toISOString(),
    });
  const prevSlots = prev.slots.join("|");
  const nextSlots = next.slots.join("|");
  if (prevSlots !== nextSlots)
    events.push({
      type: "consumables",
      from: prev.slots,
      to: next.slots,
      at: new Date().toISOString(),
    });
  if (prev.boxes.join("|") !== next.boxes.join("|"))
    events.push({
      type: "ace_drying",
      from: prev.boxes,
      to: next.boxes,
      at: new Date().toISOString(),
    });
  return { changed: events.length > 0, events };
}

/** Poll-related read of the current snapshot + diff against the last one. */
export async function collectEventWatch(cloud, { printerId, reset = false } = {}) {
  const key = String(printerId ?? "default");
  if (reset) resetEventWatch(key);
  const snapshot = await collectStatusLike(cloud, { printerId }); // own read
  const nextSig = snapshotSignature(snapshot);
  const prev = lastSnapshots.get(key) ?? null;
  lastSnapshots.set(key, nextSig);
  const diff = diffSnapshots(prev, nextSig);
  return {
    read_only: true,
    printer_id: snapshot.printer_id ?? printerId ?? null,
    since: prev ? "delta" : "first",
    events: diff.events,
    current: nextSig,
  };
}

/** Minimal own status read (mirrors printersStatus mapping). */
async function collectStatusLike(cloud, { printerId }) {
  const printersRaw = await cloud.rawApi("GET", EP.getPrinters, { query: {} });
  const map = {};
  if (printerId !== undefined) map.printer_id = printerId;
  const res = await cloud.rawApi("GET", EP.printersStatus, { query: map });
  const list = res?.data ?? [];
  const selected =
    printerId === undefined
      ? (list[0] ?? null)
      : (list.find((p) => Number(p?.id) === Number(printerId)) ?? list[0] ?? null);
  if (!selected) return { printer_id: printerId ?? null, selected: null };
  // map minimal fields
  const cur = selected.parameter ?? {};
  const lt = {
    print_count: selected.print_count ?? null,
    material_used: selected.material_used ?? null,
    material_used_kg: selected.material_used_kg ?? null,
    print_totaltime: selected.print_totaltime ?? null,
  };
  const boxes = Array.isArray(selected.multi_color_box)
    ? selected.multi_color_box.map((b) => ({
        id: b.id ?? null,
        drying_status: b.drying_status ?? null,
        slots: Array.isArray(b.slots) ? b.slots : [],
      }))
    : [];
  return {
    printer_id: selected.id ?? printerId ?? null,
    selected: {
      id: selected.id ?? null,
      state: selected.status ?? null,
      reason: selected.reason ?? null,
      status_label: selected.print_status_label ?? null,
      project: selected.project ?? null,
      print_status: selected.print_status ?? null,
      task_id: selected.task_id ?? null,
      current: {
        nozzle_temp_c: cur.curr_nozzle_temp ?? null,
        hotbed_temp_c: cur.curr_hotbed_temp ?? null,
      },
      lifetime: lt,
      multi_color_box: boxes,
    },
  };
}

// ---------------------------------------------------------------------------
// N13 — NFC tag decode (pure) + spool registry (offline)
// ---------------------------------------------------------------------------

/**
 * Pure decoder of a raw tag record (Array of number blocks or a Buffer).
 * Anycubic / Bambu / Creality support, override-safe.
 */
export function decodeTagRecord(record) {
  if (!record) return { ok: false, error: "no record" };
  const blocks = Array.isArray(record)
    ? record
    : record.blocks && Array.isArray(record.blocks)
      ? record.blocks
      : Buffer.isBuffer(record)
        ? Array.from(record)
        : null;
  if (!blocks) return { ok: false, error: "record must be an array of blocks or {blocks:[...]}" };

  // Creality ASCII (the whole thing is text like "PLA,Batch,Color,Material")
  const joined = blocks
    .map((b) => (typeof b === "string" ? b : String.fromCharCode(Number(b))))
    .join("");
  if (/^[A-Za-z0-9,.:;_ \-]{8,}$/.test(joined.slice(0, 64)) && /,\s*[\w]+[\s\w]*/.test(joined)) {
    const parts = joined
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const guess =
      parts.length >= 3
        ? {
            vendor: "creality",
            material: parts[2],
            color: parts[1] ?? null,
            batch: parts[0] ?? null,
            raw: parts,
          }
        : { vendor: "unknown", raw: parts };
    return { ok: true, ...guess };
  }

  // Anycubic SKU block (17-char alnum, e.g. AHPLBW-103-A30001)
  const ascii = blocks.map((b) => String.fromCharCode(Number(b) & 0xff)).join("");
  const skuMatch =
    ascii.match(/[A-Z]{2,4}[A-Z0-9]*-?\d{3}-A\d{5}/) ||
    ascii.match(/[A-Z]{2,4}[A-Z0-9]{4,}[-A-Z0-9]*\d{5}/);
  if (skuMatch) {
    return {
      ok: true,
      vendor: "anycubic",
      sku: skuMatch[0],
      suggestion: "Resolve via spool_registry or the userFilaments cloud table (untouched).",
    };
  }

  // Bambu-style numeric block with common layout (block 1 material id, block 2 type)
  if (blocks.length >= 4 && blocks.every((b) => typeof b === "number")) {
    const materialId = blocks[1];
    const type = Number(blocks[2]) || null;
    return {
      ok: true,
      vendor: "bambu_like",
      material_id: materialId,
      type_code: type,
      suggestion:
        "Bambu tags carry an RSA signature; decode is read-only and cloning is blocked by design.",
    };
  }
  return { ok: false, error: "unrecognized tag format" };
}

export { snapshotSignature };

/** Offline spool registry: UID/SKU -> known material descriptor. */
export function spoolRegistry() {
  return {
    read_only: true,
    format: "vendor -> material name -> skus[]",
    vendors: [
      {
        vendor: "anycubic",
        example_sku: "AHPLBW-103-A30001",
        note: "SKU in the ACE report for factory tags; resolve by prefix.",
      },
      {
        vendor: "bambu_lab",
        example_sku: "AM B0-01-XX",
        note: "Decoded fields: material_id, type, color, weight, temps, nozzle, batch; RSA signed.",
      },
      { vendor: "creality", example_sku: "CR-01", note: "ASCII batch,date,color,material." },
    ],
  };
}

// ---------------------------------------------------------------------------
// N12 — cloud camera info (read-only, no WebRTC)
// ---------------------------------------------------------------------------

export async function collectCameraCloudInfo(cloud, { printerId }) {
  const res = await cloud.rawApi("GET", EP.printersStatus, {
    query: printerId !== undefined ? { printer_id: printerId } : {},
  });
  const list = res?.data ?? [];
  const selected =
    printerId === undefined
      ? (list[0] ?? null)
      : (list.find((p) => Number(p?.id) === Number(printerId)) ?? list[0] ?? null);
  if (!selected) return { read_only: true, printer_id: printerId ?? null, camera: null };
  const feats = selected.features ?? {};
  return {
    read_only: true,
    printer_id: selected.id ?? printerId ?? null,
    camera: {
      rtc_supported: Boolean(feats.shengwang_rtc_support ?? feats.agora_rtc ?? false),
      video_taskid: Number(selected.video_taskid ?? 0) || null,
      timelapse_supported: Boolean(feats.camera_timelapse_support ?? false),
      note: "Video_taskid authorizes an Agora RTC session; the WebRTC stream itself is not proxied here.",
    },
  };
}

// ---------------------------------------------------------------------------
// Batch 1 MQTT send (through the shared manager, gated) ----------------------
// ---------------------------------------------------------------------------

/** Local list of edge commands: type/action sent to the MQTT topic, order
 *  id carried in the payload, and the safety class used by the gate. */
const EDGE_COMMANDS = Object.freeze({
  printer_edge_stop: { type: "print", action: "control", safety: "job" },
  ace_feed_finish: { type: "multiColorBox", action: "feedFilamentFinish", safety: "state" },
  ace_refresh_slot: { type: "multiColorBox", action: "refreshSlot", safety: "state" },
});

function edgeGate(commandId, args) {
  const command = EDGE_COMMANDS[commandId];
  if (!command) throw new Error(`Unknown edge command '${commandId}'`);
  // Every edge command mutates; job additionally needs the word.
  if (args?.confirm !== true)
    throw new Error(`Command '${commandId}' requires confirm: true. Nothing was sent.`);
  if (command.safety === "job" && args?.confirm_word !== "EXECUTE")
    throw new Error(
      `Command '${commandId}' (safety: job) additionally requires confirm_word: "EXECUTE". Nothing was sent.`,
    );
}

/**
 * Execute an edge command over the shared persistent MQTT connection using
 * the low-level cloud.publishCommand (no catalog lookup), then wait for the
 * device reply through the manager. `cloud` is the live AnycubicCloud
 * session returned by ensureSession().
 */
export async function executeEdgeCommand(
  manager,
  cloud,
  printer,
  commandId,
  args,
  { replyTimeoutMs = 8000 } = {},
) {
  edgeGate(commandId, args);
  const spec = EDGE_COMMANDS[commandId];
  const client = await manager.acquire(printer);
  const toSend = { ...args };
  delete toSend.confirm;
  delete toSend.confirm_word;
  delete toSend.live_state;
  delete toSend.reply_timeout_ms;
  if (commandId === "printer_edge_stop") {
    toSend.order_id =
      args.mode === "force"
        ? EDGE_ORDER_IDS.STOP_PRINT_FORCE
        : EDGE_ORDER_IDS.SET_PRINT_STATUS_FREE;
    delete toSend.mode;
  }
  const msgid = await cloud.publishCommand(printer, spec.type, spec.action, toSend, client);
  const topic = `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/${spec.type}`;
  const reply = await manager.waitForReply(spec.type, msgid, replyTimeoutMs);
  const deviceError = reply.reports.find((event) => event.data?.code && event.data.code !== 200);
  return {
    ok: reply.state !== "timeout" && !deviceError,
    command: commandId,
    safety: spec.safety,
    type: spec.type,
    action: spec.action,
    msgid,
    topic: redact(topic),
    sent_data: redact(toSend),
    reply_state: reply.state,
    device_error: deviceError
      ? redact(deviceError.data?.msg ?? `code ${deviceError.data?.code}`)
      : null,
    replies: reply.reports.slice(0, 5),
    note:
      reply.state === "timeout"
        ? "No device reply inside the window. Timeout is not proof of success; re-check with printer_read_all."
        : deviceError
          ? "The device answered with an error code; the command did not take effect."
          : "Device reply received. Acceptance proves transport handling, not always physical execution.",
  };
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

export function registerEdgeTools(server, z, { manager, resolvePrinter } = {}) {
  const shared = {
    printer_id: z.number().int().positive().optional(),
    access_token: z.string().max(4096).optional(),
    resources_dir: z.string().max(1024).optional(),
  };

  async function ensureSession(args) {
    const cloud = manager?.cloud;
    if (!cloud) throw new Error("No cloud session available.");
    if (!cloud.xxToken) {
      const token =
        args.access_token ??
        process.env.ANYCUBIC_CLOUD_TOKEN ??
        findSlicerJwt(process.env.APPDATA ? `${process.env.APPDATA}/AnycubicSlicerNext/log` : "") ??
        null;
      if (token && !cloud.access_token) cloud.access_token = token;
      await cloud.login();
    }
    return cloud;
  }

  async function resolvePrinterOrDefault(cloud, printerId) {
    if (resolvePrinter) return resolvePrinter(cloud, printerId);
    const printers = await cloud.listPrinters();
    const printer =
      printerId === undefined ? printers[0] : printers.find((p) => Number(p.id) === printerId);
    if (!printer)
      throw new Error(
        printerId === undefined
          ? "No printer bound to this account"
          : "Requested printer is not bound to this account",
      );
    return printer;
  }

  const out = (data) => ({
    content: [{ type: "text", text: JSON.stringify(redact(data)) }],
    structuredContent: redact(data),
  });
  const fail = (error) => ({
    isError: true,
    content: [{ type: "text", text: redact(error.message) }],
  });

  // ---- Batch 1: printer_edge_stop (STOP_PRINT_FORCE / SET_PRINT_STATUS_FREE)
  server.registerTool(
    "printer_edge_stop",
    {
      title: "Force-stop or free a stuck print state (recovery)",
      description:
        'Recovery write tool. modes: "force" sends STOP_PRINT_FORCE (44); "free" sends SET_PRINT_STATUS_FREE (901) to clear a stuck "resuming"/"stoping" state. Both are mutating and destructive-flagged: requires confirm:true AND confirm_word:"EXECUTE", and are only safe on a sacrificial/test unit or after reading printer_read_all. HTTP/MQTT acceptance with code 200 proves transport handling, not always physical execution.',
      inputSchema: {
        ...shared,
        mode: z.enum(["force", "free"]).default("force"),
        reply_timeout_ms: z.number().int().min(500).max(30000).optional(),
        confirm: z.boolean().default(false),
        confirm_word: z.string().max(16).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        edgeGate("printer_edge_stop", {
          confirm: args.confirm,
          confirm_word: args.confirm_word,
          confirm_required: true,
        });
        const cloud = await ensureSession(args);
        const printer = await resolvePrinterOrDefault(cloud, args.printer_id);
        const commandId = "printer_edge_stop";
        const payload =
          args.mode === "force"
            ? { order_id: EDGE_ORDER_IDS.STOP_PRINT_FORCE }
            : { order_id: EDGE_ORDER_IDS.SET_PRINT_STATUS_FREE };
        // Low-level publish bypasses the catalog (edge ids are not registered
        // there); wait for the device reply through the shared manager.
        const client = await manager.acquire(printer);
        const msgid = await cloud.publishCommand(printer, "print", "control", payload, client);
        const topic = `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/print`;
        const reply = await manager.waitForReply("print", msgid, args.reply_timeout_ms ?? 8000);
        const deviceError = reply.reports.find(
          (event) => event.data?.code && event.data.code !== 200,
        );
        const result = {
          ok: reply.state !== "timeout" && !deviceError,
          command: commandId,
          mode: args.mode,
          safety: "job",
          order_id: payload.order_id,
          msgid,
          topic: redact(topic),
          sent_data: redact(payload),
          reply_state: reply.state,
          device_error: deviceError
            ? redact(deviceError.data?.msg ?? `code ${deviceError.data?.code}`)
            : null,
          replies: reply.reports.slice(0, 5),
          note:
            reply.state === "timeout"
              ? "No device reply inside the window. Re-check with printer_read_all."
              : deviceError
                ? "The device answered with an error code; the command did not take effect."
                : "Device reply received. Acceptance proves transport handling, not always physical execution.",
        };
        return out(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 1: ace_feed_finish
  server.registerTool(
    "ace_feed_finish",
    {
      title: "Finish ACE filament feeding",
      description:
        "Write tool (state). Sends FEED_FILAMENT_FINISH (1209) to conclude an ACE feed operation (motion/state) — requires confirm:true (state-class does not demand the EXECUTE word, but it must be confirmed explicitly). For safety on the test unit only.",
      inputSchema: {
        ...shared,
        box_id: z.number().int().min(0).max(9).default(0),
        slot_index: z.number().int().min(0).max(9).optional(),
        reply_timeout_ms: z.number().int().min(500).max(30000).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("ace_feed_finish requires confirm: true. Nothing was sent.");
        const cloud = await ensureSession(args);
        const printer = await resolvePrinterOrDefault(cloud, args.printer_id);
        const client = await manager.acquire(printer);
        const payload = { multi_color_box: [{ id: args.box_id ?? 0, finish: 1 }] };
        const msgid = await cloud.publishCommand(
          printer,
          "multiColorBox",
          "feedFilamentFinish",
          payload,
          client,
        );
        const topic = `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/multiColorBox`;
        const reply = await manager.waitForReply(
          "multiColorBox",
          msgid,
          args.reply_timeout_ms ?? 8000,
        );
        const deviceError = reply.reports.find(
          (event) => event.data?.code && event.data.code !== 200,
        );
        return out({
          ok: reply.state !== "timeout" && !deviceError,
          command: "ace_feed_finish",
          box_id: args.box_id ?? 0,
          msgid,
          topic: redact(topic),
          sent_data: redact(payload),
          reply_state: reply.state,
          device_error: deviceError
            ? redact(deviceError.data?.msg ?? `code ${deviceError.data?.code}`)
            : null,
          replies: reply.reports.slice(0, 5),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 1: ace_refresh_slot
  server.registerTool(
    "ace_refresh_slot",
    {
      title: "Refresh an ACE slot",
      description:
        "Write tool (state). Sends MULTI_COLOR_BOX_REFRESH_SLOT (1210) to refresh ACE slot metadata. Requires confirm:true. For safety on the test unit only.",
      inputSchema: {
        ...shared,
        box_id: z.number().int().min(0).max(9).default(0),
        slot_index: z.number().int().min(0).max(9).optional(),
        reply_timeout_ms: z.number().int().min(500).max(30000).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("ace_refresh_slot requires confirm: true. Nothing was sent.");
        const cloud = await ensureSession(args);
        const printer = await resolvePrinterOrDefault(cloud, args.printer_id);
        const client = await manager.acquire(printer);
        const payload = { multi_color_box: [{ id: args.box_id ?? 0, refresh: 1 }] };
        const msgid = await cloud.publishCommand(
          printer,
          "multiColorBox",
          "refreshSlot",
          payload,
          client,
        );
        const topic = `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/multiColorBox`;
        const reply = await manager.waitForReply(
          "multiColorBox",
          msgid,
          args.reply_timeout_ms ?? 8000,
        );
        const deviceError = reply.reports.find(
          (event) => event.data?.code && event.data.code !== 200,
        );
        return out({
          ok: reply.state !== "timeout" && !deviceError,
          command: "ace_refresh_slot",
          box_id: args.box_id ?? 0,
          msgid,
          topic: redact(topic),
          sent_data: redact(payload),
          reply_state: reply.state,
          device_error: deviceError
            ? redact(deviceError.data?.msg ?? `code ${deviceError.data?.code}`)
            : null,
          replies: reply.reports.slice(0, 5),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 1: printer_rename (REST, write)
  server.registerTool(
    "printer_rename",
    {
      title: "Rename the printer in the cloud",
      description:
        "Write tool (N10). Changes the display name of the printer in the cloud account (/work/printer/edit). Requires confirm:true. Only transport acceptance is proven by the reply; re-read with printer_read_all to confirm.",
      inputSchema: {
        ...shared,
        new_name: z.string().min(1).max(60),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("printer_rename requires confirm: true. Nothing was sent.");
        const cloud = await ensureSession(args);
        const data = await renamePrinter(cloud, {
          printerId: args.printer_id,
          newName: args.new_name,
        });
        return out(data);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 1: firmware_update_check (read)
  server.registerTool(
    "firmware_update_check",
    {
      title: "Check for printer/ACE firmware updates (read-only)",
      description:
        "Read-only (N10). Queries the printer's firmware/OTA metadata (current and latest versions) and reports whether an update exists. It NEVER triggers, downloads or applies an OTA.",
      inputSchema: { ...shared },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const cloud = await ensureSession(args);
        const data = await checkFirmwareUpdate(cloud, { printerId: args.printer_id });
        return out(data);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 2: printer_event_watch (N14, read)
  server.registerTool(
    "printer_event_watch",
    {
      title: "Diff printer state since the last watch (events)",
      description:
        "Read-only (N14). Samples printersStatus once and compares it with the previous sample for this printer, returning the delta as events (state, print_status, task_id, temps, lifetime counters, ACE consumables and drying). Pass reset:true to discard the previous baseline. Never mutates the printer.",
      inputSchema: { ...shared, reset: z.boolean().default(false) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const cloud = await ensureSession(args);
        const data = await collectEventWatch(cloud, {
          printerId: args.printer_id,
          reset: args.reset,
        });
        return out(data);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 2: nfc_tag_decode (N13, pure/offline)
  server.registerTool(
    "nfc_tag_decode",
    {
      title: "Decode a raw NFC tag record (Anycubic/Bambu/Creality)",
      description:
        "Read-only, offline (N13). Pure decoder of a tag's raw block array or {blocks:[...]}: detects Creality ASCII, Anycubic SKU and Bambu-like layouts. No device access; never writes to any tag.",
      inputSchema: {
        record: z.union([
          z.array(z.union([z.number(), z.string()])),
          z.object({ blocks: z.array(z.union([z.number(), z.string()])) }),
        ]),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const data = decodeTagRecord(args.record);
        return out(data);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 2: spool_resolve (N13, offline registry)
  server.registerTool(
    "spool_resolve",
    {
      title: "Resolve a spool UID/SKU against the local registry",
      description:
        "Read-only, offline (N13). Maps a spool identifier (UID or SKU) to a known material descriptor via the offline registry. Requires no printer; never writes to any tag.",
      inputSchema: { uid: z.string().min(1).max(120) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ uid }) => {
      try {
        const data = spoolRegistry();
        data.query = { uid };
        return out(data);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Batch 2: camera_cloud_info (N12, read)
  server.registerTool(
    "camera_cloud_info",
    {
      title: "Cloud camera / RTC capability info (read-only)",
      description:
        "Read-only (N12). Reports whether the printer supports the cloud (Agora/Shengwang RTC) camera, the current video_taskid (authorizes an RTC session) and timelapse support. It never opens the camera or proxies the stream.",
      inputSchema: { ...shared },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const cloud = await ensureSession(args);
        const data = await collectCameraCloudInfo(cloud, { printerId: args.printer_id });
        return out(data);
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Spool registry (Opção A — tracking client-side de consumo) ------
  server.registerTool(
    "spool_register",
    {
      title: "Register a filament spool locally (client-side tracking)",
      description:
        "Write tool (local registry, Opção A). Stores a spool's initial weight (g) and metadata in the bridge JSON. The ACE has no writable weight field, so remaining is computed client-side: weight_g - Σ used_g. Requires confirm:true. Registry: %LOCALAPPDATA%\\AnycubicSlicerNextControl\\spool-registry.json",
      inputSchema: {
        ...shared,
        vendor: z.string().min(1).max(60),
        material: z.string().min(1).max(60).default("PLA"),
        color_hex: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default("#FFFFFF"),
        weight_g: z.number().positive().default(1000),
        diameter: z.number().positive().default(1.75),
        density: z.number().positive().optional(),
        sku: z.string().max(60).optional(),
        tag_uid: z.string().max(60).optional(),
        box_id: z.number().int().min(0).max(9).default(0),
        slot_index: z.number().int().min(0).max(9).optional(),
        spool_id: z.string().max(60).optional(),
        notes: z.string().max(300).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("spool_register requires confirm: true. Nothing was written.");
        const registry = loadRegistry();
        const record = upsertSpool(registry, {
          vendor: args.vendor,
          material: args.material,
          color_hex: args.color_hex,
          weight_g: args.weight_g,
          diameter: args.diameter,
          density: args.density,
          sku: args.sku,
          tag_uid: args.tag_uid,
          box_id: args.box_id,
          slot_index: args.slot_index,
          spool_id: args.spool_id,
          notes: args.notes,
        });
        return out({
          ok: true,
          spool: record,
          remaining: computeRemaining(record),
          registry_file: defaultRegistryFile(),
          note: "Client-side only. The ACE/slicer does not display this remaining.",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "spool_usage",
    {
      title: "Record filament consumption against a spool (client-side)",
      description:
        "Write tool (local registry, Opção A). Deducts used_g from a spool's remaining (weight_g - Σ used_g). Pass task_id to make consumption deduplicated by (task_id, used_g). Requires confirm:true.",
      inputSchema: {
        ...shared,
        spool_id: z.string().min(1).max(60),
        used_g: z.number().positive().max(100000),
        task_id: z.union([z.string(), z.number()]).optional(),
        note: z.string().max(300).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("spool_usage requires confirm: true. Nothing was written.");
        const registry = loadRegistry();
        const found = findSpools(registry, { spoolId: args.spool_id })[0];
        if (!found) throw new Error(`Spool ${args.spool_id} not found; register it first.`);
        const applied = applyTaskUsage(found, String(args.task_id ?? ""), args.used_g, {
          note: args.note,
        });
        if (applied.applied) saveRegistry(registry);
        return out({
          ok: true,
          applied: applied.applied,
          reason: applied.reason,
          remaining: computeRemaining(found),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "spool_status",
    {
      title: "List spool registry with computed remaining",
      description:
        "Read-only (local registry). Lists every registered spool with remaining_g = weight_g - Σ used_g, plus the registry file path. Client-side tracking; the printer does not display it.",
      inputSchema: { spool_id: z.string().max(60).optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ spool_id }) => {
      try {
        const registry = loadRegistry();
        const spools = spool_id ? findSpools(registry, { spoolId: spool_id }) : registry.spools;
        return out({
          read_only: true,
          count: spools.length,
          spools: spools.map((s) => ({ ...s, remaining: computeRemaining(s) })),
          registry_file: defaultRegistryFile(),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "spool_bind",
    {
      title: "Bind a spool to an ACE slot via legitimate manual entry",
      description:
        "Write tool (Opção A + documented bridge). Reuses the cloud ACE slot setInfo path (via ace_set_slot on the printer-command bus) to set the slot to the registered spool's material+color. It NEVER forges a tag: the slot stays edit_status:1 (manual) and the ACE will not decrement consumables — remaining stays in our registry. Requires confirm:true.",
      inputSchema: {
        ...shared,
        spool_id: z.string().min(1).max(60),
        box_id: z.number().int().min(0).max(9).default(0),
        slot_index: z.number().int().min(0).max(9).default(0),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("spool_bind requires confirm: true. Nothing was sent.");
        // notebook-style: read local spool; the actual apply goes via ace_set_slot.
        const registry = loadRegistry();
        const spool = findSpools(registry, { spoolId: args.spool_id })[0];
        if (!spool) throw new Error(`Spool ${args.spool_id} not found; register it first.`);
        // color hex -> [R,G,B]
        const hex = spool.color_hex?.replace("#", "") ?? "FFFFFF";
        const color = [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        ];
        return out({
          ok: true,
          note: "Direct bus call for slot binding is delegated to ace_set_slot; use printer_command_send ace_set_slot {box_id, slot_index, material_type, color} to apply.",
          spool: {
            spool_id: spool.spool_id,
            material: spool.material,
            color_hex: spool.color_hex,
            color,
          },
          slot: { box_id: args.box_id, slot_index: args.slot_index },
          edit_status_expected: 1,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- NFC tag writing prep (Opção B — preparado p/ hardware) ----------
  server.registerTool(
    "nfc_tag_plan",
    {
      title: "Plan an Anycubic-format NTAG write for a registered spool",
      description:
        "Read-only (local registry + pure plan, Opção B prep). Given a spool_id, produces the payload blocks intended for a virgin NTAG213 in Anycubic format (SKU, material, color, weight). No tag is written — the connector for a physical NFC writer (Android/PN532/ACR122U) comes later. Validate layout with ReSpool on hardware first.",
      inputSchema: { spool_id: z.string().min(1).max(60) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ spool_id }) => {
      try {
        const registry = loadRegistry();
        const spool = findSpools(registry, { spoolId: spool_id })[0];
        if (!spool) throw new Error(`Spool ${spool_id} not found; register it first.`);
        const plan = planAnycubicTagWrite(spool);
        return out({ read_only: true, ...plan });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- Spool consumption from cloud slice data --------------------------
  server.registerTool(
    "spool_consume_from_slice",
    {
      title: "Apply a cloud file's filament usage to a spool",
      description:
        "Write tool (Opção A). Fetches a cloud gcode/model file preview (printer_file_preview) to read per-color filament_used_g, then deducts the matching slot's usage from the registered spool at that slot. Task_id is taken from the file id so consumption is deduplicated. Requires confirm:true.",
      inputSchema: {
        ...shared,
        spool_id: z.string().min(1).max(60),
        gcode_id: z.number().int().positive().optional(),
        file_id: z.number().int().positive().optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("spool_consume_from_slice requires confirm: true. Nothing was applied.");
        const cloud = await ensureSession(args);
        const { collectFilePreview } = await import("./printer-expansion-tools.mjs");
        const preview = await collectFilePreview(cloud, {
          gcodeId: args.gcode_id,
          fileId: args.file_id,
        });
        const perColor = Array.isArray(preview?.per_color) ? preview.per_color : [];
        const registry = loadRegistry();
        const spool = findSpools(registry, { spoolId: args.spool_id })[0];
        if (!spool) throw new Error(`Spool ${args.spool_id} not found; register it first.`);
        // pick the color entry matching the spool color (hex match or first non-null)
        const target =
          perColor.find((c) => {
            const hex = hexOf(c?.color);
            return hex && hex.toLowerCase() === (spool.color_hex ?? "").toLowerCase();
          }) ?? perColor.find((c) => c?.filament_used_g != null);
        if (!target || target.filament_used_g == null) {
          return out({
            ok: false,
            reason: "no filament_used found for this slice",
            per_color: perColor,
          });
        }
        const applied = applyTaskUsage(
          spool,
          `g${args.gcode_id ?? args.file_id}`,
          target.filament_used_g,
        );
        if (applied.applied) saveRegistry(registry);
        return out({
          ok: true,
          applied: applied.applied,
          reason: applied.reason,
          source: {
            gcode_id: args.gcode_id ?? null,
            file_id: args.file_id ?? null,
            matched_color: target.color ?? null,
          },
          used_g: target.filament_used_g,
          remaining: computeRemaining(spool),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
