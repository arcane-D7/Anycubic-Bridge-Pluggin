/**
 * S9.4-001 floating toolbar store (zustand). Thin wrapper over the pure
 * `toolbar-core`: the boolean flags (snap/grid — STATE ONLY in 9.4, real
 * snapping lands 9.7) plus the shared `ViewPreset` dispatch used by the
 * toolbar / view cube / numpad.
 */

import { create } from "zustand";
import {
  DEFAULT_TOOLBAR_FLAGS,
  isViewPreset,
  toggleToolbarFlag,
  VIEW_PRESET_KEYS,
  VIEW_PRESETS,
  type BooleanOp,
  type ToolbarFlagKey,
  type ToolbarFlags,
  type ViewPreset,
} from "./toolbar-core";

export type { BooleanOp, ToolbarFlagKey, ToolbarFlags, ViewPreset };
export { isViewPreset, VIEW_PRESET_KEYS, VIEW_PRESETS };
export { BOOLEAN_OPS, booleanOpLabel, booleanProvenance } from "./toolbar-core";

interface ToolbarState extends ToolbarFlags {
  /** S9.7-002 — effective grid snap step (mm), configurable (1..100). */
  readonly snapStep: number;
  readonly setSnapStep: (mm: number) => void;
  readonly toggleFlag: (key: ToolbarFlagKey) => void;
}

const DEFAULT_SNAP_STEP_MM = 5;

/** Clamp the configurable snap step to the 1..100 mm window (AC-2). */
export function clampSnapStep(mm: number): number {
  if (!Number.isFinite(mm)) return DEFAULT_SNAP_STEP_MM;
  return Math.min(100, Math.max(1, Math.round(mm)));
}

/** Live toolbar store (zustand, S9.4-001; snapping S9.7-002). */
export const useToolbar = create<ToolbarState>()((set, get) => ({
  snap: DEFAULT_TOOLBAR_FLAGS.snap,
  grid: DEFAULT_TOOLBAR_FLAGS.grid,
  booleanTool: DEFAULT_TOOLBAR_FLAGS.booleanTool,
  snapStep: DEFAULT_SNAP_STEP_MM,
  setSnapStep: (mm) => set({ snapStep: clampSnapStep(mm) }),
  toggleFlag: (key) => set(toggleToolbarFlag(get(), key)),
}));
