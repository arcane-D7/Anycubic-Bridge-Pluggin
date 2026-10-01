/**
 * S9.5-001 print job store (zustand). Thin wrapper over the pure
 * `printjob-core` machine: staged progress, cancel, error states and the
 * send flow. The React components (`SliceButton`, `SliceProgress`,
 * `SliceStatsPanel`, `PrintJobDialog`) are thin layers over this store.
 */

import { create } from "zustand";
import {
  blockingObjects,
  initialPrintJobState,
  reducePrintJob,
  reduceSendJob,
  sendTokenFor,
  sliceEligible,
  SLICE_STAGES,
  tokenHash,
  type ObjectWatertight,
  type PrintJobEvent,
  type PrintJobState,
  type SendApprovalCard,
  type SendJobEvent,
  type SendStage,
  type SliceStats,
} from "./printjob-core";

export type {
  PrintJobEvent,
  PrintJobState,
  SendApprovalCard,
  SendJobEvent,
  SendStage,
  SliceStage,
  SliceStats,
} from "./printjob-core";
export { SLICE_STAGES, sliceEligible, blockingObjects, tokenHash, sendTokenFor };

interface PrintJobStore extends PrintJobState {
  // --- S9.5-004 send approval card (approval-card mask) -------------------
  /** Active send-to-print approval card (null when none/closed). */
  readonly approval: SendApprovalCard | null;
  /** Last approved send token hash — send time must match it exactly. */
  readonly lastApprovedHash?: string;
  /** Preflight against the current plate objects; returns blocked names. */
  readonly preflight: (objects: readonly ObjectWatertight[]) => string[];
  /** Start slicing (guarded by preflight); returns rejected reasons. */
  readonly start: () => readonly string[];
  /** Advance the staged progress bar. */
  readonly advanceStage: (index: number, total: number, label: string) => void;
  /** Slice finished — carry the pipeline stats. */
  readonly finish: (stats: SliceStats) => void;
  /** Cancel between stages. */
  readonly cancel: () => void;
  /** Surface an error. */
  readonly fail: (reason: string) => void;
  /** Begin the send flow. */
  readonly sendStart: () => void;
  readonly reportSendStage: (progress: number, stage: SendStage) => void;
  readonly sendFinished: () => void;
  readonly sendError: (reason: string) => void;
  /** Reset to fresh idle (used by the closeout of a sent/cancelled job). */
  readonly reset: () => void;
  // --- S9.5-004 send approval card (approval-card mask) -------------------
  /** Open the confirmation card for a ready slice — NOT executed yet. */
  readonly openSendApproval: (req: {
    readonly summary: string;
    readonly printerIp: string;
    readonly printerName: string;
    readonly stats: SliceStats;
  }) => void;
  /** Approve (true) or reject (false) the pending card. */
  readonly decideSendApproval: (id: string, approved: boolean) => void;
  /** Close/dismiss the card (no-op after sent). */
  readonly closeSendApproval: () => void;
}

/** Live print job store (zustand, S9.5-001 + S9.5-004). */
export const usePrintJob = create<PrintJobStore>()((set, get) => {
  const apply = (event: PrintJobEvent) => set((s) => reducePrintJob(s, event).state);
  const applySend = (event: SendJobEvent) => set((s) => reduceSendJob(s, event).state);

  return {
    ...initialPrintJobState(),
    approval: null,
    lastApprovedHash: undefined,

    preflight(objects) {
      const blocked = blockingObjects(objects);
      set((s) => reducePrintJob(s, { kind: "preflight", objects }).state);
      return blocked;
    },

    start() {
      const out = reducePrintJob(get(), { kind: "start" });
      if (out.rejected?.length) return out.rejected;
      apply({ kind: "start" });
      return [];
    },

    advanceStage(index, total, label) {
      apply({ kind: "stage", index, total, label });
    },

    finish(stats) {
      apply({ kind: "finish", stats });
    },

    cancel() {
      apply({ kind: "cancel" });
    },

    fail(reason) {
      apply({ kind: "error", reason });
    },

    sendStart() {
      apply({ kind: "send-start", stage: "negotiate" });
    },

    reportSendStage(progress, stage) {
      apply({ kind: "send-stage", stage, progress });
    },

    sendFinished() {
      apply({ kind: "send-finished" });
    },

    sendError(reason) {
      apply({ kind: "send-error", reason });
    },

    // --- S9.5-004 send approval card --------------------------------------
    openSendApproval(req) {
      applySend({ kind: "open", ...req });
    },

    decideSendApproval(id, approved) {
      applySend({ kind: "decide", id, approved });
    },

    closeSendApproval() {
      applySend({ kind: "close" });
    },

    reset() {
      set({ ...initialPrintJobState(), approval: null, lastApprovedHash: undefined });
    },
  };
});
