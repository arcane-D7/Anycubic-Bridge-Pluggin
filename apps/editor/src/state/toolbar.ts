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
  readonly toggleFlag: (key: ToolbarFlagKey) => void;
}

/** Live toolbar store (zustand, S9.4-001). */
export const useToolbar = create<ToolbarState>()((set, get) => ({
  snap: DEFAULT_TOOLBAR_FLAGS.snap,
  grid: DEFAULT_TOOLBAR_FLAGS.grid,
  booleanTool: DEFAULT_TOOLBAR_FLAGS.booleanTool,
  toggleFlag: (key) => set(toggleToolbarFlag(get(), key)),
}));
