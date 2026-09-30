/**
 * S9.2-005 — Import normalization core (dependency-free, headless-testable).
 *
 * Takes parser output (`TriangleBuffers` from `bridge/import.ts`) and produces
 * the scene-ready snapshot payload: geometry buffers + ObjectMeshInfo mirror +
 * a `transform` that places the object ON the plate (z=0). All math is pure
 * float arrays — no three.js — so Node asserts it directly.
 *
 * "Orient-flat" (auto-orient): find the mesh's dominant axis pair (longest
 * bbox extents) and rotate the buffers so that pair becomes the XY plane and
 * the remaining axis becomes Z. Applied BEFORE z-normalization so the mesh
 * sits flat on the plate.
 */

import { isWatertight, toImportedObject, type TriangleBuffers } from "./import.ts";

export interface ImportOptions {
  /** Uniform scale factor (>0); 1 = keep source units (mm). */
  readonly scale?: number;
  /** Center the mesh on the plate origin (X/Y) — default true. */
  readonly center?: boolean;
  /** Rotate the mesh so its dominant axis pair lies on the plate — default true. */
  readonly orientFlat?: boolean;
}

export interface ImporterFlags {
  readonly scale: boolean;
  readonly center: boolean;
  readonly orientFlat: boolean;
}

export const DEFAULT_IMPORT_FLAGS: ImporterFlags = {
  scale: true,
  center: true,
  orientFlat: true,
};

/** Result: the normalized buffers PLUS the ObjectMeshInfo mirror. */
export interface ImportedObjectPayload {
  readonly kind: "stl" | "3mf";
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: TriangleBuffers["bounds"];
  readonly sizeMm: readonly [number, number, number];
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly watertight: boolean;
  /** Final placement (z=0 plate surface for the lowest point). */
  readonly transform: { readonly x: number; readonly y: number; readonly z: number };
}

function copyF32(a: Float32Array): Float32Array {
  return Float32Array.from(a);
}

function copyU32(a: Uint32Array): Uint32Array {
  return Uint32Array.from(a);
}

/** Smallest bbox extent index → the "height" axis for orient-flat. */
function dominantAxis(bounds: TriangleBuffers["bounds"]): {
  flatX: number;
  flatY: number;
  lift: number;
} {
  const sx = bounds.max[0] - bounds.min[0];
  const sy = bounds.max[1] - bounds.min[1];
  const sz = bounds.max[2] - bounds.min[2];
  // lift = the axis with the SMALLEST extent (the mesh's natural height).
  const lift = sx <= sy && sx <= sz ? 0 : sy <= sx && sy <= sz ? 1 : 2;
  // flat pair = the two remaining axes in X/Y order.
  const others = [0, 1, 2].filter((i) => i !== lift);
  return { flatX: others[0]!, flatY: others[1]!, lift };
}

/**
 * Rotate positions so `src` axis becomes `dst` axis (positive 90° swaps).
 * Pure — returns a NEW Float32Array.
 */
function rotateAxes(
  positions: Float32Array,
  mapping: readonly [number, number, number],
): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    const p = [x, y, z];
    out[i] = p[mapping[0]]!;
    out[i + 1] = p[mapping[1]]!;
    out[i + 2] = p[mapping[2]]!;
  }
  return out;
}

/** Normalize buffers to the plate: z=0 base + optional X/Y centering. */
function normalizeToPlate(
  kind: "stl" | "3mf",
  name: string,
  positionsIn: Float32Array,
  normalsIn: Float32Array,
  indices: Uint32Array,
  scale: number,
  center: boolean,
): ImportedObjectPayload {
  const positions = new Float32Array(positionsIn.length);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positionsIn.length; i += 3) {
    const x = positionsIn[i]! * scale;
    const y = positionsIn[i + 1]! * scale;
    const z = positionsIn[i + 2]! * scale;
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  // translate so min corner sits at (0,0,0)
  const dx = minX;
  const dy = minY;
  const dz = minZ;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! - dx;
    positions[i + 1] = positions[i + 1]! - dy;
    positions[i + 2] = positions[i + 2]! - dz;
  }
  let cx = 0;
  let cy = 0;
  let maxW = maxX - dx;
  let maxD = maxY - dy;
  const maxH = maxZ - dz;
  // The renderer positions objects from their geometry buffers (snapshot
  // `transform` is meta-only in this shell): CENTER the X/Y extents in the
  // geometry itself so the part lands mid-plate, Z=0 base.
  if (center) {
    cx = maxW / 2;
    cy = maxD / 2;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! - cx;
      positions[i + 1] = positions[i + 1]! - cy;
    }
    maxW = maxW - cx;
    maxD = maxD - cy;
  }
  const bounds = {
    min: [-cx, -cy, 0] as const,
    max: [maxW, maxD, maxH] as const,
  };
  const sizeMm = [maxW + cx, maxD + cy, maxH] as readonly [number, number, number];

  const info = toImportedObject({
    kind,
    name,
    positions,
    normals: normalsIn,
    indices,
    bounds,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  });
  // Placement: Z=0 base (lowest vertex touches the plate); X/Y already
  // centered in the geometry; snapshot `transform` stays a no-op until the
  // renderer consumes it (scene-core setTransform is the future lane).
  return {
    kind,
    name,
    positions,
    normals: normalsIn,
    indices,
    bounds,
    sizeMm,
    volumeMm3: info.volumeMm3,
    surfaceAreaMm2: info.surfaceAreaMm2,
    vertices: info.vertices,
    triangles: info.triangles,
    watertight: isWatertight(positions, indices),
    transform: { x: 0, y: 0, z: 0 },
  };
}

