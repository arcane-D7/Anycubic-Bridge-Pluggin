/**
 * S9.11-003 — live overlay core (pure, headless).
 *
 * Pure decisions for the live-mode viewport overlay — toolhead placement,
 * nozzle color, throttle, layer bar. No React / three dependencies so Node
 * runs it headless under `node --test` (same pattern as every core here).
 *
 * Units are SI (mm / °C / %) from the agnostic snapshot. The world mapping
 * is Y-up matching BuildPlate (plate top at Y=0, footprint X×Z):
 *   world = [motion.xMm, motion.yMm, -motion.zMm]
 * with the motion Z mirrored so the toolhead travels toward the plate front
 * (+Z world) as the printer reports increasing depth.
 */

import type { AceBox, BuildVolume, PrintProgress } from "../bridge/types.ts";
import type { MachineTelemetryFrame } from "./coordinate-frames.ts";
import { machineTelemetryToEditorWorld } from "./coordinate-frames.ts";

/** Live update throttle — the sprint AC says ≤ 4 Hz (250 ms). */
export const LIVE_UPDATE_MS = 250 as const;

/** Neutral nozzle color when no loaded filament slot is known. */
export const NOZZLE_NEUTRAL_HEX = "#c8ccd2" as const;

export interface ToolheadWorld {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type ToolheadMapping =
  | { readonly ok: true; readonly position: ToolheadWorld }
  | {
      readonly ok: false;
      readonly reason:
        | "motion-unavailable"
        | "machine-frame-unknown"
        | "profile-bounds-unknown"
        | "outside-build-volume";
    };

/**
 * Map printer motion (mm) to world position on the plate. Returns null when
 * motion, frame or profile bounds are incomplete. Coordinates outside declared
 * world bounds are diagnosed, never clipped into the build volume.
 */
export function toolheadWorld(
  motion: {
    readonly xMm: number | null;
    readonly yMm: number | null;
    readonly zMm: number | null;
  } | null,
  volume: BuildVolume | null,
  frame: MachineTelemetryFrame | null,
): ToolheadMapping {
  if (!motion) return { ok: false, reason: "motion-unavailable" };
  if (!frame) return { ok: false, reason: "machine-frame-unknown" };
  if (!volume) return { ok: false, reason: "profile-bounds-unknown" };
  if (
    ![volume.widthMm, volume.depthMm, volume.heightMm].every(
      (value) => value > 0 && Number.isFinite(value),
    )
  ) {
    return { ok: false, reason: "profile-bounds-unknown" };
  }
  const profileBounds = frame.buildVolumeBoundsWorldMm;
  if (
    !profileBounds ||
    [...profileBounds.min, ...profileBounds.max].some((value) => !Number.isFinite(value)) ||
    profileBounds.min.some((value, axis) => value > profileBounds.max[axis]!)
  ) {
    return { ok: false, reason: "profile-bounds-unknown" };
  }
  const { xMm, yMm, zMm } = motion;
  if (xMm === null || yMm === null || zMm === null) {
    return { ok: false, reason: "motion-unavailable" };
  }
  const point = machineTelemetryToEditorWorld([xMm, yMm, zMm], frame);
  if (!point) return { ok: false, reason: "machine-frame-unknown" };
  const [x, y, z] = point;
  const { min, max } = profileBounds;
  if (
    min.some((value, axis) => point[axis]! < value) ||
    max.some((value, axis) => point[axis]! > value)
  ) {
    return { ok: false, reason: "outside-build-volume" };
  }
  return {
    ok: true,
    position: { x, y, z },
  };
}

/**
 * Nozzle color from the loaded filament slot of any ACE box: the first box
 * with a `loadedSlotIndex` pointing at a color-usable slot wins; otherwise
 * neutral (no guess). Idle printers (motion null) still show the neutral.
 */
export function nozzleColor(boxes: readonly AceBox[]): string {
  for (const box of boxes) {
    const idx = box.loadedSlotIndex;
    if (idx === null) continue;
    const slot = box.slots[idx];
    if (slot && slot.state !== "empty" && slot.state !== "identifying" && slot.color) {
      return slot.color;
    }
  }
  return NOZZLE_NEUTRAL_HEX;
}

/**
 * Throttle decision: true when enough time has passed since the last frame
 * (≥ 250 ms → ≤ 4 Hz). Deterministic + pure so the viewport follows the AC.
 */
export function shouldUpdateLive(lastUpdateMs: number, nowMs: number): boolean {
  return nowMs - lastUpdateMs >= LIVE_UPDATE_MS;
}

/** Layer-bar fraction (0..1) from the print progress; null when unknown. */
export function layerBarFraction(progress: PrintProgress | null): number | null {
  if (!progress) return null;
  const { currLayer, totalLayers, progressPct } = progress;
  if (typeof currLayer === "number" && typeof totalLayers === "number" && totalLayers > 0) {
    return Math.min(1, Math.max(0, (currLayer + 1) / totalLayers));
  }
  if (typeof progressPct === "number" && progressPct >= 0) {
    return Math.min(1, Math.max(0, progressPct / 100));
  }
  return null;
}

/** Spray headline (%). */
export function sprayPct(progress: PrintProgress | null): number | null {
  return progress?.progressPct ?? null;
}

/** Spray layer text ("12/120") — same format as the status bar. */
export function sprayLayerText(progress: PrintProgress | null): string | null {
  if (!progress) return null;
  const { currLayer, totalLayers } = progress;
  if (currLayer === null && totalLayers === null) return null;
  return `${currLayer === null ? 0 : currLayer + 1}/${totalLayers ?? "—"}`;
}
