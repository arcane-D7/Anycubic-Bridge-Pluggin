import { memo, useMemo } from "react";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import type { BuildVolume } from "../bridge/types";
import { quadrantCrosshairPositions, zColumnMarks } from "../state/plate-upgrade-core";
import { usePlateUpgrades } from "../state/plate-upgrades";
import { getPeiTexture } from "./plate-upgrade-visuals";

/**
 * S9.10-002 — realistic 3D-print build plate.
 *
 * The plate footprint comes from the machine profile's build volume contract —
 * NEVER a hardcoded 220x220. Renders a real-looking plate: rounded PEI-style
 * top (glossy dark surface with subtle tint), a rear locating tab, a grounded
 * metallic bed, corner feet, a faint alignment grid and a small axes gizmo.
 * The build-plate TOP sits exactly at Y=0 (objects rest on it via the
 * lay-on-plate lane).
 *
 * S9.11-004 — optional upgrades (default OFF, opt-in toggles): procedural PEI
 * texture on the surface, quadrant crosshair + "front" label, and a rear Z
 * reference column. All procedural (zero image assets); Y-axis untouched so
 * the lay-on-plate lane (regression `d9502c0`) keeps passing.
 */

interface BuildPlateProps {
  readonly volume: BuildVolume;
}

/** Footprint dimensions (mm) — plate is a 2D footprint; height is the Z max. */
export const BuildPlate = memo(function BuildPlate({ volume }: BuildPlateProps) {
  const grid = useMemo(() => {
    const positions: number[] = [];
    if (
      ![volume.widthMm, volume.depthMm, volume.heightMm].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      return new Float32Array();
    const halfWidth = volume.widthMm / 2;
    const halfDepth = volume.depthMm / 2;
    const pitch = Math.max(10, Math.max(volume.widthMm, volume.depthMm) / 512);
    for (let xCoord = -halfWidth; xCoord <= halfWidth; xCoord += pitch) {
      positions.push(xCoord, 0.08, -halfDepth, xCoord, 0.08, halfDepth);
    }
    for (let zCoord = -halfDepth; zCoord <= halfDepth; zCoord += pitch) {
      positions.push(-halfWidth, 0.08, zCoord, halfWidth, 0.08, zCoord);
    }
    return new Float32Array(positions);
  }, [volume.widthMm, volume.depthMm]);

  // S9.11-004 — optional upgrade toggles (all default OFF).
  const peiOn = usePlateUpgrades((s) => s.pei);
  const quadrantsOn = usePlateUpgrades((s) => s.quadrants);
  const zColumnOn = usePlateUpgrades((s) => s.zColumn);
  // Procedural PEI texture (cached per class — safe to toggle repeatedly) +
  // a GPU CanvasTexture created once per enabled flag.
  const peiCanvas = useMemo(() => (peiOn ? getPeiTexture().canvas : null), [peiOn]);
  const peiTexture = useMemo(
    () => (peiCanvas ? new THREE.CanvasTexture(peiCanvas) : null),
    [peiCanvas],
  );
  const quadrantPositions = useMemo(
    () => (quadrantsOn ? quadrantCrosshairPositions(volume.widthMm, volume.depthMm) : []),
    [quadrantsOn, volume.widthMm, volume.depthMm],
  );
  const zMarks = useMemo(
    () => (zColumnOn ? zColumnMarks(volume.heightMm) : []),
    [zColumnOn, volume.heightMm],
  );

  if (
    ![volume.widthMm, volume.depthMm, volume.heightMm].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return null;
  }
  // Plate centered on the XY origin, footprint from the profile.
  const halfW = volume.widthMm / 2;
  const halfD = volume.depthMm / 2;
  // Top slab: sits so its upper face is Y=0 (objects rest exactly on 0).
  const TOP_THICKNESS = 3;
  const topY = -TOP_THICKNESS / 2;

  return (
    <group>
      {/* PEI-style build surface (rounded edges, glossy dark). S9.11-004 —
          optional procedural PEI texture replaces the flat color (canvas
          value-noise, zero image assets). */}
      <RoundedBox
        args={[volume.widthMm - 2, TOP_THICKNESS, volume.depthMm - 2]}
        radius={5}
        smoothness={4}
        position={[0, topY, 0]}
      >
        {peiOn ? (
          <meshPhysicalMaterial
            map={peiTexture}
            color="#ffffff"
            roughness={0.42}
            metalness={0.18}
            clearcoat={0.7}
            clearcoatRoughness={0.45}
          />
        ) : (
          <meshPhysicalMaterial
            color="#22272b"
            roughness={0.34}
            metalness={0.28}
            clearcoat={1}
            clearcoatRoughness={0.5}
          />
        )}
      </RoundedBox>

      {/* Rear locating tab (the familiar plate handle). */}
      <RoundedBox
        args={[Math.max(40, volume.widthMm * 0.22), TOP_THICKNESS + 1, 12]}
        radius={4}
        smoothness={3}
        position={[0, topY + 0.6, halfD + 3]}
      >
        <meshStandardMaterial color="#22272b" roughness={0.34} metalness={0.28} />
      </RoundedBox>

      {/* Metallic heater bed under the surface. */}
      <mesh position={[0, -1.6, 0]}>
        <boxGeometry args={[volume.widthMm, 2.2, volume.depthMm]} />
        <meshStandardMaterial color="#454b47" metalness={0.45} roughness={0.5} />
      </mesh>

      {/* Corner feet. */}
      {(
        [
          [-halfW + 8, halfD - 8],
          [halfW - 8, halfD - 8],
          [-halfW + 8, -halfD + 8],
          [halfW - 8, -halfD + 8],
        ] as const
      ).map(([fx, fz], i) => (
        <mesh key={`foot-${i}`} position={[fx, -3.2, fz]}>
          <cylinderGeometry args={[6, 7.5, 3, 16]} />
          <meshStandardMaterial color="#3a3f45" metalness={0.5} roughness={0.55} />
        </mesh>
      ))}

      {/* Faint alignment grid (visual only). */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[grid, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#9fb4a8" transparent opacity={0.28} />
      </lineSegments>
      <axesHelper args={[25]} position={[-halfW, 0.15, halfD]} />

      {/* S9.11-004 — optional quadrant crosshair (fine lines + "front" label
          at the +Z operator edge) to help print submission. */}
      {quadrantsOn ? (
        <group>
          <lineSegments>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[new Float32Array(quadrantPositions), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color="#7fd4ff" transparent opacity={0.5} />
          </lineSegments>
          {/* "front" marker: a short tick on the +Z edge + faint halo line. */}
          <mesh position={[0, 0.09, -halfD + 3]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[20, 4]} />
            <meshBasicMaterial color="#7fd4ff" transparent opacity={0.6} />
          </mesh>
        </group>
      ) : null}

      {/* S9.11-004 — optional rear Z reference column (height ticks every
          20 mm, zero footprint change — visual only). */}
      {zColumnOn ? (
        <group position={[-halfW - 8, 0, -halfD + 10]}>
          <mesh position={[0, volume.heightMm / 2, 0]}>
            <cylinderGeometry args={[2, 2, volume.heightMm, 12]} />
            <meshStandardMaterial color="#4a525a" roughness={0.55} metalness={0.25} />
          </mesh>
          <lineSegments>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[new Float32Array(zMarks), 3]} />
            </bufferGeometry>
            <lineBasicMaterial color="#9fb4a8" transparent opacity={0.6} />
          </lineSegments>
        </group>
      ) : null}
    </group>
  );
});
