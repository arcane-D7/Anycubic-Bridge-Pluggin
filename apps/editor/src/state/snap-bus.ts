import { create } from "zustand";
import type { SnapTarget } from "../viewport/transform-core";

/**
 * S9.13 — viewport snap bus.
 *
 * Non-owning pipe between the in-canvas gizmo and the out-of-canvas readout
 * (same pattern as the labels bus, `state/labels.ts`):
 *
 * - `useSnap` (inside the R3F Canvas, via `TransformGizmo`) writes the last
 *   snapped target here during a gizmo drag.
 * - `SnapReadout` (outside the Canvas, DOM sibling overlay) subscribes to
 *   `target` and renders the chip; the in-canvas `SnapGuide` reads the same
 *   value for the world-space guide line.
 *
 * Keeping the readout DOM OUT of the three.js tree is what fixes the crash
 * "R3F: Span is not part of the THREE namespace!" — an HTML element mounted
 * inside `<Canvas>` made the R3F reconciler throw, the error boundary
 * unmounted the whole React root, and the app went white (printer selector
 * and every other control died with it).
 */
interface SnapBusState {
  /** Last snapped target (null until a snap occurs; cleared on each drag). */
  readonly target: SnapTarget | null;
  setTarget: (target: SnapTarget | null) => void;
}

export const useSnapBus = create<SnapBusState>()((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));
