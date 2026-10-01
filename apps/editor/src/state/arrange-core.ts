/**
 * S9.4-004 arrange core — dependency-free pure helpers for auto-arrange and
 * per-object "place on plate". No three.js / React imports (Node 24 runs it
 * headless via the test harness).
 *
 * Mirrors the preserved server `scripts/cad-arrange.mjs` shelf-packing math,
 * but operates on the editor's snapshot shape (bounds + transform) instead of
 * raw triangle buffers, so the mock bridge can reproduce the server's
 * deterministic layout in-process (provider swap later — same result shape).
 *
 * Contract notes:
 * - A snapshot's `transform.position` is the MESH OFFSET (the R3F group sits
 *   at `transform.position` and the geometry keeps absolute local coords), so
 *   `world center = transform.x + bounds-center * scale` and
 *   `world minZ = transform.z + bounds.min[2] * scale.z`.
 * - Rotation is preserved but the footprint/center math reads it as 0 (the
 *   demo objects carry rotation 0; non-axis-aligned rotation is out of scope
 *   for the deterministic arrange until S9.7 snap/transform math lands).
 */

import type { SceneObjectSnapshot } from "../bridge/types";
import type { SceneTransform } from "../viewport/transform-core";

/** Local normalize — keeps this core dependency-free (headless Node 24). */
function normalize(
  t: SceneObjectSnapshot["transform"] | undefined,
): Required<Pick<SceneTransform, "x" | "y" | "z" | "rx" | "ry" | "rz" | "sx" | "sy" | "sz">> {
  return {
    x: t?.x ?? 0,
    y: t?.y ?? 0,
    z: t?.z ?? 0,
    rx: t?.rx ?? 0,
    ry: t?.ry ?? 0,
    rz: t?.rz ?? 0,
    sx: t?.sx ?? 1,
    sy: t?.sy ?? 1,
    sz: t?.sz ?? 1,
  };
}

export interface ArrangeOptions {
  readonly plateW?: number;
  readonly plateD?: number;
  readonly gap?: number;
  /** Center the arranged block on the plate origin (default true). */
  readonly center?: boolean;
}

export interface ArrangePlacement {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ArrangeTransformResult {
  /** Per-object final transforms (only objects that were placed). */
  readonly transforms: ReadonlyMap<string, SceneTransform>;
  readonly placed: readonly ArrangePlacement[];
  readonly warnings: readonly string[];
}

const clampGap = (value: number | undefined): number => Math.max(0, value ?? 2);

/**
 * Per-object "place on plate": center the object's X/Y footprint on the plate
 * origin and sit its minZ exactly on Z=0. The result is derived from the
 * snapshot bounds + scale only — the previous position is replaced (the mesh
 * offset is recomputed so world center = 0,0 and world minZ = 0).
 */
export function centerOnPlateTransform(o: SceneObjectSnapshot): SceneTransform {
  const n = normalize(o.transform);
  const { bounds } = o;
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const minZ = bounds.min[2];
  const sx = n.sx;
  const sy = n.sy;
  const sz = n.sz;
  // `-0` (from -minZ when minZ=0) is a nasty equality trap — normalize to 0.
  return {
    x: -cx * sx || 0,
    y: -cy * sy || 0,
    z: -minZ * sz || 0,
    rx: n.rx,
    ry: n.ry,
    rz: n.rz,
    sx,
    sy,
    sz,
  };
}

interface Footprint {
  readonly w: number;
  readonly h: number;
  readonly area: number;
}

/** X/Y AABB footprint (bounds size scaled) — null when degenerate. */
function footprintOf(o: SceneObjectSnapshot): Footprint | null {
  const { min, max } = o.bounds;
  const sx = o.transform?.sx ?? 1;
  const sy = o.transform?.sy ?? 1;
  const w = (max[0] - min[0]) * sx;
  const h = (max[1] - min[1]) * sy;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h, area: w * h };
}

