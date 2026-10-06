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
import { CAPABILITY_SURFACE } from "./capability-surface.ts";
import type { ActorKind } from "./capability-surface.ts";

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

export type ControlOutcome = "accepted" | "refused" | "timeout" | "invalid";

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
