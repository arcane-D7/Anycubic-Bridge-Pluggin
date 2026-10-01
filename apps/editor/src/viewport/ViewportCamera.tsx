import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useCallback, useEffect, useRef } from "react";
import { VIEW_PRESET_EVENT } from "./Toolbar";
import { type ViewPreset, VIEW_PRESETS } from "../state/toolbar";
import { cellDirection, homeDirection, type ViewCubeCell } from "../state/camera-core";

/**
 * S9.4-002 damped camera tween (AC-1).
 *
 * Sits inside the <Canvas> (camera + scene graph access). Listens for:
 * - `VIEW_PRESET_EVENT` (toolbar presets) and the view cube click event
 *   (`VIEW_CUBE_EVENT`) — both carry a named orientation; the camera eases
 *   (damped lerp) from its current orbit to the preset position around the
 *   current target WITHOUT disturbing OrbitControls target (damping enabled
 *   upstream in `Viewport`). The tween runs a small rAF loop that writes the
 *   camera position each frame and stops when the delta is below epsilon.
 *
 * The plate front is -Z in three.js, so "front" approaches from +Z (see
 * `camera-core`). Home = isometric (top-front-right).
 */

export interface ViewCubeEventDetail {
  /** `null` = home (isometric). */
  readonly cell: ViewCubeCell | null;
}

/** DOM event the view cube dispatches (bottom-right UI tile). */
export const VIEW_CUBE_EVENT = "anycubic:viewport-cube";

const TWEEN_MS = 520;

export function ViewportCamera() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls as unknown as { target?: THREE.Vector3 } | null);
  const rafRef = useRef(0);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  const tweenTo = useCallback((direction: readonly [number, number, number]) => {
    const cam = cameraRef.current as THREE.PerspectiveCamera;
    const target = controlsRef.current?.target ?? new THREE.Vector3(0, 0, 0);
    // Distance preserved from the current position so zoom level stays put.
    const from = cam.position.clone();
    const dist = Math.max(from.distanceTo(target), 1);
    const dir = new THREE.Vector3(...direction).normalize();
    const to = target.clone().add(dir.multiplyScalar(dist));

    // Stop any previous tween.
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const fromPos = cam.position.clone();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TWEEN_MS);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      cam.position.lerpVectors(fromPos, to, eased);
      cam.lookAt(target);
      cam.updateProjectionMatrix();
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    const onPreset = (e: Event) => {
      const preset = (e as CustomEvent<{ preset: ViewPreset }>).detail?.preset;
      if (!preset) return;
      tweenTo(VIEW_PRESETS[preset].direction);
    };
    const onCube = (e: Event) => {
      const cell = (e as CustomEvent<ViewCubeEventDetail>).detail?.cell;
      if (cell === undefined) return; // no detail → ignore
      // null = home isometric; faces/corners/edges use the cell direction.
      tweenTo(cell === null ? homeDirection() : cellDirection(cell));
    };
    window.addEventListener(VIEW_PRESET_EVENT, onPreset);
    window.addEventListener(VIEW_CUBE_EVENT, onCube);
    return () => {
      window.removeEventListener(VIEW_PRESET_EVENT, onPreset);
      window.removeEventListener(VIEW_CUBE_EVENT, onCube);
    };
  }, [tweenTo]);

  return null;
}