/**
 * Prepare parser output for the scene graph: apply scale/center/orient-flat,
 * normalize to z=0, and return the full payload (buffers + info mirror +
 * placement transform in scene units).
 *
 * - The returned `positions`/`normals`/`indices` go straight into the store's
 *   `geometry` lane; `transform` offsets the object to the plate (z=0).
 * - `orientFlat` chooses the lift axis by SMALLEST extent (mesh natural
 *   height), mapping flat axes to X/Y so the part lies on the plate.
 */
export function prepareImportedObject(
  buffers: TriangleBuffers,
  opts: ImportOptions = {},
): ImportedObjectPayload {
  const scale = opts.scale ?? 1;
  const center = opts.center ?? true;
  const orientFlat = opts.orientFlat ?? true;

  let positions = copyF32(buffers.positions);
  const normals = buffers.normals;
  const indices = copyU32(buffers.indices);
  const bounds = buffers.bounds;

  if (orientFlat && scale === 1) {
    const ax = dominantAxis(bounds);
    if (!(ax.lift === 2)) {
      // mapping: source axis → destination (X, Y, Z)
      const mapping: readonly [number, number, number] =
        ax.lift === 0 // smallest is X → lift it to Z:
          ? [1, 2, 0] // Y→X, Z→Y, X→Z
          : [0, 2, 1]; // lift is Y → X stays, Z→Y, Y→Z
      positions = rotateAxes(positions, mapping);
    }
  }

  return normalizeToPlate(buffers.kind, buffers.name, positions, normals, indices, scale, center);
}

/** Build the SceneObjectSnapshot payload the store `add` lane accepts. */
export function toSceneObject(payload: ImportedObjectPayload): {
  readonly name: string;
  readonly vertices: number;
  readonly triangles: number;
  readonly bounds: ImportedObjectPayload["bounds"];
  readonly sizeMm: ImportedObjectPayload["sizeMm"];
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
  readonly watertight: boolean;
  readonly geometry: {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
  };
  readonly visible: boolean;
  readonly locked: boolean;
  readonly parentId: null;
  readonly transform: { readonly x: number; readonly y: number; readonly z: number };
} {
  return {
    name: payload.name,
    vertices: payload.vertices,
    triangles: payload.triangles,
    bounds: payload.bounds,
    sizeMm: payload.sizeMm,
    volumeMm3: payload.volumeMm3,
    surfaceAreaMm2: payload.surfaceAreaMm2,
    watertight: payload.watertight,
    geometry: {
      positions: payload.positions,
      normals: payload.normals,
      indices: payload.indices,
    },
    visible: true,
    locked: false,
    parentId: null,
    transform: payload.transform,
  };
}

/** File extension → import kind (headless, used by dialog + drag-drop). */
export function classifyFile(name: string): "stl" | "3mf" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".stl")) return "stl";
  if (lower.endsWith(".3mf") || lower.endsWith(".3mf.zip")) return "3mf";
  return null;
}

/**
 * Fit factor so the mesh's largest extent fits the print bed (default 220mm).
 * clamps to ≥1 to never upscale (mm units assumed already sane); returns 1
 * when the mesh already fits.
 */
export function fitFactor(bounds: TriangleBuffers["bounds"], bedMm = 220): number {
  const longest = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  if (!(longest > 0)) return 1;
  const factor = bedMm / longest;
  return factor >= 1 ? 1 : factor;
}
