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
  type ToolbarFlagKey,
  type ToolbarFlags,
  type ViewPreset,
} from "./toolbar-core";

export type { ToolbarFlagKey, ToolbarFlags, ViewPreset };
export { isViewPreset, VIEW_PRESET_KEYS, VIEW_PRESETS };

interface ToolbarState extends ToolbarFlags {
  readonly toggleFlag: (key: ToolbarFlagKey) => void;
}

/** Live toolbar store (zustand, S9.4-001). */
export const useToolbar = create<ToolbarState>()((set, get) => ({
  snap: DEFAULT_TOOLBAR_FLAGS.snap,
  grid: DEFAULT_TOOLBAR_FLAGS.grid,
  toggleFlag: (key) => set(toggleToolbarFlag(get(), key)),
}));
