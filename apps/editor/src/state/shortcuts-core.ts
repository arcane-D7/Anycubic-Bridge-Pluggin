/**
 * S9.3-003 keyboard shortcut layer — dependency-free pure core.
 *
 * No React / zustand / DOM dependencies so Node 24 runs it headless via the
 * `node --test` harness (same pattern as transform-core / viewport-core).
 * The React hook (`hooks/useShortcuts.ts`) wires these decisions against the
 * stores; the browser keyboard event is normalized to `ShortcutEventLike`
 * before entering here.
 *
 * Key map (sprint G32):
 * - `G` move grab, `R` rotate grab, `S` scale grab (Blender-style: starts a
 *   modal transform; Enter confirms, Esc cancels).
 * - `X` / `Y` / `Z` constrain the active grab (toggle — same axis clears).
 * - `Enter` confirm grab, `Esc` cancel grab (restores previous tool).
 * - `Q` / `W` / `E` tool switch select/move/rotate. `R` without a selection
 *   is the QWER *scale tool* (with a selection it is the rotate grab).
 * - `F` frame-selected (whole scene when nothing is selected).
 * - `Delete` / `Backspace` delete the selection, `Ctrl+D` duplicate,
 *   `Ctrl+Z` undo, `Ctrl+Shift+Z` / `Ctrl+Y` redo (soft journal re-import in
 *   9.3, full journal UI in 9.6).
 *
 * AC: "All listed shortcuts fire and update the scene; no-op in text inputs"
 * — the editable-target check is decision #1 and never fires otherwise.
 */

/** Tool ids exposed to the registry (Q/W/E/R + grab restores). */
export type ToolCommandId =
  "tool.select" | "tool.move" | "tool.rotate" | "tool.scale" | "tool.measure";

/** Modal transform grabbed from the keyboard (Blender G/R/S). */
export type GestureKind = "move" | "rotate" | "scale";

export type AxisName = "x" | "y" | "z";

export type ShortcutAction =
  | { readonly kind: "tool"; readonly tool: ToolCommandId }
  | { readonly kind: "grab"; readonly gesture: GestureKind }
  | { readonly kind: "constrain"; readonly axis: AxisName }
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" }
  | { readonly kind: "delete" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "frame" };

/** Normalized keyboard event (browser KeyboardEvent subset, testable). */
export interface ShortcutEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** `target.tagName` (INPUT/TEXTAREA/SELECT…) or null when irrelevant. */
  readonly targetTag?: string | null;
  readonly isContentEditable?: boolean;
}

export interface ShortcutContext {
  /** A move/rotate/scale grab is active (X/Y/Z, Enter, Esc enabled). */
  readonly gestureActive: boolean;
  /** At least one object is selected (grab/delete/duplicate enabled). */
  readonly hasSelection: boolean;
}

/** Custom-event name the F shortcut uses; the frame camera picks it up. */
export const FRAME_SELECTED_EVENT = "anycubic:frame-selected";

function isEditableTarget(e: ShortcutEventLike): boolean {
  const tag = e.targetTag?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable === true;
}

/** Map a browser key event to a shortcut action (null = no-op).
 *  Precedence: editable target → modifier combos → grabs → tool switch →
 *  grab-modal modifiers → F / Delete / Backspace. */
export function parseShortcutEvent(
  e: ShortcutEventLike,
  ctx: ShortcutContext,
): ShortcutAction | null {
  // AC: never fire while the user is typing in a text field.
  if (isEditableTarget(e)) return null;
  if (e.altKey) return null; // OS/menu reserved

  const key = e.key.toLowerCase();

  if (e.ctrlKey) {
    if (key === "z") return e.shiftKey ? { kind: "redo" } : { kind: "undo" };
    if (key === "y") return { kind: "redo" };
    if (key === "d") return { kind: "duplicate" };
    return null;
  }

  // Selection-gated grabs (Blender G/R/S). With a selection R is the rotate
  // grab; without one R is the QWER scale tool (deterministic discriminator).
  if (ctx.hasSelection) {
    if (key === "g") return { kind: "grab", gesture: "move" };
    if (key === "s") return { kind: "grab", gesture: "scale" };
    if (key === "r") return { kind: "grab", gesture: "rotate" };
  } else if (key === "r") {
    return { kind: "tool", tool: "tool.scale" };
  }
  if (key === "q") return { kind: "tool", tool: "tool.select" };
  if (key === "w") return { kind: "tool", tool: "tool.move" };
  if (key === "e") return { kind: "tool", tool: "tool.rotate" };
  // G42 measure toggle — `M` maps to the measure tool mode.
  if (key === "m") return { kind: "tool", tool: "tool.measure" };

  // Grab-modal modifiers are only meaningful inside an active grab.
  if (ctx.gestureActive) {
    if (key === "x") return { kind: "constrain", axis: "x" };
    if (key === "y") return { kind: "constrain", axis: "y" };
    if (key === "z") return { kind: "constrain", axis: "z" };
    if (key === "enter") return { kind: "confirm" };
    if (key === "escape") return { kind: "cancel" };
  }

  if (key === "f") return { kind: "frame" };
  if (key === "delete" || key === "backspace") {
    return ctx.hasSelection ? { kind: "delete" } : null;
  }
  return null;
}

/** Grab (modal transform) session state machine — pure. */
export interface GrabState {
  readonly kind: GestureKind;
  /** Active axis lock (null = free). */
  readonly axis: AxisName | null;
  /** Tool active before the grab so Esc can restore it. */
  readonly prevTool: ToolCommandId;
}

export function grabStart(kind: GestureKind, prevTool: ToolCommandId): GrabState {
  return { kind, axis: null, prevTool };
}

/** X/Y/Z toggles the axis — the same axis clears the lock (Blender-style). */
export function grabToggleAxis(g: GrabState, axis: AxisName): GrabState {
  return { ...g, axis: g.axis === axis ? null : axis };
}

/** Enter confirms the grab — session ends, tool stays on the grab kind's tool
 *  (the gizmo already reflects the gesture mode during the grab). */
export function grabConfirm(_g: GrabState): null {
  return null;
}

/** Esc cancels — session ends; the caller restores `prevTool`. */
export function grabCancel(_g: GrabState): null {
  return null;
}

/** Grab kind → the tool active while dragging (gizmo reads it). */
export function grabToTool(g: GrabState): ToolCommandId {
  return g.kind === "move" ? "tool.move" : g.kind === "rotate" ? "tool.rotate" : "tool.scale";
}

/** Human label for a grab kind (help panel / toasts). */
export function grabLabel(kind: GestureKind): string {
  return kind === "move" ? "move" : kind === "rotate" ? "rotate" : "scale";
}
