import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import { useScene } from "../state/scene";
import {
  FRAME_SELECTED_EVENT,
  parseShortcutEvent,
  type ShortcutAction,
  type ShortcutEventLike,
} from "../state/shortcuts-core";
import { useUi, grabToolToMode } from "../state/ui";

/**
 * S9.3-003 — global keyboard shortcut layer (G32).
 *
 * Owns the ONLY keydown listener for the editor scene (TransformGizmo's
 * local Q/W/E/R listener is removed; this hook is the single point of
 * truth for shortcut → action). Pure decision lives in `shortcuts-core`
 * (`parseShortcutEvent`); this hook wires wires the result to the stores:
 *
 * - tool switches Q/W/E/R → useUi.setTool (gizmo reacts).
 * - grabs G/R/S → startGrab(kind): modal grab session (axis lock + Enter/
 *   Esc); the gizmo mounts in the grabbed mode while active.
 * - X/Y/Z → toggleGrabAxis (constrains the active grab).
 * - Enter → confirmGrab, Esc → cancelGrab (restores previous tool).
 * - Delete/Backspace → remove selected objects + persist mutation lane.
 * - Ctrl+D → duplicate selection (same persist pattern).
 * - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y → journal soft events (S9.3-004 wire;
 *   today a status toast + query refetch, no data loss).
 * - F → dispatch `FRAME_SELECTED_EVENT` (frame camera in the Canvas
 *   listens; whole-scene frame when nothing selected).
 *
 * AC "no-op in text inputs" is enforced HERE at the hook level (never fire
 * while typing) and is also asserted in the pure core.
 */

function isEditable(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

/** Apply a shortcut action against the stores + bridge. */
function applyAction(
  action: ShortcutAction,
  opts: {
    readonly bridge: BridgeHandle | undefined;
    readonly queryClient: ReturnType<typeof useQueryClient>;
  },
): void {
  const ui = useUi.getState();
  const scene = useScene.getState();
  const { bridge, queryClient } = opts;

  switch (action.kind) {
    case "tool": {
      // Tool switch. When a grab is active the tool is NOT changed (modal
      // grabs own the mode); otherwise switch.
      if (ui.grab) return;
      ui.setTool(grabToolToMode(action.tool));
      return;
    }
    case "grab": {
      // Start a modal grab on the selection.
      const name = scene.selected?.name ?? null;
      if (!name) return; // grab needs a selection
      ui.startGrab(action.gesture);
      return;
    }
    case "constrain": {
      ui.toggleGrabAxis(action.axis);
      return;
    }
    case "confirm": {
      // Confirm the grab: commit the provisional mutation lane (if any) and
      // end the modal session. The authoritative snapshot refetch happens via
      // the query invalidation instead of twin-editing.
      const grab = ui.grab;
      if (!grab) return;
      ui.confirmGrab();
      if (bridge) {
        void queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      }
      return;
    }
    case "cancel": {
      // Cancel: end the modal session and restore the pre-grab tool; the
      // provisional provisional edits are rebased on the next re-fetch.
      ui.cancelGrab();
      if (bridge) {
        void queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      }
      return;
    }
    case "delete": {
      // Delete the selection (anchor).
      const name = scene.selected?.name ?? null;
      if (!name) return;
      const steps = scene.remove(name);
      if (!steps) return; // store rejected the removal
      void persistMutation(bridge, queryClient, { kind: "remove", name });
      return;
    }
    case "duplicate": {
      const name = scene.selected?.name ?? null;
      if (!name) return;
      const steps = scene.duplicate(name);
      if (!steps) return;
      void persistMutation(bridge, queryClient, { kind: "duplicate", name });
      return;
    }
    case "undo":
    case "redo": {
      // Soft journal re-import (S9.3-004 wires the real mutating lane; today
      // the authoritative snapshot is simply re-fetched — the reducer guards
      // stale revisions, never data loss).
      ui.pushToast({
        kind: "info",
        title: action.kind === "undo" ? "Undo" : "Redo",
        message:
          action.kind === "undo"
            ? "Journal undo (soft) — snapshot re-import."
            : "Journal redo (soft) — snapshot re-import.",
      });
      if (bridge) {
        void queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      }
      return;
    }
    case "frame": {
      window.dispatchEvent(new CustomEvent(FRAME_SELECTED_EVENT));
      return;
    }
  }
}

/** Persist a graph-op through the bridge mutation lane (ObjectTree pattern). */
async function persistMutation(
  bridge: BridgeHandle | undefined,
  queryClient: ReturnType<typeof useQueryClient>,
  mutation: Parameters<BridgeHandle["mutateObject"]>[0],
): Promise<void> {
  if (!bridge) return;
  try {
    const res = await bridge.mutateObject(mutation);
    if (!res.ok) {
      console.warn(`[shortcuts] mutate rejected: ${res.error}`);
    }
  } catch (err) {
    console.warn("[shortcuts] mutate failed", err);
  }
  await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
}

/** Global keyboard listener wiring the pure decisions to the stores. */
export function useShortcuts(bridge: BridgeHandle | undefined): void {
  const queryClient = useQueryClient();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // AC: never fire while typing in a text field.
      if (isEditable(e.target)) return;
      if (e.altKey) return; // OS/menu reserved — buttons keep Alt+Shift nav

      const gestureActive = useUi.getState().grab !== null;
      const hasSelection = useScene.getState().selected !== null;
      const action = parseShortcutEvent(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          targetTag: (e.target as HTMLElement | null)?.tagName ?? null,
          isContentEditable: (e.target as HTMLElement | null)?.isContentEditable ?? false,
        } satisfies ShortcutEventLike,
        { gestureActive, hasSelection },
      );
      if (!action) return;
      e.preventDefault();
      applyAction(action, { bridge: bridgeRef.current, queryClient });
    },
    [queryClient],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);
}
