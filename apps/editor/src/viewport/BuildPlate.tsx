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
 * NEVER a hardcoded 220x220. Modelled after real double-sided PEI sheets
 * (Bambu/Anycubic style): an outer FRAME rim (slightly thicker, large rounded
 * corners) holds an inner printable AREA (thin PEI surface with chamfered
 * corners) plus corner locator holes and a rear locating tab.
 *
 * P1-4-pass-4 (2026-10-06) — user feedback: "realistic plate shape".
 *  - OUTER FRAME (0.9 mm thick, its top at y=0) with big rounded corners.
 *  - INNER PRINT AREA (0.8 mm PEI layer) recessed by FRAME_INSET from every
 *    edge — the reference grid ends inside this boundary exactly like the
 *    real sheets (no grid crawling over the rim).
 *  - Corner locator holes (engraved cylinders) + rear tab.
 *  - Grid with LOGIC: minor/major lines clip to the printable area bounds
 *    (not the plate footprint) and stop at the border — realistic edges.
 *  - Engraved brand row (top), centered specs (middle), material + front
 *    arrow (bottom) — organized like the reference image.
 *
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

/** Plate layer thickness (mm) — a single thin surface; top face at y=0. */
const TOP_THICKNESS = 0.8;
/** Outer frame height (mm) — the raised rim that holds the sheet. */
const FRAME_THICKNESS = 0.9;
/** Inset of the printable area from the plate footprint edges (mm). */
const FRAME_INSET = 6;

/** Build plate grid line sets — minor (10 mm) + major (50 mm). Both lie just
 * above the PRINTABLE AREA (y=0.04) and are clipped to its bounds, so the
 * grid ends at the area boundary — never over the outer rim. */
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
  const halfWidth = volume.widthMm / 2 - FRAME_INSET;
  const halfDepth = volume.depthMm / 2 - FRAME_INSET;
  const minorPitch = 10;
  const majorPitch = 50;
  const minor: number[] = [];
  const major: number[] = [];
  for (let xMark = -halfWidth; xMark <= halfWidth; xMark += minorPitch) {
    const line = [xMark, 0.04, -halfDepth, xMark, 0.04, halfDepth];
    if (Math.abs(xMark) % majorPitch === 0) major.push(...line);
    else minor.push(...line);
  }
  for (let zMark = -halfDepth; zMark <= halfDepth; zMark += minorPitch) {
    const line = [-halfWidth, 0.04, zMark, halfWidth, 0.04, zMark];
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
  // Printable area (inside the outer rim) — the reference grid and quadrant
  // crosshair are clipped to this boundary (realistic sheet edges).
  const areaW = volume.widthMm - FRAME_INSET * 2;
  const areaD = volume.depthMm - FRAME_INSET * 2;
  const quadrantPositions = useMemo(
    () => (quadrantsOn ? quadrantCrosshairPositions(areaW, areaD) : []),
    [quadrantsOn, areaW, areaD],
  );
  // Single thin layer: upper face at Y=0. The frame is slightly THICKER and
  // its top also sits at y=0 (rim flush with the sheet surface).
  const topY = -TOP_THICKNESS / 2;
  const frameTopY = -FRAME_THICKNESS / 2;
  // Specs text: W × D × H from the profile build volume, centered row.
  const specs = `${volume.widthMm} × ${volume.depthMm} × ${volume.heightMm} mm`;

  // Locator holes on the printable-area corners (like real double-sided
  // sheets): tiny engraved cylinders, slightly proud of the surface.
  const drawer = Math.min(areaW, areaD) * 0.14;
  const cornerOffsets: readonly [number, number][] = [
    [-areaW / 2 + drawer, -areaD / 2 + drawer],
    [areaW / 2 - drawer, -areaD / 2 + drawer],
    [-areaW / 2 + drawer, areaD / 2 - drawer],
    [areaW / 2 - drawer, areaD / 2 - drawer],
  ];

  return (
    <group>
      {/* OUTER FRAME — raised rim with soft rounded corners (top at y=0). */}
      <RoundedBox
        args={[volume.widthMm - 1, FRAME_THICKNESS, volume.depthMm - 1]}
        radius={0.45}
        smoothness={2}
        position={[0, frameTopY, 0]}
      >
        <meshStandardMaterial color="#2a2f34" roughness={0.4} metalness={0.35} />
      </RoundedBox>

      {/* INNER PRINTABLE AREA — thin PEI surface, soft corners, recessed
          inside the frame (top face at y=0). */}
      <RoundedBox
        args={[areaW, TOP_THICKNESS, areaD]}
        radius={0.4}
        smoothness={2}
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
            clearcoat={0.6}
            clearcoatRoughness={0.5}
          />
        )}
      </RoundedBox>

      {/* Corner locator holes — engraved cylinders proud of the surface. */}
      {cornerOffsets.map(([cx, cz], i) => (
        <mesh key={`locator-${i}`} position={[cx, -0.05, cz]}>
          <cylinderGeometry args={[2.6, 2.6, 0.5, 20]} />
          <meshStandardMaterial color="#1a1e22" roughness={0.5} metalness={0.3} />
        </mesh>
      ))}

      {/* Rear locating tab — thin, flush with the plate. */}
      <RoundedBox
        args={[Math.max(40, volume.widthMm * 0.22), TOP_THICKNESS, 12]}
        radius={0.3}
        smoothness={2}
        position={[0, topY, halfD + 3]}
      >
        <meshStandardMaterial color="#2a2f34" roughness={0.34} metalness={0.28} />
      </RoundedBox>

      {/* Grid with LOGIC: minor/major lines clip to the printable-area bounds
          and stop at the border — like a real sheet; never over the rim.
          Pass-4: brighter colors + higher opacity (visible from any angle). */}
      {gridOn && minorGrid.length > 0 ? (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[minorGrid, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#b8d4c4" transparent opacity={0.38} depthTest />
        </lineSegments>
      ) : null}
      {gridOn && majorGrid.length > 0 ? (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[majorGrid, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#e8f4ee" transparent opacity={0.85} depthTest />
        </lineSegments>
      ) : null}
      <axesHelper args={[25]} position={[-halfW, 0.1, halfD]} />

      {/* Engraved markings — organized like the reference: brand row on the
          top edge, centered specs, material + front arrow on the bottom. */}
      <Text
        position={[0, 0.2, -areaD / 2 - 2.4]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={volume.widthMm > 230 ? 4.6 : 4.2}
        color="#e8f4ee"
        anchorX="center"
        anchorY="middle"
        letterSpacing={1.1}
        fillOpacity={0.55}
        renderOrder={5}
      >
        ANYCUBIC · S1
      </Text>
      <Text
        position={[0, 0.18, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={volume.widthMm > 230 ? 4.2 : 3.8}
        color="#b8d4c4"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.5}
        fillOpacity={0.5}
        renderOrder={5}
      >
        {specs}
      </Text>
      <Text
        position={[0, 0.2, areaD / 2 + 2.4]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={4}
        color="#b8d4c4"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.6}
        fillOpacity={0.45}
        renderOrder={5}
      >
        PEI · DOUBLE-SIDED
      </Text>
      {/* Front orientation marker — a subtle arrow tick on the +Z (front)
          edge, just inside the printable area, matching the quadrant
          crosshair's "front" convention (both at +Z). */}
      <mesh position={[0, 0.06, areaD / 2 - 6]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[12, 2.5]} />
        <meshBasicMaterial color="#7fd4ff" transparent opacity={0.5} />
      </mesh>

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
          <mesh position={[0, 0.05, areaD / 2 + 3]} rotation={[-Math.PI / 2, 0, 0]}>
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
