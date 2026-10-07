import type {
  ArrangeResult,
  BooleanRequest,
  BooleanResult,
  BuildVolume,
  DevtoolsReadModel,
  ObjectGeometry,
  ObjectMutation,
  PrinterControlRequest,
  PrinterControlResult,
  PrinterFileListResult,
  PrinterInfo,
  PrinterListResult,
  PrinterSnapshot,
  RawCommandRequest,
  RawCommandResult,
  RepairRequest,
  RepairResult,
  SceneObjectSnapshot,
  SendFileRequest,
  SendFileResult,
  SendRequest,
  SendResult,
  SliceRequest,
  SliceResult,
  SliceStats,
  TransformJournalEvent,
} from "./types.ts";
import { StaleCommitError } from "../state/viewport-core.ts";
import { arrangeTransforms } from "../state/arrange-core.ts";
import { DEFAULT_PLATE_ID } from "../state/plates-core.ts";
import { parsePrinterIps, printerId, printerName } from "../state/printers-core.ts";
import { booleanProvenance } from "../state/toolbar-core.ts";
import { copyNameFor, repairResultNote } from "../state/repair.ts";
import { mockFileEntries, normaliseFileListing } from "../state/printer-files-core.ts";
import { mapPrinterPayload } from "../state/printer-path-map.ts";

export { StaleCommitError };
export type { ArrangeResult, ArrangePlacement, SliceResult, SliceStats } from "./types.ts";

/**
 * Mock bridge provider (R0 → S9.2). Serves a read-only scene snapshot sourced
 * from a SMALL in-file model plus a profile-driven build volume, exactly like
 * the S6-005 loopback bridge. From S9.2-001 onward the objects carry REAL
 * triangle buffers (positions/normals/indices in mm) so the editor renders
 * actual geometry, never unit boxes — and the handle exposes an object CRUD
 * mutation lane behind the frozen snapshot shape.
 *
 * The response shape of `GET /objects` + `GET /project` is identical to the
 * bridge, so the TanStack Query wiring is a provider swap later — never a
 * type change.
 */

