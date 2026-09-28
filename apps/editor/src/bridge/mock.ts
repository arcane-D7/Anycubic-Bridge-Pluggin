import type { BuildVolume, ObjectMeshInfo } from "./types";

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

export async function fetchSceneSnapshot(): Promise<
  BridgeProfile & Awaited<ReturnType<typeof snapshot>>
> {
  const [scene, p] = await Promise.all([snapshot(), profile()]);
  return { ...p, ...scene };
}

export type BridgeHandle = Awaited<ReturnType<typeof fetchSceneSnapshot>>;
