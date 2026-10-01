import type {
  ArrangeResult,
  BuildVolume,
  ObjectGeometry,
  ObjectMutation,
  PrinterInfo,
  PrinterListResult,
  SceneObjectSnapshot,
  SliceRequest,
  SliceResult,
  SliceStats,
  TransformJournalEvent,
} from "./types.ts";
import { StaleCommitError } from "../state/viewport-core.ts";
import { arrangeTransforms } from "../state/arrange-core.ts";
import { DEFAULT_PLATE_ID } from "../state/plates-core.ts";
import { parsePrinterIps, printerId, printerName } from "../state/printers-core.ts";

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

const CONE = makeInfo("cone", coneGeometry(), true, [14, 0, 14]);
const CUBE = makeInfo("cube", cubeGeometry(), true, [-16, 0, -10]);
const SPHERE = makeInfo("sphere-non-watertight", sphereGeometry(), false, [8, 0, -18]);

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
 */
export function computeSliceStats(
  objects: readonly SceneObjectSnapshot[],
  opts?: { readonly layerHeightMm?: number },
): SliceStats {
  const layerHeight = opts?.layerHeightMm ?? DEFAULT_LAYER_HEIGHT_MM;
  const perObjectMm3: Record<string, number> = {};
  let volumeMm3 = 0;
  let maxZ = 0;
  for (const o of objects) {
    const v = o.volumeMm3 > 0 ? o.volumeMm3 : estimateVolume(o);
    perObjectMm3[o.name] = v;
    volumeMm3 += v;
    const h = o.sizeMm[2] ?? 0;
    if (h > maxZ) maxZ = h;
  }
  const layers = Math.max(1, Math.ceil(maxZ / layerHeight));
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
  };
  return handle;
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
