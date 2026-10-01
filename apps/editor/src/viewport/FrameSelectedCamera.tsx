import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useCallback, useEffect } from "react";
import { useScene } from "../state/scene";
import { FRAME_SELECTED_EVENT } from "../state/shortcuts-core";

/**
 * S9.3-003 — keyboard "F" frame selection (G32).
 *
 * Sits inside the <Canvas> (access to the R3F camera + scene graph).
 * Listens for the `FRAME_SELECTED_EVENT` dispatched by the shortcut layer.
 * Frames the selected object's world bbox (whole scene when nothing is
 * selected) by moving the camera to a fitted vantage without touching
 * OrbitControls' internal state — the look-at target is the bbox center and
 * the distance respects the object's size so it fills the view nicely.
 */

const BBOX_PAD_FACTOR = 1.35;

export function FrameSelectedCamera() {
  const camera = useThree((s) => s.camera);
  const sceneMain = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const objects = useScene((s) => s.objects);
  const selectedName = useScene((s) => s.selected?.name ?? null);

  const frameSelected = useCallback(() => {
    const name = selectedName ?? null;
    const target = name ? sceneMain?.getObjectByName(name) : undefined;
    // No selection → frame the whole scene (first object's group bounds,
    // which sits on the plate center).
    const resolved =
      target ?? (objects.length > 0 ? sceneMain?.getObjectByName(objects[0]!.name) : undefined);
    if (!resolved) return;

    const box = new THREE.Box3().setFromObject(resolved);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const radiusRaw = box.getBoundingSphere(new THREE.Sphere()).radius;
    const radius = Math.max(radiusRaw, 1) * BBOX_PAD_FACTOR;

    const fovRad = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
    const aspect = Math.max(0.2, size.width / Math.max(1, size.height));
    const limitingAngle = Math.min(fovRad / 2, Math.atan(Math.tan(fovRad / 2) * aspect));
    const dist = radius / Math.sin(limitingAngle);
    const offset = new THREE.Vector3(0.36, 0.62, 0.7).normalize().multiplyScalar(dist);

    camera.position.copy(center).add(offset);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  }, [camera, sceneMain, objects, selectedName, size.width, size.height]);

  useEffect(() => {
    const onFrame = () => frameSelected();
    window.addEventListener(FRAME_SELECTED_EVENT, onFrame);
    return () => window.removeEventListener(FRAME_SELECTED_EVENT, onFrame);
  }, [frameSelected]);

  return null;
}
