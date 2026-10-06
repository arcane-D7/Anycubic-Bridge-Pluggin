import { memo, useMemo } from "react";
import { RoundedBox, Text } from "@react-three/drei";
import * as THREE from "three";
import type { BuildVolume } from "../bridge/types";
import { quadrantCrosshairPositions, zColumnMarks } from "../state/plate-upgrade-core";
import { usePlateUpgrades } from "../state/plate-upgrades";
import { useToolbar } from "../state/toolbar";
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
 *
 * P1-4 (2026-10-06) — user feedback pass:
 *  - thinner plate: the metal bed no longer intersects the top slab (the top
 *    face stays EXACTLY at y=0; the bed sits fully below the slab) so objects
 *    no longer look embedded in an over-thick block.
 *  - readable minor/major reference grid (default ON, depth-tested so it hides
 *    behind objects instead of z-fighting through them).
 *  - plate specs text (W × D × H from the profile build volume) on the +Z
 *    operator edge — the same value the DOM status bar shows.
 */

interface BuildPlateProps {
  readonly volume: BuildVolume;
}

/** Top slab thickness (mm) — visually thin, top face at y=0. */
const TOP_THICKNESS = 1.4;
/** Heater bed thickness (mm) — sits ENTIRELY below the slab. */
const BED_THICKNESS = 1.6;
/** Gap between slab underside and bed top (mm). */
const BED_GAP = 0.4;

/** Build plate grid line sets — minor (10 mm) + major (50 mm). Both are
 * depth-tested: they lie just above the surface (y=0.08) so objects resting
 * on the plate correctly occlude them. */
function plateGridPositions(volume: BuildVolume): {
  readonly minor: Float32Array;
  readonly major: Float32Array;
} {
  if (
    ![volume.widthMm, volume.depthMm, volume.heightMm].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return { minor: new Float32Array(), major: new Float32Array() };
  }
  const halfWidth = volume.widthMm / 2;
  const halfDepth = volume.depthMm / 2;
  const minorPitch = 10;
  const majorPitch = 50;
  const minor: number[] = [];
  const major: number[] = [];
  for (let xMark = -halfWidth; xMark <= halfWidth; xMark += minorPitch) {
    const line = [xMark, 0.08, -halfDepth, xMark, 0.08, halfDepth];
    if (Math.abs(xMark) % majorPitch === 0) major.push(...line);
    else minor.push(...line);
  }
  for (let zMark = -halfDepth; zMark <= halfDepth; zMark += minorPitch) {
    const line = [-halfWidth, 0.08, zMark, halfWidth, 0.08, zMark];
    if (Math.abs(zMark) % majorPitch === 0) major.push(...line);
    else minor.push(...line);
  }
  return {
    minor: new Float32Array(minor),
    major: new Float32Array(major),
  };
}

/** Footprint dimensions (mm) — plate is a 2D footprint; height is the Z max. */
export const BuildPlate = memo(function BuildPlate({ volume }: BuildPlateProps) {
  const { minor: minorGrid, major: majorGrid } = useMemo(
    () => plateGridPositions(volume),
    [volume],
  );
  // P1-4 — the reference grid is a toolbar flag (shared with the toolbar
  // toggle + the plate rail); default ON but users can hide it.
  const gridOn = useToolbar((s) => s.grid);

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
  const topY = -TOP_THICKNESS / 2;
  // Bed: top gap below the slab underside (-TOP_THICKNESS), then the slab.
  const bedTop = -(TOP_THICKNESS + BED_GAP);
  const bedY = bedTop - BED_THICKNESS / 2;
  // Feet: below the bed, small cylinders.
  const footY = bedBottom(bedY, BED_THICKNESS) - 1.2;
  // Specs text: W × D × H from the profile build volume on the +Z operator edge.
  const specs = `${volume.widthMm} × ${volume.depthMm} × ${volume.heightMm} mm`;

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

      {/* Metallic heater bed UNDER the surface (no overlap with the slab —
          P1-4: the plate looks thin and objects sit ON it, not inside). */}
      <mesh position={[0, bedY, 0]}>
        <boxGeometry args={[volume.widthMm, BED_THICKNESS, volume.depthMm]} />
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
        <mesh key={`foot-${i}`} position={[fx, footY, fz]}>
          <cylinderGeometry args={[6, 7.5, 3, 16]} />
          <meshStandardMaterial color="#3a3f45" metalness={0.5} roughness={0.55} />
        </mesh>
      ))}

      {/* P1-4 — readable reference grid: minor (10 mm, faint) + major
          (50 mm, clearer). Both depth-tested — objects occlude them.
          Hidden when the toolbar grid flag is off (default ON). */}
      {gridOn && minorGrid.length > 0 ? (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[minorGrid, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#9fb4a8" transparent opacity={0.16} depthTest />
        </lineSegments>
      ) : null}
      {gridOn && majorGrid.length > 0 ? (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[majorGrid, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#cfe0d6" transparent opacity={0.42} depthTest />
        </lineSegments>
      ) : null}
      <axesHelper args={[25]} position={[-halfW, 0.15, halfD]} />

      {/* P1-4 — plate specs (W × D × H from the profile build volume), on the
          +Z operator edge. drei <Text> renders a real mesh so it follows the
          camera; the same value is exposed as the DOM status-bar aria. */}
      <Text
        position={[0, 0.28, halfD - (volume.depthMm > 220 ? 34 : 26)]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={volume.widthMm > 230 ? 9 : 8}
        color="#9fb4a8"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.6}
        fillOpacity={0.85}
        renderOrder={5}
      >
        {specs}
      </Text>

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

/** Helper: bottom of the bed. */
function bedBottom(bedY: number, bedThickness: number): number {
  return bedY - bedThickness / 2;
}
