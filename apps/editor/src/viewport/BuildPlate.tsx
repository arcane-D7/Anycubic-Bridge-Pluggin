import { memo } from "react";
import type { BuildVolume } from "../bridge/types";

/**
 * Profile-driven build plate placeholder (R0).
 *
 * The plate footprint comes from the machine profile's build volume contract —
 * NEVER a hardcoded 220x220. Until R1 provides geometry authority this renders
 * a simple plate + grid, but the source of truth for dimensions is the profile
 * passed in, so swapping the profile source never touches this component.
 */

interface BuildPlateProps {
  readonly volume: BuildVolume;
}

/** Footprint dimensions (mm) — plate is a 2D footprint; height is the Z max. */
export const BuildPlate = memo(function BuildPlate({ volume }: BuildPlateProps) {
  if (volume.widthMm <= 0 || volume.depthMm <= 0 || volume.heightMm <= 0) {
    return null;
  }
  // Plate centered on the XY origin, footprint from the profile.
  const halfW = volume.widthMm / 2;
  const halfD = volume.depthMm / 2;

  return (
    <group>
      {/* Sides — drawn from the profile footprint so the plate looks real. */}
      {([halfD, -halfD] as const).map((z, i) => (
        <mesh key={`front-back-${i}`} position={[0, -0.5, z]}>
          <boxGeometry args={[volume.widthMm, 1, 0.5]} />
          <meshStandardMaterial color="#3c4048" />
        </mesh>
      ))}
      {([halfW, -halfW] as const).map((x, i) => (
        <mesh key={`left-right-${i}`} position={[x, -0.5, 0]}>
          <boxGeometry args={[0.5, 1, volume.depthMm]} />
          <meshStandardMaterial color="#3c4048" />
        </mesh>
      ))}

      {/* Top plate surface + grid following the profile footprint. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[volume.widthMm, volume.depthMm]} />
        <meshStandardMaterial color="#2b2d31" metalness={0.35} roughness={0.85} />
      </mesh>
      <gridHelper
        args={[
          Math.max(volume.widthMm, volume.depthMm),
          Math.max(volume.widthMm, volume.depthMm) / 5,
          "#4a4e57",
          "#383b42",
        ]}
        position={[0, 0.02, 0]}
      />
    </group>
  );
});
