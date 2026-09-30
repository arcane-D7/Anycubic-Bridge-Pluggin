import { memo, useMemo, useState } from "react";
import * as THREE from "three";
import type { ObjectMeshInfo } from "../bridge/types";
import { useScene } from "../state/scene";
import { useViewport } from "../state/viewport";
import { useUi } from "../state/ui";

/**
 * Scene object model (S9.2-003) — renders REAL triangle buffers from the
 * snapshot geometry lane (positions/normals/indices in mm), never unit boxes.
 *
 * - Real buffers when `geometry` is present (kills the unit-box placeholder).
 * - Bounds-box fallback for mesh-info-only objects (no geometry yet).
 * - Wireframe edges overlay (toggleable per object / global view mode).
 * - Watertight tint (#b36a5e non-watertight convention kept), hover highlight,
 *   selection outline (2px solid --sel-outline-3d + 6px glow halo).
 * - Hidden while `!visible`; locked objects reject hover/selection styling.
 */

interface SceneObjectModelProps {
  readonly info: ObjectMeshInfo;
}

import { resolveModelRenderState } from "./scene-model-render.ts";

/** Re-exported pure helpers (headless-tested in tests/scene-object-model.test.mjs). */
export { geometryExists } from "./scene-model-render.ts";

/**
 * Build a THREE.BufferGeometry from the snapshot's triangle buffers. The data
 * is already in mm with per-face normals; the IndexedBufferGeometry is CCW.
 */
function geometryFromBuffers(info: ObjectMeshInfo): THREE.BufferGeometry | null {
  const g = (
    info as { geometry?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array } }
  ).geometry;
  if (!g) return null;
  if (g.positions.length === 0 || g.indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(g.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
  geo.computeBoundingBox();
  return geo;
}

function boundsBox(info: ObjectMeshInfo): THREE.Box3 | null {
  const { min, max } = info.bounds;
  if (min[0] === max[0] && min[1] === max[1] && min[2] === max[2]) return null;
  return new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2]),
  );
}

export const SceneObjectModel = memo(function SceneObjectModel({ info }: SceneObjectModelProps) {
  const selected = useScene((s) => (s.selected?.name === info.name ? s.selected : null));
  // Selection highlight derives from the AUTHORITATIVE snapshot selection_state
  // (S7-004): object-mode selection is a name in `selection.objectModeNames`;
  // edit-mode verts/faces/edges map to element indices per object, but the
  // editor only owns names in object mode here. Never a UI-local twin.
  const authoritativeSelected = useViewport(
    (s) => s.selection?.objectModeNames.includes(info.name) ?? false,
  );
  const [hovered, setHovered] = useState(false);

  // Edges shown by default; a global view mode toggle (sceneViewEdges) or a
  // per-object flag can hide them (S9.2-003 AC: "wireframe edges toggleable").
  const edgesVisible = useUi((s) => s.sceneViewEdges);

  const geometry = useMemo(() => geometryFromBuffers(info), [info]);
  const box = useMemo(() => boundsBox(info), [info]);

  // ---- render-state -----------------------------------------------------
  const isSelected = !!(selected || authoritativeSelected);
  const { visible, locked, baseColor } = resolveModelRenderState(info, {
    isSelected,
    isHovered: hovered,
  });
  const outlineColor = isSelected ? "var(--sel-outline-3d)" : "transparent";

  if (!visible) return null;

  return (
    <group>
      {geometry ? (
        <mesh
          geometry={geometry}
          onClick={(e) => {
            e.stopPropagation();
            useScene.getState().select(info.name, info.watertight);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            if (!locked) setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
        >
          <meshStandardMaterial
            color={baseColor}
            roughness={0.55}
            metalness={0.08}
            transparent
            opacity={0.92}
          />
        </mesh>
      ) : (
        <mesh
          position={box ? box.getCenter(new THREE.Vector3()).toArray() : undefined}
          scale={box ? box.getSize(new THREE.Vector3()).toArray() : undefined}
          onClick={(e) => {
            e.stopPropagation();
            useScene.getState().select(info.name, info.watertight);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            if (!locked) setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={baseColor} transparent opacity={0.85} />
        </mesh>
      )}

      {/* wireframe edges (optional) */}
      {edgesVisible &&
        (geometry ? (
          <lineSegments>
            <edgesGeometry args={[geometry]} />
            <lineBasicMaterial color="#d7dbe3" transparent opacity={0.5} />
          </lineSegments>
        ) : (
          <lineSegments>
            <edgesGeometry args={[new THREE.BoxGeometry(1, 1, 1)]} />
            <lineBasicMaterial color="#d7dbe3" />
          </lineSegments>
        ))}

      {/* selection outline: bounds wireframe 2px + 6px glow halo (hidden
          while a transient transform is in progress — the gizmo carries the
          affordance then) */}
      {isSelected && box && (
        <>
          <mesh
            position={box.getCenter(new THREE.Vector3()).toArray()}
            scale={box.getSize(new THREE.Vector3()).multiplyScalar(1.02).toArray()}
          >
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicMaterial color={outlineColor} wireframe transparent opacity={0.9} />
          </mesh>
          <mesh
            position={box.getCenter(new THREE.Vector3()).toArray()}
            scale={box.getSize(new THREE.Vector3()).multiplyScalar(1.06).toArray()}
          >
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicMaterial
              color="var(--sel-outline-glow)"
              wireframe
              transparent
              opacity={0.35}
            />
          </mesh>
        </>
      )}
    </group>
  );
});