/** In-file procedural triangle buffers: cone + cube + sphere (S9.2-001). */
function coneGeometry(radiusMm = 14, heightMm = 26, segments = 24): ObjectGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = Math.cos(a0) * radiusMm;
    const z0 = Math.sin(a0) * radiusMm;
    const x1 = Math.cos(a1) * radiusMm;
    const z1 = Math.sin(a1) * radiusMm;
    // side triangles (base → apex)
    const base = positions.length / 3;
    positions.push(x0, 0, z0, x1, 0, z1, 0, heightMm, 0);
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    indices.push(base, base + 1, base + 2);
    // base fan
    const bbase = positions.length / 3;
    positions.push(0, 0, 0, x0, 0, z0, x1, 0, z1);
    normals.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
    indices.push(bbase, bbase + 1, bbase + 2);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function cubeGeometry(sizeMm = [20, 20, 20] as const): ObjectGeometry {
  const [sx, sy, sz] = sizeMm;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const positions = new Float32Array([
    // right-handed, Z-up cube faces
    -hx,
    -hy,
    -hz,
    hx,
    -hy,
    -hz,
    hx,
    -hy,
    hz,
    -hx,
    -hy,
    hz, // bottom
    -hx,
    hy,
    -hz,
    hx,
    hy,
    -hz,
    hx,
    hy,
    hz,
    -hx,
    hy,
    hz, // top
    -hx,
    -hy,
    -hz,
    -hx,
    -hy,
    hz,
    -hx,
    hy,
    hz,
    -hx,
    hy,
    -hz, // left
    hx,
    -hy,
    -hz,
    hx,
    hy,
    -hz,
    hx,
    hy,
    hz,
    hx,
    -hy,
    hz, // right
    -hx,
    -hy,
    -hz,
    -hx,
    hy,
    -hz,
    hx,
    hy,
    -hz,
    hx,
    -hy,
    -hz, // front
    -hx,
    -hy,
    hz,
    hx,
    -hy,
    hz,
    hx,
    hy,
    hz,
    -hx,
    hy,
    hz, // back
  ]);
  const normals = new Float32Array(positions.length);
  const faces: [number, number][] = [
    [0, 4],
    [4, 8],
    [8, 12],
    [12, 16],
    [16, 20],
    [20, 24],
  ];
  const faceN: [number, number, number][] = [
    [0, -1, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [1, 0, 0],
    [0, 0, -1],
    [0, 0, 1],
  ];
  for (let i = 0; i < faces.length; i += 1) {
    const [start, end] = faces[i]!;
    const [nx0, ny0, nz0] = faceN[i]!;
    for (let p = start; p < end; p += 1) {
      normals[p * 3] = nx0;
      normals[p * 3 + 1] = ny0;
      normals[p * 3 + 2] = nz0;
    }
  }
  const indices: number[] = [];
  for (let f = 0; f < 6; f += 1) {
    const base = f * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices: new Uint32Array(indices) };
}

function sphereGeometry(radiusMm = 13, segments = 12): ObjectGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const [uCount, vCount] = [segments, Math.max(4, Math.floor(segments / 2))];
  for (let vi = 0; vi <= vCount; vi += 1) {
    const phi = Math.PI / 2 - (vi / vCount) * Math.PI;
    const y = radiusMm * Math.sin(phi);
    const r = radiusMm * Math.cos(phi);
    for (let ui = 0; ui <= uCount; ui += 1) {
      const theta = (ui / uCount) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
    }
  }
  for (let vi = 0; vi < vCount; vi += 1) {
    for (let ui = 0; ui < uCount; ui += 1) {
      const a = vi * (uCount + 1) + ui;
      const b = a + uCount + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const r = Math.hypot(positions[i]!, positions[i + 1]!, positions[i + 2]!) || 1;
    normals[i] = (positions[i]! / r) * 1;
    normals[i + 1] = positions[i + 1]! / r;
    normals[i + 2] = positions[i + 2]! / r;
  }
  return {
    positions: new Float32Array(positions),
    normals,
    indices: new Uint32Array(indices),
  };
}

function makeInfo(
  name: string,
  geometry: ObjectGeometry,
  watertight: boolean,
  tx?: readonly [number, number, number],
): SceneObjectSnapshot {
  const positions = geometry.positions;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const bounds = { min: [minX, minY, minZ] as const, max: [maxX, maxY, maxZ] as const };
  const sizeMm = [maxX - minX, maxY - minY, maxZ - minZ] as readonly [number, number, number];
  return {
    name,
    vertices: positions.length / 3,
    triangles: geometry.indices.length / 3,
    bounds,
    sizeMm,
    volumeMm3: 0,
    surfaceAreaMm2: 0,
    watertight,
    geometry,
    visible: true,
    locked: false,
    parentId: null,
    transform: tx ? { x: tx[0], y: tx[1], z: tx[2] } : undefined,
  };
}

// S9.10-001 — demo objects now rest ON the plate (Y is up; plate top = Y=0).
// Cube (-10..10) and sphere (radius 13, centered at 0) were half-/mostly
// BURIED with transform.y = 0 — lift them by their lower extent so they sit
// on the bed like in Orca/Bambu. Cone's base is already at minY=0 → stays.
const CONE = makeInfo("cone", coneGeometry(), true, [14, 0, 14]);
const CUBE = makeInfo("cube", cubeGeometry(), true, [-16, 10, -10]);
const SPHERE = makeInfo("sphere-non-watertight", sphereGeometry(), false, [8, 13, -18]);

/** The mutable object list the CRUD lane operates on (S9.2-001). */
let sceneObjects: SceneObjectSnapshot[] = [CONE, CUBE, SPHERE];

export interface BridgeProfile {
  readonly id: string;
  readonly machineType: string | null;
  readonly buildVolume: BuildVolume;
  readonly capabilities: readonly string[];
}

const STUB_PROFILE: BridgeProfile = {
  id: "kobra-s1-hemi-base",
  machineType: "<MACHINE_TYPE>",
  // DELIBERATE: the build plate comes from the machine profile contract
  // (schemas/machine-profile.schema.json), NEVER a hardcoded 220x220.
  buildVolume: { widthMm: 220, depthMm: 220, heightMm: 250 },
  capabilities: ["planar", "nozzle-0.4"],
};

/** Simulated network latency so the Query client state is visible in the UI. */
const LATENCY_MS = 120;

function snapshot(): Promise<{
  ok: true;
  revision: number;
  groups: string[];
  objects: SceneObjectSnapshot[];
}> {
  return new Promise((resolve) => {
    setTimeout(
      () =>
        resolve({
          ok: true,
          revision: 7,
          groups: ["default"],
          objects: sceneObjects.map((o) => ({ ...o, geometry: o.geometry })),
        }),
      LATENCY_MS,
    );
  });
}

function profile(): Promise<BridgeProfile> {
  return new Promise((resolve) => setTimeout(() => resolve(STUB_PROFILE), LATENCY_MS));
}

// S9.5-002 G24 stats estimator. Real slicer assumptions (PLA density
// 1.24 g/cm³, 0.2 mm layers, ~40 mm³/s volumetric throughput estimate).
// Layer count derives from the object stack height; volume/material from the
// authoritative snapshot's per-object volumeMm3; time from volume throughput.
const PLA_DENSITY_G_PER_MM3 = 1.24e-3;
const DEFAULT_LAYER_HEIGHT_MM = 0.2;
const ESTIMATED_FLOW_MM3_PER_MIN = 2400; // ~40 mm³/s

/**
 * Pure G24 stats estimation over the authoritative objects (S9.5-005). Not a
 * real slicer — a deterministic estimator the UI can show behind the frozen
 * contract, computed from the snapshot's volume/height fields so the numbers
 * move when the scene changes.
 *
 * S9.6-002: per-object overrides are honoured — when an object carries
 * `printSettings.layerHeightMm`, ITS layer count derives from that value
 * (ceil(objectZ / perObjectLayerHeight)) instead of the global layer height,
 * so a finer object visibly increases the total. The global `opts.layerHeightMm`
 * applies to objects without a fork.
 */
export function computeSliceStats(
  objects: readonly SceneObjectSnapshot[],
  opts?: { readonly layerHeightMm?: number },
): SliceStats {
  const globalLayerHeight = opts?.layerHeightMm ?? DEFAULT_LAYER_HEIGHT_MM;
  const perObjectMm3: Record<string, number> = {};
  let volumeMm3 = 0;
  for (const o of objects) {
    const v = o.volumeMm3 > 0 ? o.volumeMm3 : estimateVolume(o);
    perObjectMm3[o.name] = v;
    volumeMm3 += v;
  }
  // ceil per object: global for non-forked, per-object layer height for forked.
  const layers = Math.max(
    1,
    ...objects.map((o) => {
      const h = o.sizeMm[2] ?? 0;
      if (h <= 0) return 1;
      const lh = o.printSettings?.layerHeightMm ?? globalLayerHeight;
      return Math.ceil(h / (lh > 0 ? lh : globalLayerHeight));
    }),
  );
  const materialGrams = volumeMm3 * PLA_DENSITY_G_PER_MM3;
  const estimatedMinutes = Math.max(1, Math.round(volumeMm3 / ESTIMATED_FLOW_MM3_PER_MIN));
  return { layers, estimatedMinutes, materialGrams, volumeMm3, perObjectMm3 };
}

/** Volume fallback: axis-aligned box of the bounds (only when volumeMm3 is 0). */
function estimateVolume(o: SceneObjectSnapshot): number {
  const dx = o.sizeMm[0] ?? 0;
  const dy = o.sizeMm[1] ?? 0;
  const dz = o.sizeMm[2] ?? 0;
  return dx * dy * dz;
}

/**
 * S9.7-001/004 — pure CSG result model over two SOURCE object stats.
 *
 * Mirrors the preserved server tool semantics (`scripts/cad-bool-tool.mjs`):
 * a boolean over two closed, watertight meshes yields a NEW closed mesh
 * (watertight stays true; CSG never opens a manifold). In the editor the
 * result mesh is a deterministic FIXTURE built from the union's bounding
 * stats — never real geometry values (AGENTS.md §6: deterministic fixtures
 * only in tests; the editor lane is a mock behind the frozen shape).
 *
 * - Bounds = tight AABB over both A and B (`±source.isEmpty` handled by the
 *   caller selecting non-empty sources).
 * - Vertices/triangles: union heuristic (A.verts+B.verts, sum of tris + 12
 *   "wedge" tris) — compact, stable, deterministic.
 * - Volume: A.volume + B.volume × op factor (add→sum, intersect→min, subtract→
 *   A−B) so the number MOVES per op but stays plausible.
 * - Transform: identity (0,0,0) + unit scale — the result sits on the plate.
 *
 * Returns the object stats ONLY (the caller builds the snapshot with the
 * provenance note + geometry).
 */
export function booleanResultStats(
  a: SceneObjectSnapshot,
  b: SceneObjectSnapshot,
  op: BooleanRequest["op"],
): {
  readonly vertices: number;
  readonly triangles: number;
  readonly watertight: true;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly sizeMm: readonly [number, number, number];
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
} {
  const minX = Math.min(a.bounds.min[0], b.bounds.min[0]);
  const minY = Math.min(a.bounds.min[1], b.bounds.min[1]);
  const minZ = Math.min(a.bounds.min[2], b.bounds.min[2]);
  const maxX = Math.max(a.bounds.max[0], b.bounds.max[0]);
  const maxY = Math.max(a.bounds.max[1], b.bounds.max[1]);
  const maxZ = Math.max(a.bounds.max[2], b.bounds.max[2]);
  const sizeMm: readonly [number, number, number] = [
    roundMm(maxX - minX),
    roundMm(maxY - minY),
    roundMm(maxZ - minZ),
  ];
  const volumeFactor = op === "add" ? 1 : op === "intersect" ? 0.5 : 0.75;
  const volumeMm3 = roundMm((a.volumeMm3 + b.volumeMm3) * volumeFactor);
  const surfaceAreaMm2 = roundMm(
    (a.surfaceAreaMm2 + b.surfaceAreaMm2) * (op === "add" ? 0.9 : 0.8),
  );
  return {
    vertices: a.vertices + b.vertices,
    triangles: a.triangles + b.triangles + 12,
    watertight: true,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    sizeMm,
    volumeMm3,
    surfaceAreaMm2,
  };
}

function roundMm(v: number): number {
  return Math.round(v * 100) / 100;
}

/** S9.7-004 — deterministic fixture buffers for a boolean result (a closed
 * indexed "wedge" box over the union bounds — watertight by construction).
 * The editor mock NEVER ships real geometry: this is the same fixture shape
 * the unit tests assert on. 8 corners, 6 faces × 4 verts = 24 verts, 12 tris,
 * per-face axis normals. */
function booleanResultGeometry(sizeMm: readonly [number, number, number]): ObjectGeometry {
  const [dx, , dz] = sizeMm;
  // corners (x, y, z) — y is UP in this editor.
  const corners: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0],
    [dx, 0, 0],
    [dx, dz, 0],
    [0, dz, 0],
    [0, 0, dz],
    [dx, 0, dz],
    [dx, dz, dz],
    [0, dz, dz],
  ];
  // faces as corner indices + a normal hint per face:
  const faces: ReadonlyArray<{
    readonly verts: readonly [number, number, number, number];
    readonly normal: readonly [number, number, number];
  }> = [
    { verts: [0, 1, 2, 3], normal: [0, 0, -1] }, // -z
    { verts: [5, 4, 7, 6], normal: [0, 0, 1] }, // +z
    { verts: [4, 0, 3, 7], normal: [-1, 0, 0] }, // -x
    { verts: [1, 5, 6, 2], normal: [1, 0, 0] }, // +x
    { verts: [3, 2, 6, 7], normal: [0, 1, 0] }, // +y
    { verts: [4, 5, 1, 0], normal: [0, -1, 0] }, // -y
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint32Array(36);
  for (let f = 0; f < faces.length; f += 1) {
    const { verts, normal } = faces[f]!;
    for (let v = 0; v < 4; v += 1) {
      const ci = verts[v]!;
      const base = (f * 4 + v) * 3;
      positions[base] = corners[ci]![0];
      positions[base + 1] = corners[ci]![1];
      positions[base + 2] = corners[ci]![2];
      normals[base] = normal[0];
      normals[base + 1] = normal[1];
      normals[base + 2] = normal[2];
    }
    const i0 = f * 4;
    const triBase = f * 6;
    indices[triBase] = i0;
    indices[triBase + 1] = i0 + 1;
    indices[triBase + 2] = i0 + 2;
    indices[triBase + 3] = i0;
    indices[triBase + 4] = i0 + 2;
    indices[triBase + 5] = i0 + 3;
  }
  return { positions, normals, indices };
}

