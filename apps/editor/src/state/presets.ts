/**
 * S9.6-001 — Preset selection store (printer / filament / quality).
 *
 * Thin zustand wrapper over `presets/catalog.ts`. The selection writes the
 * SettingsPanel draft state (export path unchanged — the panel already owns
 * the numeric draft); this store only tracks WHICH preset is selected so the
 * UI can apply preset values into the draft on change.
 */

import { create } from "zustand";
import {
  DEFAULT_PRESET_SELECTION,
  filamentPresetById,
  layerHeightFor,
  printerPresetById,
  qualityPresetById,
} from "../presets/catalog.ts";
import type { PresetSelection, QualityPresetId } from "../presets/catalog.ts";

export interface PresetDraftValues {
  readonly nozzleDiameterMm: number;
  readonly nozzleTempC: number;
  readonly bedTempC: number;
  readonly flowPct: number;
  readonly layerHeightMm: number;
  readonly lineWidthMm: number;
  readonly material: string;
  readonly color: string;
}

export interface SliceSettingsDraft {
  readonly layer_height_mm: number;
  readonly line_width_mm: number;
  readonly nozzle_diameter_mm: number;
  readonly wall_loops: number;
  readonly top_bottom_layers: number;
  readonly infill_density_pct: number;
  readonly infill_pattern: string;
  readonly filament_diameter_mm: number;
  readonly material: string;
  readonly nozzle_temperature_c: number;
  readonly bed_temperature_c: number;
  readonly fan_pct: number;
  readonly print_speed_mm_s: number;
  readonly travel_speed_mm_s: number;
}

export const DEFAULT_SLICE_SETTINGS: SliceSettingsDraft = {
  layer_height_mm: 0.2,
  line_width_mm: 0.45,
  nozzle_diameter_mm: 0.4,
  wall_loops: 2,
  top_bottom_layers: 4,
  infill_density_pct: 15,
  infill_pattern: "Grid",
  filament_diameter_mm: 1.75,
  material: "PLA",
  nozzle_temperature_c: 210,
  bed_temperature_c: 60,
  fan_pct: 100,
  print_speed_mm_s: 30,
  travel_speed_mm_s: 120,
};

export interface PresetStore extends PresetSelection {
  readonly sliceSettings: SliceSettingsDraft;
  readonly supports: boolean;
  readonly brimWidthMm: number;
  /**
   * Values a preset change implies — applied by the SettingsPanel into its
   * draft (the export path stays unchanged). `null` until a change happens
   * so the panel can keep its initial DEFAULT_DRAFT.
   */
  readonly draftValues: PresetDraftValues | null;
  readonly setPrinter: (id: string) => void;
  readonly setFilament: (id: string) => void;
  readonly setQuality: (id: QualityPresetId) => void;
  readonly setCustomLayerHeight: (mm: number) => void;
  readonly updateSliceSettings: (settings: SliceSettingsDraft) => void;
  readonly setSupports: (enabled: boolean) => void;
  readonly setBrimWidth: (widthMm: number) => void;
}

export function presetDraftValuesFor(selection: PresetSelection): PresetDraftValues {
  const printer = printerPresetById(selection.printerId);
  const filament = filamentPresetById(selection.filamentId);
  const quality = qualityPresetById(selection.qualityId);
  return {
    nozzleDiameterMm: printer?.nozzleMm ?? 0.4,
    nozzleTempC: filament?.nozzleTempC ?? printer?.nozzleTempC ?? 210,
    bedTempC: filament?.bedTempC ?? printer?.bedTempC ?? 60,
    flowPct: printer?.flowPct ?? 100,
    layerHeightMm: layerHeightFor(selection),
    lineWidthMm: quality?.defaultLineWidthMm ?? 0.45,
    material: filament?.material ?? "PLA",
    color: filament?.color ?? "#4fa8dc",
  };
}

export const usePresets = create<PresetStore>((set) => ({
  ...DEFAULT_PRESET_SELECTION,
  sliceSettings: DEFAULT_SLICE_SETTINGS,
  supports: false,
  brimWidthMm: 0,
  draftValues: null,
  setPrinter: (printerId) =>
    set((state) => {
      if (!printerPresetById(printerId)) return state;
      const next = { ...state, printerId };
      return { ...next, draftValues: presetDraftValuesFor(next) };
    }),
  setFilament: (filamentId) =>
    set((state) => {
      if (!filamentPresetById(filamentId)) return state;
      const next = { ...state, filamentId };
      return { ...next, draftValues: presetDraftValuesFor(next) };
    }),
  setQuality: (qualityId) =>
    set((state) => {
      if (!qualityPresetById(qualityId)) return state;
      const next = { ...state, qualityId };
      return { ...next, draftValues: presetDraftValuesFor(next) };
    }),
  setCustomLayerHeight: (mm) =>
    set((state) => ({
      ...state,
      qualityId: "custom",
      draftValues: {
        ...(state.draftValues ?? presetDraftValuesFor(state)),
        layerHeightMm: mm,
      },
    })),
  updateSliceSettings: (sliceSettings) => set({ sliceSettings }),
  setSupports: (supports) => set({ supports }),
  setBrimWidth: (brimWidthMm) => set({ brimWidthMm }),
}));
