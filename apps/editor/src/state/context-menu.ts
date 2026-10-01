import { create } from "zustand";
import type { ContextMenuState } from "../components/context-menu-core";

/**
 * S9.8-001 — app-wide context menu store. A SINGLE `ContextMenu` is mounted
 * once (in App) and any surface opens it by setting `state`. The store is
 * headless (no React), so tests can drive it without mounting.
 */

interface ContextMenuStore {
  readonly state: ContextMenuState | null;
  readonly open: (state: ContextMenuState) => void;
  readonly close: () => void;
}

export const useContextMenuStore = create<ContextMenuStore>()((set) => ({
  state: null,
  open: (state) => set({ state }),
  close: () => set({ state: null }),
}));