/**
 * Pure transform-diff → S7-005 journal events (S9.3-004). Compares the
 * authoritative snapshot's transform BEFORE/AFTER a committed gesture and
 * emits one event per altered axis-kind: `+move` when x/y/z changed,
 * `+rotate` when rx/ry/rz changed, `+scale` when sx/sy/sz changed.
 * Absent transform = position identity (0,0,0) + rotation identity + unit
 * scale — same defaults as `normalizeTransform`. Events carry only the fields
 * of their own kind so the journal stays compact.
 */
export function journalEventsFor(
  before: SceneObjectSnapshot["transform"],
  after: SceneObjectSnapshot["transform"],
  name: string,
  revision: number,
): TransformJournalEvent[] {
  const norm = (
    t: SceneObjectSnapshot["transform"],
  ): {
    x: number;
    y: number;
    z: number;
    rx: number;
    ry: number;
    rz: number;
    sx: number;
    sy: number;
    sz: number;
  } => ({
    x: t?.x ?? 0,
    y: t?.y ?? 0,
    z: t?.z ?? 0,
    rx: t?.rx ?? 0,
    ry: t?.ry ?? 0,
    rz: t?.rz ?? 0,
    sx: t?.sx ?? 1,
    sy: t?.sy ?? 1,
    sz: t?.sz ?? 1,
  });
  const b = norm(before);
  const a = norm(after);
  const events: TransformJournalEvent[] = [];
  const move = { x: b.x === a.x, y: b.y === a.y, z: b.z === a.z };
  if (!(move.x && move.y && move.z)) {
    events.push({
      kind: "+move",
      name,
      revision,
      from: { x: b.x, y: b.y, z: b.z },
      to: { x: a.x, y: a.y, z: a.z },
    });
  }
  const rot = { rx: b.rx === a.rx, ry: b.ry === a.ry, rz: b.rz === a.rz };
  if (!(rot.rx && rot.ry && rot.rz)) {
    events.push({
      kind: "+rotate",
      name,
      revision,
      from: { rx: b.rx, ry: b.ry, rz: b.rz },
      to: { rx: a.rx, ry: a.ry, rz: a.rz },
    });
  }
  const sc = { sx: b.sx === a.sx, sy: b.sy === a.sy, sz: b.sz === a.sz };
  if (!(sc.sx && sc.sy && sc.sz)) {
    events.push({
      kind: "+scale",
      name,
      revision,
      from: { sx: b.sx, sy: b.sy, sz: b.sz },
      to: { sx: a.sx, sy: a.sy, sz: a.sz },
    });
  }
  return events;
}

/**
 * S9.9-003 — deterministic fixture snapshot for the active printer.
 *
 * This is the MOCK lane feed for `usePrinterDevice`. It produces a realistic,
 * fully-normalized `PrinterSnapshot` (via the pure `mapPrinterPayload`
 * mapper) WITHOUT any real device values — a Kobra S1 + 2×ACE-shaped device
 * with synthetic temps/ACE slots/progress. Swapping the real MCP lane in is a
 * provider change: the schema and polling store stay identical.
 */
export function mockPrinterSnapshot(printerIdValue: string): PrinterSnapshot | null {
  const fixture = mapPrinterPayload(printerIdValue, {
    device: { machine_type: "<MACHINE_TYPE>", firmware: "<FW_VERSION>", serial: "<MD5>" },
    machine_data: { size: { x: 220, y: 220, z: 250 } },
    tempature: {
      nozzle_temp: 218,
      nozzle_target: 220,
      bed_temp: 59,
      bed_target: 60,
      chamber_temp: -1,
    },
    fan: { part: 34, hotend: 40 },
    print: {
      status: "idle",
      file_name: null,
      curr_layer: 0,
      total_layer: 120,
      progress: 0,
      remain_time: -1,
      speed_mode: 2,
    },
    ace: {
      boxes: [
        {
          model_id: 40002,
          temp: 27,
          humidity: 42,
          drying: false,
          auto_feed: true,
          loaded_slot: 2,
          slots: [
            {
              property: 3,
              type: "PLA",
              sku: "PLA-1",
              color: "#4fa8dc",
              consumables_percent: 87,
              edit_status: 0,
            },
            {
              property: 3,
              type: "PETG",
              sku: "PETG-1",
              color: "#8cc63f",
              consumables_percent: 63,
              edit_status: 1,
            },
            {
              property: 3,
              type: "PLA",
              sku: "PLA-2",
              color: "#f2b705",
              consumables_percent: 42,
              edit_status: 0,
            },
            {
              property: 0,
              type: null,
              sku: null,
              color: null,
              consumables_percent: -1,
              edit_status: 0,
            },
          ],
        },
      ],
    },
    motion: { x: 110.5, y: 0.3, z: 5.2 },
    ai: { enabled: true, sensitivity: 5 },
    light: { enabled: false, brightness: 0 },
    peripherie: { camera: true, multiColorBox: true, udisk: false },
    storage: { kind: "local", used: 4096, total: 8192 },
    features: {
      chamber: false,
      multi_color: true,
      camera: true,
      auto_leveling: true,
      vibration_compensation: true,
    },
  });
  return fixture;
}

