import type { IconName } from "@/components/icons";

/**
 * Shortcut registry (S9.1-005 scaffold, WIRED by S9.3-003).
 * Maps key bindings to semantic command ids (menus/toolbar also consume the
 * ids). Pure/dependency-free — consumed by `shortcuts-core.ts` decisions and
 * the `shortcut-help` panel (S9.3-003 AC-2).
 */

export interface ShortcutEntry {
  /** Stable command id (also used by menus/toolbar). */
  readonly id: string;
  readonly label: string;
  readonly keys: readonly string[];
  readonly icon?: IconName;
  /** When true, Ctrl/Cmd required. */
  readonly ctrl?: boolean;
  /** When true, Alt required. */
  readonly alt?: boolean;
  readonly shift?: boolean;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: "tool.select", label: "Select", keys: ["q"], icon: "snap" },
  { id: "tool.move", label: "Move", keys: ["w"] },
  { id: "tool.rotate", label: "Rotate", keys: ["e"] },
  { id: "tool.scale", label: "Scale", keys: ["r"] },
  { id: "view.fit", label: "Fit view", keys: ["f"], icon: "fit" },
  { id: "view.iso", label: "Isometric view", keys: ["1"] },
  { id: "view.top", label: "Top view", keys: ["2"] },
  { id: "view.front", label: "Front view", keys: ["3"] },
  { id: "view.right", label: "Right view", keys: ["4"] },
  { id: "edit.undo", label: "Undo", keys: ["z"], ctrl: true, icon: "undo" },
  { id: "edit.redo", label: "Redo", keys: ["y"], ctrl: true, icon: "redo" },
  { id: "object.duplicate", label: "Duplicate", keys: ["d"], ctrl: true, icon: "duplicate" },
  { id: "object.delete", label: "Delete", keys: ["Delete"], icon: "trash" },
  { id: "measure.toggle", label: "Measure", keys: ["m"], icon: "measure" },
  { id: "snap.toggle", label: "Snap", keys: ["x"], icon: "snap" },
  { id: "grid.toggle", label: "Grid", keys: ["g"], icon: "grid" },
  // S9.3-003 (G32): modal transform grabs + grab-modal modifiers.
  { id: "object.grabMove", label: "Move (grab)", keys: ["g"] },
  { id: "object.grabRotate", label: "Rotate (grab)", keys: ["r"] },
  { id: "object.grabScale", label: "Scale (grab)", keys: ["s"] },
  { id: "object.constrain.axis", label: "Constrain axis", keys: ["x", "y", "z"] },
  { id: "object.grabConfirm", label: "Confirm grab", keys: ["Enter"] },
  { id: "object.grabCancel", label: "Cancel grab", keys: ["Esc"] },
  // Ctrl+Shift+Z redo alias (edit.redo lists Ctrl+Z in registry for tooltips).
  { id: "edit.redoShift", label: "Redo (shift)", keys: ["z"], ctrl: true, shift: true },
];

/** Look up a shortcut by command id. */
export function shortcutFor(id: string): ShortcutEntry | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Human "Ctrl+Z" style label for tooltips. */
export function shortcutLabel(entry: ShortcutEntry): string {
  const mods = [
    entry.ctrl ? "Ctrl" : null,
    entry.alt ? "Alt" : null,
    entry.shift ? "Shift" : null,
  ].filter(Boolean);
  return mods.length > 0 ? [...mods, ...entry.keys].join("+") : entry.keys.join("+");
}

/** Tooltips for toolbar/panel controls (consumed by the shortcut help UI). */
export const SHORTCUT_HELP: readonly {
  readonly id: string;
  readonly label: string;
  readonly keys: readonly string[];
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}[] = [
  { id: "grab-move", label: "Move (grab)", keys: ["G"] },
  { id: "grab-rotate", label: "Rotate (grab)", keys: ["R"] },
  { id: "grab-scale", label: "Scale (grab)", keys: ["S"] },
  { id: "constrain", label: "Constrain axis", keys: ["X", "Y", "Z"] },
  { id: "confirm", label: "Confirm grab", keys: ["Enter"] },
  { id: "cancel", label: "Cancel grab", keys: ["Esc"] },
  { id: "frame", label: "Frame selection", keys: ["F"] },
  { id: "duplicate", label: "Duplicate", keys: ["D"], ctrl: true },
  { id: "delete", label: "Delete", keys: ["Delete"] },
  { id: "undo", label: "Undo", keys: ["Z"], ctrl: true },
  { id: "redo", label: "Redo", keys: ["Shift", "Z"], ctrl: true },
  { id: "tool-switch", label: "Select / Move / Rotate / Scale", keys: ["Q", "W", "E", "R"] },
];
