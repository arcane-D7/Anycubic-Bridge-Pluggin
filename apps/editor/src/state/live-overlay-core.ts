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

/** Live update throttle — the sprint AC says ≤ 4 Hz (250 ms). */
export const LIVE_UPDATE_MS = 250 as const;

/** Neutral nozzle color when no loaded filament slot is known. */
export const NOZZLE_NEUTRAL_HEX = "#c8ccd2" as const;

export interface ToolheadWorld {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Map printer motion (mm) to world position on the plate. Returns null when
 * the motion or volume is incomplete (no guess — the overlay hides until the
 * machine reports a real position).
 */
export function toolheadWorld(
  motion: {
    readonly xMm: number | null;
    readonly yMm: number | null;
    readonly zMm: number | null;
  } | null,
  volume: BuildVolume | null,
): ToolheadWorld | null {
  if (!motion || !volume) return null;
  const { xMm, yMm, zMm } = motion;
  if (xMm === null || yMm === null || zMm === null) return null;
  if (
    ![volume.widthMm, volume.depthMm, volume.heightMm].every((v) => Number.isFinite(v) && v > 0)
  ) {
    return null;
  }
  // Clamp to the build volume so a stale/wrong report never throws the
  // toolhead out of the renderable plate area (safe floor/ceiling).
  const halfW = volume.widthMm / 2;
  const halfD = volume.depthMm / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: clamp(xMm, -halfW, halfW),
    y: clamp(yMm, 0, volume.heightMm),
    z: -clamp(zMm, -halfD, halfD),
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
