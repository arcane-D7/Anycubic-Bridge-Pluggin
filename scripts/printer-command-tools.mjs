/**
 * MCP registration for the cloud command bus + stable connection.
 * Every tool is safety-gated: read tools are readOnlyHint, control tools are
 * destructiveHint with mandatory confirm (and confirm_word for motion/job).
 */
import { redact } from "./cloud-readonly-diagnostics.mjs";
import { COMMANDS, COMMAND_SAFETY } from "./printer-command-bus-catalog.mjs";
import { findSlicerJwt } from "./anycubic-cloud.mjs";
import {
  assertConfirm,
  cloudPrintStart,
  createManager,
  executeCloudCommand,
  resolveCloudGcode,
} from "./printer-command-bus.mjs";

const COMMAND_IDS = Object.keys(COMMANDS);
let closureManager = null;

function cloudFromArgs(args) {
  const cloud = args.cloud ?? closureManager?.cloud;
  if (!cloud) throw new Error("No cloud session available.");
  return cloud;
}

/**
 * Ensure the shared cloud session is logged in. The XX-Token is memoized by
 * anycubic-cloud.mjs, so repeated calls reuse it; an explicit access_token or
 * the stored DPAPI token wins over the slicer-log fallback.
 */
async function ensureSession(args) {
  const cloud = cloudFromArgs(args);
  if (!cloud.xxToken) {
    const token =
      args.access_token ??
      process.env.ANYCUBIC_CLOUD_TOKEN ??
      // Last-resort fallback: the Slicer Next debug logs carry the account JWT
      // while the user is logged in. Same source the read tools use.
      findSlicerJwt(process.env.APPDATA ? `${process.env.APPDATA}/AnycubicSlicerNext/log` : "") ??
      null;
    if (token && !cloud.access_token) cloud.access_token = token;
    await cloud.login();
  }
  return cloud;
}

