/**
 * S9.11-001 view mode — dependency-free pure core.
 *
 * No React / zustand dependencies so Node 24 runs it headless under the
 * `node --test` harness (same pattern as printers-core / viewport-core).
 * The zustand store (`state/view-mode.ts`) owns persistence + reachability
 * wiring; this core owns the pure rules:
 *
 *   - mode is one of `'mesh' | 'slicer' | 'live'` (default `mesh`);
 *   - `live` requires an active, reachable printer — when it is missing the
 *     mode FALLS BACK to `slicer` and the UI shows a one-line banner;
 *   - everything else is deterministic and testable headless.
 *
 * The store never guesses — reachability comes from the probe result, not
 * from this core.
 */

export type ViewMode = "mesh" | "slicer" | "live";

export const VIEW_MODES: readonly ViewMode[] = ["mesh", "slicer", "live"] as const;

/** Default mode when nothing is persisted yet. */
export const DEFAULT_VIEW_MODE: ViewMode = "mesh";

/** localStorage key (same machine-agnostic rule as dock/theme). */
export const VIEW_MODE_STORAGE_KEY = "anycubic:view-mode:v1";

export function isViewMode(value: unknown): value is ViewMode {
  return value === "mesh" || value === "slicer" || value === "live";
}

/** Parse a raw storage value; anything invalid → default (never crashes). */
export function parseViewMode(raw: unknown): ViewMode {
  return isViewMode(raw) ? raw : DEFAULT_VIEW_MODE;
}

/**
 * Effective mode after the reachability rule:
 * `'live'` requested but no reachable printer → `'slicer'` fallback.
 * `mesh` / `slicer` are never gated (they are purely local renders).
 */
export function effectiveViewMode(requested: ViewMode, liveReachable: boolean): ViewMode {
  if (requested === "live" && !liveReachable) return "slicer";
  return requested;
}

/** True when the requested mode was downgraded by the reachability gate. */
export function isLiveFallback(requested: ViewMode, liveReachable: boolean): boolean {
  return requested === "live" && !liveReachable;
}
