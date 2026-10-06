/**
 * S9.11-003 — live-mode real-state overlay (R3F).
 *
 * Renders the toolhead (from the printer `motion`), the nozzle sphere colored
 * by the loaded filament, a floating "spray of data" (%, layer, temps) and an
 * animated vertical layer bar beside the model. Purpose: instant visual
 * confirmation of the live job.
 *
 * Performance contract (AC): toolhead updates ≤ 4 Hz and the FULL scene graph
 * is not re-rendered — the overlay reads the printer snapshot OUTSIDE the R3F
 * render tree (zustand selector) and mutates a small THREE group imperatively
 * on a throttled timer; React only re-renders the overlay subtree, never the
 * meshes of the scene.
 */

import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { BuildVolume } from "../bridge/types";
import { usePrinterDevice } from "../state/printer-device";
import {
  LIVE_UPDATE_MS,
  layerBarFraction,
  nozzleColor,
  shouldUpdateLive,
  sprayLayerText,
  sprayPct,
  toolheadWorld,
  NOZZLE_NEUTRAL_HEX,
} from "../state/live-overlay-core";
import { useViewMode } from "../state/view-mode";

interface LiveOverlayProps {
  readonly volume: BuildVolume | null;
}

const NOZZLE_RADIUS = 3.4;

/** Vertical layer bar (animated fraction) — a 1-unit mesh scaled by ratio. */
function LayerBar({ fraction }: { readonly fraction: number | null }) {
  if (fraction === null) return null;
  const h = Math.max(0.02, Math.min(1, fraction));
  return (
    <mesh position={[0, h / 2 - 0.5, 0]}>
      <boxGeometry args={[0.12, 1, 0.12]} />
      <meshStandardMaterial color="#4fa8dc" transparent opacity={0.85} />
      <mesh position={[0, (1 - h) / 2, 0]}>
        <boxGeometry args={[0.12, 1, 0.12]} />
        <meshStandardMaterial color="#4fa8dc" transparent opacity={0.35} />
      </mesh>
    </mesh>
  );
}

/**
 * The live overlay. Reads the LAST GOOD snapshot (kept stale by the device
 * store on failures) at most every 250 ms; the toolhead/nozzle group is
 * mutated imperatively so a 4 Hz tick never re-renders the parent scene.
 */
export const LiveOverlay = memo(function LiveOverlay({ volume }: LiveOverlayProps) {
  const snapshot = usePrinterDevice((s) => s.snapshot);
  const viewMode = useViewMode((s) => s.mode);

  const groupRef = useRef<THREE.Group>(null);
  const nozzleRef = useRef<THREE.Mesh>(null);
  const lastApplied = useRef(0);

  const boxes = snapshot?.ace.boxes ?? [];
  const motion = snapshot?.motion ?? null;
  const progress = snapshot?.print ?? null;
  const temp = snapshot?.temps ?? null;

  // Driver for the ≤ 4 Hz tick — no re-render per frame.
  useEffect(() => {
    const apply = () => {
      const now = Date.now();
      if (!shouldUpdateLive(lastApplied.current, now)) return;
      lastApplied.current = now;
      const world = toolheadWorld(motion, volume);
      const g = groupRef.current;
      if (g && world) {
        g.position.set(world.x, world.y + 5, world.z);
        const n = nozzleRef.current;
        if (n) {
          const color = nozzleColor(boxes);
          (n.material as THREE.MeshStandardMaterial).color.set(color);
        }
      }
    };
    apply();
    const id = window.setInterval(apply, LIVE_UPDATE_MS);
    return () => window.clearInterval(id);
  }, [motion, volume, boxes]);

  const fraction = useMemo(() => layerBarFraction(progress), [progress]);
  const active = viewMode === "live" && snapshot !== null;

  if (!active) return null;
  return (
    <group>
      {/* Toolhead carriage (imperatively moved). */}
      <group ref={groupRef}>
        <mesh>
          <boxGeometry args={[18, 14, 22]} />
          <meshStandardMaterial color="#2c3035" metalness={0.4} roughness={0.45} />
        </mesh>
        {/* Nozzle — colored by loaded filament. */}
        <mesh ref={nozzleRef} position={[0, -12, 0]}>
          <coneGeometry args={[NOZZLE_RADIUS, 8, 16]} />
          <meshStandardMaterial color={NOZZLE_NEUTRAL_HEX} metalness={0.7} roughness={0.3} />
        </mesh>
      </group>

      {/* Spray of data: % + layer + nozzle temp floating near the toolhead. */}
      <group position={[26, 120, -40]}>
        <mesh>
          <boxGeometry args={[96, 36, 2]} />
          <meshBasicMaterial color="#0f1418" transparent opacity={0.82} />
        </mesh>
        {/* Three text sprites (16 font) — HUD-like. */}
        <TextSprite text={`${sprayPct(progress) ?? "—"}%`} y={12} />
        <TextSprite text={sprayLayerText(progress) ?? "—"} y={-2} />
        <TextSprite
          text={
            temp?.nozzle != null
              ? `${temp.nozzle.currentC ?? "—"}°/${temp.nozzle.targetC ?? "—"}°`
              : "—"
          }
          y={-16}
        />
      </group>

      {/* Vertical layer bar alongside the model (animated fraction). */}
      <group position={[volume ? volume.widthMm / 2 - 12 : 0, 0, 0]}>
        <LayerBar fraction={fraction} />
      </group>
    </group>
  );
});

/** Minimal DOM-2D text as a THREE sprite (no font assets — canvas text). */
function TextSprite({ text, y }: { readonly text: string; readonly y: number }) {
  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#e8ecef";
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, 128, 32);
    return c;
  }, [text]);
  const texture = useMemo(() => new THREE.CanvasTexture(canvas), [canvas]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={[0, y, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

export { NOZZLE_NEUTRAL_HEX };
