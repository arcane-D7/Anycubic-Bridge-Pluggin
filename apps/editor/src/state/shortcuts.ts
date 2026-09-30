import type { IconName } from "@/components/icons";

/**
 * Shortcut registry scaffolding (S9.1-005). Maps key bindings to semantic
 * command ids — WIRED IN SPRINT 9.3 (transform controls + activate tool).
 * Kept pure/dependency-free so 9.3 can consume it directly.
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
