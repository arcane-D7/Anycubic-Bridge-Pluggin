/**
 * S9.18-001 — workspace view store.
 *
 * The single low-level view mutation is `setView`, closed-validated through
 * the registry core (`parseWorkspaceView`) so an unknown view is refused and
 * the current view is preserved. The PUBLIC entry for every view change is
 * `executeRegistryOperation({ id: "workspace.navigate", ... })` (see
 * state/operation-registry.ts) — the nav buttons and the future AI tool
 * frontend call the exact same reversible handler, so a tool-driven switch
 * is observable-identical to a pointer tab click. This store is the part the
 * registry handler delegates to; it never mutates project scope or
 * conversation identity.
 */
import { create } from "zustand";
import { isWorkspaceViewId, type WorkspaceViewId } from "./operation-registry-core";

export type { WorkspaceViewId };

export interface WorkspaceViewState {
  readonly view: WorkspaceViewId;
  /** Low-level validated mutation (registry handler only). Returns false
   * when the view is not one of home/prepare/preview/workbench. */
  readonly setView: (view: WorkspaceViewId) => boolean;
}

export const useWorkspaceView = create<WorkspaceViewState>()((set) => ({
  view: "home",
  setView: (view) => {
    if (!isWorkspaceViewId(view)) return false;
    set({ view });
    return true;
  },
}));
