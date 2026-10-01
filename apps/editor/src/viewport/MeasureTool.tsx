import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneObjectSnapshot } from "../bridge/types";
import { useMeasure } from "../state/measure";
import { useUi } from "../state/ui";
import { pushProbe as reduceProbe, type MeasurePoint } from "./measure-core";

/**
 * S9.8-003 (G42) — Measure tool (distance / radius / angle probe).
 *
 * In-canvas piece: while `useMeasure.active` the gizmo is hidden and canvas
 * clicks raycast against REAL object geometry (S9.2 buffers) to collect probe
 * points. The deterministic math lives in `measure-core.ts` (headless tested):
 * `pushProbe` reduces the click stream to a measurement and the residual
 * points. Markers (world-space spheres + polyline) mirror the probes.
 *
 * The readout overlay (bottom-left, mono) is OUT-OF-CANVAS — mounted in
 * `Viewport` next to the other overlays — and subscribes to the same store,
 * so canvas re-renders are avoided (labels pattern).
 *
 * Kind switching `setKind` clears the stream; reading a full set resets to
 * the residual last point. `clear` wipes everything (readout button).
 */

interface MeasureToolProps {
  readonly objects: readonly SceneObjectSnapshot[];
}

export function MeasureTool({ objects }: MeasureToolProps) {
  const active = useMeasure((s) => s.active);
  const kind = useMeasure((s) => s.kind);
  const probes = useMeasure((s) => s.probes);
  const pushProbe = useMeasure((s) => s.pushProbe);
  const bumpMarkers = useMeasure((s) => s.bumpMarkers);
  const markToken = useMeasure((s) => s.markToken);
  const tool = useUi((s) => s.tool);

  // Drive the measure store's active flag from the toolbar mode (M key /
  // toolbar toggle both land here through useUi.setTool).
  useEffect(() => {
    useMeasure.getState().setActive(tool === "measure");
  }, [tool]);

  const camera = useThree((s) => s.camera);
  const sceneGraph = useThree((s) => s.scene);
  const raycaster = useRef(new THREE.Raycaster());
  const pointer = useRef(new THREE.Vector2());
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const probesRef = useRef(probes);
  probesRef.current = probes;

  // Capture clicks on the three canvas while active.
  useEffect(() => {
    if (!active) return;
    const canvas = document.querySelector("canvas");
    if (!canvas) return;

    const onClick = (e: MouseEvent) => {
      // Ignore clicks on the readout/kind strip (overlay above the canvas).
      if (
        e.target instanceof HTMLElement &&
        e.target.closest(".measure-readout, .measure-kind, .measure-clear")
      ) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      pointer.current.x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      pointer.current.y = -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      raycaster.current.setFromCamera(pointer.current, camera);

      // Raycast against the real meshes (group name = snapshot name).
      const meshes: THREE.Mesh[] = [];
      for (const o of objectsRef.current) {
        const obj = sceneGraph.getObjectByName(o.name);
        if (!obj) continue;
        obj.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
      }
      if (meshes.length === 0) return;
      const hits = raycaster.current.intersectObjects(meshes, false);
      if (hits.length === 0) return;
      const p = hits[0]!.point;
      const next = reduceProbe(kindRef.current, probesRef.current, {
        x: p.x,
        y: p.y,
        z: p.z,
      });
      probesRef.current = next.points;
      pushProbe(next.points, next.result);
      bumpMarkers();
    };

    canvas.addEventListener("click", onClick);
    return () => canvas.removeEventListener("click", onClick);
  }, [active, camera, sceneGraph, pushProbe, bumpMarkers]);

  if (!active) return null;
  return <MeasureMarkers points={probes} markToken={markToken} />;
}

/** World-space markers: probe points (small spheres) + connecting polyline. */
function MeasureMarkers({
  points,
  markToken,
}: {
  readonly points: readonly MeasurePoint[];
  readonly markToken: number;
}) {
  void markToken; // replay token — re-renders markers after each probe
  const positions = useMemo(() => {
    const arr: number[] = [];
    for (const p of points) arr.push(p.x, p.y, p.z);
    return new Float32Array(arr);
  }, [points]);
  return (
    <group>
      {points.map((p, i) => (
        <mesh key={i} position={[p.x, p.y, p.z]}>
          <sphereGeometry args={[1.2, 10, 10]} />
          <meshBasicMaterial color="#4f9cf7" />
        </mesh>
      ))}
      {points.length >= 2 ? (
        <line>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#4f9cf7" transparent opacity={0.85} />
        </line>
      ) : null}
    </group>
  );
}
