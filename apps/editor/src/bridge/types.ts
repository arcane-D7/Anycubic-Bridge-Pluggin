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
  /** Plate membership (S9.4-003). Absent = default plate. */
  readonly plateId?: string;
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
  | { readonly kind: "setPlate"; readonly name: string; readonly plateId: string }
  | { readonly kind: "commitObject"; readonly name: string };

/** Build plate footprint (mm) driven by the machine profile, never hardcoded. */
export interface BuildVolume {
  readonly widthMm: number;
  readonly depthMm: number;
  readonly heightMm: number;
}

/**
 * S9.5 slice result (G24). The bridge slice lane computes these from the
 * authoritative snapshot: layers come from the object stack height over the
 * layer height; volume/material/estimated time are derived by the lane's
 * estimator (PLA density, flow/velocity assumptions) — mirroring what the
 * real slicer pipeline would return. `perObjectMm3` is the per-object share.
 */
export interface SliceStats {
  readonly layers: number;
  readonly estimatedMinutes: number;
  readonly materialGrams: number;
  readonly volumeMm3: number;
  readonly perObjectMm3: Readonly<Record<string, number>>;
}

/**
 * Slice lane request/result (S9.5-005 contract). `objects` anchor which
 * objects were sliced (the active plate's); the lane re-reads the snapshot for
 * authoritative stats.
 */
export interface SliceRequest {
  readonly plateId: string;
  readonly layerHeightMm?: number;
  readonly infillPercent?: number;
}

/** Result of a bridge slice lane call (S9.5-002). */
export interface SliceResult {
  readonly ok: true;
  readonly revision: number;
  readonly stats: SliceStats;
  readonly blockedBy: readonly string[];
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

/** Single object placement produced by the arrange lane (mirrors the server's
 * `placed` array from `scripts/cad-arrange.mjs`). */
export interface ArrangePlacement {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Result of the bridge auto-arrange lane (S9.4-004). */
export interface ArrangeResult {
  readonly ok: true;
  /** Revision after the arrange re-commit. */
  readonly revision: number;
  readonly objects: readonly SceneObjectSnapshot[];
  readonly placed: readonly ArrangePlacement[];
  readonly warnings: readonly string[];
}

/**
 * S9.5-003 printer descriptor (G43). A discovered Anycubic printer target.
 * `reachable` is tri-state: `true` when the LAN probe succeeded, `false` when
 * it timed out/refused, `null` when status is unknown (or probing in flight).
 * Identifiers come ONLY from `ANYCUBIC_PRINTER_IPS` (env) — never hardcoded.
 */
export interface PrinterInfo {
  readonly id: string;
  readonly name: string;
  readonly ip: string;
  readonly machineType: string | null;
  readonly reachable: boolean | null;
  readonly lastSeenAt: number | null;
}

/**
 * Result of the bridge printer discovery lane (S9.5-003). `source` mirrors
 * how the list was built (env list for now; subnet scan later) so the picker
 * can explain an empty list.
 */
export interface PrinterListResult {
  readonly ok: true;
  readonly source: "env";
  readonly printers: readonly PrinterInfo[];
}

/**
 * S9.5-004 send-to-print job (G25). The confirmation dialog shows this
 * summary BEFORE any control order goes out — the send lane is only ever
 * called after the user approves the card. `printerId` identifies the armed
 * target from the picker (never a raw IP in the contract surface).
 */
export interface SendRequest {
  readonly printerId: string;
  /** Printer IP (read-only display/transport hint — the lane validates it). */
  readonly ip: string;
  /** The slice result being sent. */
  readonly stats: SliceStats;
  /** Human summary shown in the confirmation dialog. */
  readonly summary: string;
}

/**
 * Result of the send-to-print lane (S9.5-004). `ok: false` carries a
 * semantic error code so the UI can surface offline/region/unknown reasons
 * as distinct toasts instead of a generic failure.
 */
export type SendResult =
  | { readonly ok: true; readonly taskId: string }
  | { readonly ok: false; readonly error: string; readonly kind: "offline" | "region" | "unknown" };
