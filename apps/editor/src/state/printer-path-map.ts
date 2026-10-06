/**
 * S9.9-002 — printer path map: MCP property paths → PrinterSnapshot.
 *
 * The MCP server exposes ~553 property paths per printer
 * (`docs/printer-property-map.md`). This module is the single normalized
 * decode: a declarative, JSON-parseable map whose keys are the GROUP names
 * the snapshot schema uses, with per-field normalizers (°C, /100, sentinel
 * `-1 → null`, layer+1). Unmapped paths land in `raw` so DevTools/Agent can
 * still see everything — nothing is ever dropped silently.
 *
 * Rules:
 *  - PURE + headless (only `type` imports) — unit-testable under Node.
 *  - Model ids are opaque keys. Visibility is `capabilities`-driven, NEVER
 *    by interpreting `modelName`.
 *  - No real machine/account values in source — fixtures live in `tests/`.
 */

import type {
  AceBox,
  AceSlot,
  EditOrigin,
  FilamentState,
  PrinterSnapshot,
  SpeedMode,
} from "../bridge/types.ts";

/** Deep-mutable mirror of a readonly type (mapper-internal only). */
type DeepWritable<T> = {
  -readonly [K in keyof T]: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends readonly (infer U)[]
      ? U[]
      : T[K] extends object
        ? DeepWritable<T[K]>
        : T[K];
};
/** Redacted-safety: sentinel values the printer uses for "unknown". */
const SENTINEL_MINUS_ONE = -1 as const;

/** Normalize a raw number that may be a `-1` sentinel → null. */
export function toNumberOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v === SENTINEL_MINUS_ONE ? null : v;
}

/** `-1` sentinel → null; anything else passes through. */
export function toPctOrNull(v: unknown): number | null {
  const n = toNumberOrNull(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

/** Map a raw bus speed code (1/2/3) to a named `SpeedMode`. */
export function speedModeFrom(raw: unknown): SpeedMode | null {
  if (raw === 1) return "silent";
  if (raw === 2) return "standard";
  if (raw === 3) return "sport";
  return null;
}

/** `edit_status` (0=RFID, 1=manual) → named `EditOrigin`. */
export function editOriginFrom(raw: unknown): EditOrigin {
  return raw === 1 ? "manual" : "rfid";
}

/** FILAMENT_STATES subset → named `FilamentState`. */
export function filamentStateFrom(raw: unknown): FilamentState {
  switch (raw) {
    case 0:
      return "empty";
    case 1:
      return "unknown";
    case 2:
      return "identifying";
    case 3:
    case 4:
      return "identified";
    default:
      return "unknown";
  }
}

/** Generic path reader with dotted/bracket key support. */
export function getPath(src: Readonly<Record<string, unknown>>, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: unknown = src;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Readonly<Record<string, unknown>>)[part];
  }
  return cur;
}

/** Helpers often used inside the map (readable, pure). */
export function asBool(v: unknown): boolean {
  return Boolean(v);
}
export function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
export function asNumber(v: unknown): number | null {
  return toNumberOrNull(v);
}

/** Build the empty (agnostic) snapshot — every field nullable. */
export function emptySnapshot(printerId: string): PrinterSnapshot {
  return {
    schemaVersion: 1,
    printerId,
    capturedAt: null,
    identity: {
      machineType: null,
      firmwareVersion: null,
      serial: null,
      nozzleDiameterMm: null,
      buildVolume: null,
    },
    temps: {
      nozzle: { currentC: null, targetC: null },
      bed: { currentC: null, targetC: null },
      chamber: { currentC: null, targetC: null },
    },
    fans: { partCoolingPct: null, hotendPct: null },
    print: {
      state: "unknown",
      filename: null,
      currLayer: null,
      totalLayers: null,
      progressPct: null,
      remainingSeconds: null,
      speedMode: null,
    },
    ace: { boxes: [], totalSlots: 0 },
    motion: null,
    ai: null,
    lights: null,
    peripherals: { hasCamera: false, hasMultiColorBox: false, hasUsbDrive: false },
    storage: { kind: "unknown", usedBytes: null, totalBytes: null, freeBytes: null },
    capabilities: {},
    raw: {},
  };
}

/**
 * Decode one ACE slot object (raw payload → AceSlot). Pure + agnostic:
 * any missing key defaults safely.
 */
export function aceSlotFrom(raw: Readonly<Record<string, unknown>>, index: number): AceSlot {
  return {
    index,
    state: filamentStateFrom(raw["property"] ?? raw["state"]),
    material: asString(raw["type"] ?? raw["material"]),
    sku: asString(raw["sku"]),
    color: asString(raw["color"] ?? raw["color_group"]),
    remainingPct: toPctOrNull(raw["consumables_percent"]) ?? toPctOrNull(raw["remainder"]),
    editOrigin: editOriginFrom(raw["edit_status"]),
    stateCode: asNumber(raw["state_code"] ?? raw["error_code"] ?? raw["slot_state"]),
    recommendedTempsC: {
      nozzle: null,
      bed: null,
    },
  };
}

