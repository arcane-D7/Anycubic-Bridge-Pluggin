import { create } from "zustand";

/**
 * S9.17-004 NAV-05 — reactive project-scope display store.
 *
 * The chat scope identity (`currentProjectId` + per-scope conversations)
 * lives in `state/chat-conversations` (pure-core owned). This tiny store
 * only carries the DISPLAY name for the "Project: <name>" chat context
 * label — the safe project name (never a username), set synchronously in
 * `App.activateProject` from the project snapshot (NOT from the async scene
 * query, so a stale cache for a previous project can never re-write scope B
 * back to A's label).
 *
 * Selectors used by consumers return primitives (string | null) — never
 * fresh objects (React 19 + zustand getSnapshot loop guard, S9.6-001).
 */
export interface ProjectScopeState {
  /** Active project scope (null = workspace/global). */
  readonly projectId: string | null;
  /** Safe display name for the active project (null → fall back to id). */
  readonly name: string | null;
  readonly setScope: (projectId: string | null, name?: string | null) => void;
}

export const useProjectScope = create<ProjectScopeState>()((set) => ({
  projectId: null,
  name: null,
  setScope: (projectId, name = null) => set({ projectId, name: name ?? null }),
}));

/** Primitive selector: display name for the CURRENT chat scope (null-safe
 * against a stale scoped name from a previous project). */
export function currentScopeName(
  state: ProjectScopeState,
  chatScopeProjectId: string | null,
): string | null {
  return state.projectId === chatScopeProjectId ? state.name : null;
}
