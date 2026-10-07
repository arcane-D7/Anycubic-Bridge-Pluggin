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
  /**
   * Per-object print settings fork (S9.6-002). Absent = "using global".
   * Present = overridden values for THIS object only; slice merges them over
   * the global settings. Kept as a Partial so a fork can override a subset
   * and inherit the rest from the global draft.
   */
  readonly printSettings?: Partial<ObjectPrintSettings>;
  /** Per-object filament assignment (S9.6-002). Absent = global filament. */
  readonly filamentId?: string;
  /**
   * Non-destructive lineage note (S9.7-001). The boolean lane stamps the
   * result object with `+bool <op> A∩B` so the object tree/tooltip can show
   * where it came from (AC-2 provenance). Journal-repairable: the op itself
   * is never destructive — sources stay until the user hides/deletes them.
   */
  readonly provenance?: string;
}

/**
 * The overridable per-object print settings surface (S9.6-002). Mirrors the
 * global draft fields the slicer consumes; a fork may override any subset.
 */
export interface ObjectPrintSettings {
  readonly layerHeightMm: number;
  readonly lineWidthMm: number;
  readonly nozzleDiameterMm: number;
  readonly wallLoops: number;
  readonly topBottomLayers: number;
  readonly infillDensityPct: number;
  readonly infillPattern: string;
  readonly nozzleTempC: number;
  readonly bedTempC: number;
  readonly fanPct: number;
  readonly printSpeedMmS: number;
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
  | { readonly kind: "commitObject"; readonly name: string }
  | {
      readonly kind: "setObjectSettings";
      readonly name: string;
      /** Per-object fork; `undefined` clears it (reset-to-parent → global). */
      readonly settings?: Partial<ObjectPrintSettings>;
      readonly filamentId?: string;
    };

/** Build plate footprint (mm) driven by the machine profile, never hardcoded. */
export interface BuildVolume {
  readonly widthMm: number;
  readonly depthMm: number;
  readonly heightMm: number;
}

/* ============================================================================
 * S9.9-001 — Printer live snapshot (agnostic, versioned).
 *
 * Mirrors EVERYTHING the MCP server exposes for a printer (553 property
 * paths — `docs/printer-property-map.md`), normalized to a single schema
 * that the editor UI AND the future Agent draw from. Rules:
 *  - `schemaVersion: 1` — the schema is versioned; bumps are explicit.
 *  - Every telemetry field is NULLABLE. A bare Kobra 3 differs from a
 *    Kobra S1 + 2×ACE; absent = "hardware does not expose it", never 0/NaN.
 *  - Units SI (°C, %, seconds, mm). Enums are NAMED (`PrinterState`,
 *    `SpeedMode`, `EditOrigin`), never raw numbers (`0`, `-1`, `20025`).
 *  - `capabilities` stays a raw `Record<string, boolean>` — visibility is
 *    driven by it, never by interpreting `modelName`.
 *  - `raw` mirrors every unmapped path for DevTools/Agent diagnostics.
 * ========================================================================== */

export type PrinterState = "unknown" | "idle" | "printing" | "paused" | "error" | "offline";

/** Named speed modes (Anycubic bus: silent=1, standard=2, sport=3). */
export type SpeedMode = "silent" | "standard" | "sport";

/** How a filament slot's material info was set: RFID tag or manual edit. */
export type EditOrigin = "rfid" | "manual";

/** Filament load state per ACE slot (FILAMENT_STATES subset). */
export type FilamentState = "empty" | "unknown" | "identified" | "identifying";

export interface AceSlot {
  readonly index: number;
  readonly state: FilamentState;
  /** Material short name from RFID/slot info (e.g. "PLA"). */
  readonly material: string | null;
  readonly sku: string | null;
  /** Filament color (#hex) from `color_group`/color payload. */
  readonly color: string | null;
  /** Remaining filament, 0–100. `-1` sentinel → null. */
  readonly remainingPct: number | null;
  readonly editOrigin: EditOrigin;
  /**
   * Raw slot state code (feed/slot states). 129–135 are errors → alert
   * (S9.9-006); null when the bus didn't report a number.
   */
  readonly stateCode: number | null;
  /** Manufacturer's recommended nozzle/bed range, when known (°C). */
  readonly recommendedTempsC: {
    readonly nozzle: { readonly min: number; readonly max: number } | null;
    readonly bed: { readonly min: number; readonly max: number } | null;
  };
}

export interface AceBox {
  readonly index: number;
  readonly modelId: number | null;
  readonly slots: readonly AceSlot[];
  readonly ambientTempC: number | null;
  readonly humidityPct: number | null;
  readonly drying: {
    readonly active: boolean;
    readonly targetTempC: number | null;
    readonly remainingSeconds: number | null;
  };
  readonly autoFeed: boolean;
  /** Index of the slot currently loaded into the toolhead, if any. */
  readonly loadedSlotIndex: number | null;
}

/** A single live temperature probe (nozzle/bed/chamber). */
export interface TempProbe {
  readonly currentC: number | null;
  readonly targetC: number | null;
}

export interface PrintProgress {
  readonly state: PrinterState;
  readonly filename: string | null;
  readonly currLayer: number | null;
  readonly totalLayers: number | null;
  readonly progressPct: number | null;
  readonly remainingSeconds: number | null;
  readonly speedMode: SpeedMode | null;
}

/** Perceived printer (all fields nullable per the agnostic rule). */
export interface PrinterSnapshot {
  readonly schemaVersion: 1;
  readonly printerId: string;
  readonly capturedAt: number | null;
  /** Identifier fields stay raw — visibility is `capabilities`-driven. */
  readonly identity: {
    readonly machineType: string | null;
    readonly firmwareVersion: string | null;
    readonly serial: string | null;
    readonly nozzleDiameterMm: number | null;
    readonly buildVolume: BuildVolume | null;
  };
  readonly temps: {
    readonly nozzle: TempProbe;
    readonly bed: TempProbe;
    readonly chamber: TempProbe;
  };
  readonly fans: {
    readonly partCoolingPct: number | null;
    readonly hotendPct: number | null;
  };
  readonly print: PrintProgress;
  readonly ace: {
    readonly boxes: readonly AceBox[];
    readonly totalSlots: number;
  };
  readonly motion: {
    readonly xMm: number | null;
    readonly yMm: number | null;
    readonly zMm: number | null;
  } | null;
  readonly ai: {
    readonly enabled: boolean;
    readonly sensitivity: number | null;
  } | null;
  readonly lights: {
    readonly enabled: boolean;
    readonly brightnessPct: number | null;
  } | null;
  readonly peripherals: {
    readonly hasCamera: boolean;
    readonly hasMultiColorBox: boolean;
    readonly hasUsbDrive: boolean;
  };
  readonly storage: {
    readonly kind: "local" | "usb" | "unknown";
    readonly usedBytes: number | null;
    readonly totalBytes: number | null;
    readonly freeBytes: number | null;
  };
  readonly capabilities: Readonly<Record<string, boolean>>;
  /** Every path the mapper did NOT understand — diagnostics/Agent. */
  readonly raw: Readonly<Record<string, unknown>>;
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
 * `placed` array from `scripts/cad-arrange.mjs`). Grid coords on the plate
 * plane: x = width axis, z = depth axis (Y is up, so it stays 0). */
export interface ArrangePlacement {
  readonly name: string;
  readonly x: number;
  readonly z: number;
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
 * can explain an empty list. S9.13-002: the CLOUD lane returns
 * `source: "cloud"` for account printers discovered via the loopback bridge.
 */
export interface PrinterListResult {
  readonly ok: true;
  readonly source: "env" | "cloud";
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

/**
 * S9.7-001 boolean lane request (G26). Mirrors the preserved server tool
 * `cad_v2_boolean` (`scripts/cad-bool-tool.mjs`): the UI picks object A →
 * op (add/subtract/intersect) → object B → the bridge lane executes the CSG
 * op over the authoritative snapshot and returns the NEW result object.
 * `result_name` lets the caller pre-prefix (the lane dedupes to a free
 * name); `hide_sources` routes the AC-2 "hidden-or-kept" choice.
 */
export interface BooleanRequest {
  readonly name_a: string;
  readonly name_b: string;
  readonly op: "add" | "subtract" | "intersect";
  /** Optional desired result name (deduped when already taken). */
  readonly result_name?: string;
  /** When true the source objects are hidden post-commit (AC-2 kept-or-hidden). */
  readonly hide_sources?: boolean;
}

/**
 * S9.7-001 boolean lane result. Mirrors the server's structured content:
 * `object` = the NEW result object name, `revision` = the commit revision,
 * mesh stats + `watertight: true` (CSG over closed meshes stays closed),
 * plus `op` normalized and the resulting snapshot for the UI.
 */
export interface BooleanResult {
  readonly ok: true;
  readonly object: string;
  readonly revision: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly watertight: true;
  readonly op: "add" | "subtract" | "intersect";
  /** The new result snapshot (authoritative post-commit). */
  readonly objectSnapshot: SceneObjectSnapshot;
}

/**
 * S9.7-003/004 repair lane request (G46). The UI triggers "Auto-repair" on a
 * non-watertight object (existing `#b36a5e` tint + dashed edge becomes
 * actionable). `mode` selects the AC choice: "replace" (watertight closure
 * replaces the mesh in place, keeps identity + placement) or "copy"
 * (replace-as-copy — a NEW object is created, the source stays untouched).
 * `name` targets the object in the authoritative snapshot.
 */
export interface RepairRequest {
  readonly name: string;
  readonly mode: "replace" | "copy";
}

/**
 * S9.7-003/004 repair lane result. The repaired object is re-flagged
 * `watertight: true` and its mesh stats reflect the closure (deterministic
 * fixture for now — the manifold-3d backend swap keeps the same contract).
 * `object` is the object that was repaired (replace: same name; copy: the
 * new `-repair` name). `revision` is the commit revision after the lane.
 */
export interface RepairResult {
  readonly ok: true;
  readonly object: string;
  readonly revision: number;
  readonly mode: "replace" | "copy";
  /** The repaired (or copied) snapshot (authoritative post-commit). */
  readonly objectSnapshot: SceneObjectSnapshot;
}

/**
 * S9.10-002 — printer control lane request. Carries the validated
 * `printer_command_send` ENVELOPE built by the pure control core
 * (`state/printer-control-core.ts`) — the bridge lane is a transport, never
 * the authority on grammar. `printerId` identifies the target from the
 * picker (never a raw IP in the contract surface).
 */
export interface PrinterControlRequest {
  readonly printerId: string;
  readonly envelope: Readonly<{
    readonly command: string;
    readonly args: Readonly<Record<string, string | number | boolean | readonly number[] | null>>;
    readonly confirm: true;
    readonly confirmWord?: string;
  }>;
}

/**
 * S9.10-002 — control lane result. `ok: true` means the bus accepted the
 * command. Failure carries a SEMANTIC kind so the UI can show distinct
 * toasts: `invalid` (the envelope failed local validation — a programming
 * error, never expected from the gated UI), `refused` (the printer/bus
 * rejected the command), `timeout` (no reply before the deadline — neither
 * success nor failure, per the MQTT honesty rule).
 */
export type PrinterControlResult =
  | { readonly ok: true; readonly command: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly kind: "invalid" | "refused" | "timeout";
    };

/**
 * S9.12-001 — a single file entry from the printer's storage (local/USB).
 * `name` is the display name (basename — the device reports a path),
 * `sizeBytes`/`modifiedAt` come from the device and are nullable; only the
 * name is required (an empty file list is legitimate). `path` is the
 * device-side path used as a stable key — never a host path. No account
 * identifiers ever appear here (AGENTS.md §6 — real ids only in fixtures).
 */
export interface PrinterFileEntry {
  readonly kind: "local" | "usb";
  /** Stable device-side key (the raw path the device reports). */
  readonly id: string;
  /** Display name (basename, no directory). */
  readonly name: string;
  /** Size in bytes, when the device reports it. */
  readonly sizeBytes: number | null;
  /** Last-modified epoch ms, when the device reports it. */
  readonly modifiedAt: number | null;
  /** Thumbnail colors/palette hint — the device has no image URLs; the UI
   * renders a deterministic swatch from this (or a neutral one). */
  readonly thumbHint: string | null;
}

/**
 * S9.12-001 — file listing result from a printer storage lane. `source`
 * names the storage backing (local vs usb); `stale` is set when a refresh
 * is expected but the latest listing is older than the printer's poll
 * window (same honesty rule as `PrinterSnapshot` staleness — never claim a
 * fresh list that is not).
 */
export interface PrinterFileListResult {
  readonly ok: boolean;
  readonly source: "local" | "usb";
  readonly files: readonly PrinterFileEntry[];
  /** Epoch ms of the LAST successful listing (null = never listed). */
  readonly loadedAt: number | null;
  /** True when the list is expected to refresh but has not. */
  readonly stale: boolean;
}

/**
 * S9.12-001 — send/print of a file from the Files tab. Goes through the
 * SAME confirm-before-send flow as the sliced-job send (S9.5-004 approval
 * card) — `printerId` is the armed target, `fileId`/`name` the selected
 * entry. The lane re-validates the printer is reachable and mints a mock
 * task id on success (same seam as `sendJob`).
 */
export interface SendFileRequest {
  readonly printerId: string;
  /** Printer IP (display/transport hint — the lane validates it). */
  readonly ip: string;
  /** Device-side file key (`PrinterFileEntry.id`). */
  readonly fileId: string;
  /** Human display name (for summary + post-send toast). */
  readonly name: string;
  /** Storage backing the file came from. */
  readonly source: "local" | "usb";
  /** Storage preflight shown before send (bytes used/total). */
  readonly storage: Readonly<{
    readonly usedBytes: number | null;
    readonly totalBytes: number | null;
  }>;
}

/** Result of the file send lane (S9.12-001) — same semantic union as
 * `SendResult`: ok carries a mock task id; failure surfaces a semantic
 * kind for distinct toasts. */
export type SendFileResult =
  | { readonly ok: true; readonly taskId: string; readonly fileId: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly kind: "offline" | "region" | "unknown";
    };
