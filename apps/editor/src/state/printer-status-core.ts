/**
 * S9.9-006 — status-bar printer chip helpers + alert levels (pure, headless).
 *
 * Every value the printer chips render + every alert threshold comes from
 * here (single source of truth, like S9.9-005): temp/progress/layer/clock
 * formatters, filament alert buckets (<15% toast dot, <5% persistent), the
 * material temperature-window check and the ACE error-code range 129–135.
 *
 * No React/zustand/three — importable from `.mjs` tests.
 */

import type { AceBox, TempProbe } from "../bridge/types.ts";

/** Remaining% below which the filament chip gets a toast + dot (low). */
export const STATUS_FILAMENT_LOW_PCT = 15 as const;
/** Remaining% below which the alert is persistent (critical). */
export const STATUS_FILAMENT_CRIT_PCT = 5 as const;

export type FilamentAlert = "none" | "low" | "crit";

/** Filament alert bucket: crit < 5 ≤ low < 15, else none. */
export function filamentAlertFor(pct: number | null): FilamentAlert {
  if (pct === null) return "none";
  if (pct < STATUS_FILAMENT_CRIT_PCT) return "crit";
  if (pct < STATUS_FILAMENT_LOW_PCT) return "low";
  return "none";
}

/** True when the current temp sits outside the material window (from the
 * slot's `recommendedTempsC`), i.e. a preventive alert candidate. */
export function tempOutsideWindow(
  currentC: number | null,
  rec: { readonly min: number; readonly max: number } | null,
): boolean {
  if (currentC === null || rec === null) return false;
  return currentC < rec.min || currentC > rec.max;
}

/** ACE feed/slot state codes 129–135 are errors → red toast + DevTools. */
export function isAceErrorCode(state: number | null): boolean {
  return state !== null && state >= 129 && state <= 135;
}

/** Formatters — all null → "—", numbers rounded, mono tabular-nums friendly. */
export function formatTempC(v: number | null): string {
  return v === null ? "—" : String(Math.round(v));
}

export function formatTempProbe(p: TempProbe): string {
  return `${formatTempC(p.currentC)}/${formatTempC(p.targetC)}`;
}

/** "12/120" — total required, current optional (0 when unknown). */
export function formatLayerPart(curr: number | null, total: number | null): string | null {
  if (total === null) return null;
  return `${curr ?? 0}/${total}`;
}

/** "42%" — null → null (no chip). */
export function formatPct(p: number | null): string | null {
  return p === null ? null : `${Math.round(p)}%`;
}

/** "1:23" — null → null. */
export function formatClock(total: number | null): string | null {
  if (total === null) return null;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Lowest remaining% across all ACE boxes/slots (null when none usable). */
export function lowestFilamentPct(boxes: readonly AceBox[]): number | null {
  let lowest: number | null = null;
  for (const box of boxes) {
    for (const s of box.slots) {
      if (s.state === "empty" || s.remainingPct === null) continue;
      if (lowest === null || s.remainingPct < lowest) lowest = s.remainingPct;
    }
  }
  return lowest;
}

/** Loaded slot number (1-based) across boxes, or null when nothing loaded. */
export function loadedSlotNumber(boxes: readonly AceBox[]): number | null {
  for (const box of boxes) {
    if (box.loadedSlotIndex !== null && box.loadedSlotIndex >= 0) {
      return box.loadedSlotIndex + 1;
    }
  }
  return null;
}

/** Any ACE slot erroring (state 129–135)? → alert chip (red). */
export function aceErrorCode(boxes: readonly AceBox[]): number | null {
  for (const box of boxes) {
    for (const s of box.slots) {
      if (isAceErrorCode(s.stateCode ?? null)) return s.stateCode ?? null;
    }
  }
  return null;
}

export type { AceBox, TempProbe };