/** Decode one ACE box (raw payload → AceBox). */
export function aceBoxFrom(raw: Readonly<Record<string, unknown>>, index: number): AceBox {
  const slotsRaw = Array.isArray(raw["slots"])
    ? (raw["slots"] as ReadonlyArray<Readonly<Record<string, unknown>>>)
    : [];
  const slots: AceSlot[] = slotsRaw.map((r, i) => aceSlotFrom(r, i));
  // If no explicit slots array, synthesize from the typical 4-per-box layout.
  const effective =
    slots.length > 0 ? slots : Array.from({ length: 4 }, (_, i) => aceSlotFrom({}, i));
  return {
    index,
    modelId: asNumber(raw["model_id"]),
    slots: effective,
    ambientTempC: toPctOrNull(raw["temp"]) ?? toPctOrNull(raw["box_temp"]),
    humidityPct: toPctOrNull(raw["humidity"]),
    drying: {
      active: asBool(raw["drying"] ?? raw["is_drying"]),
      targetTempC: asNumber(raw["dry_temp"]),
      remainingSeconds: asNumber(raw["dry_left"]),
    },
    autoFeed: asBool(raw["auto_feed"]),
    loadedSlotIndex: asNumber(raw["loaded_slot"]),
  };
}

/**
 * The declarative path map. Each group maps MCP raw property paths to the
 * snapshot shape via normalizers. Unknown paths fall through to `raw`.
 * Paths use dot notation with `[n]` for arrays. `null` normalizer = pass
 * through to the snapshot as-is (raw values are still normalized).
 */
export type PathNormalizer = (v: unknown) => unknown;
export interface PathGroup {
  /** Key inside the PrinterSnapshot (dotted, e.g. `identity.machineType`). */
  readonly target: string;
  /** One or more raw MCP paths feeding this target (first hit wins). */
  readonly paths: readonly string[];
  readonly normalize?: PathNormalizer;
}

/** Group 1–12 lookup tables (Consultor §B.2). */
export const PATH_GROUPS: readonly PathGroup[] = [
  // G1 identity
  {
    target: "identity.machineType",
    paths: ["device.machine_type", "machine_type", "info.machineType"],
  },
  {
    target: "identity.firmwareVersion",
    paths: ["device.firmware", "firmware_version", "info.fwVersion"],
  },
  { target: "identity.serial", paths: ["device.serial", "serial"] },
  { target: "identity.nozzleDiameterMm", paths: ["device.nozzle", "nozzle_diameter_mm"] },
  { target: "identity.buildVolume", paths: ["machine_data.size", "machine_size"] },
  // G2 temps
  {
    target: "temps.nozzle.currentC",
    paths: ["tempature.nozzle_temp", "extruder.temp", "nozzle_temp"],
    normalize: toNumberOrNull,
  },
  {
    target: "temps.nozzle.targetC",
    paths: ["tempature.nozzle_target", "target_nozzle", "nozzle_target_temp"],
    normalize: toNumberOrNull,
  },
  {
    target: "temps.bed.currentC",
    paths: ["tempature.bed_temp", "heatbed.temp", "bed_temp"],
    normalize: toNumberOrNull,
  },
  {
    target: "temps.bed.targetC",
    paths: ["tempature.bed_target", "target_bed", "bed_target_temp"],
    normalize: toNumberOrNull,
  },
  {
    target: "temps.chamber.currentC",
    paths: ["tempature.chamber_temp", "chamber_temp"],
    normalize: toNumberOrNull,
  },
  {
    target: "temps.chamber.targetC",
    paths: ["tempature.chamber_target", "chamber_target"],
    normalize: toNumberOrNull,
  },
  // G3 fans
  {
    target: "fans.partCoolingPct",
    paths: ["fan.part", "part_fan", "cooling_fan"],
    normalize: toPctOrNull,
  },
  { target: "fans.hotendPct", paths: ["fan.hotend", "hotend_fan"], normalize: toPctOrNull },
  // G4 print
  { target: "print.state", paths: ["print.status", "status", "print_state"] },
  { target: "print.filename", paths: ["print.file_name", "print.filename"] },
  {
    target: "print.currLayer",
    paths: ["print.current_layer", "curr_layer"],
    normalize: toNumberOrNull,
  },
  {
    target: "print.totalLayers",
    paths: ["print.total_layer", "total_layer"],
    normalize: toNumberOrNull,
  },
  { target: "print.progressPct", paths: ["print.progress", "progress"], normalize: toPctOrNull },
  {
    target: "print.remainingSeconds",
    paths: ["print.remain_time", "remain_time"],
    normalize: toNumberOrNull,
  },
  {
    target: "print.speedMode",
    paths: ["print.speed_mode", "speed_mode"],
    normalize: speedModeFrom,
  },
  // G5 ACE (constructed from per-box payloads — the box targets are dynamic)
  { target: "ace.boxes", paths: ["ace.boxes", "multiColorBox", "extfilbox"] },
  // G6 motion
  { target: "motion.xMm", paths: ["motion.x", "axis.x"], normalize: toNumberOrNull },
  { target: "motion.yMm", paths: ["motion.y", "axis.y"], normalize: toNumberOrNull },
  { target: "motion.zMm", paths: ["motion.z", "axis.z"], normalize: toNumberOrNull },
  // G7 AI
  { target: "ai.enabled", paths: ["ai.enable", "ai.enabled"], normalize: asBool },
  { target: "ai.sensitivity", paths: ["ai.sensitivity", "ai.sens"], normalize: toNumberOrNull },
  // G8 lights
  { target: "lights.enabled", paths: ["light.enable", "light.enabled"], normalize: asBool },
  {
    target: "lights.brightnessPct",
    paths: ["light.brightness", "light.value"],
    normalize: toPctOrNull,
  },
  // G9 peripherals
  {
    target: "peripherals.hasCamera",
    paths: ["peripherie.camera", "peripherie.video"],
    normalize: asBool,
  },
  {
    target: "peripherals.hasMultiColorBox",
    paths: ["peripherie.multiColorBox", "peripherie.box"],
    normalize: asBool,
  },
  {
    target: "peripherals.hasUsbDrive",
    paths: ["peripherie.udisk", "peripherie.usb"],
    normalize: asBool,
  },
  // G10 storage
  { target: "storage.kind", paths: ["storage.kind", "files.path"] },
  { target: "storage.usedBytes", paths: ["storage.used", "files.used"], normalize: toNumberOrNull },
  {
    target: "storage.totalBytes",
    paths: ["storage.total", "files.total"],
    normalize: toNumberOrNull,
  },
  // G11 capabilities
  { target: "capabilities", paths: ["features"] },
  // G12 diagnostics/time
  { target: "capturedAt", paths: ["catched_time", "ts", "timestamp"] },
];

