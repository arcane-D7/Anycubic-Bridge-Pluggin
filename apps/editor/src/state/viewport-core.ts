/**
 * Viewport-as-view pure state machine + renderer consistency check (S7-004).
 *
 * Deliberately dependency-free (no React, no zustand) so the modal lifecycle,
 * stale-revision handling and renderer-vs-snapshot rule are testable headless
 * under the plain Node test runner. The zustand store (`./viewport`) and the
 * React components are thin wrappers over these pure functions.
 *
 * Invariants enforced here:
 * - The viewport NEVER mutates geometry; it only records the authoritative
 *   revision + selection_state from commit events.
 * - A modal op outside a session is rejected; a stale expected revision is
 *   surfaced (re-base), never forced.
 * - Selection derives from the last authoritative snapshot ONLY.
 * - A renderer triangle disagreeing with the native snapshot is a renderer bug
 *   (snapshot wins) — surfaced, never silently merged.
 */

export interface SelectionSnapshot {
  readonly verts: readonly number[];
  readonly faces: readonly number[];
  readonly edges: readonly number[];
  readonly objectModeNames: readonly string[];
}

export type SessionStatus = "idle" | "active" | "committed" | "cancelled" | "invalidated";

/** The authoritative viewport ledger state. */
export interface ViewportState {
  readonly revision: number;
  readonly beginRevision: number | null;
  readonly expectedRevision: number;
  readonly sessionStatus: SessionStatus;
  readonly selection: SelectionSnapshot | null;
}

export type ViewportEvent =
  | {
      readonly kind: "commit-event";
      readonly revision: number;
      readonly selection: SelectionSnapshot;
    }
  | { readonly kind: "begin"; readonly expectedRevision: number }
  | { readonly kind: "update"; readonly expectedRevision: number }
  | { readonly kind: "commit"; readonly expectedRevision: number }
  | { readonly kind: "cancel"; readonly beginRevision: number }
  | {
      readonly kind: "invalidate";
      readonly reason: { readonly expected: string; readonly actual: string };
    };

export interface ViewportOutcome {
  readonly state: ViewportState;
  /** A stale expected_revision was rejected — UI must re-base, never force. */
  readonly staleRejected?: { readonly expected: number; readonly actual: number };
  /** Session invalidated out-of-band (BLEND modified) — re-import offered. */
  readonly invalidatedReason?: { readonly expected: string; readonly actual: string };
}

export const EMPTY_SELECTION: SelectionSnapshot = {
  verts: [],
  faces: [],
  edges: [],
  objectModeNames: [],
};

export function initialViewportState(): ViewportState {
  return {
    revision: 0,
    beginRevision: null,
    expectedRevision: 0,
    sessionStatus: "idle",
    selection: null,
  };
}