async function resolvePrinter(cloud, printerId) {
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

export function registerPrinterCommands(server, z, { manager, resolvePrinter } = {}) {
  closureManager = manager ?? null;
  const shared = {
    printer_id: z.number().int().positive().optional(),
    access_token: z.string().max(4096).optional(),
    resources_dir: z.string().max(1024).optional(),
  };

  server.registerTool(
    "printer_command_catalog",
    {
      title: "List the available printer commands",
      description:
        "Read-only, offline. Lists every executable cloud command with its message type, action, payload grammar, safety class (read/state/thermal/motion/job) and the exact confirmations each requires. It never contacts the printer.",
      inputSchema: { safety: z.enum(["read", "state", "thermal", "motion", "job"]).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ safety }) => {
      try {
        const commands = Object.entries(COMMANDS)
          .filter(([, command]) => !safety || command.safety === safety)
          .map(([id, command]) => ({
            id,
            type: command.type,
            action: command.action,
            safety: command.safety,
            evidence: command.evidence,
            confirm_required: command.safety !== "read",
            confirm_word_required: COMMAND_SAFETY.EXECUTE_WORD.has(command.safety),
            note: command.note ?? null,
          }));
        const data = { read_only: true, executable: true, total: commands.length, commands };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_command_send",
    {
      title: "Send a control command to the printer over the cloud",
      description:
        'Executes one cloud MQTT control command: light on/off+brightness, fan speeds, chamber temperature targets, ACE drying/auto-feed/slot/feed, AI detection switch, axis move/home/motors-off, camera capture start/stop, running-job settings update (print_update), print pause/resume/stop or local-file start. Every non-read command REQUIRES confirm:true; motion and job commands additionally require confirm_word:"EXECUTE". Returns the device reply state and never retries automatically.',
      inputSchema: {
        ...shared,
        command: z.enum(COMMAND_IDS.filter((id) => id !== "print_start")),
        confirm: z.boolean().default(false),
        confirm_word: z.string().max(16).optional(),
        // payload fields (validated again per command)
        on: z.boolean().optional(),
        brightness: z.number().int().min(0).max(100).optional(),
        light_type: z.number().int().min(0).max(9).optional(),
        fan: z.enum(["part", "aux", "box"]).optional(),
        speed_pct: z.number().int().min(0).max(100).optional(),
        nozzle: z.number().min(0).max(320).optional(),
        bed: z.number().min(0).max(120).optional(),
        axis: z.enum(["x", "y", "z", 3, 4]).optional(),
        move_type: z.number().int().min(1).max(2).optional(),
        distance_mm: z.number().optional(),
        box_id: z.number().int().min(0).max(9).optional(),
        slot_index: z.number().int().min(0).max(9).optional(),
        material_type: z.string().max(60).optional(),
        color: z.array(z.number().int().min(0).max(255)).length(3).optional(),
        feed_type: z.number().int().min(0).max(9).optional(),
        enabled: z.boolean().optional(),
        stop: z.boolean().optional(),
        target_temp: z.number().min(0).max(80).optional(),
        duration_min: z.number().int().min(0).max(1440).optional(),
        ai_detect: z.boolean().optional(),
        camera_timelapse: z.boolean().optional(),
        file_name: z.string().max(200).optional(),
        file_path: z.string().max(400).optional(),
        task_id: z.string().max(64).optional(),
        print_speed_mode: z.number().int().min(0).max(9).optional(),
        type: z.number().int().min(0).max(9).optional(),
        count: z.number().int().min(0).max(1000).optional(),
        sensitivity_level: z.array(z.number().int()).max(4).optional(),
        notice_type: z.array(z.number().int()).max(4).optional(),
        reply_timeout_ms: z.number().int().min(500).max(30000).optional(),
        live_state: z.string().max(40).optional(),
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
        // Gate BEFORE any network activity: a missing confirmation must never
        // reach the cloud, not even for a login.
        assertConfirm(args.command, args);
        const cloud = await ensureSession(args);
        const printer = await resolvePrinter(cloud, args.printer_id);
        const result = await executeCloudCommand(manager, printer, args.command, args, {
          replyTimeoutMs: args.reply_timeout_ms ?? 8000,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_print_start",
    {
      title: "Start a cloud print with the LIVE-VALIDATED order 1 contract",
      description:
        'Starts a cloud G-code on the account printer using the LIVE-VALIDATED contract (order 1 = START_PRINT int, filetype 0; task <TASK_ID> reached "printing" on real hardware 2026-09-11 — the old 1240 value answered "Operation successful" yet never created a task): resolves gcode_id -> cloud file id via /work/gcode/infoFdm first, passes through the full slice_param, refuses while the printer is busy, requires an explicit ACE mapping when use_ams is set, and only reports success after the created task preserves the file reference and the device enters an active state. HTTP acceptance alone is never success. Requires confirm:true AND confirm_word:"EXECUTE".',
      inputSchema: {
        ...shared,
        gcode_id: z.number().int().positive(),
        file_name: z.string().max(200).optional(),
        ai_detect: z.boolean().default(true),
        camera_timelapse: z.boolean().default(false),
        use_ams: z.boolean().default(false),
        ams_box_mapping: z.record(z.string(), z.unknown()).optional(),
        live_state: z.string().max(40).optional(),
        confirm: z.boolean().default(false),
        confirm_word: z.string().max(16).optional(),
        verify_timeout_ms: z.number().int().min(5000).max(60000).optional(),
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
        if (args.use_ams && !args.ams_box_mapping) {
          throw new Error(
            "use_ams requires ams_box_mapping (slot -> ams_index). Nothing was sent.",
          );
        }
        // Gate BEFORE any network activity.
        if (args.confirm !== true || args.confirm_word !== "EXECUTE") {
          throw new Error(
            'cloud print start requires confirm: true AND confirm_word: "EXECUTE". Nothing was sent.',
          );
        }
        const cloud = await ensureSession(args);
        const printer = await resolvePrinter(cloud, args.printer_id);
        const result = await cloudPrintStart(
          manager,
          cloud,
          printer,
          {
            ...args,
            ams: args.use_ams ? { ams_box_mapping: args.ams_box_mapping } : null,
          },
          { verifyTimeoutMs: args.verify_timeout_ms ?? 25000 },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_gcode_resolve",
    {
      title: "Resolve a cloud gcode_id to file metadata",
      description:
        "Read-only. Resolves a cloud gcode_id via /work/gcode/infoFdm to the cloud file id, slice metadata, layers and md5 that printer_print_start needs. The id must be the G-code id, not the task id.",
      inputSchema: { ...shared, gcode_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const cloud = await ensureSession(args);
        const data = redact(await resolveCloudGcode(cloud, args.gcode_id));
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_connection_status",
    {
      title: "Show the persistent cloud connection health",
      description:
        "Read-only. Reports whether the persistent cloud MQTT session is connected, its statistics (connects, published commands, received reports) and the buffered recent events. Use it to diagnose connection stability before sending commands.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit = 10 }) => {
      try {
        const health = manager.health();
        const data = { ...health, recent_events: manager.events.slice(-limit) };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );
}

export { assertConfirm };

