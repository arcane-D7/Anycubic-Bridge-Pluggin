import { create } from "zustand";
import type { MeasureKind, MeasurePoint, MeasureResult } from "../viewport/measure-core";

/**
 * S9.8-003 (G42) — measure mode bus.
 *
 * The IN-CANVAS `MeasureTool` owns the probe capture + 3D markers and pushes
 * measurements into this bus; the OUT-OF-CANVAS readout overlay (bottom-left,
 * mono) subscribes. Probe-point math lives in `measure-core.ts` (pure).
 */

export interface MeasureState {
  readonly active: boolean;
  readonly kind: MeasureKind;
  readonly probes: readonly MeasurePoint[];
  readonly result: MeasureResult | null;
  /** Marker replay token (bump after every probe so markers re-render). */
  readonly markToken: number;
  setActive: (active: boolean) => void;
  setKind: (kind: MeasureKind) => void;
  /** Capture a probe: forward the whole stream to the core reducer. */
  pushProbe: (points: readonly MeasurePoint[], result: MeasureResult | null) => void;
  clear: () => void;
  bumpMarkers: () => void;
}

export const useMeasure = create<MeasureState>()((set) => ({
  active: false,
  kind: "distance",
  probes: [],
  result: null,
  markToken: 0,
  setActive: (active) =>
    set((s) => (active === s.active ? {} : { active, probes: [], result: null, markToken: 0 })),
  setKind: (kind) => set((s) => (s.kind === kind ? {} : { kind, probes: [], result: null })),
  pushProbe: (probes, result) => set({ probes, result }),
  clear: () => set({ probes: [], result: null, markToken: 0 }),
  bumpMarkers: () => set((s) => ({ markToken: s.markToken + 1 })),
}));
