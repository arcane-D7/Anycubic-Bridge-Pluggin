import { create } from "zustand";
import type { SceneObjectSnapshot } from "../bridge/types";
import { type SceneGraphState, EMPTY_GRAPH, reduceSceneGraph } from "./scene-core";

export type { SceneGraphState } from "./scene-core";

/**
 * Scene/selection store (S9.2-002) — full graph store over the frozen
 * consumer API.
 *
 * The exported names `selected`, `select`, `clear` are FROZEN for consumers
 * (ObjectTree / SceneObjectModel). The store now owns the whole scene graph:
 * objects (id/name/transform/visible/locked/watertight/mesh), multi-select
 * (shift-click toggles membership over `selectedNames`), and pure CRUD actions
 * (add/remove/rename/duplicate/toggleVisible/toggleLock/setTransform).
 *
 * Destructive ops (remove/duplicate) return the S7-002 framed modal pipeline
 * (`begin→update→commit`) so the UI routes them through the modal contract
 * instead of doing unde-less destructive edits. The store itself keeps the
 * objects authoritative and never drops data on a stale revision — re-base is
 * surfaced, never forced (viewport-core invariant).
 */

export interface SelectedObject {
  readonly name: string;
  /** Mirrors the meshInfo flag so the viewport can tint non-watertight meshes. */
  readonly watertight: boolean;
}

export interface SceneStore extends SceneGraphState {
  /** Legacy single-selection mirror (frozen API) — the anchor object. */
  readonly selected: SelectedObject | null;
  /** Frozen API: select one object by name (replaces the multi-set). */
  readonly select: (name: string, watertight: boolean) => void;
  /** Shift-click: toggle membership in the multi-select set. */
  readonly toggleSelect: (name: string, watertight: boolean) => void;
  /** Frozen API: empty the selection. */
  readonly clear: () => void;
  /** Replace the whole graph from an authoritative snapshot (hydrate). */
  readonly hydrate: (objects: readonly SceneObjectSnapshot[]) => void;
  /** Add an object; selects it; emits the S7-002 add mutation. */
  readonly add: (object: SceneObjectSnapshot) => boolean;
  /** Remove an object; returns the S7-002 modal pipeline to route (begin→update→commit). */
  readonly remove: (name: string) => readonly ("begin" | "update" | "commit" | "cancel")[] | null;
  /** Rename an object. */
  readonly rename: (from: string, to: string) => boolean;
  /** Duplicate an object; returns the S7-002 modal pipeline to route. */
  readonly duplicate: (
    name: string,
  ) => readonly ("begin" | "update" | "commit" | "cancel")[] | null;
  /** Toggle visible flag. */
  readonly toggleVisible: (name: string) => void;
  /** Toggle locked flag. */
  readonly toggleLock: (name: string) => void;
  /** Set per-object transform. */
  readonly setTransform: (name: string, transform: { x: number; y: number; z: number }) => void;
}

const watertightOf = (objects: readonly SceneObjectSnapshot[], name: string | null): boolean => {
  if (!name) return false;
  const o = objects.find((x) => x.name === name);
  return o ? o.watertight : false;
};

export const useScene = create<SceneStore>()((set, get) => ({
  ...EMPTY_GRAPH,

  // Mirror the last-clicked anchor as the legacy single `selected` mirror.
  selected: null,
  select: (name, watertight) => {
    set((s) => {
      const out = reduceSceneGraph(s, { kind: "select", name });
      return {
        ...out.state,
        selected: { name, watertight },
      };
    });
  },

  toggleSelect: (name, _watertight) => {
    set((s) => {
      const out = reduceSceneGraph(s, { kind: "multiSelectToggle", name });
      return { ...out.state, selected: null };
    });
  },

  clear: () => {
    set((s) => ({
      ...s,
      selectedNames: [],
      anchorName: null,
      selected: null,
    }));
  },

  hydrate: (objects) => {
    set(() => ({
      objects,
      selectedNames: [],
      anchorName: null,
      selected: null,
    }));
  },

  add: (object) => {
    const out = reduceSceneGraph(get(), { kind: "add", object });
    set(() => ({
      ...out.state,
      selected: { name: object.name, watertight: object.watertight },
    }));
    return true;
  },

  remove: (name) => {
    const out = reduceSceneGraph(get(), { kind: "remove", name });
    set(() => ({
      ...out.state,
      selected: out.state.selectedNames[0]
        ? {
            name: out.state.selectedNames[0]!,
            watertight: watertightOf(out.state.objects, out.state.selectedNames[0]!),
          }
        : null,
    }));
    return out.pipeline?.steps ?? null;
  },

  rename: (from, to) => {
    const before = get().objects;
    const out = reduceSceneGraph(get(), { kind: "rename", from, to });
    if (out.state.objects === before) return false;
    set(() => ({
      ...out.state,
      selected: out.state.anchorName
        ? {
            name: out.state.anchorName,
            watertight: watertightOf(out.state.objects, out.state.anchorName),
          }
        : null,
    }));
    return true;
  },

  duplicate: (name) => {
    const beforeLen = get().objects.length;
    const out = reduceSceneGraph(get(), { kind: "duplicate", name });
    if (out.state.objects.length === beforeLen) return null;
    const anchor = out.state.anchorName;
    set(() => ({
      ...out.state,
      selected: anchor ? { name: anchor, watertight: false } : null,
    }));
    return out.pipeline?.steps ?? null;
  },

  toggleVisible: (name) => {
    set((s) => {
      const out = reduceSceneGraph(s, { kind: "toggleVisible", name });
      return out.state;
    });
  },

  toggleLock: (name) => {
    set((s) => {
      const out = reduceSceneGraph(s, { kind: "toggleLock", name });
      return out.state;
    });
  },

  setTransform: (name, transform) => {
    set((s) => {
      const out = reduceSceneGraph(s, { kind: "setTransform", name, transform });
      return out.state;
    });
  },
}));
