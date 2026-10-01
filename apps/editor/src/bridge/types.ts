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

/**
 * Real triangle buffers behind a scene object (S9.2-001). The snapshot's
 * geometry-agnostic fields stay frozen; geometry is added behind them, so a
 * future real-bridge swap is a provider change, never a type change.
 */
export interface ObjectGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Full scene object: the frozen mesh-info mirror PLUS the geometry lane and
 * graph flags (S9.2-002 will lift these into the scene store).
 */
export interface SceneObjectSnapshot extends ObjectMeshInfo {
  readonly geometry?: ObjectGeometry;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly parentId?: string | null;
  /**
   * Object placement in scene space (S9.3). Position (x/y/z) existed from
   * S9.2; rotation (rx/ry/rz euler degrees) and scale (sx/sy/sz) are added
   * behind the same shape so the S9.3 gizmo/inspector drive them. Absent
   * rotation = identity, absent scale = unit.
   */
  readonly transform?: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly rx?: number;
    readonly ry?: number;
    readonly rz?: number;
    readonly sx?: number;
    readonly sy?: number;
    readonly sz?: number;
  };
}

/** Scene snapshot as served by the read-only bridge (S6-005). */
export interface SceneSnapshot {
  readonly ok: boolean;
  readonly revision: number;
  readonly groups: readonly string[];
  readonly objects: readonly ObjectMeshInfo[];
}

/**
 * CRUD mutation lane for the scene graph (S9.2-001). Mirrors the S7-002 modal
 * contract where destructive ops route through begin→update→commit; the
 * returned `objects` are the authoritative post-commit list.
 */
export type ObjectMutation =
  | { readonly kind: "add"; readonly object: SceneObjectSnapshot }
  | { readonly kind: "remove"; readonly name: string }
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  | { readonly kind: "duplicate"; readonly name: string }
  | { readonly kind: "toggleVisible"; readonly name: string }
  | { readonly kind: "toggleLock"; readonly name: string }
  | {
      readonly kind: "setTransform";
      readonly name: string;
      readonly transform: {
        x: number;
        y: number;
        z: number;
        rx?: number;
        ry?: number;
        rz?: number;
        sx?: number;
        sy?: number;
        sz?: number;
      };
    }
  | { readonly kind: "commitObject"; readonly name: string };

/** Build plate footprint (mm) driven by the machine profile, never hardcoded. */
export interface BuildVolume {
  readonly widthMm: number;
  readonly depthMm: number;
  readonly heightMm: number;
}

/**
 * S9.3-004 transform journal event (S7-005 soft). Emitted by the bridge lane
 * on commit for every object whose transform changed during the gesture —
 * one event per altered axis-kind (`+move` for x/y/z, `+rotate` for
 * rx/ry/rz, `+scale` for sx/sy/sz). `from`/`to` carry only the fields of
 * that kind so Ctrl+Z/Y "soft re-import" can replay the authoritative
 * snapshot without geometry knowledge.
 */
export interface TransformJournalEvent {
  readonly kind: "+move" | "+rotate" | "+scale";
  readonly name: string;
  /** Revision the event belongs to (the commit's new revision). */
  readonly revision: number;
  readonly from: Readonly<Record<string, number>>;
  readonly to: Readonly<Record<string, number>>;
}
