/**
 * S9.12-003 — MCP Agent tools mirroring the UI control surface.
 *
 * The future Agent inside the app reads the SAME `PrinterSnapshot` the UI
 * draws — no duplicate pipeline. Two tool families:
 *
 *   - `printer_get_snapshot` — read-only; returns the exact 9.9-001 snapshot
 *     schema (schemaVersion 1) by reusing the read-only full-read collector
 *     and the editor's OWN pure mapper (`printer-path-map.ts`), so the Agent
 *     and the UI literally share one shape. Never writes.
 *   - write tools — `set_temperature`, `set_speed_mode`, `print_pause`,
 *     `print_resume`, `print_stop`, `ace_dry`, `ace_auto_feed`, `slot_bind`.
 *     Each is routed through the SAME capability policy the UI/DevTools use
 *     (`capability-surface.ts`): the Agent ALWAYS needs approval (S9-006 card)
 *     before a write executes; the tool refuses without it (never a schema
 *     default). Execution reuses the shared command bus manager.
 *
 * Storage exposure to the Agent is limited to METADATA only: the snapshot
 * `storage` block is always `{ kind, usedBytes, totalBytes }` summed-up
 * figures — never raw file records. (Decision per S9.12-003: burner caps.)
 *
 * Confirm contract (matches the printer-command-bus): non-read commands
 * require `confirm:true`; motion/job commands additionally require
 * `confirm_word:"EXECUTE"`. The approval card supplies both — the Agent can
 * never bypass because the tool validates them BEFORE any network activity.
 */
import { redact } from "./cloud-readonly-diagnostics.mjs";
import { findSlicerJwt } from "./anycubic-cloud.mjs";
import { COMMANDS } from "./printer-command-bus-catalog.mjs";
import { executeCloudCommand } from "./printer-command-bus.mjs";
import { collectFullReadings } from "./printer-full-read.mjs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const EDITOR_STATE = path.resolve(SCRIPTS, "..", "apps", "editor", "src", "state");

/** Lazily import the editor's pure mapper (Node 24 type-strips the .ts). */
let mapperPromise = null;
function loadMapper() {
  if (!mapperPromise) {
    const url =
      pathToFileURL(path.join(EDITOR_STATE, "printer-path-map.ts")).href + `?key=${Date.now()}`;
    mapperPromise = import(url);
  }
  return mapperPromise;
}

/** Lazily import the editor's capability policy (S9.10-001, pure .ts). */
let surfacePromise = null;
function loadSurface() {
  if (!surfacePromise) {
    const url =
      pathToFileURL(path.join(EDITOR_STATE, "capability-surface.ts")).href + `?key=${Date.now()}`;
    surfacePromise = import(url);
  }
  return surfacePromise;
}

/** Every write tool the Agent exposes, mirrored from the capability surface. */
export const AGENT_WRITE_ACTIONS = Object.freeze({
  set_temperature: { action: "temps.setNozzle", command: "temperature_set", safety: "thermal" },
  set_speed_mode: { action: "speed.setMode", command: "print_update", safety: "thermal" },
  print_pause: { action: "print.pause", command: "print_pause", safety: "job" },
  print_resume: { action: "print.resume", command: "print_resume", safety: "job" },
  print_stop: { action: "print.stop", command: "print_stop", safety: "job" },
  ace_dry: { action: "ace.dry", command: "ace_dry", safety: "thermal" },
  ace_auto_feed: { action: "ace.autoFeed", command: "ace_auto_feed", safety: "state" },
  slot_bind: { action: "ace.bindSlot", command: "ace_set_slot", safety: "state" },
});

/**
 * The Agent's write gate — single source of truth is the editor policy
 * (`capability-surface.ts`, imported directly). Every Agent write MUST pass
 * the S9-006 approval: `confirm:true` always, and `confirm_word:"EXECUTE"`
 * additionally for motion/job safety classes (matching COMMAND_SAFETY). The
 * approval card supplies both; without them the tool refuses BEFORE any
 * network activity. `raw.command` never appears here (agentBlocked, so the
 * policy rejects it with "not allowed for actor agent").
 */
