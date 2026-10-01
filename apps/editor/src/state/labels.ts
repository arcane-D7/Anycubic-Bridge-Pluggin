import { create } from "zustand";

/**
 * S9.8-002 (G45) — viewport label bus.
 *
 * A tiny non-owning pipe between the in-canvas projector and the out-of-canvas
 * overlay, so chips follow objects with ZERO canvas re-renders:
 *
 * - `LabelProjector` (inside the R3F Canvas) runs each frame, computes the
 *   NDC anchor for every visible object from its LIVE object3D matrix, writes
 *   it into the mutable `ndcMap`, and bumps `frame`.
 * - `ObjectLabels` (outside the Canvas, sibling overlay) subscribes to
 *   `frame`, reads `ndcMap` during render and converts NDC → CSS pixels.
 *
 * Pointer hover is also shared here: `SceneObjectModel` reports mesh hover so
 * the overlay can show that object's chip (unless always-on).
 */

export interface NdcPoint {
  readonly x: number;
  readonly y: number;
  readonly behind: boolean;
}

/** Mutable NDC bus — never React-reactive by design. */
const ndcMap = new Map<string, NdcPoint>();

export function writeNdc(name: string, point: NdcPoint): void {
  ndcMap.set(name, point);
}

export function clearNdc(): void {
  ndcMap.clear();
}

export function readNdc(name: string): NdcPoint | undefined {
  return ndcMap.get(name);
}

interface LabelsBusState {
  /** Frame counter — the overlay subscribes to re-render on each pass. */
  readonly frame: number;
  bump: () => void;
  /** Object whose mesh is currently hovered (null = none). */
  readonly hoveredName: string | null;
  setHovered: (name: string | null) => void;
}

export const useLabelsBus = create<LabelsBusState>()((set) => ({
  frame: 0,
  bump: () => set((s) => ({ frame: s.frame + 1 })),
  hoveredName: null,
  setHovered: (name) => set({ hoveredName: name }),
}));
