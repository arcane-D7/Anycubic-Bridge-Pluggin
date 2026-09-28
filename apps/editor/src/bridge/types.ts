/**
 * R0 shell contract — what the editor needs from the backend at boot.
 *
 * The bridge surface is intentionally mocked in S6-001 (there is no geometry
 * authority yet — that is R1). The types below mirror the S6-005 read-only
 * loopback bridge responses so swapping the mock for the real client later is
 * purely a provider swap, never a type change.
 */

/** Mesh info for a single object (mirrors the preserved server's meshInfo). */
export interface ObjectMeshInfo {
  readonly name: string;
  /** Per-triangle vertex count (preserved importer repacks per triangle). */
  readonly vertices: number;
  readonly triangles: number;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly sizeMm: readonly [number, number, number];
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
  readonly watertight: boolean;
}

/** Scene snapshot as served by the read-only bridge (S6-005). */
export interface SceneSnapshot {
  readonly ok: boolean;
  readonly revision: number;
  readonly groups: readonly string[];
  readonly objects: readonly ObjectMeshInfo[];
}

/** Build plate footprint (mm) driven by the machine profile, never hardcoded. */
export interface BuildVolume {
  readonly widthMm: number;
  readonly depthMm: number;
  readonly heightMm: number;
}
