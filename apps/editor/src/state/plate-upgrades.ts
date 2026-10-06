/**
 * S9.11-004 — BuildPlate upgrade flags (zustand). Thin wrapper over the pure
 * `plate-upgrade-core`: each optional upgrade (PEI texture, quadrants +
 * "front" label, hot-end visual, Z column) is an opt-in toggle DEFAULTING
 * OFF, so the base viewport stays fast and unchanged.
 */

import { create } from "zustand";
import {
  DEFAULT_PLATE_UPGRADES,
  isPlateUpgradeKey,
  PLATE_UPGRADE_KEYS,
  togglePlateUpgrade,
  type PlateUpgradeFlags,
  type PlateUpgradeKey,
} from "./plate-upgrade-core.ts";

export type { PlateUpgradeFlags, PlateUpgradeKey };
export { DEFAULT_PLATE_UPGRADES, PLATE_UPGRADE_KEYS };
export * from "./plate-upgrade-core.ts";

interface PlateUpgradeState extends PlateUpgradeFlags {
  readonly toggleUpgrade: (key: PlateUpgradeKey) => void;
}

/** Live plate-upgrade flags store (zustand, S9.11-004). */
export const usePlateUpgrades = create<PlateUpgradeState>()((set, get) => ({
  pei: DEFAULT_PLATE_UPGRADES.pei,
  quadrants: DEFAULT_PLATE_UPGRADES.quadrants,
  hotend: DEFAULT_PLATE_UPGRADES.hotend,
  zColumn: DEFAULT_PLATE_UPGRADES.zColumn,
  toggleUpgrade: (key) => {
    if (!isPlateUpgradeKey(key)) return;
    set(togglePlateUpgrade(get(), key));
  },
}));
