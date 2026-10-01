import { memo, useEffect, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneObjectSnapshot } from "../bridge/types";
import { useUi } from "../state/ui";
import { clearNdc, readNdc, useLabelsBus, writeNdc } from "../state/labels";
import { clampChip, ndcToViewport, statusOf } from "./labels-core";

/**
 * S9.8-002 (G45) — viewport object label chips (hover + always-on).
 *
 * Two thin pieces, zero canvas re-renders for labels:
 *
 * - `LabelProjector` mounts INSIDE the R3F Canvas. Each frame it projects
 *   every visible object's bounding-box top-center into NDC through the LIVE
 *   object3D matrix (via the shared `anchorProbes` registry from
 *   `SceneObjectModel`), writing into the mutable labels bus (`state/labels`)
 *   and bumping `frame`.
 * - `ObjectLabels` mounts OUTSIDE the Canvas (sibling overlay, same pattern
 *   as ViewCube/NonWatertightBadges). It subscribes to `frame`, converts NDC
 *   → CSS pixels, clamps, and renders tiny glass chips. Always-on toggle from
 *   the toolbar forces every chip; otherwise chips show for the hovered
 *   object (hover comes from the scene's mesh pointer events via the bus).
 */

/** Shared registry: SceneObjectModel registers its live anchor probe so the
 *  projector can follow gizmo drags without re-architecting the scene. */
const anchorProbes = new Map<
  string,
  () => { readonly x: number; readonly y: number; readonly z: number } | null
>();

export function registerAnchorProbe(
  name: string,
  probe: () => { readonly x: number; readonly y: number; readonly z: number } | null,
): () => void {
  anchorProbes.set(name, probe);
  return () => anchorProbes.delete(name);
}

const vec3 = new THREE.Vector3();

function worldAnchorToNdc(
  anchor: { readonly x: number; readonly y: number; readonly z: number },
  camera: THREE.Camera,
): { readonly x: number; readonly y: number; readonly z: number; readonly behind: boolean } {
  // World space → NDC (the probe already ran localToWorld on the group).
  vec3.set(anchor.x, anchor.y, anchor.z);
  vec3.project(camera);
  const behind = vec3.z > 1;
  return { x: vec3.x, y: vec3.y, z: vec3.z, behind };
}

/**
 * In-canvas projector: runs `THREE.Matrix4` math each frame. Projected NDC
 * is pushed into the bus; the overlay does the CSS conversion.
 */
export function LabelProjector({ objects }: { readonly objects: readonly SceneObjectSnapshot[] }) {
  const camera = useThree((s) => s.camera);
  const bump = useLabelsBus((s) => s.bump);
  const size = useThree((s) => s.size);
  const { width, height } = size;

  useEffect(() => {
    let raf = 0;
    let alive = true;

    const tick = () => {
      if (!alive) return;
      for (const o of objects) {
        const probe = anchorProbes.get(o.name);
        if (!probe) {
          writeNdc(o.name, { x: 0, y: 0, behind: true });
          continue;
        }
        const anchor = probe();
        if (!anchor) {
          writeNdc(o.name, { x: 0, y: 0, behind: true });
          continue;
        }
        const p = worldAnchorToNdc(anchor, camera);
        writeNdc(o.name, { x: p.behind ? 0 : p.x, y: p.behind ? 0 : p.y, behind: p.behind });
      }
      bump();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearNdc();
    };
  }, [camera, objects, bump, width, height]);

  return null;
}

/** Out-of-canvas overlay: chips in CSS pixels. */
export const ObjectLabels = memo(function ObjectLabels({
  objects,
}: {
  readonly objects: readonly SceneObjectSnapshot[];
}) {
  const frame = useLabelsBus((s) => s.frame);
  const hoveredName = useLabelsBus((s) => s.hoveredName);
  const alwaysOn = useUi((s) => s.objectLabelsAlwaysOn);
  const [dim, setDim] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setDim({ width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The reactive key is the frame counter; keep it referenced so the overlay
  // re-reads the bus every projector pass.
  void frame;

  return (
    <div
      className="viewport-labels"
      data-testid="viewport-labels"
      ref={rootRef}
      onPointerLeave={() => useLabelsBus.getState().setHovered(null)}
    >
      {dim.width > 0 &&
        dim.height > 0 &&
        objects.map((o) => {
          const pt = readNdc(o.name);
          if (!pt || pt.behind) return null;
          const status = statusOf(o.watertight, o.locked);
          const show = alwaysOn || hoveredName === o.name;
          const screen = ndcToViewport(pt.x, pt.y, dim.width, dim.height);
          const clamped = clampChip(screen.x, screen.y, dim, 4);
          return (
            <div
              key={o.name}
              className={`object-label-chip${show ? " is-visible" : ""}${
                alwaysOn ? " is-always-on" : ""
              }`}
              data-testid={`object-label-${o.name}`}
              data-status={status}
              style={{
                left: clamped.x + "px",
                top: clamped.y + "px",
                opacity: show ? 1 : 0,
                pointerEvents: show ? "auto" : "none",
              }}
              title={o.name}
            >
              <span className="object-label-dot" aria-hidden="true" />
              <span className="object-label-name">{o.name}</span>
              {status !== "watertight" ? (
                <span className="object-label-status">{status}</span>
              ) : null}
            </div>
          );
        })}
    </div>
  );
});
