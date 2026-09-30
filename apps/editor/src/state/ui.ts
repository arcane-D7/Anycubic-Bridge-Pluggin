import { create } from "zustand";

/**
 * Local UI state (R0 panels + S9.1-005 toast bus).
 * Panel sizes are per-window session state only — not persisted yet
 * (R2+ may persist layout per workspace).
 */

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly title: string;
  readonly message?: string;
  readonly createdAt: number;
}

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
  /** Global scene view flags (S9.2-003): wireframe edges overlay toggle. */
  readonly sceneViewEdges: boolean;
  readonly toggleSceneViewEdges: () => void;
  /** Toast bus (S9.1-005). Top-right stacked, auto-dismiss. */
  readonly toasts: readonly Toast[];
  readonly pushToast: (t: Omit<Toast, "id" | "createdAt">) => void;
  readonly dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUi = create<UiState>()((set, get) => ({
  plateOverrideMm: null,
  setPlateOverride: (mm) => set({ plateOverrideMm: mm }),
  leftOpen: true,
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  rightOpen: true,
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  sceneViewEdges: true,
  toggleSceneViewEdges: () => set((s) => ({ sceneViewEdges: !s.sceneViewEdges })),
  toasts: [],
  pushToast: ({ kind, title, message }) => {
    const id = toastSeq++;
    set((s) => ({
      toasts: [...s.toasts, { id, kind, title, message, createdAt: Date.now() }],
    }));
    // Auto-dismiss (info/success: 4s; warning/error: 7s).
    const ms = kind === "warning" || kind === "error" ? 7000 : 4000;
    window.setTimeout(() => {
      const still = get().toasts.some((t) => t.id === id);
      if (still) get().dismissToast(id);
    }, ms);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
