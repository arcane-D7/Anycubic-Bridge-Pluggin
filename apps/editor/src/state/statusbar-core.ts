/**
 * S9.4-005 status bar core — dependency-free pure helpers for the extended
 * status strip. No React/zustand/three imports (Node 24 runs it headless via
 * the test harness).
 *
 * Derives what the status bar shows from the frozen snapshot shape only:
 * - selected coords (mono, 1 decimal),
 * - current plate dims (AABB of the active plate's objects in scene space),
 * - revision + dirty chip semantics ("● N unsaved").
 */

import type { SceneObjectSnapshot } from "../bridge/types";

export interface CoordTriple {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Round to one decimal for the mono display (ties away from zero). */
function d1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Position triple from a snapshot transform (absent = identity 0). */
export function positionOf(o: Pick<SceneObjectSnapshot, "transform">): CoordTriple {
  const t = o.transform;
  return { x: t?.x ?? 0, y: t?.y ?? 0, z: t?.z ?? 0 };
}

/** Mono-formatted selected coords: `x 12.3  y -4.0  z 0.5`. */
export function formatCoords(transform: { x: number; y: number; z: number }): string {
  return `x ${d1(transform.x)}  y ${d1(transform.y)}  z ${d1(transform.z)}`;
}

/**
 * Scene-space AABB of a set of objects. World min/max per axis are computed
 * from each object's local bounds offset by its transform position (rotation
 * is read as 0, scale as 1 — same convention as the arrange core; orientation
 * math is out of scope here). Returns null for an empty set.
 */
export function plateBounds(objects: readonly SceneObjectSnapshot[]): {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
} | null {
  if (objects.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const o of objects) {
    const p = positionOf(o);
    const { min, max } = o.bounds;
    const x0 = p.x + min[0];
    const x1 = p.x + max[0];
    const y0 = p.y + min[1];
    const y1 = p.y + max[1];
    const z0 = p.z + min[2];
    const z1 = p.z + max[2];
    minX = Math.min(minX, x0, x1);
    maxX = Math.max(maxX, x0, x1);
    minY = Math.min(minY, y0, y1);
    maxY = Math.max(maxY, y0, y1);
    minZ = Math.min(minZ, z0, z1);
    maxZ = Math.max(maxZ, z0, z1);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Plate dims label (mm): `123 × 45 × 67 mm` from the bounds AABB. */
export function formatPlateDims(bounds: NonNullable<ReturnType<typeof plateBounds>>): string {
  const w = d1(bounds.maxX - bounds.minX);
  const d = d1(bounds.maxY - bounds.minY);
  const h = d1(bounds.maxZ - bounds.minZ);
  return `${w} × ${d} × ${h} mm`;
}

/**
 * Unsaved-objects count for the dirty chip. The editor's only persistent
 * "unsaved transform" is the inspector draft (`dirtyKinds`); a plate flagged
 * dirty without a draft counts its objects. Returns 0 when clean.
 */
export function unsavedCount(
  activePlateDirty: boolean,
  objectsOnPlate: readonly unknown[],
  dirtyTransformName: string | null,
  objects: readonly SceneObjectSnapshot[],
): number {
  if (dirtyTransformName) {
    return objects.some((o) => o.name === dirtyTransformName) ? 1 : 0;
  }
  return activePlateDirty ? objectsOnPlate.length : 0;
}