export async function assertAgentApproval(action, confirm, confirmWord, command) {
  const { CAPABILITY_SURFACE, allowedFor } = await loadSurface();
  const entry = CAPABILITY_SURFACE.byAction[action];
  if (!entry || entry.kind === "read") {
    throw new Error(`Action '${action}' is not a writable policy entry. Nothing was sent.`);
  }
  if (entry.agentBlocked || !allowedFor("agent", entry)) {
    throw new Error(`Action '${action}' is blocked for the Agent by policy. Nothing was sent.`);
  }
  if (confirm !== true) {
    throw new Error(
      `Agent action '${action}' requires confirm:true (S9-006 approval). Nothing was sent.`,
    );
  }
  const cmd = COMMANDS[command];
  if (cmd && ["motion", "job"].includes(cmd.safety) && confirmWord !== "EXECUTE") {
    throw new Error(
      `Agent action '${action}' (safety: ${cmd.safety}) requires confirm_word:"EXECUTE". Nothing was sent.`,
    );
  }
  return entry;
}

export function registerAgentTools(server, z, { manager, resolvePrinter } = {}) {
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

  server.registerTool(
    "printer_get_snapshot",
    {
      title: "Read the print-ready printer snapshot (schema v1)",
      description:
        "READ-ONLY. Returns the exact 9.9-001 snapshot schema (schemaVersion 1) the Device panel draws: identity, temps, fans, print state/progress/speed, motion, AI, lights, peripherals, storage (metadata totals only — never raw file records) and capabilities. It reuses the read-only full-read collector and the editor's own pure mapper, so the Agent and the UI share ONE shape. Never moves, heats, feeds, uploads, deletes or starts/stops a print.",
      inputSchema: {
        ...shared,
        sources: z.array(z.string().max(48)).optional(),
        timeout_ms: z.number().int().min(1000).max(60000).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const cloud = await ensureSession(args);
        const printer = await resolvePrinterOrDefault(cloud, args.printer_id);
        const readings = await collectFullReadings({
          transport: "cloud",
          printerId: Number(printer.id),
          sources: args.sources ?? undefined,
          timeoutMs: args.timeout_ms ?? 20000,
          accessToken: args.access_token,
          resourcesDir: args.resources_dir,
        });
        const { mapPrinterPayload } = await loadMapper();
        // Merge every source's `data` (raw) into ONE flat payload the mapper
        // understands. It is read-only — never includes the account reads.
        const mergedPayload = {};
        for (const source of Object.values(readings.sources ?? {})) {
          if (source?.raw && typeof source.raw === "object") {
            Object.assign(mergedPayload, source.raw);
          }
        }
        const snapshot = mapPrinterPayload(
          Number.isFinite(Number(args.printer_id)) ? String(args.printer_id) : "printer",
          mergedPayload,
        );
        // Storage exposure is burned to metadata only (S9.12-003 decision):
        // the mapper already gives { kind, usedBytes, totalBytes, freeBytes }.
        const data = {
          schemaVersion: snapshot.schemaVersion,
          printerId: snapshot.printerId,
          capturedAt: readings.collected_at,
          ...snapshot,
          read_only: true,
          sources: Object.keys(readings.sources ?? {}),
          connection_error: readings.connection?.connection_error ?? null,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  // ---------------------------------------------------------------------
  // Write tools — policy-routed: Agent approval (S9-006) always required.
  // ---------------------------------------------------------------------

  const writeTool = (name, title, description, schema, cmdBuilder) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          ...shared,
          ...schema,
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
          const action = AGENT_WRITE_ACTIONS[name].action;
          const commandId = AGENT_WRITE_ACTIONS[name].command;
          // Policy approval gate happens BEFORE any cloud/mqtt access.
          await assertAgentApproval(action, args.confirm, args.confirm_word, commandId);
          const cloud = await ensureSession(args);
          const printer = await resolvePrinterOrDefault(cloud, args.printer_id);
          const commandArgs = cmdBuilder(args);
          const result = await executeCloudCommand(manager, printer, commandId, {
            ...commandArgs,
            confirm: args.confirm,
            confirm_word: args.confirm_word,
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
  };

  // set_temperature(nozzle/bed)
  writeTool(
    "set_temperature",
    "Set nozzle/bed temperature",
    "Sets the hotend and/or bed temperature target. REQUIRES the Agent approval card (confirm:true; thermal). Nothing is sent without it. The printer heats only after an explicit approved command.",
    {
      nozzle: z.number().min(0).max(300).optional(),
      bed: z.number().min(0).max(120).optional(),
    },
    (a) => ({ nozzle: a.nozzle, bed: a.bed }),
  );

  // set_speed_mode(mode)
  writeTool(
    "set_speed_mode",
    "Set print speed mode",
    "Sets the running job's speed mode (silent/standard/sport). REQUIRES the Agent approval card (confirm:true; thermal — modifies the RUNNING job settings). Nothing is sent without it.",
    {
      mode: z.enum(["silent", "standard", "sport"]),
    },
    (a) => {
      // Speed-mode number on the Anycubic bus (matches SPEED_MODE_NUM):
      // silent=1, standard=2, sport=3.
      const modeMap = { silent: 1, standard: 2, sport: 3 };
      return { print_speed_mode: modeMap[a.mode] };
    },
  );

  // print_pause
  writeTool(
    "print_pause",
    "Pause the running print",
    "Pauses the active print job. REQUIRES the Agent approval card (confirm:true AND confirm_word:EXECUTE; job safety). Nothing is sent without it.",
    {},
    () => ({}),
  );

  // print_resume
  writeTool(
    "print_resume",
    "Resume the paused print",
    "Resumes a paused print job. REQUIRES the Agent approval card (confirm:true AND confirm_word:EXECUTE; job safety). Nothing is sent without it.",
    {},
    () => ({}),
  );

  // print_stop
  writeTool(
    "print_stop",
    "Stop the running print",
    "Stops the active print job. REQUIRES the Agent approval card (confirm:true AND confirm_word:EXECUTE; job safety). Nothing is sent without it.",
    {},
    () => ({}),
  );

  // ace_dry
  writeTool(
    "ace_dry",
    "Start/stop ACE filament drying",
    "Turns the ACE drying cycle on/off for a box. REQUIRES the Agent approval card (confirm:true; thermal). Nothing is sent without it.",
    {
      box_id: z.number().int().min(0).max(9),
      enabled: z.boolean(),
      target_temp: z.number().min(0).max(80).optional(),
      duration_min: z.number().int().min(0).max(1440).optional(),
    },
    (a) => ({
      box_id: a.box_id,
      stop: !a.enabled,
      target_temp: a.target_temp,
      duration_min: a.duration_min,
    }),
  );

  // ace_auto_feed
  writeTool(
    "ace_auto_feed",
    "Toggle ACE auto-feed",
    "Enables/disables ACE automatic filament feeding for a box. REQUIRES the Agent approval card (confirm:true; state). Nothing is sent without it.",
    {
      box_id: z.number().int().min(0).max(9),
      enabled: z.boolean(),
    },
    (a) => ({ box_id: a.box_id, enabled: a.enabled }),
  );

  // slot_bind
  writeTool(
    "slot_bind",
    "Bind an ACE slot to a material/color",
    "Writes the material type + RGB color into an ACE slot (manual bind — never forges a tag). REQUIRES the Agent approval card (confirm:true; state). Nothing is sent without it.",
    {
      box_id: z.number().int().min(0).max(9),
      slot_index: z.number().int().min(0).max(9),
      material_type: z.string().max(60),
      color: z.array(z.number().int().min(0).max(255)).length(3),
    },
    (a) => ({
      box_id: a.box_id,
      slot_index: a.slot_index,
      material_type: a.material_type,
      color: a.color,
    }),
  );
}
