/**
 * S9.4-003 plate state — dependency-free pure core.
 *
 * No React / zustand dependencies so Node 24 runs it headless via the `node
 * --test` harness (same pattern as toolbar-core / shortcuts-core). The zustand
 * store (`state/plates.ts`) and the React UI (`viewport/PlateTabs.tsx`) are
 * thin wrappers over these pure functions.
 *
 * Plates group scene objects: every object belongs to exactly one plate; only
 * the active plate's objects render in the viewport. This core owns:
 * - plate list (id, name, dirty flag) — add / switch / duplicate / rename
 * - per-plate membership — which object names belong to which plate
 * - the active plate id
 *
 * Objects carry an optional `plateId` on their snapshot. When absent the
 * object is treated as belonging to a default plate. Cross-plate moves (drag
 * between tabs / context menu) are pure membership reassignments here; the
 * scenes' authoritative `plateId` mutation is applied by the React wrapper via
 * the existing mutation lane (S7-004 reducer / bridge commit).
 */

/** Stable internal plate identifier (never shown; the label is user-named). */
export type PlateId = string;

/** Plate descriptor shown in the PlateTabs chip row. */
export interface PlateDescriptor {
  readonly id: PlateId;
  /** User-facing name (defaults to "Plate N"). */
  readonly name: string;
  /** True when the plate has local unpersisted changes (3px dot indicator). */
  readonly dirty: boolean;
}

/** Immutable plate state snapshot consumed by store + tabs UI. */
export interface PlatesState {
  readonly plates: readonly PlateDescriptor[];
  readonly activeId: PlateId;
}

/** Default first plate on boot. */
export const DEFAULT_PLATE_ID = "plate-1";

/** Fallback used when no active plate matches (defensive). */
export const FALLBACK_PLATE_ID: PlateId = DEFAULT_PLATE_ID;

/** Maximum user-named plate label length (UI enforces; core guards). */
export const PLATE_NAME_MAX = 32;

/**
 * Build a default single-plate state.
 * @param label initial user-facing name (defaults to "Plate 1").
 */
export function defaultPlates(label = "Plate 1"): PlatesState {
  return {
    plates: [{ id: DEFAULT_PLATE_ID, name: label, dirty: false }],
    activeId: DEFAULT_PLATE_ID,
  };
}

/** A unique "Plate N" label that does not collide with existing names. */
export function nextPlateLabel(plates: readonly PlateDescriptor[]): string {
  const existing = new Set(plates.map((p) => p.name));
  let n = plates.length + 1;
  while (existing.has(`Plate ${n}`)) n += 1;
  return `Plate ${n}`;
}

/** Add a plate; returns a NEW state (never mutates input). */
export function addPlate(state: PlatesState, label?: string): PlatesState {
  const name = label && label.trim().length > 0 ? label.trim() : nextPlateLabel(state.plates);
  const id = `plate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    plates: [...state.plates, { id, name, dirty: false }],
    activeId: id,
  };
}

/** Switch the active plate; returns the same state when the id is unknown. */
export function switchPlate(state: PlatesState, id: PlateId): PlatesState {
  if (!state.plates.some((p) => p.id === id)) return state;
  if (state.activeId === id) return state;
  return { ...state, activeId: id };
}

/** Duplicate an existing plate (label "name copy", no members kept). */
export function duplicatePlate(state: PlatesState, id: PlateId): PlatesState {
  const source = state.plates.find((p) => p.id === id);
  if (!source) return state;
  const label = `${source.name} copy`;
  const cp: PlateDescriptor = {
    id: `plate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: label,
    dirty: false,
  };
  return {
    plates: [...state.plates, cp],
    activeId: cp.id,
  };
}

/** Rename an existing plate (returns same state when unknown / empty / same). */
export function renamePlate(state: PlatesState, id: PlateId, label: string): PlatesState {
  const trimmed = label.trim();
  if (!trimmed) return state;
  const target = state.plates.find((p) => p.id === id);
  if (!target || target.name === trimmed) return state;
  return {
    ...state,
    plates: state.plates.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
  };
}

/** Purely cosmetic dirty toggle (persisted state flips it via the wrapper). */
export function markPlateDirty(state: PlatesState, id: PlateId, dirty: boolean): PlatesState {
  return {
    ...state,
    plates: state.plates.map((p) => (p.id === id ? { ...p, dirty } : p)),
  };
}

/** Active plate descriptor (falls back to the first plate defensively). */
export function activePlate(state: PlatesState): PlateDescriptor {
  return (
    state.plates.find((p) => p.id === state.activeId) ??
    state.plates[0] ?? { id: FALLBACK_PLATE_ID, name: "Plate 1", dirty: false }
  );
}

/** Effective plate id for an object snapshot (absent plateId → default). */
export function plateIdFor(object: { readonly plateId?: PlateId }): PlateId {
  return object.plateId ?? DEFAULT_PLATE_ID;
}

/** Objects belonging to the given plate (absent plateId → default plate). */
export function objectsOnPlate<T extends { readonly plateId?: PlateId }>(
  objects: readonly T[],
  plate: PlateId,
): T[] {
  return objects.filter((o) => plateIdFor(o) === plate);
}

/** True when any object references a plate that is not in the known list. */
export function hasOrphanObjects<T extends { readonly plateId?: PlateId }>(
  objects: readonly T[],
  plates: readonly PlateDescriptor[],
): boolean {
  const known = new Set(plates.map((p) => p.id));
  return objects.some((o) => !known.has(plateIdFor(o)));
}

/** Move every named object to the plate (membership reassignment). */
export function assignObjectPlate<T extends { readonly name: string; readonly plateId?: PlateId }>(
  objects: readonly T[],
  names: readonly string[],
  plate: PlateId,
): readonly T[] {
  const target = new Set(names);
  if (target.size === 0) return objects;
  return objects.map((o) => (target.has(o.name) ? { ...o, plateId: plate } : o));
}