/**
 * Deterministic shelf-packing layout over the snapshot list (port of
 * `scripts/cad-arrange.mjs`): each object is normalized to the plate origin
 * (center XY + minZ 0), packed largest-first into rows that respect the
 * plate width, and the whole block is re-centered. Objects whose footprint
 * exceeds the plate produce an overflow warning and are left on-row (may
 * overlap). Returns per-object final transforms + placements + warnings.
 */
export function arrangeTransforms(
  objects: readonly SceneObjectSnapshot[],
  opts: ArrangeOptions = {},
): ArrangeTransformResult {
  const plateW = opts.plateW ?? 220;
  const plateD = opts.plateD ?? 220;
  const gap = clampGap(opts.gap);
  const warnings: string[] = [];

  // 1. Collect normalized footprints, largest first.
  interface Item {
    readonly o: SceneObjectSnapshot;
    readonly w: number;
    readonly h: number;
    readonly area: number;
    x: number;
    y: number;
  }
  const items: Item[] = [];
  for (const o of objects) {
    const f = footprintOf(o);
    if (!f) {
      warnings.push(`object '${o.name}' skipped (empty footprint)`);
      continue;
    }
    items.push({ o, w: f.w, h: f.h, area: f.area, x: 0, y: 0 });
  }
  items.sort((a, b) => b.area - a.area);

  // 2. Shelf packing — Y grows downward (more negative); block top = 0.
  const shelves: { top: number; xCursor: number; h: number }[] = [{ top: 0, xCursor: 0, h: 0 }];
  let current = shelves[0]!;
  for (const item of items) {
    const slotW = item.w + gap;
    const slotH = item.h + gap;
    if (current.xCursor + slotW <= plateW + 1e-6) {
      item.x = current.xCursor + item.w / 2;
      item.y = current.top - item.h / 2;
      current.xCursor += slotW;
      current.h = Math.max(current.h, slotH);
    } else {
      const newTop = current.top - current.h;
      if (-newTop + slotH > plateD + 1e-6) {
        warnings.push(
          `object '${item.o.name}' (${item.w.toFixed(1)}×${item.h.toFixed(1)} mm) does not ` +
            `fit plate ${plateW}×${plateD} mm — placed on row (may overlap)`,
        );
        item.x = current.xCursor + item.w / 2;
        item.y = current.top - item.h / 2;
      } else {
        shelves.push({ top: newTop, xCursor: 0, h: slotH });
        current = shelves[shelves.length - 1]!;
        item.x = current.xCursor + item.w / 2;
        item.y = current.top - item.h / 2;
        current.xCursor += slotW;
      }
    }
  }
  const placed: ArrangePlacement[] = items.map((item) => ({
    name: item.o.name,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
  }));

  // 3. Center the block on the plate origin.
  if (opts.center !== false && placed.length > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of placed) {
      minX = Math.min(minX, p.x - p.w / 2);
      maxX = Math.max(maxX, p.x + p.w / 2);
      minY = Math.min(minY, p.y - p.h / 2);
      maxY = Math.max(maxY, p.y + p.h / 2);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const placedMutable = placed.map((p) => ({ ...p }));
    for (const p of placedMutable) {
      p.x -= cx;
      p.y -= cy;
    }
    // Rebuild the readonly array with the centered values.
    placed.splice(0, placed.length, ...placedMutable);
    const blockW = maxX - minX;
    const blockH = maxY - minY;
    if (blockW > plateW + 1e-6 || blockH > plateD + 1e-6) {
      warnings.push(
        `arranged block ${blockW.toFixed(0)}×${blockH.toFixed(0)} mm exceeds plate ` +
          `${plateW}×${plateD} mm — scale pieces down or reduce the gap`,
      );
    }
  }

  // 4. Materialize transforms: normalize each object to the origin (center
  // XY + minZ 0), then apply the grid position as the mesh offset.
  const byName = new Map(objects.map((o) => [o.name, o]));
  const transforms = new Map<string, SceneTransform>();
  for (const p of placed) {
    const o = byName.get(p.name);
    if (!o) continue;
    const base = centerOnPlateTransform(o);
    transforms.set(o.name, { ...base, x: p.x + base.x, y: p.y + base.y });
  }

  return { transforms, placed, warnings };
}
