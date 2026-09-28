import { memo, useMemo } from "react";
import * as THREE from "three";
import type { ObjectMeshInfo } from "../bridge/types";
import { useScene } from "../state/scene";

/**
 * Scene object model placeholder (R0). The preserved server repacks mesh
 * positions PER TRIANGLE, but this shell has no geometry authority yet — so
 * the object renders as a normalized unit box proportional to its bounds,
 * tinted by selection and non-watertight state, and sized from the mesh info
 * returned by the bridge (bounds/sizeMm), never guessed.
 */

const NON_WATERTIGHT = "#b36a5e";
const NEUTRAL = "#7a8699";
const SELECTED = "#4f9cf7";

interface SceneObjectModelProps {
  readonly info: ObjectMeshInfo;
}

export const SceneObjectModel = memo(function SceneObjectModel({ info }: SceneObjectModelProps) {
  const selected = useScene((s) => (s.selected?.name === info.name ? s.selected : null));
  const color = selected ? SELECTED : info.watertight ? NEUTRAL : NON_WATERTIGHT;

  // Deterministic unit box scaled to the object's real size (mm) from bounds.
  const { position, scale } = useMemo(() => {
    const { min, max } = info.bounds;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const cz = (min[2] + max[2]) / 2;
    const sx = Math.max(0.01, max[0] - min[0]);
    const sy = Math.max(0.01, max[1] - min[1]);
    const sz = Math.max(0.01, max[2] - min[2]);
    return { position: [cx, cy, cz] as const, scale: [sx, sy, sz] as const };
  }, [info.bounds]);

  return (
    <mesh
      position={position}
      scale={scale}
      onClick={(e) => {
        e.stopPropagation();
        useScene.getState().select(info.name, info.watertight);
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} transparent opacity={0.85} />
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(1, 1, 1)]} />
        <lineBasicMaterial color="#d7dbe3" />
      </lineSegments>
    </mesh>
  );
});
