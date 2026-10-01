/**
 * S9.4-001 floating toolbar state — dependency-free pure core.
 *
 * No React / zustand dependencies so Node 24 runs it headless via the `node
 * --test` harness (same pattern as shortcuts-core / transform-core). The
 * zustand store (`state/toolbar.ts`) and the React toolbar
 * (`viewport/Toolbar.tsx`) are thin wrappers over these pure functions.
 *
 * Scope for 9.4: tool modes already live in `state/ui.ts` (`ToolMode` +
 * `tool`/`setTool`, driven by the S9.3-003 shortcut layer Q/W/E/R). This core
 * owns the toolbar-wide boolean flags (snap/grid — STATE ONLY in 9.4; real
 * snapping behavior lands 9.7) and the camera view presets used by the view
 * cube + numpad (iso/top/front/right).
 */

/** Camera orientations selectable from the toolbar / view cube. */
export type ViewPreset = "iso" | "top" | "front" | "right";

/** View preset → camera target direction + up (plate axes, front-left origin). */
export interface ViewTarget {
  /** Direction from the origin the camera looks FROM (position offset). */
  readonly direction: readonly [number, number, number];
  /** Approximate world-up vector for the orientation. */
  readonly up: readonly [number, number, number];
}

/** Namespaced view-orientation directions (front = -Z in three.js). */
export const VIEW_PRESETS: Record<ViewPreset, ViewTarget> = {
  iso: { direction: [0.36, 0.62, 0.7] as const, up: [0, 1, 0] as const },
  top: { direction: [0, 1, 0.0001] as const, up: [0, 0, -1] as const },
  front: { direction: [0, 0.15, 1] as const, up: [0, 1, 0] as const },
  right: { direction: [1, 0.15, 0.0001] as const, up: [0, 1, 0] as const },
};

/** Numpad key → preset (registry ids share names 1:1). */
export const VIEW_PRESET_KEYS: Record<string, ViewPreset> = {
  "1": "iso",
  "2": "top",
  "3": "front",
  "4": "right",
  Home: "iso",
};

export function isViewPreset(value: unknown): value is ViewPreset {
  return value === "iso" || value === "top" || value === "front" || value === "right";
}

/** Boolean toggle flags on the toolbar (state-only in 9.4). */
export interface ToolbarFlags {
  readonly snap: boolean;
  readonly grid: boolean;
}

export const DEFAULT_TOOLBAR_FLAGS: ToolbarFlags = { snap: true, grid: true };

export type ToolbarFlagKey = keyof ToolbarFlags;

/** Toggle one flag, returning a fresh object (identity changes only when set). */
export function toggleToolbarFlag(flags: ToolbarFlags, key: ToolbarFlagKey): ToolbarFlags {
  return { ...flags, [key]: !flags[key] };
}
