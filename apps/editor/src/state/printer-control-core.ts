/**
 * S9.10-002 — printer control envelope core (pure, headless).
 *
 * Every Device Monitor control maps to a validated `printer_command_send`
 * envelope. This core builds the envelope from a high-level action without
 * any network/MCP/zustand knowledge, so the command-construction logic is
 * unit-testable under the plain Node runner — same pattern as
 * `printer-status-core` / `printers-core`.
 *
 * The real server schema (schemas/tools.json → printer_command_send):
 *
 *   command   : light_control | fan_set | temperature_set | print_update | ...
 *   confirm   : true            (required, non-read)
 *   confirm_word: "EXECUTE"     (motion/job classes only)
 *   payload   : per-command fields (nozzle/bed mins match the schema:
 *              nozzle 0–320 °C, bed 0–120 °C, speed_pct 0–100)
 *
 * Capability surface (S9.10-001) is the POLICY; this core is the GRAMMAR.
 * `buildCommandEnvelope` maps an action to `{ command, args, confirm }` and
 * validates the full sets listed below — every UI control ends up validated
 * here, and the Agent approval card hashes the SAME envelope.
 *
 * Safety rule repeated from AGENTS.md: no real device values, no hardcoded
 * ids — only agnostic action names + user-supplied payloads.
 */

import type { SpeedMode } from "../bridge/types.ts";
import type { PrinterControlResult, PrinterSnapshot } from "../bridge/types.ts";
import { CAPABILITY_SURFACE } from "./capability-surface.ts";
import type { ActorKind } from "./capability-surface.ts";
import type { ControlTargetContext } from "./device-availability-core.ts";

/* --------------------------- Central limits --------------------------- */

/** Nozzle target clamp window (schema `nozzle` min/max). */
export const NOZZLE_TARGET_MIN_C = 0 as const;
export const NOZZLE_TARGET_MAX_C = 320 as const;

/** Bed target clamp window (schema `bed` min/max). */
export const BED_TARGET_MIN_C = 0 as const;
export const BED_TARGET_MAX_C = 120 as const;

/** Fan speed clamp window (schema `speed_pct` min/max). */
export const FAN_PCT_MIN = 0 as const;
export const FAN_PCT_MAX = 100 as const;

/** Chamber light brightness window (schema `brightness` min/max). */
export const LIGHT_BRIGHTNESS_MIN = 0 as const;
export const LIGHT_BRIGHTNESS_MAX = 100 as const;

/** Speed-mode number on the Anycubic bus: silent=1, standard=2, sport=3. */
export const SPEED_MODE_NUM: Readonly<Record<SpeedMode, number>> = {
  silent: 1,
  standard: 2,
  sport: 3,
} as const;

/* --------------------------- ACE ranges --------------------------- */

/** ACE dryer target clamp window (°C — schema `target_temp` 0–80). */
export const DRYER_TARGET_MIN_C = 0 as const;
export const DRYER_TARGET_MAX_C = 80 as const;

/** ACE dryer duration clamp window (min — schema `duration_min` 0–1440). */
export const DRYER_DURATION_MIN_MIN = 0 as const;
export const DRYER_DURATION_MAX_MIN = 1440 as const;

/** Default dryer target when none given (agnostic — never a real value). */
export const DRYER_DEFAULT_TARGET_C = 45 as const;
/** Default dryer duration when none given (min). */
export const DRYER_DEFAULT_DURATION_MIN = 240 as const;

/** ACE box id window (schema `box_id` 0–9). */
export const ACE_BOX_MIN = 0 as const;
export const ACE_BOX_MAX = 9 as const;

/** ACE slot index window (schema `slot_index` 0–9). */
export const ACE_SLOT_MIN = 0 as const;
export const ACE_SLOT_MAX = 9 as const;

/** The bridge spec commands this core may emit (printer_command_send enum). */
export type BusCommandName =
  | "temperature_set"
  | "fan_set"
  | "print_update"
  | "light_control"
  | "ace_dry"
  | "ace_auto_feed"
  | "ace_set_slot";

