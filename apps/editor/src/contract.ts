/**
 * Shared editor contract types — Sprint 5 (S5-002/S5-003) workspace skeleton.
 *
 * This file exists to (a) give the strict `tsc --noEmit` gate real inputs before
 * Sprint 6 creates the full Tauri shell, and (b) lock the dual-mode slicing
 * contract (§3.0a, user-confirmed 2026-09-28) as types so later sprints cannot
 * drift from it. No runtime feature code lands here by design.
 */

/** Project slicing mode per §3.0a — persisted per project, default `standard`. */
export type SlicingMode = "standard" | "nonplanar";

/** Capabilities a machine profile must declare for `nonplanar` to be selectable. */
export interface NonPlanarCapabilities {
  readonly continuous_z: { readonly supported: boolean };
  readonly slopeBudgetDeg?: { readonly maxDegrees: number };
  readonly jointModel?: "cartesian" | "rotary";
}

/** Per-segment IR provenance mode tag (§3.0a, S8-004). */
export interface SegmentModeTag {
  readonly mode: SlicingMode;
  /** Z-ramp segments only exist in `nonplanar` jobs — validator rejects them in `standard`. */
  readonly isContinuousZ: boolean;
}

/** A project's persisted mode + capability gate result (S6-004). */
export interface SlicingModeSetting {
  readonly mode: SlicingMode;
  /** Why nonplanar is unavailable, iff mode is `standard` and capabilities are missing. */
  readonly nonPlanarDisabledReason?: string;
}
