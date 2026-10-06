/**
 * S9.11-001 view mode store (zustand) — thin wrapper over the pure
 * `view-mode-core` plus persistence + reachability wiring.
 *
 * The mode is persisted per-context to `localStorage` under
 * `anycubic:view-mode:v1` (machine-agnostic, same rule as dock/theme).
 * Reachability for the `live` fallback comes from the printers store
 * (probe result), never from this store guessing.
 */

import { create } from "zustand";
import {
  DEFAULT_VIEW_MODE,
  isViewMode,
  parseViewMode,
  VIEW_MODE_STORAGE_KEY,
  type ViewMode,
} from "./view-mode-core";

export type { ViewMode } from "./view-mode-core";
export {
  DEFAULT_VIEW_MODE,
  effectiveViewMode,
  isLiveFallback,
  isViewMode,
  VIEW_MODES,
} from "./view-mode-core";

/** localStorage helpers — guarded so SSR/tests without a DOM never crash. */
function readStoredMode(): ViewMode {
  if (typeof localStorage === "undefined") return DEFAULT_VIEW_MODE;
  let raw: unknown;
  try {
    raw = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  } catch {
    return DEFAULT_VIEW_MODE;
  }
  return parseViewMode(raw);
}

function writeStoredMode(mode: ViewMode) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, JSON.stringify(mode));
  } catch {
    // quota / private mode — the in-memory mode still applies.
  }
}

interface ViewModeState {
  /** Requested mode (user intent; may be downgraded by reachability). */
  readonly mode: ViewMode;
  /** Set the requested mode (persists). No fallback happens here. */
  readonly setMode: (mode: ViewMode) => void;
}

/** View mode store (zustand, S9.11-001). */
export const useViewMode = create<ViewModeState>()((set, get) => ({
  mode: readStoredMode(),
  setMode: (mode) => {
    if (!isViewMode(mode)) return;
    set({ mode });
    writeStoredMode(mode);
    void get(); // keep the setter stable for subscriptions
  },
}));