/* --------------------------- Result types --------------------------- */

export type ControlOutcome =
  "accepted" | "refused" | "timeout" | "invalid" | "unavailable" | "indeterminate";

const CONTROL_CAPABILITY_BY_COMMAND: Readonly<Record<BusCommandName, string>> = {
  temperature_set: "tempature",
  fan_set: "fans",
  print_update: "print",
  light_control: "light",
  ace_dry: "multiColorBox",
  ace_auto_feed: "multiColorBox",
  ace_set_slot: "multiColorBox",
};

export function controlEffectObserved(
  envelope: ControlEnvelope,
  snapshot: PrinterSnapshot | undefined,
  target: ControlTargetContext,
  requestedCapturedAt: number,
  currentCapturedAt: number | null,
): boolean {
  if (
    !snapshot ||
    !target ||
    snapshot.printerId !== target.printerId ||
    !Number.isFinite(snapshot.capturedAt) ||
    !Number.isFinite(requestedCapturedAt) ||
    !Number.isFinite(currentCapturedAt) ||
    snapshot.capturedAt === null ||
    snapshot.capturedAt <= requestedCapturedAt ||
    currentCapturedAt !== snapshot.capturedAt
  ) {
    return false;
  }
  const args = envelope.args;
  switch (envelope.command) {
    case "temperature_set": {
      const fields = Object.entries(args);
      return (
        fields.length > 0 &&
        fields.every(([key, value]) => {
          if (key === "nozzle" || key === "bed") {
            return typeof value === "number" && snapshot.temps[key].targetC === value;
          }
          return false;
        })
      );
    }
    case "fan_set":
      return args.fan === "part" && snapshot.fans.partCoolingPct === args.speed_pct;
    case "light_control":
      return (
        snapshot.lights !== null &&
        typeof args.on === "boolean" &&
        snapshot.lights.enabled === args.on &&
        (args.brightness === undefined ||
          (typeof args.brightness === "number" &&
            snapshot.lights.brightnessPct === args.brightness))
      );
    case "print_update": {
      const mode = Object.entries(SPEED_MODE_NUM).find(([, value]) =>
        Object.entries(args).some(
          ([key, argValue]) => key === "print_speed_mode" && argValue === value,
        ),
      )?.[0];
      return mode !== undefined && snapshot.print.speedMode === mode;
    }
    default:
      return false;
  }
}

export interface ControlExecutionRequest {
  readonly target: ControlTargetContext;
  readonly envelope: ControlEnvelope;
}

export interface ControlExecutionProvider {
  currentContext(): ControlExecutionContext;
  authorize(
    request: ControlExecutionRequest,
  ): Promise<
    | { readonly ok: true; readonly reference: string }
    | { readonly ok: false; readonly reason: string }
  >;
  execute(request: ControlExecutionRequest, reference: string): Promise<PrinterControlResult>;
}

export interface ControlExecutionContext {
  readonly target: ControlTargetContext | null;
  readonly selectedPrinterId: string | null;
  readonly currentCapturedAt: number | null;
  readonly capabilityKey: string;
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

function immutableRequest(request: ControlExecutionRequest): ControlExecutionRequest {
  const copy: ControlExecutionRequest = {
    target: {
      ...request.target,
      capabilities: { ...request.target.capabilities },
    },
    envelope: {
      ...request.envelope,
      args: Object.fromEntries(
        Object.entries(request.envelope.args).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value,
        ]),
      ),
    },
  };
  return freezeTree(copy);
}

export const unavailableControlProvider: ControlExecutionProvider = {
  currentContext() {
    return {
      target: null,
      selectedPrinterId: null,
      currentCapturedAt: null,
      capabilityKey: "",
    };
  },
  async authorize() {
    return { ok: false, reason: "printer control provider unavailable" };
  },
  async execute() {
    return { ok: false, kind: "unavailable", error: "printer control provider unavailable" };
  },
};