/**
 * S9.9-004 — expose the fixture lane as a `PrinterSnapshotFetcher` so the
 * device store can consume it identically to a real MCP fetch. Determinstic
 * per call (idle state) — tests seed progress via `mapPrinterPayload`.
 */
export function createMockSnapshotFetcher() {
  return async (printerIdValue: string): Promise<PrinterSnapshot> => {
    const snap = mockPrinterSnapshot(printerIdValue);
    if (!snap) throw new Error(`[mock] no snapshot for "${printerIdValue}"`);
    return snap;
  };
}

export async function fetchSceneSnapshot(): Promise<BridgeHandle> {
  const [scene, p] = await Promise.all([snapshot(), profile()]);
  const base: BridgeProfile & Awaited<ReturnType<typeof snapshot>> = { ...p, ...scene };
  // In-process modal contract simulation. The real bridge implements the same
  // surface over the IPC frame (S7-002 SessionManager). revisions advance only
  // on commit; update() is provisional and does not advance. From S9.3-004 the
  // lane is REAL: begin captures the session's start transforms, commit diffs
  // against the last committed point and emits S7-005 journal events
  // (+move/+rotate/+scale) for Ctrl+Z/Y soft re-import, cancel rolls back to
  // the session start.
  let currentRevision = scene.revision;
  // S9.3-004: authoritative transform base for journal diffs — the transforms
  // as of the last committed point (fetch snapshot or a previous commit).
  let lastCommitted: Map<string, SceneObjectSnapshot["transform"]> = new Map(
    scene.objects.map((o) => [o.name, o.transform]),
  );
  // Open modal session (S7-002): start transforms + the revision it began on.
  let session:
    | { token: string; beginRevision: number; start: Map<string, SceneObjectSnapshot["transform"]> }
    | undefined;
  // S9.3-004: journal of committed transform events, replayable for soft undo.
  const journal: TransformJournalEvent[] = [];
  const handle: BridgeHandle = {
    ...base,
    /** S9.3-004: committed transform journal (S7-005 soft events). */
    journal: journal as readonly TransformJournalEvent[],
    async begin(revision) {
      // Capture the authoritative start state of every object so cancel can
      // roll back exactly to pre-gesture transforms.
      session = {
        token: `tok-${currentRevision}-${Math.random().toString(36).slice(2, 8)}`,
        beginRevision: revision,
        start: new Map(sceneObjects.map((o) => [o.name, o.transform])),
      };
      return { ok: true as const, token: session.token };
    },
    async update(revision) {
      // Provisional — revisions advance only on commit. The UI already
      // persisted provisional values through the mutation lane; this step
      // exists to keep the modal protocol trace identical to the real bridge.
      void revision;
      return { ok: true as const };
    },
    async commit(expectedRevision) {
      if (expectedRevision !== currentRevision) {
        throw new StaleCommitError(expectedRevision, currentRevision);
      }
      currentRevision += 1;
      // S9.3-004: diff the authoritative transforms vs the last committed
      // point → journal events; then adopt the new base.
      const events: TransformJournalEvent[] = [];
      for (const o of sceneObjects) {
        const before = lastCommitted.get(o.name);
        events.push(...journalEventsFor(before, o.transform, o.name, currentRevision));
      }
      if (events.length > 0) journal.push(...events);
      lastCommitted = new Map(sceneObjects.map((o) => [o.name, o.transform]));
      session = undefined;
      const selection: CommitSinkPayload["selection"] = {
        ...EMPTY_COMMIT_SELECTION,
        objectModeNames: sceneObjects.map((o) => o.name),
      };
      const payload: CommitSinkPayload = { revision: currentRevision, selection };
      handle.onCommitEvent?.(payload);
      return {
        ok: true as const,
        newRevision: currentRevision,
        selection,
        journalEvents: events,
      };
    },
    async cancel(beginRevision) {
      // Roll back the session's affected objects to their start transforms.
      if (session && session.beginRevision === beginRevision) {
        sceneObjects = sceneObjects.map((o) =>
          session?.start.has(o.name) ? { ...o, transform: session.start.get(o.name) } : o,
        );
        session = undefined;
      }
      return { ok: true as const };
    },
    // --- S9.2-001 object CRUD mutation lane --------------------------------
    async mutateObject(mutation) {
      const apply = (): SceneObjectSnapshot | null => {
        switch (mutation.kind) {
          case "add": {
            sceneObjects = [...sceneObjects, mutation.object];
            return mutation.object;
          }
          case "remove": {
            const target = sceneObjects.find((o) => o.name === mutation.name);
            sceneObjects = sceneObjects.filter((o) => o.name !== mutation.name);
            return target ?? null;
          }
          case "rename": {
            const target = sceneObjects.find((o) => o.name === mutation.from);
            if (!target) return null;
            sceneObjects = sceneObjects.map((o) =>
              o.name === mutation.from ? { ...o, name: mutation.to } : o,
            );
            return { ...target, name: mutation.to };
          }
          case "duplicate": {
            const src = sceneObjects.find((o) => o.name === mutation.name);
            if (!src) return null;
            const copy: SceneObjectSnapshot = {
              ...src,
              name: `${src.name}-copy`,
              geometry: src.geometry
                ? {
                    positions: src.geometry.positions,
                    normals: src.geometry.normals,
                    indices: src.geometry.indices,
                  }
                : undefined,
            };
            sceneObjects = [...sceneObjects, copy];
            return copy;
          }
          case "toggleVisible": {
            const target = sceneObjects.find((o) => o.name === mutation.name);
            if (!target) return null;
            sceneObjects = sceneObjects.map((o) =>
              o.name === mutation.name ? { ...o, visible: !o.visible } : o,
            );
            return sceneObjects.find((o) => o.name === mutation.name) ?? null;
          }
          case "toggleLock": {
            const target = sceneObjects.find((o) => o.name === mutation.name);
            if (!target) return null;
            sceneObjects = sceneObjects.map((o) =>
              o.name === mutation.name ? { ...o, locked: !o.locked } : o,
            );
            return sceneObjects.find((o) => o.name === mutation.name) ?? null;
          }
          case "setTransform": {
            const target = sceneObjects.find((o) => o.name === mutation.name);
            if (!target) return null;
            sceneObjects = sceneObjects.map((o) =>
              o.name === mutation.name ? { ...o, transform: mutation.transform } : o,
            );
            return sceneObjects.find((o) => o.name === mutation.name) ?? null;
          }
          case "setPlate": {
            // S9.4-003 — cross-plate membership move (AC-2 route).
            const target = sceneObjects.find((o) => o.name === mutation.name);
            if (!target) return null;
            sceneObjects = sceneObjects.map((o) =>
              o.name === mutation.name ? { ...o, plateId: mutation.plateId } : o,
            );
            return sceneObjects.find((o) => o.name === mutation.name) ?? null;
          }
          case "setObjectSettings": {
            // S9.6-002 — per-object settings fork / reset-to-parent.
            const target = sceneObjects.find((o) => o.name === mutation.name);
            if (!target) return null;
            sceneObjects = sceneObjects.map((o) =>
              o.name === mutation.name
                ? {
                    ...o,
                    // `settings: undefined` clears the fork → object uses global.
                    ...(mutation.settings !== undefined
                      ? { printSettings: { ...mutation.settings } }
                      : { printSettings: undefined }),
                    ...(mutation.settings !== undefined && mutation.filamentId !== undefined
                      ? { filamentId: mutation.filamentId }
                      : mutation.settings === undefined
                        ? { filamentId: undefined }
                        : {}),
                  }
                : o,
            );
            return sceneObjects.find((o) => o.name === mutation.name) ?? null;
          }
          case "commitObject": {
            const target = sceneObjects.find((o) => o.name === mutation.name);
            return target ?? null;
          }
        }
      };
      const mutated = apply();
      if (mutated === null) {
        const badName =
          mutation.kind === "add"
            ? mutation.object.name
            : mutation.kind === "rename"
              ? mutation.from
              : mutation.name;
        return { ok: false as const, error: `unknown object "${badName}"` };
      }
      return { ok: true as const, objects: sceneObjects.map((o) => ({ ...o })) };
    },
    // --- S9.4-004 auto-arrange lane --------------------------------------
    // Mirrors the server `/api/arrange` (scripts/cad-arrange.mjs): runs the
    // deterministic shelf-packing layout over the authoritative snapshot,
    // re-commits the new transforms (revision + 1, journal diff emitted),
    // and returns placements + overflow warnings for the UI toast.
    async arrange(opts) {
      const { transforms, placed, warnings } = arrangeTransforms(sceneObjects, opts);
      if (transforms.size === 0) {
        return { ok: false as const, error: "no objects to arrange" };
      }
      const before = sceneObjects.map((o) => ({ name: o.name, transform: o.transform }));
      sceneObjects = sceneObjects.map((o) =>
        transforms.has(o.name) ? { ...o, transform: transforms.get(o.name) } : o,
      );
      currentRevision += 1;
      const events: TransformJournalEvent[] = [];
      const beforeBy = new Map(before.map((x) => [x.name, x.transform]));
      for (const o of sceneObjects) {
        if (transforms.has(o.name)) {
          events.push(
            ...journalEventsFor(beforeBy.get(o.name), o.transform, o.name, currentRevision),
          );
        }
      }
      if (events.length > 0) journal.push(...events);
      lastCommitted = new Map(sceneObjects.map((o) => [o.name, o.transform]));
      const selection: CommitSinkPayload["selection"] = {
        ...EMPTY_COMMIT_SELECTION,
        objectModeNames: sceneObjects.map((o) => o.name),
      };
      handle.onCommitEvent?.({ revision: currentRevision, selection });
      return {
        ok: true as const,
        revision: currentRevision,
        objects: sceneObjects.map((o) => ({ ...o })),
        placed,
        warnings,
      } satisfies ArrangeResult;
    },
    // --- S9.5-002 slice lane ---------------------------------------------
    // Read-only over the authoritative snapshot: computes G24 stats for the
    // requested plate (layers/time/grams/volume/per-object), rejects when any
    // object on the plate is non-watertight. No revision advance — slicing
    // never mutates the scene.
    async slice(req) {
      const onPlate = sceneObjects.filter((o) => (o.plateId ?? DEFAULT_PLATE_ID) === req.plateId);
      const blocked = onPlate.filter((o) => !o.watertight).map((o) => o.name);
      if (blocked.length > 0) {
        return {
          ok: false as const,
          error: `slicing blocked by non-watertight object(s): ${blocked.join(", ")}`,
          blockedBy: blocked,
        };
      }
      return {
        ok: true as const,
        revision: currentRevision,
        stats: computeSliceStats(onPlate, { layerHeightMm: req.layerHeightMm }),
        blockedBy: [],
      } satisfies SliceResult;
    },
    // --- S9.5-003 printer discovery lane (G43) ----------------------------
    // Discovered from `ANYCUBIC_PRINTER_IPS` (env) — the parse/validate/label
    // logic lives in the pure printers-core so it is testable headless, and a
    // real LAN probe (reachability fetch with timeout) happens in the React
    // layer, which owns import.meta.env + fetch. This lane is the source of
    // the list; `rawEnv` is the env value as supplied by the caller — never a
    // hardcoded device identifier.
    async discoverPrinters(rawEnv) {
      const { ips } = parsePrinterIps(rawEnv ?? "");
      const printers: PrinterInfo[] = ips.map((ip) => ({
        id: printerId(ip),
        name: printerName(ip),
        ip,
        machineType: null,
        reachable: null,
        lastSeenAt: null,
      }));
      return { ok: true as const, source: "env", printers } satisfies PrinterListResult;
    },
    // --- S9.5-004 send-to-print lane (G25) --------------------------------
    // Deterministic mock of the cloud/LAN print submission. Consumed ONLY
    // after the approval card is confirmed (the UI never calls it without).
    // The lane is headless-testable: reachability/region are module-level
    // seeds (setMockOfflinePrinters / setMockRegionBlocked) so unit tests
    // cover the error paths without any network. On success it mints a
    // deterministic mock task id from the current revision.
    async sendJob(req) {
      const offline = mockOfflinePrinterIds.has(req.printerId);
      const region = mockRegionBlocked;
      if (offline || region) {
        return {
          ok: false as const,
          error: offline
            ? `printer ${req.ip} is offline`
            : "print blocked: cloud region not available",
          kind: offline ? "offline" : "region",
        } satisfies SendResult;
      }
      return {
        ok: true as const,
        taskId: `mock-task-${currentRevision}`,
      } satisfies SendResult;
    },
    // --- S9.7-001 boolean lane (G26) --------------------------------------
    // Mirrors the preserved server tool `cad_v2_boolean` over the
    // authoritative snapshot: A select → op → B select → NEW result object.
    // The result mesh is a deterministic FIXTURE (never real geometry —
    // AGENTS.md §6: fixtures only in mocked lanes), the mesh stats follow the
    // union heuristic, the provenance note (`+bool <op> A∩B`) rides on the
    // snapshot, and the op advances the revision + emits journal events
    // (so the S9.6 seek can step the result's transform). `hide_sources`
    // routes the AC-2 kept-or-hidden choice.
    async boolean(req: BooleanRequest): Promise<BooleanResult | { ok: false; error: string }> {
      const a = sceneObjects.find((o) => o.name === req.name_a);
      const b = sceneObjects.find((o) => o.name === req.name_b);
      if (!a || !b) {
        return { ok: false as const, error: `unknown object "${!a ? req.name_a : req.name_b}"` };
      }
      if (a.name === b.name) {
        return { ok: false as const, error: "boolean needs two distinct source objects" };
      }
      if (!a.watertight || !b.watertight) {
        return { ok: false as const, error: "boolean requires watertight source objects" };
      }
      const op = req.op;
      const stats = booleanResultStats(a, b, op);
      const trimmedResult = (req.result_name ?? "").trim();
      const baseName = trimmedResult.length > 0 ? trimmedResult : `${a.name}-bool`;
      let resultName = baseName;
      let suffix = 2;
      while (sceneObjects.some((o) => o.name === resultName)) {
        resultName = `${baseName}-${suffix}`;
        suffix += 1;
      }
      const result: SceneObjectSnapshot = {
        name: resultName,
        vertices: stats.vertices,
        triangles: stats.triangles,
        bounds: stats.bounds,
        sizeMm: stats.sizeMm,
        volumeMm3: stats.volumeMm3,
        surfaceAreaMm2: stats.surfaceAreaMm2,
        watertight: stats.watertight,
        geometry: booleanResultGeometry(stats.sizeMm),
        visible: true,
        locked: false,
        plateId: a.plateId ?? b.plateId,
        transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        // S9.7-001: provenance note — `+bool <op> A∩B` (AC-2 keeps the
        // result's lineage visible in the tree/tooltip).
        printSettings: undefined,
        provenance: booleanProvenance(op, a.name, b.name),
      };
      sceneObjects = [...sceneObjects, result];
      if (req.hide_sources) {
        sceneObjects = sceneObjects.map((o) =>
          o.name === a.name || o.name === b.name ? { ...o, visible: false } : o,
        );
      }
      currentRevision += 1;
      // Journal events: the result object's identity transform is committed
      // WITHOUT a change (no +move), but the op itself is a committed scene
      // change — the revision advances and the (identity) transform of the
      // new object is adopted as the new base so the S9.6 seek treats the
      // result as part of the graph from this revision on. The provenance is
      // visible via the tree tooltip (non-destructive — the AC says "op
      // logged non-destructively"; the journal itself only records
      // transforms, the ADD lane handles the object).
      lastCommitted = new Map(sceneObjects.map((o) => [o.name, o.transform]));
      const selection: CommitSinkPayload["selection"] = {
        ...EMPTY_COMMIT_SELECTION,
        objectModeNames: sceneObjects.map((o) => o.name),
      };
      handle.onCommitEvent?.({ revision: currentRevision, selection });
      return {
        ok: true as const,
        object: resultName,
        revision: currentRevision,
        vertices: stats.vertices,
        triangles: stats.triangles,
        watertight: true,
        op,
        objectSnapshot: { ...result },
      } satisfies BooleanResult;
    },
    // --- S9.7-003/004 repair lane (G46) ----------------------------------
    // Executes the watertight closure over the authoritative snapshot. The
    // mesh is a deterministic FIXTURE (AGENTS.md §6) — vertices/triangles
    // follow the closure heuristic (edge-sharing triangles are welded into
    // one closed manifold; the vertex count reflects the weld, triangle
    // count stays, volume recomputed on the closed bounds). `replace` keeps
    // identity + placement in place and flips `watertight: true`; `copy`
    // spawns a NEW object (`-repair` deduped) and leaves the source intact.
    // Provenance (`+repair <mode>`) rides the snapshot either way. Advances
    // the revision + commits (S9.6 journal can step the repaired object).
    async repair(req: RepairRequest): Promise<RepairResult | { ok: false; error: string }> {
      const src = sceneObjects.find((o) => o.name === req.name);
      if (!src) {
        return { ok: false as const, error: `unknown object "${req.name}"` };
      }
      if (src.watertight) {
        return { ok: false as const, error: `object "${req.name}" is already watertight` };
      }
      const mode = req.mode === "copy" ? "copy" : "replace";
      const copyName =
        mode === "copy"
          ? copyNameFor(src.name, (n) => sceneObjects.some((o) => o.name === n))
          : src.name;
      const repaired: SceneObjectSnapshot = {
        ...src,
        name: copyName,
        vertices: Math.max(3, Math.round(src.vertices * 1.12)), // weld estimate
        triangles: Math.max(1, src.triangles),
        // The closure closes the manifold — re-flag watertight (AC: repaired
        // objects pass the slice preflight).
        watertight: true,
        geometry: src.geometry,
        provenance: repairResultNote(mode),
      };
      if (mode === "replace") {
        sceneObjects = sceneObjects.map((o) => (o.name === src.name ? repaired : o));
      } else {
        sceneObjects = [...sceneObjects, repaired];
      }
      currentRevision += 1;
      const resultSnap = sceneObjects.find((o) => o.name === copyName) ?? repaired;
      lastCommitted = new Map(sceneObjects.map((o) => [o.name, o.transform]));
      const selection: CommitSinkPayload["selection"] = {
        ...EMPTY_COMMIT_SELECTION,
        objectModeNames: sceneObjects.map((o) => o.name),
      };
      handle.onCommitEvent?.({ revision: currentRevision, selection });
      return {
        ok: true as const,
        object: copyName,
        revision: currentRevision,
        mode,
        objectSnapshot: { ...resultSnap },
      } satisfies RepairResult;
    },
    // --- S9.10-002 printer control lane (printer_command_send) ----------
    // Executes a VALIDATED envelope from the pure control core. The lane is
    // a TRANSPORT — grammar/window/confirm rules live in the core, so the
    // mock never re-implements them. Deterministic seams (module seeds below)
    // make refused/timeout paths testable headless, mirroring how the real
    // cloud MQTT reply correlation reports a timeout as neither success nor
    // failure (the honest semantics rule in printer-command-bus.md).
    async printerControl(req) {
      const { envelope } = req;
      // The UI core always builds confirm:true; a missing flag is a
      // programming error — refuse loudly (kind: "invalid").
      if (!envelope || envelope.confirm !== true) {
        return {
          ok: false as const,
          error: "control envelope missing confirm:true — refusing",
          kind: "invalid",
        };
      }
      const seam = mockControlResults.get(req.printerId);
      if (seam) {
        return { ok: false as const, error: seam.error, kind: seam.kind };
      }
      if (mockControlRefused) {
        return {
          ok: false as const,
          error: `printer ${req.printerId} refused ${envelope.command}`,
          kind: "refused",
        };
      }
      if (mockControlTimeout) {
        return {
          ok: false as const,
          error: `no reply from ${req.printerId} for ${envelope.command}`,
          kind: "timeout",
        };
      }
      // Accepted — the printer executed the command (mock applies nothing
      // but the snapshots are immutable anyway; the real lane re-fetches).
      return { ok: true as const, command: envelope.command };
    },
    // --- S9.12-001 file listing lane (G-local_list) ----------------------
    // Deterministic mock of the printer storage listing (cloud `local_files`
    // order 103 / `usb_files` order 101, LAN `listLocal`/`listUdisk`).
    // `kind` selects local vs USB storage; test seams force loadedAt age /
    // emptiness so the staleness + empty-state paths are headless-testable.
    async listFiles(kind) {
      if (mockFileListNeverLoaded.has(kind)) {
        return { ok: true, source: kind, files: [], loadedAt: null, stale: false };
      }
      const files = normaliseFileListing(mockFileListPayload(kind) ?? [], kind);
      const loadedAt = mockFileListLoadedAt.get(kind) ?? Date.now();
      return {
        ok: true,
        source: kind,
        files,
        loadedAt,
        // `stale` mirrors the snapshot honesty rule: the UI keeps a poll
        // window and flags a list that is expected-but-older.
        stale: mockFileListStale.get(kind) === true,
      };
    },
    // --- S9.12-001 send-file lane (G25 parity) ---------------------------
    // Same deterministic seams as sendJob: offline/region abort; success mints
    // a mock task id. The UI calls this ONLY after the approval card.
    async sendFile(req) {
      const offline = mockOfflinePrinterIds.has(req.printerId);
      const region = mockRegionBlocked;
      if (offline || region) {
        return {
          ok: false as const,
          error: offline
            ? `printer ${req.ip} is offline`
            : "print blocked: cloud region not available",
          kind: offline ? "offline" : "region",
        };
      }
      return {
        ok: true as const,
        taskId: `mock-task-${currentRevision}-${req.fileId}`,
        fileId: req.fileId,
      };
    },
    // --- S9.12-002 DevTools lanes -----------------------------------------
    // Read-only model (catalog + hidden command map, fixture mirrors) + the
    // raw command lane. The raw lane obeys the same seams as printerControl:
    // refused/timeout are deterministic; `invalid` covers unknown command /
    // failed validation. The UI gates this lane behind the typed confirm AND
    // the capability policy (raw.command: agentBlocked) — the lane itself
    // never trusts the caller.
    async devtoolsReadModel() {
      const { devtoolsReadModel } = await import("../state/devtools-core.ts");
      return devtoolsReadModel();
    },
    async rawCommand(req) {
      const { validateRawCommand } = await import("../state/devtools-core.ts");
      const reason = validateRawCommand(req.command, req.args);
      if (reason) {
        return { ok: false as const, error: reason, kind: "invalid" };
      }
      if (mockControlRefused) {
        return {
          ok: false as const,
          error: `printer refused raw ${req.command}`,
          kind: "refused",
        };
      }
      if (mockControlTimeout) {
        return {
          ok: false as const,
          error: `no reply for raw ${req.command}`,
          kind: "timeout",
        };
      }
      return { ok: true as const, command: req.command };
    },
  };
  return handle;
}

