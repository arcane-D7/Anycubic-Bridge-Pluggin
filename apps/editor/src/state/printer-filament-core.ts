/**
 * S9.9-005 — filament/ACE thresholds + state mapping (pure, headless).
 *
 * Every threshold the Filaments tab cares about lives here so unit tests
 * (and later the status bar in S9.9-006) share ONE source of truth:
 *
 *   - progress-ring color buckets  (>=50 green, >=15 amber, <15 red)
 *   - `loaded_slot` highlight rule (loaded slot index vs slot index)
 *   - dryer state machine rendering (idle → heating → drying → done)
 *   - `editOrigin` badge mapping    (rfid vs manual)
 *
 * No React/zustand/three: importable from `.mjs` tests and reused by the
 * PrinterStatusBar later. Agnostic — never any hardcoded model/IDs.
 */

import type { AceBox, AceSlot, EditOrigin, FilamentState } from "../bridge/types.ts";

/** Percent below which the ring turns amber (material getting low). */
export const RING_WARN_PCT = 50 as const;
/** Percent below which the ring turns red + toast fires (S9.9-006 reuses). */
export const RING_CRIT_PCT = 15 as const;

/** Visual bucket for the progress ring. */
export type RingTone = "ok" | "warn" | "crit" | "na";

/** Map a slot remaining% to a ring tone (null/unknown → "na"). */
export function ringToneFor(pct: number | null): RingTone {
  if (pct === null || Number.isNaN(pct)) return "na";
  if (pct < RING_CRIT_PCT) return "crit";
  if (pct < RING_WARN_PCT) return "warn";
  return "ok";
}

/** CSS class suffix for the tone (`.device-ring-{tone}`), '' when na. */
export function ringClassFor(pct: number | null): string {
  return ringToneFor(pct) === "na" ? "" : ` device-ring-${ringToneFor(pct)}`;
}

/** Was this slot flagged as low (amber) or critical (red)? */
export function isLowFilament(slot: Pick<AceSlot, "state" | "remainingPct">): boolean {
  if (slot.state === "empty") return false;
  return ringToneFor(slot.remainingPct) !== "ok" && ringToneFor(slot.remainingPct) !== "na";
}

/** Lowest remaining% across all boxes' slots (null when none usable). */
export function selectLowestFilamentPct(boxes: readonly AceBox[]): {
  readonly pct: number | null;
  readonly slot: AceSlot | null;
} {
  let lowest: AceSlot | null = null;
  for (const box of boxes) {
    for (const slot of box.slots) {
      if (slot.state === "empty") continue;
      if (slot.remainingPct === null) continue;
      if (!lowest || lowest.remainingPct === null || slot.remainingPct < lowest.remainingPct) {
        lowest = slot;
      }
    }
  }
  return { pct: lowest?.remainingPct ?? null, slot: lowest };
}

/** Dryer state machine buckets. */
export type DryerPhase = "absent" | "off" | "heating" | "drying" | "done";

export function dryerPhaseFor(box: AceBox): DryerPhase {
  if (!box.drying) return "absent";
  if (!box.drying.active) return "off";
  const { targetTempC, remainingSeconds } = box.drying;
  if (targetTempC === null && remainingSeconds === null) return "drying";
  if (remainingSeconds !== null && remainingSeconds <= 0) return "done";
  if (remainingSeconds !== null && remainingSeconds > 0) return "drying";
  // Active with target but no countdown — still heating/on.
  return "heating";
}

/** Is THIS slot the one currently loaded into the toolhead? */
export function isLoadedSlot(box: AceBox, slotIndex: number): boolean {
  return box.loadedSlotIndex !== null && box.loadedSlotIndex === slotIndex;
}

/** Badge label key for `editOrigin` (RFID-tagged vs manual edit). */
export function editOriginKey(
  origin: EditOrigin,
): "device.fil.origin.rfid" | "device.fil.origin.manual" {
  return origin === "rfid" ? "device.fil.origin.rfid" : "device.fil.origin.manual";
}

/** Material display label: prefer real name, fall back to state label. */
export function materialLabel(slot: AceSlot): string {
  if (slot.material) return slot.material;
  switch (slot.state) {
    case "identified":
    case "identifying":
      return slot.state;
    default:
      return slot.state === "empty" ? "" : slot.state;
  }
}

/** Count of boxes + total slots for the section header. */
export function boxSummary(boxes: readonly AceBox[]): {
  readonly boxCount: number;
  readonly loadedCount: number;
} {
  let loadedCount = 0;
  for (const box of boxes) {
    if (box.loadedSlotIndex !== null && box.loadedSlotIndex >= 0) loadedCount += 1;
  }
  return { boxCount: boxes.length, loadedCount };
}

export type { AceBox, AceSlot, EditOrigin, FilamentState };
