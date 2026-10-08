import type { SliceSettingsDraft } from "../state/presets.ts";
import { editorWorldToSliceIr } from "../state/coordinate-frames.ts";
import { isTauriRuntime } from "./project-provider.ts";
import type { SlicingMode } from "../contract";

export interface NativeSliceRequest {
  readonly job_id: string;
  readonly expected_revision: number;
  readonly slicing_mode: SlicingMode;
  readonly coordinate_frame: "editor-world";
  readonly editor_to_slice_frame: {
    readonly origin_mm: readonly [number, number, number];
    readonly x_axis: readonly [number, number, number];
    readonly y_axis: readonly [number, number, number];
    readonly z_axis: readonly [number, number, number];
  };
  readonly plate_id: string;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly build_volume_x_mm: number;
  readonly build_volume_y_mm: number;
  readonly build_volume_z_mm: number;
  readonly dialect: "anycubic" | "cura";
  readonly layer_height_mm: number;
  readonly line_width_mm: number;
  readonly nozzle_diameter_mm: number;
  readonly wall_loops: number;
  readonly top_bottom_layers: number;
  readonly infill_density_pct: number;
  readonly infill_pattern: string;
  readonly brim_width_mm: number;
  readonly filament_diameter_mm: number;
  readonly material_id: string;
  readonly material_type: string;
  readonly nozzle_temperature_c: number;
  readonly bed_temperature_c: number;
  readonly fan_pct: number;
  readonly print_speed_mm_s: number;
  readonly travel_speed_mm_s: number;
  readonly supports: boolean;
  readonly target_ids: readonly string[];
}

export interface NativeSliceReply {
  readonly job_id: string;
  readonly status: "ready";
  readonly compatibility: "preview-only";
  readonly source_revision: number;
  readonly target_ids: readonly string[];
  readonly input_digest: string;
  readonly artifact_id: string;
  readonly layer_count: number;
  readonly segment_count: number;
  readonly stats: {
    readonly layers: number;
    readonly estimated_minutes: number;
    readonly material_grams: number | null;
    readonly volume_mm3: number;
    readonly per_object_mm3: Readonly<Record<string, number>>;
  };
  readonly ir: unknown;
  readonly program: string;
}

let activeJobId: string | null = null;

export function createNativeSliceRequest(input: {
  readonly revision: number;
  readonly slicingMode: SlicingMode;
  readonly plateId: string;
  readonly profileId: string;
  readonly buildVolume: {
    readonly widthMm: number;
    readonly depthMm: number;
    readonly heightMm: number;
  };
  readonly materialId: string;
  readonly materialType: string;
  readonly settings: SliceSettingsDraft;
  readonly supports: boolean;
  readonly brimWidthMm: number;
  readonly targetIds: readonly string[];
}): NativeSliceRequest {
  if (input.targetIds.length === 0)
    throw new Error("slice preflight: no placed objects on the active plate");
  const origin = editorWorldToSliceIr([0, 0, 0]);
  const xAxis = editorWorldToSliceIr([1, 0, 0]);
  const yAxis = editorWorldToSliceIr([0, 1, 0]);
  const zAxis = editorWorldToSliceIr([0, 0, 1]);
  return {
    job_id: globalThis.crypto.randomUUID(),
    expected_revision: input.revision,
    slicing_mode: input.slicingMode,
    coordinate_frame: "editor-world",
    editor_to_slice_frame: {
      origin_mm: origin,
      x_axis: [xAxis[0] - origin[0], xAxis[1] - origin[1], xAxis[2] - origin[2]],
      y_axis: [yAxis[0] - origin[0], yAxis[1] - origin[1], yAxis[2] - origin[2]],
      z_axis: [zAxis[0] - origin[0], zAxis[1] - origin[1], zAxis[2] - origin[2]],
    },
    plate_id: input.plateId,
    profile_id: input.profileId,
    profile_version: "catalog-v1",
    build_volume_x_mm: input.buildVolume.widthMm,
    build_volume_y_mm: input.buildVolume.depthMm,
    build_volume_z_mm: input.buildVolume.heightMm,
    dialect: "anycubic",
    layer_height_mm: input.settings.layer_height_mm,
    line_width_mm: input.settings.line_width_mm,
    nozzle_diameter_mm: input.settings.nozzle_diameter_mm,
    wall_loops: input.settings.wall_loops,
    top_bottom_layers: input.settings.top_bottom_layers,
    infill_density_pct: input.settings.infill_density_pct,
    infill_pattern: input.settings.infill_pattern,
    brim_width_mm: input.brimWidthMm,
    filament_diameter_mm: input.settings.filament_diameter_mm,
    material_id: input.materialId,
    material_type: input.materialType,
    nozzle_temperature_c: input.settings.nozzle_temperature_c,
    bed_temperature_c: input.settings.bed_temperature_c,
    fan_pct: input.settings.fan_pct,
    print_speed_mm_s: input.settings.print_speed_mm_s,
    travel_speed_mm_s: input.settings.travel_speed_mm_s,
    supports: input.supports,
    target_ids: [...input.targetIds].sort(),
  };
}

export async function runNativeSliceJob(request: NativeSliceRequest): Promise<NativeSliceReply> {
  if (!isTauriRuntime())
    throw new Error("real slice provider is available only in the Tauri application");
  activeJobId = request.job_id;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("slice_job_run", { request })) as NativeSliceReply;
  } finally {
    if (activeJobId === request.job_id) activeJobId = null;
  }
}

export async function cancelNativeSliceJob(): Promise<boolean> {
  if (!activeJobId || !isTauriRuntime()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("slice_job_cancel", { jobId: activeJobId });
}
