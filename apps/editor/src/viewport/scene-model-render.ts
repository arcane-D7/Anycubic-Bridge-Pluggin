/**
 * S9.2-003 — Pure render-state decision for the scene object model.
 *
 * Dependency-free (no React/three/R3F imports) so the plain Node test runner
 * can assert the tint/visibility/wireframe matrix headless. The R3F component
 * (`SceneObjectModel.tsx`) calls these helpers; this module never touches the
 * DOM or WebGL.
 */

import type { ObjectMeshInfo } from "../bridge/types";

export const MODEL_COLORS = {
  nonWatertight: "#b36a5e",
  neutral: "#7a8699",
  selected: "#4f9cf7",
  hover: "#aeb9c9",
} as const;

/** Real triangle-buffer geometry exists behind the mesh-info mirror. */
export function geometryExists(info: ObjectMeshInfo): boolean {
  const g = (
    info as { geometry?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array } }
  ).geometry;
  return !!g && g.positions.length > 0 && g.indices.length > 0;
}

export interface ModelRenderState {
  readonly visible: boolean;
  readonly locked: boolean;
  readonly baseColor: string;
  readonly hasRealGeometry: boolean;
  readonly selectionOutline: boolean;
}

/**
 * Pure render-state decision:
 * - `!visible` → the component returns null (hidden).
 * - non-watertight mesh keeps the frozen tint `#b36a5e`.
 * - selection outline requires REAL geometry (the glow derives from bounds
 *   only when the object renders an actual mesh; mesh-info-only fallback
 *   keeps the simple tint).
 */
export function resolveModelRenderState(
  info: ObjectMeshInfo,
  opts: { readonly isSelected: boolean; readonly isHovered: boolean },
): ModelRenderState {
  const locked = (info as { locked?: boolean }).locked ?? false;
  const visible = (info as { visible?: boolean }).visible ?? true;
  const hasRealGeometry = geometryExists(info);
  const baseColor = !info.watertight
    ? MODEL_COLORS.nonWatertight
    : opts.isSelected
      ? MODEL_COLORS.selected
      : opts.isHovered && !locked
        ? MODEL_COLORS.hover
        : MODEL_COLORS.neutral;
  return {
    visible,
    locked,
    baseColor,
    hasRealGeometry,
    selectionOutline: opts.isSelected && hasRealGeometry,
  };
}
