import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ObjectMeshInfo, SceneObjectSnapshot } from "../bridge/types";
import { useScene } from "../state/scene";
import { useViewport } from "../state/viewport";
import { useUi } from "../state/ui";
import { useLabelsBus } from "../state/labels";
import { registerAnchorProbe } from "./Labels";

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
  readonly info: SceneObjectSnapshot;
}

import { resolveModelRenderState } from "./scene-model-render.ts";
import { applyTransform } from "./transform-core";
import { selectionGlow, selectionOutline } from "./theme-colors";
import { useViewMode } from "../state/view-mode";
import { usePresets } from "../state/presets";
import { usePrinterDevice } from "../state/printer-device";
import { FILAMENT_PRESETS } from "../presets/catalog";
import { resolveFilamentColor, materialClassFor } from "../state/material-assign-core";
import { filamentMaterial } from "./filament-material";

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
  const setLabelHovered = useLabelsBus((s) => s.setHovered);

  // Edges shown by default; a global view mode toggle (sceneViewEdges) or a
  // per-object flag can hide them (S9.2-003 AC: "wireframe edges toggleable").
  const edgesVisible = useUi((s) => s.sceneViewEdges);

  const geometry = useMemo(() => geometryFromBuffers(info), [info]);
  const box = useMemo(() => boundsBox(info), [info]);

  // S9.8-002 — hover from meshes also drives the label chips (a hovered
  // object shows its chip even when labels are not always-on).
  const onHover = (entered: boolean) => {
    setHovered(entered);
    if (entered) setLabelHovered(info.name);
    else setLabelHovered(null);
  };

  const rootRef = useRef<THREE.Group>(null);
  const boxRef = useRef(box);
  boxRef.current = box;
  // Locked flag lives in the render-state (below); mirror into a ref so the
  // stable pointer handlers can consult it without re-subscribing.
  const lockedRef = useRef(false);
  const renderState = resolveModelRenderState(info, {
    isSelected: !!(selected || authoritativeSelected),
    isHovered: hovered,
  });
  lockedRef.current = renderState.locked;
  // S9.8-002 — register the LIVE anchor probe for the label projector: the
  // world-space top-center of the bounds box (follows gizmo drags because it
  // reads the object3D matrix each frame).
  useEffect(() => {
    const unregister = registerAnchorProbe(info.name, () => {
      const root = rootRef.current;
      const b = boxRef.current;
      if (!root || !b) return null;
      const topCenter = new THREE.Vector3(
        (b.min.x + b.max.x) / 2,
        b.max.y + 4,
        (b.min.z + b.max.z) / 2,
      );
      const world = topCenter.applyMatrix4(root.matrixWorld);
      return { x: world.x, y: world.y, z: world.z };
    });
    return unregister;
  }, [info.name]);

  // S9.3-001: the object's placement in scene space. The real transform
  // (position + euler rotation deg + scale) is applied to the root group so
  // gizmo drags move/rotate/scale the OBJECT — geometry buffers untouched.
  const transform = useMemo(() => applyTransform(info.transform), [info.transform]);

  // ---- S9.11-002 slicer-style material ---------------------------------
  // When the view mode is 'slicer' (and NOT 'live'/'mesh'), the object shows
  // the REAL material + color: per-object `filamentId` (S9.6-002), else the
  // global preset filament, mapped through the live ACE snapshot with the
  // preset-neutral fallback chain (never guesses). Procedural material only.
  const viewMode = useViewMode((s) => s.mode);
  const selectedMode = viewMode === "slicer" ? "slicer" : null;
  const globalFilamentId = usePresets((s) => s.filamentId);
  const slicerMatch = selectedMode
    ? resolveFilamentColor({
        boxes: usePrinterDevice.getState().snapshot?.ace.boxes ?? [],
        filamentId: info.filamentId ?? globalFilamentId,
        materialLabel: undefined,
        presets: FILAMENT_PRESETS,
      })
    : null;

  // ---- render-state -----------------------------------------------------
  const isSelected = !!(selected || authoritativeSelected);
  const { visible, baseColor } = renderState;
  const outlineColor = isSelected ? selectionOutline() : null;
  const filamentColor = slicerMatch?.color;
  const effectiveBaseColor = filamentColor ?? baseColor;
  const useFilamentMaterial = selectedMode === "slicer";
  const material = useMemo(
    () =>
      useFilamentMaterial && filamentColor
        ? filamentMaterial(filamentColor, materialClassFor(slicerMatch!))
        : null,
    [useFilamentMaterial, filamentColor, slicerMatch],
  );

  if (!visible) return null;

  return (
    // name = the R3F scene-graph lookup key for the S9.3 gizmo target.
    <group
      name={info.name}
      ref={rootRef}
      position={transform.position}
      rotation={transform.rotation}
      scale={transform.scale}
    >
      {geometry ? (
        <mesh
          geometry={geometry}
          onClick={(e) => {
            e.stopPropagation();
            useScene.getState().select(info.name, info.watertight);
          }}
          onContextMenu={(e) => {
            e.stopPropagation();
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            if (!lockedRef.current) {
              onHover(true);
            }
          }}
          onPointerOut={() => onHover(false)}
        >
          {material ? (
            <primitive object={material} attach="material" />
          ) : (
            <meshStandardMaterial
              color={effectiveBaseColor}
              roughness={0.55}
              metalness={0.08}
              transparent
              opacity={0.92}
            />
          )}
        </mesh>
      ) : (
        <mesh
          position={box ? box.getCenter(new THREE.Vector3()).toArray() : undefined}
          scale={box ? box.getSize(new THREE.Vector3()).toArray() : undefined}
          onClick={(e) => {
            e.stopPropagation();
            useScene.getState().select(info.name, info.watertight);
          }}
          onContextMenu={(e) => {
            e.stopPropagation();
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            if (!lockedRef.current) {
              onHover(true);
            }
          }}
          onPointerOut={() => onHover(false)}
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
      {isSelected && box && outlineColor && (
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
            <meshBasicMaterial color={selectionGlow()} wireframe transparent opacity={0.35} />
          </mesh>
        </>
      )}
    </group>
  );
});
