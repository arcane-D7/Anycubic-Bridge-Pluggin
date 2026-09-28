import { useCallback, useEffect } from "react";
import type { BridgeHandle, CommitSinkPayload } from "../bridge/mock";
import { useViewport } from "../state/viewport";
/**
 * S7-004: UI-owned interaction driving the modal lifecycle
 * (begin → update* → commit | cancel) through the viewport store (zustand →
 * pure core reducer), which forwards to the contract. The UI owns the GESTURE;
 * Blender owns the MESH state. The viewport never mutates geometry — it only
 * replays the authoritative revision+selection from commit events.
 *
 * Gestures delegate ENTIRELY to `runFlow(contract, flow)` — the pure flow
 * issues begin → (update* for gizmo) → commit|cancel in one ordered trace, so
 * the UI can never double-begin or fire out-of-order. A stale expected
 * revision is surfaced (re-base offered), never forced.
 *
 * AC-1 (commit events): subscribes `onCommitEvent` on the live bridge handle
 * (installed once) so each authoritative snapshot re-renders the viewport.
 */
export function ModalInteraction({ bridge }: { readonly bridge?: BridgeHandle }) {
  const runFlow = useViewport((s) => s.runFlow);
  const cancel = useViewport((s) => s.cancel);
  const revision = useViewport((s) => s.revision);
  const sessionStatus = useViewport((s) => s.sessionStatus);

  // AC-1: subscribe to commit events (authoritative snapshot re-render).
  // Installed once per bridge handle; removed when the handle changes.
  useEffect(() => {
    if (!bridge) return;
    const onEvent = (payload: CommitSinkPayload) => {
      useViewport.getState().onCommitEvent(payload.revision, payload.selection);
    };
    bridge.onCommitEvent = onEvent;
    return () => {
      if (bridge.onCommitEvent === onEvent) delete bridge.onCommitEvent;
    };
  }, [bridge]);

  // Esc cancels an active modal session (rolls back to begin-rev).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sessionStatus === "active") {
        cancel(revision);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionStatus, cancel, revision]);

  const runGizmo = useCallback(() => {
    if (!bridge) return;
    void runFlow(bridge, "gizmo");
  }, [bridge, runFlow]);

  const runNumeric = useCallback(
    (value: string) => {
      if (value === "") {
        // Empty numeric field → roll back (cancel).
        if (sessionStatus === "active") {
          cancel(revision);
        }
        return;
      }
      if (!bridge) return;
      // Numeric issues begin → 0 updates → commit (the whole edit commits at once).
      void runFlow(bridge, "numeric");
    },
    [sessionStatus, cancel, revision, bridge, runFlow],
  );

  return (
    <div data-testid="modal-interaction">
      <div data-testid="viewport-session-status" className="viewport-status">
        {sessionStatus}
      </div>
      <button type="button" data-testid="gizmo-start" onPointerDown={runGizmo}>
        Gizmo
      </button>
      <input
        type="number"
        data-testid="numeric-entry"
        onBlur={(e) => runNumeric(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") runNumeric(e.currentTarget.value);
        }}
      />
    </div>
  );
}
