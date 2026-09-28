import { create } from "zustand";

/**
 * Local UI panel state (R0). Panel sizes are per-window session state only —
 * not persisted yet (R2+ may persist layout per workspace).
 */

interface UiState {
  /** Builder plate diameter override (mm); null = profile default. */
  readonly plateOverrideMm: number | null;
  readonly setPlateOverride: (mm: number | null) => void;
  /** Left panel visibility (object tree). */
  readonly leftOpen: boolean;
  readonly toggleLeft: () => void;
  /** Right panel visibility (chat). */
  readonly rightOpen: boolean;
  readonly toggleRight: () => void;
}

export const useUi = create<UiState>()((set) => ({
  plateOverrideMm: null,
  setPlateOverride: (mm) => set({ plateOverrideMm: mm }),
  leftOpen: true,
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  rightOpen: true,
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
}));
