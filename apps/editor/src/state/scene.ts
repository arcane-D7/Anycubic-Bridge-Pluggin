import { create } from "zustand";

/**
 * Scene/selection state stub (R0). No geometry authority yet — selection is a
 * name + flags carried through the R3F viewport highlight. R2+ will extend this
 * with per-object transforms and regions; the shape is frozen for the shell.
 */

export interface SelectedObject {
  readonly name: string;
  /** Mirrors the meshInfo flag so the viewport can tint non-watertight meshes. */
  readonly watertight: boolean;
}

interface SceneState {
  readonly selected: SelectedObject | null;
  readonly select: (name: string, watertight: boolean) => void;
  readonly clear: () => void;
}

export const useScene = create<SceneState>()((set) => ({
  selected: null,
  select: (name, watertight) => set({ selected: { name, watertight } }),
  clear: () => set({ selected: null }),
}));