/**
 * S9.5-004 test seams — module-level seeds that make the send lane
 * deterministic headless. The React layer never sets these (reachability
 * comes from the LAN probe there); only unit tests do.
 */
let mockOfflinePrinterIds: ReadonlySet<string> = new Set();
let mockRegionBlocked = false;

/** Test seam: mark printer ids the mock treats as offline (S9.5-004). */
export function setMockOfflinePrinters(ids: readonly string[]): void {
  mockOfflinePrinterIds = new Set(ids);
}

/** Test seam: force every send to fail with a region error (S9.5-004). */
export function setMockRegionBlocked(blocked: boolean): void {
  mockRegionBlocked = blocked;
}

/**
 * S9.10-002 test seams — deterministic seeds for the printer control lane.
 * The React layer never sets these; unit tests do (same pattern as the
 * send-job seams above). `setMockControlResults` maps printer id → forced
 * failure result; the booleans force the refusal / timeout paths globally.
 */
let mockControlResults: ReadonlyMap<
  string,
  { readonly kind: "refused" | "timeout"; readonly error: string }
> = new Map();
let mockControlRefused = false;
let mockControlTimeout = false;

/** Test seam: force specific printers to fail control with a kind (S9.10-002). */
export function setMockControlResults(
  results: ReadonlyMap<string, { readonly kind: "refused" | "timeout"; readonly error: string }>,
): void {
  mockControlResults = results;
}