export async function executeControl(
  provider: ControlExecutionProvider,
  request: ControlExecutionRequest,
): Promise<PrinterControlResult> {
  const authorizedRequest = immutableRequest(request);
  let approval: Awaited<ReturnType<ControlExecutionProvider["authorize"]>>;
  try {
    approval = await provider.authorize(authorizedRequest);
  } catch (error) {
    return {
      ok: false,
      kind: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!approval.ok || !approval.reference.trim()) {
    return {
      ok: false,
      kind: approval.ok ? "invalid" : "unavailable",
      error: approval.ok ? "missing backend approval reference" : approval.reason,
    };
  }
  try {
    const { validateControlTarget } = await import("./device-availability-core.ts");
    const context = provider.currentContext();
    const requiredCapability = CONTROL_CAPABILITY_BY_COMMAND[authorizedRequest.envelope.command];
    const current = validateControlTarget(
      context.target,
      context.selectedPrinterId,
      context.currentCapturedAt,
      requiredCapability,
    );
    if (
      !current.ok ||
      context.capabilityKey !== requiredCapability ||
      !context.target ||
      context.target?.printerId !== authorizedRequest.target.printerId ||
      context.target?.source !== authorizedRequest.target.source ||
      context.target?.snapshotCapturedAt !== authorizedRequest.target.snapshotCapturedAt
    ) {
      return {
        ok: false,
        kind: "invalid",
        error: current.ok
          ? "control target or snapshot changed after authorization"
          : current.reason,
      };
    }
  } catch {
    return {
      ok: false,
      kind: "unavailable",
      error: "control context could not be revalidated",
    };
  }
  try {
    return await provider.execute(authorizedRequest, approval.reference);
  } catch (error) {
    return {
      ok: false,
      kind: "indeterminate",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A validated command envelope — exactly what the bridge lane sends. */
export interface ControlEnvelope {
  readonly command: BusCommandName;
  readonly args: Readonly<Record<string, string | number | boolean | readonly number[] | null>>;
  readonly confirm: true;
  /** Present only for job/motion classes (schema requires EXECUTE). */
  readonly confirmWord?: "EXECUTE";
}

/** Result of building an envelope — either ready or a refusal reason. */
export type EnvelopeResult =
  | { readonly ok: true; readonly envelope: ControlEnvelope }
  | { readonly ok: false; readonly reason: string };

/* ------------------------ Action payload types ------------------------ */

export type ControlAction =
  | "temps.setNozzle"
  | "temps.setBed"
  | "fans.setPart"
  | "speed.setMode"
  | "lights.setEnabled"
  | "lights.setBrightness"
  | "ace.dry"
  | "ace.autoFeed"
  | "ace.bindSlot";

export type ControlRequest =
  | { readonly action: "temps.setNozzle"; readonly targetC: number }
  | { readonly action: "temps.setBed"; readonly targetC: number }
  | { readonly action: "fans.setPart"; readonly speedPct: number }
  | { readonly action: "speed.setMode"; readonly mode: SpeedMode }
  | { readonly action: "lights.setEnabled"; readonly enabled: boolean }
  | { readonly action: "lights.setBrightness"; readonly brightnessPct: number }
  // S9.10-003 ACE writes ------------------------------------------------
  | {
      readonly action: "ace.dry";
      readonly boxId: number;
      /** false → stop the dryer for the box. */
      readonly active: boolean;
      readonly targetC?: number;
      readonly durationMin?: number;
    }
  | {
      readonly action: "ace.autoFeed";
      readonly boxId: number;
      readonly enabled: boolean;
    }
  | {
      readonly action: "ace.bindSlot";
      readonly boxId: number;
      readonly slotIndex: number;
      /** Material short name (e.g. "PLA") written via the MANUAL path. */
      readonly material: string;
      /** Filament color #hex (e.g. "#4fa8dc") — converted to [R,G,B] below. */
      readonly colorHex: string;
    };

export function capabilityForControlAction(action: ControlAction): string {
  return CAPABILITY_SURFACE.byAction[action]?.capabilityKey ?? "";
}

/* --------------------------- Envelope build --------------------------- */

/**
 * Build the validated `printer_command_send` envelope for a control write.
 * Rejects (ok:false) when the payload falls outside the schema window or the
 * action is not a known write — the UI never receives a malformed command.
 * `actor` defaults to "user" (UI direct); "agent" only when the approval
 * card already authorized the exact hash (S9.12).
 */
export function buildCommandEnvelope(
  req: ControlRequest,
  actor: ActorKind = "user",
): EnvelopeResult {
  const surface = CAPABILITY_SURFACE;
  const entry = surface.byAction[req.action];
  if (!entry || entry.kind === "read") {
    return { ok: false, reason: `unknown or read action "${req.action}"` };
  }
  if (entry.kind === "raw") {
    return { ok: false, reason: `raw actions are not buildable here: "${req.action}"` };
  }
  // Policy gate before the grammar: the actor must be allowed to write.
  if (!allowedActorWrite(actor, entry.action)) {
    return { ok: false, reason: `action "${req.action}" is not allowed for actor "${actor}"` };
  }

  switch (req.action) {
    case "temps.setNozzle": {
      if (!inRange(req.targetC, NOZZLE_TARGET_MIN_C, NOZZLE_TARGET_MAX_C)) {
        return {
          ok: false,
          reason: `nozzle target ${req.targetC}°C outside ${NOZZLE_TARGET_MIN_C}–${NOZZLE_TARGET_MAX_C}°C`,
        };
      }
      return {
        ok: true,
        envelope: {
          command: "temperature_set",
          args: { nozzle: req.targetC },
          confirm: true,
        },
      };
    }
    case "temps.setBed": {
      if (!inRange(req.targetC, BED_TARGET_MIN_C, BED_TARGET_MAX_C)) {
        return {
          ok: false,
          reason: `bed target ${req.targetC}°C outside ${BED_TARGET_MIN_C}–${BED_TARGET_MAX_C}°C`,
        };
      }
      return {
        ok: true,
        envelope: {
          command: "temperature_set",
          args: { bed: req.targetC },
          confirm: true,
        },
      };
    }
    case "fans.setPart": {
      if (!inRange(req.speedPct, FAN_PCT_MIN, FAN_PCT_MAX)) {
        return {
          ok: false,
          reason: `fan speed ${req.speedPct}% outside ${FAN_PCT_MIN}–${FAN_PCT_MAX}%`,
        };
      }
      return {
        ok: true,
        envelope: {
          command: "fan_set",
          args: { fan: "part", speed_pct: req.speedPct },
          confirm: true,
        },
      };
    }
    case "speed.setMode": {
      if (!(req.mode in SPEED_MODE_NUM)) {
        return { ok: false, reason: `unknown speed mode "${req.mode}"` };
      }
      return {
        ok: true,
        envelope: {
          command: "print_update",
          args: { print_speed_mode: SPEED_MODE_NUM[req.mode] },
          confirm: true,
        },
      };
    }
    case "lights.setEnabled": {
      return {
        ok: true,
        envelope: {
          command: "light_control",
          args: { on: req.enabled },
          confirm: true,
        },
      };
    }
    case "lights.setBrightness": {
      if (!inRange(req.brightnessPct, LIGHT_BRIGHTNESS_MIN, LIGHT_BRIGHTNESS_MAX)) {
        return {
          ok: false,
          reason: `brightness ${req.brightnessPct}% outside ${LIGHT_BRIGHTNESS_MIN}–${LIGHT_BRIGHTNESS_MAX}%`,
        };
      }
      return {
        ok: true,
        envelope: {
          command: "light_control",
          args: { on: true, brightness: req.brightnessPct },
          confirm: true,
        },
      };
    }
    /* ---------------- S9.10-003: ACE writes ---------------- */
    case "ace.dry": {
      if (!inRange(req.boxId, ACE_BOX_MIN, ACE_BOX_MAX)) {
        return {
          ok: false,
          reason: `ACE box ${req.boxId} outside ${ACE_BOX_MIN}–${ACE_BOX_MAX}`,
        };
      }
      if (
        req.active &&
        req.targetC !== undefined &&
        !inRange(req.targetC, DRYER_TARGET_MIN_C, DRYER_TARGET_MAX_C)
      ) {
        return {
          ok: false,
          reason:
            `dryer target ${req.targetC}°C outside ` +
            `${DRYER_TARGET_MIN_C}–${DRYER_TARGET_MAX_C}°C`,
        };
      }
      if (
        req.active &&
        req.durationMin !== undefined &&
        !inRange(req.durationMin, DRYER_DURATION_MIN_MIN, DRYER_DURATION_MAX_MIN)
      ) {
        return {
          ok: false,
          reason:
            `dryer duration ${req.durationMin} min outside ` +
            `${DRYER_DURATION_MIN_MIN}–${DRYER_DURATION_MAX_MIN} min`,
        };
      }
      return {
        ok: true,
        envelope: {
          command: "ace_dry",
          // Flat tool args; the server translates them into the bus payload
          // ({multi_color_box:[{id, drying_status:{status, target_temp,
          //   duration, remain_time}}]}) with stop → status 0.
          args: {
            box_id: req.boxId,
            stop: !req.active,
            target_temp: req.targetC ?? DRYER_DEFAULT_TARGET_C,
            duration_min: req.durationMin ?? DRYER_DEFAULT_DURATION_MIN,
            remain_time: 0,
          },
          confirm: true,
        },
      };
    }
    case "ace.autoFeed": {
      if (!inRange(req.boxId, ACE_BOX_MIN, ACE_BOX_MAX)) {
        return {
          ok: false,
          reason: `ACE box ${req.boxId} outside ${ACE_BOX_MIN}–${ACE_BOX_MAX}`,
        };
      }
      return {
        ok: true,
        envelope: {
          command: "ace_auto_feed",
          args: { box_id: req.boxId, enabled: req.enabled },
          confirm: true,
        },
      };
    }
    case "ace.bindSlot": {
      if (!inRange(req.boxId, ACE_BOX_MIN, ACE_BOX_MAX)) {
        return {
          ok: false,
          reason: `ACE box ${req.boxId} outside ${ACE_BOX_MIN}–${ACE_BOX_MAX}`,
        };
      }
      if (!inRange(req.slotIndex, ACE_SLOT_MIN, ACE_SLOT_MAX)) {
        return {
          ok: false,
          reason: `ACE slot ${req.slotIndex} outside ${ACE_SLOT_MIN}–${ACE_SLOT_MAX}`,
        };
      }
      const rgb = hexToRgb(req.colorHex);
      if (!rgb) {
        return { ok: false, reason: `invalid color hex "${req.colorHex}"` };
      }
      if (!req.material || typeof req.material !== "string") {
        return { ok: false, reason: `missing material "${req.material}"` };
      }
      return {
        ok: true,
        envelope: {
          command: "ace_set_slot",
          // Manual path only — the ACE stays edit_status:1 (no forged RFID
          // tag), consumables stay tracked in our local registry (spool_bind
          // contract, docs/research/expansion-audit-2026-09-11.md §P1).
          args: {
            box_id: req.boxId,
            slot_index: req.slotIndex,
            material_type: req.material,
            color: rgb,
          },
          confirm: true,
        },
      };
    }
  }
}

/* ------------------------------ Helpers ------------------------------ */

function inRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function allowedActorWrite(actor: ActorKind, action: string): boolean {
  const entry = CAPABILITY_SURFACE.byAction[action];
  if (!entry) return false;
  // Reuse the same policy the UI/Agent use: writes allowed for both actors
  // (agent needs approval first), raw blocked for agent.
  if (entry.kind === "raw") return actor === "user";
  if (entry.agentBlocked && actor === "agent") return false;
  return entry.kind === "write";
}

/**
 * Parse a #RRGGBB hex color into the [r,g,b] triple the ACE slot write uses.
 * Accepts optional leading `#`. Returns null for anything else — the caller
 * turns that into a refusal (never a raw error crash).
 */
function hexToRgb(hex: string): readonly [number, number, number] | null {
  if (typeof hex !== "string") return null;
  const cleaned = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return [r, g, b] as const;
}
