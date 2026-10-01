/**
 * S9.5-001 print job state machine — dependency-free pure core.
 *
 * Models the slice job lifecycle per the S8 pipeline contract:
 *
 *   idle ──start──▶ slicing ──finish──▶ ready ──send-start──▶ sending ──sent
 *    │                 │  ▲                │
 *    │                 │  └──cancel──▶ cancelled (only pre-preview stages)
 *    └──error(any)─────┴──▶ error ◀──play── sending (send failed → back to ready)
 *
 * Invariants:
 * - Non-watertight objects block start (preflight) with an actionable hint
 *   naming the offender(s) — slicing NEVER starts on a dirty plate.
 * - Every stage transition keeps `stage + 1 over total` and a mono label;
 *   cancel is only honoured between stages (a finished slice is immutable).
 * - send requires a ready slice; a send failure returns to ready (retryable),
 *   never to slicing.
 * - Stale revisions are dropped (re-base), never forced.
 *
 * Deliberately dependency-free (no React/zustand) so transitions, cancel and
 * error paths are testable headless under the plain Node test runner. Only
 * `type` imports from the bridge contract (no runtime coupling).
 */

import type { SliceStats } from "../bridge/types";

export type { SliceStats };

/** S8 pipeline stages, ordered — labels shown in the staged progress bar. */
export const SLICE_STAGES = ["prepare", "planar-core", "IR", "postprocess", "preview"] as const;
export type SliceStage = (typeof SLICE_STAGES)[number];

export type PrintJobStatus =
  "idle" | "slicing" | "ready" | "sending" | "sent" | "cancelled" | "error";

export type SendStage = "negotiate" | "upload" | "queue";

export interface PrintJobState {
  readonly status: PrintJobStatus;
  /** 0-based index of the current (or last completed) pipeline stage. */
  readonly stage: number;
  readonly stageTotal: number;
  /** Mono label of the current stage ("" when idle/ready). */
  readonly stageLabel: string;
  /** Result of a finished slice. */
  readonly stats: SliceStats | null;
  /** Objects that blocked the slice (non-watertight), for the repair hint. */
  readonly blockedBy: readonly string[];
  /** Human error reason (status === "error"). */
  readonly error: string | null;
  /** Send progress 0..1 (status === "sending"). */
  readonly sendProgress: number | null;
  /** Active send stage label (status === "sending"). */
  readonly sendStage: string | null;
}

export interface ObjectWatertight {
  readonly name: string;
  readonly watertight: boolean;
}

export type PrintJobEvent =
  | {
      readonly kind: "preflight";
      /** Objects eligible for slicing (must be watertight). */
      readonly objects: readonly ObjectWatertight[];
    }
  | { readonly kind: "start" }
  | {
      readonly kind: "stage";
      readonly index: number;
      readonly total: number;
      readonly label: string;
    }
  | { readonly kind: "finish"; readonly stats: SliceStats }
  | { readonly kind: "cancel" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "send-start"; readonly stage: SendStage }
  | { readonly kind: "send-stage"; readonly stage: SendStage; readonly progress: number }
  | { readonly kind: "send-finished" }
  | { readonly kind: "send-error"; readonly reason: string };

export interface PrintJobOutcome {
  readonly state: PrintJobState;
  /**
   * Set when a transition was rejected because the job isn't in the right
   * state — the caller should surface the reason, never force the machine.
   */
  readonly rejected?: readonly string[];
}

export function initialPrintJobState(): PrintJobState {
  return {
    status: "idle",
    stage: 0,
    stageTotal: SLICE_STAGES.length,
    stageLabel: "",
    stats: null,
    blockedBy: [],
    error: null,
    sendProgress: null,
    sendStage: null,
  };
}

/** True when every object on the plate is watertight (empty plate → false). */
export function sliceEligible(objects: readonly ObjectWatertight[]): boolean {
  return objects.length > 0 && objects.every((o) => o.watertight);
}

