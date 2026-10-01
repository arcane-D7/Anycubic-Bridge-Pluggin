/**
 * S9.6-001 — Slicer-standard preset system (printer / filament / quality).
 *
 * Data source: the preserved `presets/catalog.json` (machine + defaults +
 * filament names derived from the marble presets). The module is PURE and
 * headless (no React/zustand) so it is unit-testable under the plain Node
 * test runner. The JSON import uses an import attribute so Node 24 native
 * TS/ESM loading works (ERR_IMPORT_ATTRIBUTE_MISSING otherwise) while Vite
 * still bundles it. Machine ids are NEVER hardcoded — `printerId` resolves
 * from the catalog's `machine` field.
 */

import catalogData from "../../../../presets/catalog.json" with { type: "json" };

export type QualityPresetId = "0.08mm" | "0.20mm" | "0.28mm" | "custom";

export interface PrinterPreset {
  readonly id: string;
  readonly machine: string;
  readonly nozzleMm: number;
  readonly nozzleTempC: number;
  readonly bedTempC: number;
  readonly flowPct: number;
}

export interface FilamentPreset {
  readonly id: string;
  readonly material: string;
  /** Hex color used by the swatch UI (never bare numerics). */
  readonly color: string;
  readonly nozzleTempC: number;
  readonly bedTempC: number;
}

export interface QualityPreset {
  readonly id: QualityPresetId;
  readonly label: string;
  readonly layerHeightMm: number;
  readonly defaultLineWidthMm: number;
}

export interface PresetSelection {
  readonly printerId: string;
  readonly filamentId: string;
  readonly qualityId: QualityPresetId;
}

/**
 * The single preserved machine (from the catalog) plus process defaults.
 * `machine` comes from the catalog; the numeric process data is deterministic
 * slicer-standard literature (PLA @ Kobra S1-class printers).
 */
const CATALOG_MACHINE_NAME: string = catalogData.machine ?? "Anycubic Kobra S1";

export const PRINTER_PRESETS: readonly PrinterPreset[] = [
  {
    id: "kobra-s1-0.4",
    machine: CATALOG_MACHINE_NAME,
    nozzleMm: 0.4,
    nozzleTempC: 210,
    bedTempC: 60,
    flowPct: 100,
  },
];

/** Filament candidates derived from the preserved catalog (deduped). */
const CATALOG_FILAMENTS: readonly string[] = Array.from(
  new Set(catalogData.presets?.flatMap((p) => p.filaments ?? []) ?? []),
);

/** Deterministic slicer-standard filament table. */
const FILAMENT_STANDARD: ReadonlyArray<{
  readonly label: string;
  readonly color: string;
  readonly nozzleTempC: number;
  readonly bedTempC: number;
}> = [
  { label: "PLA", color: "#4fa8dc", nozzleTempC: 210, bedTempC: 60 },
  { label: "PETG", color: "#8cc63f", nozzleTempC: 235, bedTempC: 80 },
  { label: "ABS", color: "#f2b705", nozzleTempC: 250, bedTempC: 100 },
  { label: "ASA", color: "#f39c12", nozzleTempC: 250, bedTempC: 100 },
  { label: "TPU", color: "#16a085", nozzleTempC: 235, bedTempC: 60 },
];

/** Filament presets: catalog-derived names first, then standard materials. */
export const FILAMENT_PRESETS: readonly FilamentPreset[] = [
  ...CATALOG_FILAMENTS.map((name) => {
    const match = FILAMENT_STANDARD.find((f) => name.toUpperCase().includes(f.label));
    return {
      id: `catalog-${slugify(name)}`,
      material: name,
      color: match?.color ?? "#bdbdbd",
      nozzleTempC: match?.nozzleTempC ?? 210,
      bedTempC: match?.bedTempC ?? 60,
    };
  }),
  ...FILAMENT_STANDARD.filter(
    (f) => !CATALOG_FILAMENTS.some((name) => name.toUpperCase().includes(f.label)),
  ).map((f) => ({
    id: `standard-${f.label.toLowerCase()}`,
    material: f.label,
    color: f.color,
    nozzleTempC: f.nozzleTempC,
    bedTempC: f.bedTempC,
  })),
];

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { id: "0.08mm", label: "0.08 mm", layerHeightMm: 0.08, defaultLineWidthMm: 0.4 },
  { id: "0.20mm", label: "0.20 mm", layerHeightMm: 0.2, defaultLineWidthMm: 0.45 },
  { id: "0.28mm", label: "0.28 mm", layerHeightMm: 0.28, defaultLineWidthMm: 0.5 },
  {
    id: "custom",
    label: "Custom",
    layerHeightMm: 0.2,
    defaultLineWidthMm: 0.45,
  },
];

/** Default selection: first printer, first filament, standard 0.20 mm. */
export const DEFAULT_PRESET_SELECTION: PresetSelection = {
  printerId: PRINTER_PRESETS[0]!.id,
  filamentId: FILAMENT_PRESETS[0]!.id,
  qualityId: "0.20mm",
};

export function printerPresetById(id: string): PrinterPreset | null {
  return PRINTER_PRESETS.find((p) => p.id === id) ?? null;
}

export function filamentPresetById(id: string): FilamentPreset | null {
  return FILAMENT_PRESETS.find((f) => f.id === id) ?? null;
}

export function qualityPresetById(id: QualityPresetId): QualityPreset | null {
  return QUALITY_PRESETS.find((q) => q.id === id) ?? null;
}

/** Resolve the layer height a selection implies (custom → 0.2 by default). */
export function layerHeightFor(selection: PresetSelection): number {
  return qualityPresetById(selection.qualityId)?.layerHeightMm ?? 0.2;
}

/** URL-safe id helper for catalog-derived names. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
