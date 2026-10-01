/**
 * Scene graph core (S9.2-002) — dependency-free pure functions.
 *
 * Follows the viewport-core pattern: all decisions live in pure functions that
 * the plain Node test runner can exercise headless; the zustand store in
 * `state/scene.ts` is a thin wrapper.
 *
 * The scene graph owns per-object id/name/transform/visible/locked/watertight/
 * mesh (region list + buffers). Selection is multi-select with a "last clicked"
 * anchor (shift-click toggles membership). Object mutations (add/remove/rename/
 * duplicate/toggle) are PURE — the store applies the returned list; destructive
 * ops (remove/duplicate) also emit a `pipeline` of S7-002 modal steps
 * (begin→update→commit) so the UI can route them through the framed modal
 * contract instead of doing undo-less destructive edits.
 */

import type { SceneObjectSnapshot } from "../bridge/types";
import type { ObjectPrintSettings } from "../bridge/types";

export interface SceneGraphState {
  /** All scene objects in display order (authoritative). */
  readonly objects: readonly SceneObjectSnapshot[];
  /**
   * Multi-selection. `anchor` is the last-clicked name (shift-click toggles
   * membership; plain click replaces the set and sets the anchor).
   */
  readonly selectedNames: readonly string[];
  readonly anchorName: string | null;
}

export const EMPTY_GRAPH: SceneGraphState = {
  objects: [],
  selectedNames: [],
  anchorName: null,
};

export interface SceneGraphEvent {
  readonly kind:
    | "hydrate"
    | "select"
    | "multiSelectToggle"
    | "add"
    | "remove"
    | "rename"
    | "duplicate"
    | "toggleVisible"
    | "toggleLock"
    | "setTransform"
    | "setPlate"
    | "setObjectSettings";
  readonly object?: SceneObjectSnapshot;
  readonly name?: string;
  readonly from?: string;
  readonly to?: string;
  readonly transform?: SceneObjectSnapshot["transform"];
  readonly plateId?: string;
  /** Per-object fork payload (S9.6-002); `undefined` clears (reset-to-parent). */
  readonly settings?: Partial<ObjectPrintSettings>;
  readonly filamentId?: string;
}

/** The S7-002 framed modal steps a destructive op must route through. */
export interface ModalPipeline {
  readonly steps: readonly ("begin" | "update" | "commit" | "cancel")[];
}

export interface SceneGraphOutcome {
  readonly state: SceneGraphState;
  /** Suggested modal pipeline for destructive ops (remove/duplicate). */
  readonly pipeline: ModalPipeline | null;
  /** The mutation payload for the bridge CRUD lane, if any. */
  readonly mutation?:
    | { readonly kind: "add"; readonly object: SceneObjectSnapshot }
    | { readonly kind: "remove"; readonly name: string };
}

/**
 * Pure graph reducer. `byId` lookup uses the object's `name` — the frozen
 * ObjectMeshInfo name IS the stable identifier in this shell (S9.2-002 keeps
 * consumer API intact: ObjectTree/SceneObjectModel select by name).
 */