/** `features` payload → flat boolean capabilities record. */
export function capabilitiesFrom(raw: unknown): Readonly<Record<string, boolean>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Readonly<Record<string, unknown>>;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * Full mapper: raw MCP printer payload → normalized PrinterSnapshot.
 * Every unmatched key is preserved in `raw`. Booleans/enums are named.
 */
export function mapPrinterPayload(
  printerId: string,
  payload: Readonly<Record<string, unknown>>,
): PrinterSnapshot {
  const snap = emptySnapshot(printerId);
  const mutable = snap as DeepWritable<PrinterSnapshot>;
  const get = (path: string): unknown => getPath(payload, path);

  // Pass 1: scalar groups (skip ACE + capabilities, handled structurally).
  for (const group of PATH_GROUPS) {
    if (group.target === "ace.boxes" || group.target === "capabilities") continue;
    let hit: unknown;
    for (const p of group.paths) {
      const v = get(p);
      if (v !== undefined) {
        hit = v;
        break;
      }
    }
    if (hit === undefined) continue;
    const key = group.target.split(".").pop()!;
    const container = resolveTarget(mutable, group.target);
    container[key] = group.normalize ? group.normalize(hit) : hit;
  }

  // Pass 2: capabilities (raw features → boolean map).
  const features = get("features");
  mutable.capabilities = capabilitiesFrom(features);

  // Pass 3: ACE boxes (per-box payloads; unknown structure → empty).
  const aceRaw = get("ace.boxes") ?? get("multiColorBox") ?? get("extfilbox");
  if (Array.isArray(aceRaw)) {
    mutable.ace.boxes = (aceRaw as ReadonlyArray<Readonly<Record<string, unknown>>>).map((b, i) =>
      aceBoxFrom(b ?? {}, i),
    );
    mutable.ace.totalSlots = mutable.ace.boxes.reduce((acc, b) => acc + b.slots.length, 0);
  }

  // Pass 4: the raw mirror (every key paths don't explain).
  mutable.raw = { ...payload };

  return snap;
}

/** Navigate the snapshot object tree and return the nested container. */
function resolveTarget(snap: PrinterSnapshot, target: string): Record<string, unknown> {
  const parts = target.split(".");
  let cur: Record<string, unknown> = snap as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) {
      // Seed the container so the final assignment never throws.
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  return cur;
}
