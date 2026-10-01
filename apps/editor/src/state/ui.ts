import { create } from "zustand";
import { grabStart, grabToggleAxis, type GestureKind, type GrabState } from "./shortcuts-core";

/**
 * Local UI state (R0 panels + S9.1-005 toast bus).
 * Panel sizes are per-window session state only — not persisted yet
 * (R2+ may persist layout per workspace).
 */

export type ToastKind = "info" | "success" | "warning" | "error";

/** Toolbar interaction mode (S9.3-001): which transform the gizmo drives. */
export type ToolMode = "select" | "move" | "rotate" | "scale" | "measure";

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
  /**
   * Viewport object label chips (S9.8-002): always-on forces every chip
   * visible (also shown on hover when false).
   */
  readonly objectLabelsAlwaysOn: boolean;
  readonly toggleObjectLabelsAlwaysOn: () => void;
  /** Active toolbar tool (S9.3-001): select|move|rotate|scale. */
  readonly tool: ToolMode;
  readonly setTool: (mode: ToolMode) => void;
  /**
   * Transform inspector dirty state (S9.3-002, AC-3). When the numeric
   * inspector holds a draft that differs from the committed bridge snapshot,
   * the status bar shows which kinds are dirty (`position|rotation|scale`).
   * `dirtyTransformName` scopes it to the object the draft belongs to so a
   * selection change clears the diff.
   */
  readonly dirtyTransformName: string | null;
  readonly dirtyKinds: readonly ("position" | "rotation" | "scale")[] | null;
  readonly setDirtyTransform: (
    name: string,
    kinds: readonly ("position" | "rotation" | "scale")[] | null,
  ) => void;
  readonly clearDirtyTransform: () => void;
  /**
   * Keyboard grab session (S9.3-003, G/R/S). A grab starts a modal transform:
   * the gizmo mounts in that mode until Enter confirms or Esc cancels (which
   * restores the previous tool). X/Y/Z constrain the active grab axis.
   */
  readonly grab: GrabState | null;
  readonly startGrab: (kind: GestureKind) => void;
  readonly toggleGrabAxis: (axis: "x" | "y" | "z") => void;
  readonly confirmGrab: () => void;
  readonly cancelGrab: () => void;
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
  objectLabelsAlwaysOn: false,
  toggleObjectLabelsAlwaysOn: () => set((s) => ({ objectLabelsAlwaysOn: !s.objectLabelsAlwaysOn })),
  tool: "select",
  setTool: (mode) => set({ tool: mode }),
  dirtyTransformName: null,
  dirtyKinds: null,
  setDirtyTransform: (name, kinds) => set({ dirtyTransformName: name, dirtyKinds: kinds }),
  clearDirtyTransform: () => set({ dirtyTransformName: null, dirtyKinds: null }),
  grab: null,
  startGrab: (kind) =>
    set((s) => {
      if (s.grab) return {}; // modal already active — ignore
      return {
        grab: grabStart(kind, s.tool === "select" ? "tool.select" : grabToolFor(s.tool)),
      };
    }),
  toggleGrabAxis: (axis) => set((s) => ({ grab: s.grab ? grabToggleAxis(s.grab, axis) : null })),
  confirmGrab: () => set({ grab: null }),
  cancelGrab: () =>
    set((s) => {
      if (!s.grab) return {};
      const out = { grab: null, tool: grabToolToMode(s.grab.prevTool) };
      return out;
    }),
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

/** ToolMode → ToolCommandId (registry ids share names 1:1). */
export function grabToolFor(
  mode: ToolMode,
): "tool.select" | "tool.move" | "tool.rotate" | "tool.scale" {
  // measure has no gizmo/grabs — treat as select for a safety fallback.
  if (mode === "select" || mode === "measure") return "tool.select";
  return mode === "move" ? "tool.move" : mode === "rotate" ? "tool.rotate" : "tool.scale";
}

/** ToolCommandId → ToolMode (Esc restores the pre-grab tool). */
export function grabToolToMode(
  id: "tool.select" | "tool.move" | "tool.rotate" | "tool.scale" | "tool.measure",
): ToolMode {
  return id === "tool.select"
    ? "select"
    : id === "tool.move"
      ? "move"
      : id === "tool.rotate"
        ? "rotate"
        : id === "tool.scale"
          ? "scale"
          : "measure";
}
