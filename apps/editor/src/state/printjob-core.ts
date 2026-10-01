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

// ---------------------------------------------------------------------------
// S9.5-004 — send-to-print approval card (approval-card semantics + token
// hashing, port of the S9-006 chat approval pattern): a concrete effect is
// shown, a token hash pins the exact payload, and the send lane is ONLY ever
// triggered by an approved card — never auto-executed.
// ---------------------------------------------------------------------------

/** Hash of the send token (FNV-1a 64-bit → hex). Pins the exact payload the
 * user approved — a differing hash at send time means the payload changed and
 * the card must be re-confirmed, never sent blindly. Pure + deterministic. */
export function tokenHash(token: string): string {
  // FNV-1a 32-bit — deterministic, integer-exact (no 64-bit literals that
  // would exceed Number.MAX_SAFE_INTEGER). The hash only gates equality of
  // an already-approved payload, not a collision-resistant digest.
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** A send-to-print approval card (S9.5-004) — pending until the user acts. */
export interface SendApprovalCard {
  readonly id: string;
  /** What will be sent — NOT executed until approved. */
  readonly summary: string;
  readonly printerIp: string;
  readonly printerName: string;
  readonly stats: SliceStats;
  /** FNV-1a hash of the token that pins this exact payload (S9-006 pattern). */
  readonly tokenHashHex: string;
  readonly state: "pending" | "approved" | "rejected";
}

export interface SendJobState {
  /** Active approval card (null when none/closed). */
  readonly approval: SendApprovalCard | null;
  /** Last approved send token hash — used to verify payload at send time. */
  readonly lastApprovedHash?: string;
}

export const initialSendJobState: SendJobState = {
  approval: null,
  lastApprovedHash: undefined,
};

export type SendJobEvent =
  | {
      readonly kind: "open";
      readonly summary: string;
      readonly printerIp: string;
      readonly printerName: string;
      readonly stats: SliceStats;
    }
  | { readonly kind: "decide"; readonly id: string; readonly approved: boolean }
  | { readonly kind: "close" };

export interface SendJobOutcome {
  readonly state: SendJobState;
  /** Set when the transition was rejected (e.g. unknown card id). */
  readonly rejected?: readonly string[];
}

/** Serialise the exact payload the user is approving (for the token hash). */
export function sendTokenFor(printerIp: string, stats: SliceStats): string {
  return `${printerIp}|${stats.layers}|${stats.estimatedMinutes}|${stats.volumeMm3}`;
}

/** Pure reducer for the send-to-print approval card (S9.5-004). */
export function reduceSendJob(state: SendJobState, event: SendJobEvent): SendJobOutcome {
  switch (event.kind) {
    case "open": {
      const token = sendTokenFor(event.printerIp, event.stats);
      return {
        state: {
          ...state,
          approval: {
            id: `send-${token.slice(0, 8)}`,
            summary: event.summary,
            printerIp: event.printerIp,
            printerName: event.printerName,
            stats: event.stats,
            tokenHashHex: tokenHash(token),
            state: "pending",
          },
          lastApprovedHash: undefined,
        },
      };
    }
    case "decide": {
      const card = state.approval;
      if (!card || card.id !== event.id) {
        return { state, rejected: [`unknown approval card "${event.id}"`] };
      }
      if (card.state !== "pending") {
        return { state, rejected: [`card "${event.id}" already decided`] };
      }
      return {
        state: {
          ...state,
          approval: {
            ...card,
            state: event.approved ? "approved" : "rejected",
          },
          lastApprovedHash: event.approved ? card.tokenHashHex : undefined,
        },
      };
    }
    case "close": {
      return { state: { ...state, approval: null, lastApprovedHash: undefined } };
    }
  }
}
