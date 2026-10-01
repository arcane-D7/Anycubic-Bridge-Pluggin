/**
 * S9.6-003 — object placement metrics core (pure, headless).
 *
 * G14. Columns for center x/y/z (mono tabular), footprint (width × depth),
 * volume. Values derive from the snapshot's transform + mesh bounds (the
 * same contract `arrange-core` uses): a snapshot's `transform.position` is
 * the MESH OFFSET — the R3F group sits at `transform.position` and the
 * geometry keeps absolute local coords — so
 *   world center = transform.position + bounds-center * scale
 * and the footprint is the scaled X/Y AABB.
 *
 * No React/three.js imports: Node 24 runs this headless via the test
 * harness (same pattern as arrange-core / scene-core).
 */

import type { SceneObjectSnapshot } from "../bridge/types";

export interface PlacementMetrics {
  /** World-space center of the object's AABB (mm). */
  readonly center: readonly [number, number, number];
  /** Scaled X/Y footprint (width × depth, mm). */
  readonly footprint: { readonly w: number; readonly d: number } | null;
  /** Footprint area (mm²) — 0 when degenerate. */
  readonly footprintArea: number;
  /** Volume (mm³) — AABB fallback when volumeMm3 is 0. */
  readonly volumeMm3: number;
}

function num(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Scaled AABB (bounds * scale) centered at the mesh offset. */
export function placementMetrics(o: SceneObjectSnapshot): PlacementMetrics {
  const t = o.transform;
  const x = num(t?.x, 0);
  const y = num(t?.y, 0);
  const z = num(t?.z, 0);
  const sx = num(t?.sx, 1);
  const sy = num(t?.sy, 1);
  const sz = num(t?.sz, 1);

  const { min, max } = o.bounds;
  const cxAbs = (min[0] + max[0]) / 2;
  const cyAbs = (min[1] + max[1]) / 2;
  const czAbs = (min[2] + max[2]) / 2;
  const center: [number, number, number] = [x + cxAbs * sx, y + cyAbs * sy, z + czAbs * sz];

  const w = (max[0] - min[0]) * sx;
  const d = (max[1] - min[1]) * sy;
  const footprint = Number.isFinite(w) && Number.isFinite(d) && w > 0 && d > 0 ? { w, d } : null;

  const volumeMm3 = o.volumeMm3 > 0 ? o.volumeMm3 : w * d * (max[2] - min[2]) * sz;

  return {
    center,
    footprint,
    footprintArea: footprint ? footprint.w * footprint.d : 0,
    volumeMm3,
  };
}

/** Sort keys for the ObjectTree columns (S9.6-003 AC: sortable where sensible). */
export type PlacementSortKey = "name" | "x" | "y" | "z" | "footprint" | "volume";

/** Deterministic comparator for a column. Returns -1/0/1. */
export function comparePlacement(
  a: SceneObjectSnapshot,
  b: SceneObjectSnapshot,
  key: PlacementSortKey,
): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "x": {
      const av = placementMetrics(a).center[0];
      const bv = placementMetrics(b).center[0];
      return av === bv ? 0 : av < bv ? -1 : 1;
    }
    case "y": {
      const av = placementMetrics(a).center[1];
      const bv = placementMetrics(b).center[1];
      return av === bv ? 0 : av < bv ? -1 : 1;
    }
    case "z": {
      const av = placementMetrics(a).center[2];
      const bv = placementMetrics(b).center[2];
      return av === bv ? 0 : av < bv ? -1 : 1;
    }
    case "footprint": {
      const av = placementMetrics(a).footprintArea;
      const bv = placementMetrics(b).footprintArea;
      return av === bv ? 0 : av < bv ? -1 : 1;
    }
    case "volume": {
      const av = placementMetrics(a).volumeMm3;
      const bv = placementMetrics(b).volumeMm3;
      return av === bv ? 0 : av < bv ? -1 : 1;
    }
  }
}
