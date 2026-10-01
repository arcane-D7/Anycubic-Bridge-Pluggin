/**
 * S9.4-002 camera presets — dependency-free pure core.
 *
 * No React / zustand / three imports so Node 24 runs it headless under the
 * `node --test` harness (same pattern as toolbar-core / shortcuts-core). The
 * R3F components (`viewport/ViewportCamera.tsx` + `viewport/ViewCube.tsx`)
 * are thin wrappers over these pure functions.
 *
 * Presets are named orientations (iso/top/front/right) + the view cube
 * faces/corners/edges. The camera stays a fixed distance from the target;
 * only the direction changes.
 */

/** A camera position relative to the target (direction * distance). */
export interface CameraOrbit {
  /** Unit direction from target → camera. */
  readonly direction: readonly [number, number, number];
  /** World-up hint for the orientation (used for "up" when unrolling). */
  readonly up: readonly [number, number, number];
}

/** View cube cell ids: 3×3 grid around the target. */
export type ViewCubeCell =
  | "faceFront"
  | "faceBack"
  | "faceTop"
  | "faceBottom"
  | "faceLeft"
  | "faceRight"
  | "cornerTopFrontLeft"
  | "cornerTopFrontRight"
  | "cornerTopBackLeft"
  | "cornerTopBackRight"
  | "cornerBottomFrontLeft"
  | "cornerBottomFrontRight"
  | "cornerBottomBackLeft"
  | "cornerBottomBackRight"
  | "edgeTopFront"
  | "edgeTopBack"
  | "edgeTopLeft"
  | "edgeTopRight"
  | "edgeBottomFront"
  | "edgeBottomBack"
  | "edgeBottomLeft"
  | "edgeBottomRight"
  | "edgeFrontLeft"
  | "edgeFrontRight"
  | "edgeBackLeft"
  | "edgeBackRight";

/**
 * Face/corner/edge cell → camera direction (three.js axes: X right, Y up,
 * Z toward viewer). The PLATE convention: front = -Z (viewer side), so the
 * "front" face is approached from +Z.
 */
export function cellDirection(cell: ViewCubeCell): readonly [number, number, number] {
  // Face directions — unit vectors from the surface toward the camera.
  const FACE_DIRS: Record<ViewCubeCell, readonly [number, number, number] | undefined> = {
    faceFront: [0, 0, 1],
    faceBack: [0, 0, -1],
    faceTop: [0, 1, 0.0001],
    faceBottom: [0, -1, 0.0001],
    faceLeft: [1, 0, 0.0001],
    faceRight: [-1, 0, 0.0001],
    cornerTopFrontLeft: [0.5, 0.5, 0.5],
    cornerTopFrontRight: [-0.5, 0.5, 0.5],
    cornerTopBackLeft: [0.5, 0.5, -0.5],
    cornerTopBackRight: [-0.5, 0.5, -0.5],
    cornerBottomFrontLeft: [0.5, -0.5, 0.5],
    cornerBottomFrontRight: [-0.5, -0.5, 0.5],
    cornerBottomBackLeft: [0.5, -0.5, -0.5],
    cornerBottomBackRight: [-0.5, -0.5, -0.5],
    edgeTopFront: [0, 0.7, 0.7],
    edgeTopBack: [0, 0.7, -0.7],
    edgeTopLeft: [0.7, 0.7, 0],
    edgeTopRight: [-0.7, 0.7, 0],
    edgeBottomFront: [0, -0.7, 0.7],
    edgeBottomBack: [0, -0.7, -0.7],
    edgeBottomLeft: [0.7, -0.7, 0],
    edgeBottomRight: [-0.7, -0.7, 0],
    edgeFrontLeft: [0.7, 0, 0.7],
    edgeFrontRight: [-0.7, 0, 0.7],
    edgeBackLeft: [0.7, 0, -0.7],
    edgeBackRight: [-0.7, 0, -0.7],
  };
  const dir = FACE_DIRS[cell];
  if (!dir) throw new Error(`unknown view cube cell: ${cell}`);
  return dir;
}

/** Home (isometric) view = the top-front-right corner direction. */
export function homeDirection(): readonly [number, number, number] {
  return cellDirection("cornerTopFrontRight");
}
