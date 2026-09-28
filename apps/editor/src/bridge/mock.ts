import type { BuildVolume, ObjectMeshInfo } from "./types";
import { StaleCommitError } from "../state/viewport-core";

export { StaleCommitError };

/**
 * Mock bridge provider (R0). Serves a read-only scene snapshot sourced from a
 * SMALL in-file model plus a profile-driven build volume, exactly like the
 * S6-005 loopback bridge will once R1 gives us geometry authority.
 *
 * The response shape is identical to the bridge's `GET /objects` + `GET /project`
 * so the TanStack Query wiring is a provider swap later — never a type change.
 */

const SAMPLE_OBJECTS: readonly ObjectMeshInfo[] = [
  {
    name: "print-bed-block",
    vertices: 36,
    triangles: 12,
    bounds: { min: [-10, -10, 0], max: [10, 10, 20] },
    sizeMm: [20, 20, 20],
    volumeMm3: 8000,
    surfaceAreaMm2: 2400,
    watertight: false,
  },
];

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
  objects: ObjectMeshInfo[];
}> {
  return new Promise((resolve) => {
    setTimeout(
      () =>
        resolve({
          ok: true,
          revision: 7,
          groups: ["default"],
          objects: SAMPLE_OBJECTS.map((o) => ({ ...o, bounds: { ...o.bounds } })),
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
        objectModeNames: SAMPLE_OBJECTS.map((o) => o.name),
      };
      const payload: CommitSinkPayload = { revision: currentRevision, selection };
      handle.onCommitEvent?.(payload);
      return { ok: true, newRevision: currentRevision, selection };
    },
    async cancel(beginRevision) {
      void beginRevision;
      return { ok: true };
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
}

/** Live bridge handle: the fetched profile+scene snapshot PLUS the commit sink
 * and the modal contract. The viewport subscribes to commit events here
 * (AC-1) and drives gizmo/numeric flows (AC-2) against the same handle.
 */
export type BridgeHandle = (BridgeProfile & Awaited<ReturnType<typeof snapshot>>) &
  BridgeContract & {
    onCommitEvent?: (payload: CommitSinkPayload) => void;
  };
