/**
 * S9.10-004 — print readiness guard (pure, headless).
 *
 * The approval card derives from the LIVE ACE snapshot, not MOCK stats:
 * before the user can approve a send, this core answers "is there usable
 * filament for this job?" from the real slots.
 *
 * `SliceStats` has no per-color breakdown, so the guard works at the box
 * level: a job is sendable iff at least one slot is loaded/identified with
 * `remainingPct` >= the job's needs (see `FILAMENT_*` below). This is the
 * HONEST rule — no network, no assumptions about which slot maps to which
 * extruder; the ACE decides the physical slot.
 *
 * Local-filament owners (no multiColorBox, e.g. a toolhead with spool) are
 * never blocked: `boxes.length === 0` → pass (the printer may feed from
 * its own spool).
 */

import type { AceBox } from "../bridge/types.ts";

/** A slot is only a candidate if it holds at least this much filament. */
export const PRINT_MIN_REMAIN_PCT = 10 as const;
/** Warn under this level (amber), hard-block below `PRINT_MIN_REMAIN_PCT`. */
export const PRINT_WARN_REMAIN_PCT = 50 as const;

export type PrintReadiness =
  | { readonly ready: true; readonly reason: string | null }
  | { readonly ready: false; readonly reason: string };

/**
 * Evaluate ACE readiness for a print job.
 *
 * @param boxes ACE boxes from the live snapshot (`snap.ace.boxes`).
 * @returns `{ready:true}` when there is at least one identified/manual slot
 *          with enough remaining, or when there is NO ACE at all (unknown
 *          local spool — pass-through honest). `{ready:false}` otherwise,
 *          with an actionable reason: no filament at all, or too low.
 */
export function printReady(boxes: readonly AceBox[]): PrintReadiness {
  if (boxes.length === 0) {
    return { ready: true, reason: null };
  }
  const usable: AceBox["slots"][number][] = [];
  for (const box of boxes) {
    for (const slot of box.slots) {
      if (slot.state === "empty") continue;
      if (slot.state === "identifying") continue;
      usable.push(slot);
    }
  }
  if (usable.length === 0) {
    return { ready: false, reason: "printer has no loaded filament slots" };
  }
  const best = usable.reduce<AceBox["slots"][number] | null>((acc, slot) => {
    if (acc === null) return slot;
    const a = slot.remainingPct ?? 0;
    const b = acc.remainingPct ?? 0;
    return a >= b ? slot : acc;
  }, null);
  const bestPct = best?.remainingPct ?? 0;
  if (bestPct < PRINT_MIN_REMAIN_PCT) {
    return {
      ready: false,
      reason: `lowest loaded filament is ${bestPct}%, below the ${PRINT_MIN_REMAIN_PCT}% minimum`,
    };
  }
  return {
    ready: true,
    reason: bestPct < PRINT_WARN_REMAIN_PCT ? `filament below ${PRINT_WARN_REMAIN_PCT}%` : null,
  };
}