/** Pure reducer — the whole viewport modal lifecycle in one function. */
export function reduceViewport(state: ViewportState, event: ViewportEvent): ViewportOutcome {
  switch (event.kind) {
    case "commit-event": {
      // Authoritative snapshot update — selection is REPLACED, never merged.
      // The received revision is now the connection's current revision, so the
      // next gesture begins there.
      return {
        state: {
          ...state,
          revision: event.revision,
          expectedRevision: event.revision,
          selection: event.selection,
        },
      };
    }

    case "begin": {
      if (state.sessionStatus === "active") {
        // A second begin while a session is active is a protocol violation.
        return {
          state,
          staleRejected: {
            expected: event.expectedRevision,
            actual: state.expectedRevision,
          },
        };
      }
      return {
        state: {
          ...state,
          sessionStatus: "active",
          beginRevision: event.expectedRevision,
          expectedRevision: event.expectedRevision,
        },
      };
    }

    case "update": {
      if (state.sessionStatus !== "active") {
        // A topology update outside a modal session → rejected.
        return {
          state,
          staleRejected: { expected: event.expectedRevision, actual: state.expectedRevision },
        };
      }
      if (state.expectedRevision !== event.expectedRevision) {
        return {
          state,
          staleRejected: { expected: event.expectedRevision, actual: state.expectedRevision },
        };
      }
      return { state };
    }

    case "commit": {
      // The contract validates expected==current; the reducer only confirms
      // the transition when the gesture's expected revision matches. The
      // revision ADVANCE comes with the follow-up commit-event carrying the
      // contract's new revision (never invented by the UI).
      if (state.sessionStatus !== "active") {
        return {
          state,
          staleRejected: { expected: event.expectedRevision, actual: state.expectedRevision },
        };
      }
      if (state.expectedRevision !== event.expectedRevision) {
        return {
          state,
          staleRejected: { expected: event.expectedRevision, actual: state.expectedRevision },
        };
      }
      return { state: { ...state, sessionStatus: "committed" } };
    }

    case "cancel": {
      if (state.sessionStatus !== "active" || state.beginRevision !== event.beginRevision) {
        return { state };
      }
      // Roll back to the begin revision; the session closes.
      return {
        state: {
          ...state,
          sessionStatus: "cancelled",
          revision: event.beginRevision,
          beginRevision: null,
          expectedRevision: event.beginRevision,
        },
      };
    }

    case "invalidate": {
      return {
        state: { ...state, sessionStatus: "invalidated" },
        invalidatedReason: event.reason,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Modal flows against the contract (UI-owned interaction; Blender owns mesh)
// ---------------------------------------------------------------------------

/** The contract surface a stub must implement (mirrors S7-002 SessionManager). */
export interface ContractLike {
  readonly begin: (revision: number) => Promise<unknown>;
  readonly update: (revision: number) => Promise<unknown>;
  /** Commit validates expected==current; returns the NEW revision + selection. */
  readonly commit: (
    expectedRevision: number,
  ) => Promise<{ readonly newRevision: number; readonly selection: SelectionSnapshot }>;
  readonly cancel: (beginRevision: number) => Promise<unknown>;
}

/** A commit the contract refused because expected != current. Carries actual. */
export class StaleCommitError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`stale commit: expected ${expected}, actual ${actual} (re-base, never force)`);
    this.name = "StaleCommitError";
    this.expected = expected;
    this.actual = actual;
  }
}

export type FlowKind = "gizmo" | "numeric" | "cancel";

export interface FlowResult {
  readonly state: ViewportState;
  /** Contract calls issued, in order (end-to-end protocol trace). */
  readonly calls: readonly string[];
  /** The authoritative selection committed, or null on cancel/refusal. */
  readonly selection: SelectionSnapshot | null;
  readonly staleRejected?: { readonly expected: number; readonly actual: number };
}

/**
 * Drive a UI gesture through the full modal lifecycle against the stub
 * contract server. `gizmo` = begin → update → commit; `numeric` = begin → 0
 * updates → commit; `cancel` = begin → cancel (rollback to begin-revision).
 */
export async function runModalFlow(
  contract: ContractLike,
  flow: FlowKind,
  start: ViewportState,
): Promise<FlowResult> {
  const calls: string[] = [];
  let state = start;

  const stepBegin = async (expected: number) => {
    calls.push(`begin(${expected})`);
    await contract.begin(expected);
    return reduceViewport(state, { kind: "begin", expectedRevision: expected });
  };
  const stepUpdate = async (expected: number) => {
    calls.push(`update(${expected})`);
    await contract.update(expected);
    return reduceViewport(state, { kind: "update", expectedRevision: expected });
  };
  const stepCommit = async (expected: number) => {
    calls.push(`commit(${expected})`);
    let resp;
    try {
      resp = await contract.commit(expected);
    } catch (err) {
      if (err instanceof StaleCommitError) {
        return {
          state,
          staleRejected: { expected: err.expected, actual: err.actual },
        } satisfies ViewportOutcome;
      }
      throw err;
    }
    // 1) Local confirmation: validate expected==current, session → committed.
    const confirmed = reduceViewport(state, { kind: "commit", expectedRevision: expected });
    if (confirmed.staleRejected) {
      return confirmed;
    }
    state = confirmed.state;
    // 2) Authoritative snapshot: the contract's new revision + selection.
    return reduceViewport(state, {
      kind: "commit-event",
      revision: resp.newRevision,
      selection: resp.selection,
    });
  };

  // begin is the same for all flows.
  let out = await stepBegin(state.expectedRevision);
  if (out.staleRejected) {
    return { state: out.state, calls, selection: null, staleRejected: out.staleRejected };
  }
  state = out.state;

  if (flow === "cancel") {
    const beginRevision = state.beginRevision ?? state.expectedRevision;
    calls.push(`cancel(${beginRevision})`);
    await contract.cancel(beginRevision);
    out = reduceViewport(state, { kind: "cancel", beginRevision });
    return { state: out.state, calls, selection: null };
  }

  if (flow === "gizmo") {
    out = await stepUpdate(state.expectedRevision);
    if (out.staleRejected) {
      return { state: out.state, calls, selection: null, staleRejected: out.staleRejected };
    }
    state = out.state;
  }
  // numeric: NO updates — plays the entire edit into the commit only.

  out = await stepCommit(state.expectedRevision);
  if (out.staleRejected) {
    return { state: out.state, calls, selection: null, staleRejected: out.staleRejected };
  }
  return { state: out.state, calls, selection: out.state.selection };
}

// ---------------------------------------------------------------------------
// Renderer-vs-snapshot consistency (snapshot is AUTHORITATIVE)
// ---------------------------------------------------------------------------

export interface RendererMismatch {
  readonly rendererBug: boolean;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Pure rule: the renderer's observable triangle count MUST equal the native
 * snapshot's authoritative triangle count. Any disagreement is definitionally
 * a renderer bug (snapshot wins) — never a silent merge.
 */
export function checkRendererSnapshotConsistency(
  rendererTriangleCount: number,
  snapshotTriangleCount: number,
): RendererMismatch | null {
  if (rendererTriangleCount === snapshotTriangleCount) return null;
  return {
    rendererBug: true,
    expected: String(snapshotTriangleCount),
    actual: String(rendererTriangleCount),
  };
}