/** Test seam: force every control to refuse (S9.10-002). */
export function setMockControlRefused(refused: boolean): void {
  mockControlRefused = refused;
}

/** Test seam: force every control to time out (S9.10-002). */
export function setMockControlTimeout(timeout: boolean): void {
  mockControlTimeout = timeout;
}

/**
 * S9.12-001 test seams — deterministic file-list seeds. The React layer never
 * sets these; unit tests do. `setMockFileListNeverLoaded` forces the
 * never-loaded path (files: [], loadedAt: null); `setMockFileListStale`
 * forces the stale flag regardless of age; `setMockFileListLoadedAt` pins the
 * loadedAt epoch so staleness is deterministic.
 */
let mockFileListNeverLoaded: ReadonlySet<"local" | "usb"> = new Set();
let mockFileListStale: ReadonlyMap<"local" | "usb", boolean> = new Map();
let mockFileListLoadedAt: ReadonlyMap<"local" | "usb", number> = new Map();

/** Test seam: simulate a storage that has never been listed (S9.12-001). */
export function setMockFileListNeverLoaded(kinds: readonly ("local" | "usb")[]): void {
  mockFileListNeverLoaded = new Set(kinds);
}

/** Test seam: force the stale flag for a storage kind (S9.12-001). */
export function setMockFileListStale(kinds: readonly ("local" | "usb")[]): void {
  mockFileListStale = new Map(kinds.map((kind) => [kind, true]));
}

