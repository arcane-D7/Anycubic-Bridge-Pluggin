import type { BuildVolume, ObjectGeometry, ObjectMutation, SceneObjectSnapshot } from "./types.ts";
import { StaleCommitError } from "../state/viewport-core.ts";

export { StaleCommitError };

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

export async function fetchSceneSnapshot(): Promise<BridgeHandle> {
  const [scene, p] = await Promise.all([snapshot(), profile()]);
  const base: BridgeProfile & Awaited<ReturnType<typeof snapshot>> = { ...p, ...scene };
  // In-process modal contract simulation. The real bridge implements the same
  // surface over the IPC frame (S7-002 SessionManager). revisions advance only
  // on commit; update() is provisional and does not advance.
  let currentRevision = scene.revision;
  const handle: BridgeHandle = {
    ...base,
    async begin(revision) {
      void revision;
      return { ok: true, token: `tok-${currentRevision}` };
    },
    async update(revision) {
      void revision;
      return { ok: true };
    },
    async commit(expectedRevision) {
      if (expectedRevision !== currentRevision) {
        throw new StaleCommitError(expectedRevision, currentRevision);
      }
      currentRevision += 1;
      const selection: CommitSinkPayload["selection"] = {
        ...EMPTY_COMMIT_SELECTION,
        objectModeNames: sceneObjects.map((o) => o.name),
      };
      const payload: CommitSinkPayload = { revision: currentRevision, selection };
      handle.onCommitEvent?.(payload);
      return { ok: true, newRevision: currentRevision, selection };
    },
    async cancel(beginRevision) {
      void beginRevision;
      return { ok: true };
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
 * next revision + authoritative selection, cancel closes the session.
 */
export interface BridgeContract {
  begin(revision: number): Promise<{ ok: true; token: string }>;
  update(revision: number): Promise<{ ok: true }>;
  commit(
    expectedRevision: number,
  ): Promise<{ ok: true; newRevision: number; selection: CommitSinkPayload["selection"] }>;
  cancel(beginRevision: number): Promise<{ ok: true }>;
  /** S9.2-001: object CRUD mutations behind the frozen snapshot shape. */
  mutateObject(
    mutation: ObjectMutation,
  ): Promise<{ ok: true; objects: SceneObjectSnapshot[] } | { ok: false; error: string }>;
}

/** Live bridge handle: the fetched profile+scene snapshot PLUS the commit sink
 * and the modal contract. The viewport subscribes to commit events here
 * (AC-1) and drives gizmo/numeric flows (AC-2) against the same handle.
 */
export type BridgeHandle = (BridgeProfile & Awaited<ReturnType<typeof snapshot>>) &
  BridgeContract & {
    onCommitEvent?: (payload: CommitSinkPayload) => void;
  };