/** Names of objects that would block slicing (empty when all watertight). */
export function blockingObjects(objects: readonly ObjectWatertight[]): string[] {
  return objects.filter((o) => !o.watertight).map((o) => o.name);
}

/**
 * Pure reducer — the whole print job lifecycle in one function. Every
 * transition is guarded; invalid ones return `rejected` reasons.
 */
export function reducePrintJob(state: PrintJobState, event: PrintJobEvent): PrintJobOutcome {
  switch (event.kind) {
    case "preflight": {
      const blocked = blockingObjects(event.objects);
      if (blocked.length > 0) {
        // Stay idle, but remember who blocked it so the Slice button can show
        // an actionable repair hint (toast + dialog link → 9.7 repair).
        return { state: { ...state, status: "idle", blockedBy: blocked, error: null } };
      }
      return { state: { ...state, blockedBy: [], error: null } };
    }

    case "start": {
      if (state.status !== "idle") {
        return { state, rejected: ["start requires idle"] };
      }
      if (state.blockedBy.length > 0) {
        return {
          state,
          rejected: ["slicing blocked by non-watertight objects", ...state.blockedBy],
        };
      }
      return {
        state: {
          ...state,
          status: "slicing",
          stage: 0,
          stageTotal: SLICE_STAGES.length,
          stageLabel: SLICE_STAGES[0]!,
          stats: null,
          error: null,
          sendProgress: null,
          sendStage: null,
        },
      };
    }

    case "stage": {
      if (state.status !== "slicing") {
        return { state, rejected: ["stage only while slicing"] };
      }
      // Monotonic forward-only stage advance: a stale/out-of-order index is
      // dropped, never forced.
      if (event.index < state.stage || event.index > event.total) {
        return { state, rejected: ["stale stage index"] };
      }
      return {
        state: {
          ...state,
          stage: event.index,
          stageTotal: event.total,
          stageLabel: event.label,
        },
      };
    }

    case "finish": {
      if (state.status !== "slicing") {
        return { state, rejected: ["finish requires slicing"] };
      }
      return {
        state: { ...state, status: "ready", stats: event.stats, stageLabel: "" },
      };
    }

    case "cancel": {
      // Cancellation is only honoured between pipeline stages — a finished
      // slice (ready) is immutable and must go through the full flow.
      if (state.status === "slicing") {
        return { state: { ...state, status: "cancelled" } };
      }
      if (state.status === "idle") {
        return { state: { ...state, status: "cancelled" } };
      }
      return { state, rejected: ["cancel only while slicing"] };
    }

    case "error": {
      if (state.status === "sent" || state.status === "ready") {
        return { state, rejected: ["error not allowed from ready/sent"] };
      }
      return { state: { ...state, status: "error", error: event.reason } };
    }

    case "send-start": {
      if (state.status !== "ready") {
        return { state, rejected: ["send-start requires ready"] };
      }
      return {
        state: {
          ...state,
          status: "sending",
          sendProgress: 0,
          sendStage: event.stage,
        },
      };
    }

    case "send-stage": {
      if (state.status !== "sending") {
        return { state, rejected: ["send-stage only while sending"] };
      }
      return {
        state: { ...state, sendStage: event.stage, sendProgress: event.progress },
      };
    }

    case "send-finished": {
      if (state.status !== "sending") {
        return { state, rejected: ["send-finished requires sending"] };
      }
      return {
        state: {
          ...state,
          status: "sent",
          sendProgress: 1,
          sendStage: null,
        },
      };
    }

    case "send-error": {
      // A failed send returns to ready (retryable) — the slice result is
      // preserved, never thrown away.
      if (state.status !== "sending") {
        return { state, rejected: ["send-error requires sending"] };
      }
      return {
        state: {
          ...state,
          status: "ready",
          sendProgress: null,
          sendStage: null,
          error: event.reason,
        },
      };
    }
  }
}