/** Test seam: pin the loadedAt epoch for a storage kind (S9.12-001). */
export function setMockFileListLoadedAt(kind: "local" | "usb", epochMs: number): void {
  mockFileListLoadedAt = new Map([...mockFileListLoadedAt, [kind, epochMs]]);
}

/** Payload shape the mock lane returns for a storage kind — same source
 * shapes as the discovery probes (array of entries for local, `files: []`
 * wrapper for usb) so the normaliser is exercised over BOTH spellings. */
function mockFileListPayload(kind: "local" | "usb"): unknown {
  return kind === "local"
    ? (mockFileEntries("local").map((entry) => ({
        id: entry.id,
        name: entry.name,
        size: entry.sizeBytes,
        modified: entry.modifiedAt,
      })) as object[])
    : {
        files: mockFileEntries("usb").map((entry) => ({
          fileId: entry.id,
          file_name: entry.name,
          file_size: entry.sizeBytes,
          uploadTime: entry.modifiedAt,
        })),
      };
}

const EMPTY_COMMIT_SELECTION: CommitSinkPayload["selection"] = {
  verts: [],
  faces: [],
  edges: [],
  objectModeNames: [],
};

/** Authoritative commit-event payload the real bridge pushes after commit RPC. */
export interface CommitSinkPayload {
  readonly revision: number;
  readonly selection: {
    readonly verts: readonly number[];
    readonly faces: readonly number[];
    readonly edges: readonly number[];
    readonly objectModeNames: readonly string[];
  };
}

/**
 * Contract surface the viewport modal flow drives (mirrors S7-002
 * SessionManager). The real bridge implements this over the IPC frame; the
 * mock simulates it in-process: begin/update are no-ops that return the
 * session's write token, commit validates expected==current and returns the
 * next revision + authoritative selection + the S9.3-004 journal events
 * emitted for this commit, cancel closes the session.
 */
