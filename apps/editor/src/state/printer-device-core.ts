/**
 * S9.9-003 — printer device POLLING helpers (pure, headless).
 *
 * Decision helpers for the adaptive polling engine in `printer-device.ts`.
 * Kept dependency-free (NO zustand/React) so the mode/interval/staleness/
 * diff logic is unit-testable under the plain Node test runner — matching
 * the repo's `*-core.ts` convention.
 *
 * Frequencies follow the HA-validated matrix (Consultor §B.3):
 *   printing/paused → 2 s · idle → 15 s · background (hidden tab) → 60 s.
 * The ACE answers only to queries, so its data is re-read on the same tick
 * cadence; deeper ACE-rate shaping lives in the store wiring.
 */

import type { PrinterSnapshot } from "../bridge/types.ts";

export type PollingMode = "idle" | "printing" | "background";
export type PollingStatus = "idle" | "polling" | "stale" | "offline";

export type PrintStateLike = "unknown" | "idle" | "printing" | "paused" | "error" | "offline";

/** Mode derived from the last snapshot's print state. */
export function modeFromState(state: PrintStateLike): PollingMode {
  return state === "printing" || state === "paused" ? "printing" : "idle";
}

/** Interval (ms) for a given mode + tab visibility. */
export function intervalFor(mode: PollingMode, hidden: boolean): number {
  if (hidden) return 60_000;
  return mode === "printing" ? 2_000 : 15_000;
}

/** Staleness threshold (ms): beyond this the snapshot is grayed. */
export function staleThresholdFor(mode: PollingMode, hidden: boolean): number {
  return intervalFor(mode, hidden) * 3;
}

/** After N consecutive failures we mark offline. */
export const OFFLINE_AFTER_FAILURES = 3 as const;

/** Compare two snapshots field-by-field; returns the changed group paths. */
export function diffSnapshot(a: PrinterSnapshot | null, b: PrinterSnapshot | null): string[] {
  if (!a || !b) return a || b ? ["*"] : [];
  const changed: string[] = [];
  const groups: ReadonlyArray<readonly [string, ...string[]]> = [
    ["identity", "machineType", "firmwareVersion", "serial", "nozzleDiameterMm", "buildVolume"],
    ["temps.nozzle", "currentC", "targetC"],
    ["temps.bed", "currentC", "targetC"],
    ["fans", "partCoolingPct", "hotendPct"],
    [
      "print",
      "state",
      "filename",
      "currLayer",
      "totalLayers",
      "progressPct",
      "remainingSeconds",
      "speedMode",
    ],
    ["motion", "xMm", "yMm", "zMm"],
  ];
  for (const [group, ...fields] of groups) {
    const gA = groupPath(a, group);
    const gB = groupPath(b, group);
    let groupChanged = false;
    for (const f of fields) {
      const vA = gA ? gA[f] : undefined;
      const vB = gB ? gB[f] : undefined;
      if (vA !== vB) {
        changed.push(`${group}.${f}`);
        groupChanged = true;
      }
    }
    if (groupChanged) changed.push(group);
  }
  if (JSON.stringify(a.ace) !== JSON.stringify(b.ace)) changed.push("ace");
  return changed;
}

function groupPath(snap: PrinterSnapshot, group: string): Readonly<Record<string, unknown>> | null {
  const parts = group.split(".");
  let cur: unknown = snap;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Readonly<Record<string, unknown>>)[p];
  }
  return cur as Readonly<Record<string, unknown>> | null;
}

/** Compare two snapshots for deep equality (whole payload). */
export function snapshotsEqual(a: PrinterSnapshot, b: PrinterSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
