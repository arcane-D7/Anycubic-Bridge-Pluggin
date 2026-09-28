import { create } from "zustand";
import {
  type ContractLike,
  type FlowKind,
  type SelectionSnapshot,
  type SessionStatus,
  initialViewportState,
  reduceViewport,
  runModalFlow as pureRunModalFlow,
} from "./viewport-core";

export type { SessionStatus, SelectionSnapshot } from "./viewport-core";

/**
 * Viewport store (S7-004) — thin zustand wrapper over the dependency-free
 * state machine in `viewport-core.ts`. All lifecycle decisions live in the
 * pure reducer; the store only bridges React <-> core and issues contract
 * calls (begin/update/commit/cancel) which the bridge forwards to Blender.
 *
 * The viewport is a VIEW: it never mutates geometry. It records the
 * authoritative revision + selection_state from commit events, drives modal
 * flows (gizmo begin→update→commit, numeric begin→0 updates→commit, cancel
 * rollback), and surfaces renderer-vs-snapshot mismatches (renderer bug —
 * snapshot wins).
 */

interface ViewportActions {
  /** Bridge event: authoritative snapshot arrived (revision + selection). */
  onCommitEvent: (revision: number, selection: SelectionSnapshot) => void;
  /** UI gesture: begin a modal session at current connection revision. */
  begin: (expectedRevision: number) => void;
  /** UI gesture: provisional update while dragging a gizmo. */
  update: (expectedRevision: number) => void;
  /** UI gesture: end the session; commit validated against the contract. */
  commit: (expectedRevision: number) => Promise<void>;
  /** UI gesture: cancel; roll back to begin revision. */
  cancel: (beginRevision: number) => void;
  /** Contract flicked an invalidation (BLEND changed) — surface, re-import offered. */
  invalidate: (reason: { readonly expected: string; readonly actual: string }) => void;
  /** Drive a full UI gesture end-to-end against the contract (protocol trace). */
  runFlow: (contract: ContractLike, flow: FlowKind) => Promise<void>;
  /** Reset to a pristine idle viewport (e.g. after re-import). */
  reset: () => void;
}

export type ViewportStore = {
  revision: number;
  selection: SelectionSnapshot | null;
  sessionStatus: SessionStatus;
  beginRevision: number | null;
  expectedRevision: number;
  rendererMismatch: { readonly expected: string; readonly actual: string } | null;
} & ViewportActions;

const EMPTY_SELECTION: SelectionSnapshot = {
  verts: [],
  faces: [],
  edges: [],
  objectModeNames: [],
};

export const useViewport = create<ViewportStore>()((set, get) => ({
  ...initialViewportState(),
  rendererMismatch: null,

  onCommitEvent: (revision, selection) =>
    set((s) => {
      const out = reduceViewport(s, { kind: "commit-event", revision, selection });
      return {
        ...out.state,
        selection: selection ?? EMPTY_SELECTION,
        rendererMismatch: null,
      };
    }),

  begin: (expectedRevision) =>
    set((s) => reduceViewport(s, { kind: "begin", expectedRevision }).state),

  update: (expectedRevision) =>
    set((s) => reduceViewport(s, { kind: "update", expectedRevision }).state),

  commit: (expectedRevision) =>
    new Promise<void>((resolve) => {
      set((s) => {
        const out = reduceViewport(s, { kind: "commit", expectedRevision });
        resolve();
        return out.state;
      });
    }),

  cancel: (beginRevision) => set((s) => reduceViewport(s, { kind: "cancel", beginRevision }).state),

  invalidate: (reason) =>
    set((s) => {
      const out = reduceViewport(s, { kind: "invalidate", reason });
      return { ...out.state, rendererMismatch: out.invalidatedReason ?? null };
    }),

  runFlow: async (contract, flow) => {
    const s = get();
    const out = await pureRunModalFlow(contract, flow, {
      revision: s.revision,
      beginRevision: s.beginRevision,
      expectedRevision: s.expectedRevision,
      sessionStatus: s.sessionStatus,
      selection: s.selection,
    });
    set(out.state);
    if (out.staleRejected) {
      // Surface the stale rejection to the UI (re-base offered), never force.
      console.warn(
        `viewport: stale revision refused (${out.staleRejected.expected}] -> ${out.staleRejected.actual})`,
      );
    }
  },

  reset: () => set({ ...initialViewportState(), rendererMismatch: null }),
}));

export { initialViewportState };
