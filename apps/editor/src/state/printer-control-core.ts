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

/** The bridge spec commands this core may emit (printer_command_send enum). */
export type BusCommandName = "temperature_set" | "fan_set" | "print_update" | "light_control";

/* --------------------------- Result types --------------------------- */

export type ControlOutcome = "accepted" | "refused" | "timeout" | "invalid";

/** A validated command envelope — exactly what the bridge lane sends. */
export interface ControlEnvelope {
  readonly command: BusCommandName;
  /** print_update carries the speed mode on the bus. */
  readonly args: Readonly<Record<string, string | number | boolean | null>>;
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
  | "lights.setBrightness";

export type ControlRequest =
  | { readonly action: "temps.setNozzle"; readonly targetC: number }
  | { readonly action: "temps.setBed"; readonly targetC: number }
  | { readonly action: "fans.setPart"; readonly speedPct: number }
  | { readonly action: "speed.setMode"; readonly mode: SpeedMode }
  | { readonly action: "lights.setEnabled"; readonly enabled: boolean }
  | { readonly action: "lights.setBrightness"; readonly brightnessPct: number };

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