export function reduceSceneGraph(
  state: SceneGraphState,
  event: SceneGraphEvent,
): SceneGraphOutcome {
  switch (event.kind) {
    case "hydrate": {
      const objects = event.object ? [event.object] : [];
      // Selection never survives a hydrate (authoritative snapshot replaces it).
      return { state: { objects, selectedNames: [], anchorName: null }, pipeline: null };
    }

    case "select": {
      const name = event.name;
      if (!name) return { state, pipeline: null };
      return {
        state: { ...state, selectedNames: [name], anchorName: name },
        pipeline: null,
      };
    }

    case "multiSelectToggle": {
      const name = event.name;
      if (!name) return { state, pipeline: null };
      const has = state.selectedNames.includes(name);
      const selectedNames = has
        ? state.selectedNames.filter((n) => n !== name)
        : [...state.selectedNames, name];
      return {
        state: {
          ...state,
          selectedNames,
          anchorName: has ? state.anchorName : name,
        },
        pipeline: null,
      };
    }

    case "add": {
      const object = event.object;
      if (!object) return { state, pipeline: null };
      return {
        state: {
          ...state,
          objects: [...state.objects, object],
          selectedNames: [object.name],
          anchorName: object.name,
        },
        pipeline: null,
        mutation: { kind: "add", object },
      };
    }

    case "remove": {
      const name = event.name;
      if (!name) return { state, pipeline: null };
      const remaining = state.objects.filter((o) => o.name !== name);
      if (remaining.length === state.objects.length) return { state, pipeline: null };
      return {
        state: {
          ...state,
          objects: remaining,
          selectedNames: state.selectedNames.filter((n) => n !== name),
          anchorName: state.anchorName === name ? null : state.anchorName,
        },
        pipeline: { steps: ["begin", "update", "commit"] },
        mutation: { kind: "remove", name },
      };
    }

    case "rename": {
      const from = event.from;
      const to = event.to;
      if (!from || !to) return { state, pipeline: null };
      if (state.objects.some((o) => o.name === to)) return { state, pipeline: null };
      const objects = state.objects.map((o) => (o.name === from ? { ...o, name: to } : o));
      return {
        state: {
          ...state,
          objects,
          selectedNames: state.selectedNames.map((n) => (n === from ? to : n)),
          anchorName: state.anchorName === from ? to : state.anchorName,
        },
        pipeline: null,
      };
    }

    case "duplicate": {
      const name = event.name;
      if (!name) return { state, pipeline: null };
      const src = state.objects.find((o) => o.name === name);
      if (!src) return { state, pipeline: null };
      const copyName = `${src.name}-copy`;
      const copy: SceneObjectSnapshot = {
        ...src,
        name: copyName,
        geometry: src.geometry
          ? {
              positions: src.geometry.positions.slice(),
              normals: src.geometry.normals.slice(),
              indices: src.geometry.indices.slice(),
            }
          : undefined,
      };
      return {
        state: {
          ...state,
          objects: [...state.objects, copy],
          selectedNames: [copyName],
          anchorName: copyName,
        },
        pipeline: { steps: ["begin", "update", "commit"] },
        mutation: { kind: "add", object: copy },
      };
    }

    case "toggleVisible": {
      const name = event.name;
      if (!name) return { state, pipeline: null };
      const objects = state.objects.map((o) =>
        o.name === name ? { ...o, visible: !o.visible } : o,
      );
      return { state: { ...state, objects }, pipeline: null };
    }

    case "toggleLock": {
      const name = event.name;
      if (!name) return { state, pipeline: null };
      const objects = state.objects.map((o) => (o.name === name ? { ...o, locked: !o.locked } : o));
      return { state: { ...state, objects }, pipeline: null };
    }

    case "setTransform": {
      const name = event.name;
      if (!name) return { state, pipeline: null };
      const objects = state.objects.map((o) =>
        o.name === name ? { ...o, transform: event.transform } : o,
      );
      return { state: { ...state, objects }, pipeline: null };
    }

    case "setPlate": {
      // S9.4-003 — per-plate membership move (AC-2 route: PlateTabs context menu).
      const name = event.name;
      const plateId = event.plateId;
      if (!name || !plateId) return { state, pipeline: null };
      const objects = state.objects.map((o) => (o.name === name ? { ...o, plateId } : o));
      return { state: { ...state, objects }, pipeline: null };
    }

    case "setObjectSettings": {
      // S9.6-002 — per-object fork / reset-to-parent (AC: override toggle works).
      const name = event.name;
      if (!name) return { state, pipeline: null };
      const objects = state.objects.map((o) =>
        o.name === name
          ? {
              ...o,
              // `settings: undefined` clears the fork → object uses global again.
              ...(event.settings !== undefined
                ? { printSettings: { ...event.settings } }
                : { printSettings: undefined }),
              ...(event.settings !== undefined && event.filamentId !== undefined
                ? { filamentId: event.filamentId }
                : event.settings === undefined
                  ? { filamentId: undefined }
                  : {}),
            }
          : o,
      );
      return { state: { ...state, objects }, pipeline: null };
    }
  }
}

/** Derive the primed multi-select set after a plain/shift click. */
export function selectWith(
  state: SceneGraphState,
  name: string,
  mode: "replace" | "toggle",
): SceneGraphState {
  const out = reduceSceneGraph(
    state,
    mode === "replace" ? { kind: "select", name } : { kind: "multiSelectToggle", name },
  );
  return out.state;
}
