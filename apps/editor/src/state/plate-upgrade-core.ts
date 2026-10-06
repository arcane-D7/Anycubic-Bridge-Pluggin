/**
 * S9.11-004 — BuildPlate upgrade flags + geometry (pure, headless).
 *
 * Pure decisions for the optional plate upgrades — procedural PEI texture
 * on/off, quadrant crosshair marks + "front" label, the live-mode hot-end
 * visual, and the Z reference column. No React / three dependencies so Node
 * runs it headless under `node --test` (same pattern as every core here).
 *
 * All upgrades are opt-in toggles that DEFAULT OFF — the base viewport stays
 * exactly as-is, so the lay-on-plate lane (regression `d9502c0`) is never
 * disturbed. Geometry helpers return positions (mm) derived ONLY from the
 * profile's build-volume contract — never a hardcoded footprint.
 */

export interface PlateUpgradeFlags {
  /** Procedural PEI texture on the build surface (roughness + grain). */
  readonly pei: boolean;
  /** Fine crosshair lines + "front" label to help print submission. */
  readonly quadrants: boolean;
  /** Hot-end visual (duct + nozzle) over the live toolhead. */
  readonly hotend: boolean;
  /** Z reference column with height ticks at the rear corner. */
  readonly zColumn: boolean;
}

export type PlateUpgradeKey = keyof PlateUpgradeFlags;

/** Every upgrade defaults OFF — base viewport behavior is unchanged. */
export const DEFAULT_PLATE_UPGRADES: PlateUpgradeFlags = {
  pei: false,
  quadrants: false,
  hotend: false,
  zColumn: false,
};

export const PLATE_UPGRADE_KEYS: readonly PlateUpgradeKey[] = [
  "pei",
  "quadrants",
  "hotend",
  "zColumn",
];

export function isPlateUpgradeKey(value: unknown): value is PlateUpgradeKey {
  return value === "pei" || value === "quadrants" || value === "hotend" || value === "zColumn";
}

/** Toggle one upgrade flag, returning a fresh object (identity changes only when set). */
export function togglePlateUpgrade(
  flags: PlateUpgradeFlags,
  key: PlateUpgradeKey,
): PlateUpgradeFlags {
  return { ...flags, [key]: !flags[key] };
}

/**
 * Quadrant crosshair lines (two thin lines crossing the plate center, X and Z
 * at half-height above the surface) + the front marker position. Returns the
 * line segment positions as X,Y,Z triplets (2 lines × 2 vertices) or an empty
 * array when the footprint is not a finite positive area. The "front" is the
 * plate's +Z side (the operator-facing edge, matching the live toolhead
 * mirroring in live-overlay-core).
 */
export function quadrantCrosshairPositions(widthMm: number, depthMm: number): number[] {
  if (![widthMm, depthMm].every((value) => Number.isFinite(value) && value > 0)) {
    return [];
  }
  const halfW = widthMm / 2;
  const halfD = depthMm / 2;
  const y = 0.12;
  // X axis line (runs along world X at z = 0) + Z axis line (along world Z
  // at x = 0) — 4 vertices, 2 line segments.
  return [-halfW, y, 0, halfW, y, 0, 0, y, -halfD, 0, y, halfD];
}

/**
 * Height tick marks for the Z reference column: horizontal segments every
 * `everyMm` mm from the plate up to `heightMm`, each 8 mm long. Returns
 * X,Y,Z triplets (parity: N ticks × 2 vertices) or an empty array when the
 * height is not a finite positive number. Marks are centered at x=0 of the
 * column plane (the caller positions the column itself).
 */
export function zColumnMarks(heightMm: number, everyMm = 20): number[] {
  if (!Number.isFinite(heightMm) || heightMm <= 0) return [];
  const step = Math.max(1, Math.floor(everyMm));
  const positions: number[] = [];
  for (let y = step; y <= heightMm; y += step) {
    positions.push(-4, y, 0, 4, y, 0);
  }
  return positions;
}
