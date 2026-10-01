/**
 * S9.4-003 plate store (zustand). Thin wrapper over the pure `plates-core`:
 * add / switch / duplicate / rename plates + per-plate object membership.
 * The React wrapper (`viewport/PlateTabs.tsx`) renders the chips and routes
 * cross-plate moves through the existing scene mutation lane (bridge commit),
 * so this store stays UI-agnostic and headless-testable.
 */

import { create } from "zustand";
import {
  DEFAULT_PLATE_ID,
  FALLBACK_PLATE_ID,
  PLATE_NAME_MAX,
  activePlate,
  addPlate,
  defaultPlates,
  duplicatePlate,
  markPlateDirty,
  nextPlateLabel,
  plateIdFor,
  renamePlate,
  switchPlate,
  type PlateDescriptor,
  type PlateId,
  type PlatesState,
} from "./plates-core";

export type { PlateDescriptor, PlateId, PlatesState };
export { DEFAULT_PLATE_ID, FALLBACK_PLATE_ID, nextPlateLabel, plateIdFor, PLATE_NAME_MAX };

interface PlatesStore extends PlatesState {
  /** Create a new plate (optional label; auto "Plate N") and activate it. */
  readonly add: (label?: string) => void;
  /** Activate an existing plate by id. */
  readonly switchTo: (id: PlateId) => void;
  /** Duplicate the plate (source name + " copy") and activate the copy. */
  readonly duplicate: (id: PlateId) => void;
  /** Rename a plate (label trimmed; empty / same name are no-ops). */
  readonly rename: (id: PlateId, label: string) => void;
  /** Flip a plate's dirty indicator (3px dot shown by PlateTabs). */
  readonly setDirty: (id: PlateId, dirty: boolean) => void;
}

/** Live plate store (zustand, S9.4-003). */
export const usePlates = create<PlatesStore>()((set, get) => ({
  ...defaultPlates(),
  add: (label) => set(addPlate(get(), label)),
  switchTo: (id) => set(switchPlate(get(), id)),
  duplicate: (id) => set(duplicatePlate(get(), id)),
  rename: (id, label) => set(renamePlate(get(), id, label)),
  setDirty: (id, dirty) => set(markPlateDirty(get(), id, dirty)),
}));

/** Helper: active plate descriptor from the live store (hook consumers). */
export function useActivePlate(): PlateDescriptor {
  return usePlates((s) => activePlate(s));
}