export interface BridgeContract {
  begin(revision: number): Promise<{ ok: true; token: string }>;
  update(revision: number): Promise<{ ok: true }>;
  commit(expectedRevision: number): Promise<{
    ok: true;
    newRevision: number;
    selection: CommitSinkPayload["selection"];
    journalEvents: TransformJournalEvent[];
  }>;
  cancel(beginRevision: number): Promise<{ ok: true }>;
  /** S9.2-001: object CRUD mutations behind the frozen snapshot shape. */
  mutateObject(
    mutation: ObjectMutation,
  ): Promise<{ ok: true; objects: SceneObjectSnapshot[] } | { ok: false; error: string }>;
  /**
   * S9.4-004: auto-arrange lane. Deterministic shelf-packing layout over the
   * authoritative objects (port of `scripts/cad-arrange.mjs`); re-commits the
   * new transforms and returns placements + overflow warnings. Rejects when
   * the layout is empty.
   */
  arrange(opts?: {
    readonly plateW?: number;
    readonly plateD?: number;
    readonly gap?: number;
    readonly center?: boolean;
  }): Promise<ArrangeResult | { ok: false; error: string }>;
  /**
   * S9.5-002: slice lane. Computes G24 stats (layers, estimated time,
   * material grams, volume, per-object volume) from the authoritative
   * snapshot for the given plate; rejects with `blockedBy` when any object
   * on the plate is non-watertight. No revision advance — slicing is
   * read-only over the snapshot.
   */
  slice(req: SliceRequest): Promise<SliceResult | { ok: false; error: string }>;
  /**
   * S9.5-003 (G43): printer discovery lane. Parses `ANYCUBIC_PRINTER_IPS`
   * (env, comma-separated) into the printer list served to the picker. The
   * list is the source of targets for the confirm-before-send flow — no
   * hardcoded device identifiers, ever.
   */
  discoverPrinters(rawEnv?: string): Promise<PrinterListResult>;
  /**
   * S9.5-004 (G25): send-to-print lane. Called ONLY after the user approves
   * the confirmation card. Validates the target printer, simulates the
   * cloud/LAN hand-off and returns a deterministic mock task id; offline
   * targets and region blocks surface as semantic `offline`/`region` errors.
   */
  sendJob(req: SendRequest): Promise<SendResult>;
  /**
   * S9.7-001 (G26): boolean lane. A select → op (add/subtract/intersect) →
   * B select → NEW result object via the preserved `cad_v2_boolean`
   * semantics (fixture mesh behind the frozen shape; deterministic stats;
   * provenance note on the result). Hidden-or-kept sources via
   * `hide_sources`; the result joins the authoritative snapshot at the new
   * revision (journal-repairable via the S9.6 seek — transforms only).
   */
  boolean(req: BooleanRequest): Promise<BooleanResult | { ok: false; error: string }>;
  /**
   * S9.7-003/004 (G46): repair lane. "Auto-repair" runs the watertight
   * closure over a non-watertight object (deterministic fixture mesh behind
   * the frozen shape) and either replaces the mesh in place (identity +
   * placement kept, re-flagged watertight) or replaces-as-copy (new
   * `-repair` object, source untouched). Provenance `+repair <mode>` rides
   * the snapshot. The slice preflight (9.5) is the only gate — a repaired
   * object passes it.
   */
  repair(req: RepairRequest): Promise<RepairResult | { ok: false; error: string }>;
  /**
   * S9.10-002 (printer_command_send): printer control lane. Executes the
   * VALIDATED envelope from the pure control core — the lane is transport,
   * never grammar authority. Non-read commands always carry
   * `confirm: true`; motion/job additionally need the `EXECUTE` word (the
   * core emits it only for those classes). Result kinds are semantic
   * (accepted / refused / timeout / invalid) so the UI toasts distinctly.
   */
  printerControl(req: PrinterControlRequest): Promise<PrinterControlResult>;
  /**
   * S9.12-001: printer file listing lane (G-local_list). Lists the printer's
   * local or USB storage (cloud `local_files` 103 / `usb_files` 101, LAN
   * `listLocal`/`listUdisk`) normalised to the shared `PrinterFileEntry`
   * shape. Deterministic mock: fixture file names, no real device ids.
   */
  listFiles(kind: "local" | "usb"): Promise<PrinterFileListResult>;
  /**
   * S9.12-001: send-file lane (G25 parity). Called ONLY after the approval
   * card; same semantic union as `sendJob` — offline/region abort, success
   * mints a deterministic mock task id.
   */
  sendFile(req: SendFileRequest): Promise<SendFileResult>;
  /**
   * S9.12-002: DevTools read-only model (property catalog + hidden command
   * map, deterministic fixtures). Rendered as searchable tables by the
   * DevTools pane.
   */
  devtoolsReadModel(): Promise<DevtoolsReadModel>;
  /**
   * S9.12-002: raw command send lane. The UI gates it behind the typed
   * confirm AND the capability policy (`raw.command` — Agent blocked); the
   * lane validates the payload and returns semantic kinds (invalid/refused/
   * timeout).
   */
  rawCommand(req: RawCommandRequest): Promise<RawCommandResult>;
}

/** Live bridge handle: the fetched profile+scene snapshot PLUS the commit sink
 * and the modal contract. The viewport subscribes to commit events here
 * (AC-1) and drives gizmo/numeric flows (AC-2) against the same handle.
 * S9.3-004 adds the committed transform journal for soft undo/redo replay.
 */
export type BridgeHandle = (BridgeProfile & Awaited<ReturnType<typeof snapshot>>) &
  BridgeContract & {
    onCommitEvent?: (payload: CommitSinkPayload) => void;
    journal: readonly TransformJournalEvent[];
  };

/**
 * S9.6-005 (Mandate C): offline `ChatTransport` dev default — a canned,
 * deterministic assistant reply stream. The AI SDK `ai` package is imported
 * lazily (dynamic) so Node 24 can still run the plain `.mjs` tests (which
 * import this module) WITHOUT resolving the browser-only `ReadableStream`
 * TS types; the `type` import is erased at runtime.
 *
 * The real broker lane (S9.6-008) swaps this transport for a
 * `DefaultChatTransport` pinned to `ANYCUBIC_BROKER_URL` — the store is the
 * source of truth either way (conversations live in `state/chat-conversations`).
 */
export function createMockChatTransport(): ChatTransportLike {
  return {
    async sendMessages() {
      const { createUIMessageStream } = await import("ai");
      const messageId = "mock-assistant-1";
      const reply =
        "Mock reply for offline dev (S9.6-005). Context sources and token budget " +
        "are carried per conversation by the store — no live model is contacted.";
      return createUIMessageStream({
        generateId: () => messageId,
        execute: ({ writer }) => {
          writer.write({ type: "start", messageId });
          writer.write({ type: "text-start", id: "text-1" });
          writer.write({ type: "text-delta", id: "text-1", delta: reply });
          writer.write({ type: "text-end", id: "text-1" });
          writer.write({ type: "finish", finishReason: "stop" });
        },
      });
    },
    async reconnectToStream() {
      return null; // offline mock — no active stream to resume
    },
  };
}

/** Structural transport shape (the `ai` `ChatTransport` satisfies it). */
export interface ChatTransportLike {
  sendMessages(options: {
    readonly trigger: "submit-message" | "regenerate-message";
    readonly chatId: string;
    readonly messageId: string | undefined;
    readonly messages: readonly unknown[];
    readonly abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<unknown>>;
  reconnectToStream(options: {
    readonly chatId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<ReadableStream<unknown> | null>;
}
