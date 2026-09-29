import { memo, useMemo } from "react";
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

      <mesh position={[0, -1.3, 0]}>
        <boxGeometry args={[volume.widthMm, 2.6, volume.depthMm]} />
        <meshStandardMaterial color="#454b47" metalness={0.15} roughness={0.85} />
      </mesh>
      <mesh position={[0, -1.3, halfD + 4]}>
        <boxGeometry args={[volume.widthMm * 0.2, 2.6, 8]} />
        <meshStandardMaterial color="#454b47" roughness={0.85} />
      </mesh>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[grid, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#748078" transparent opacity={0.55} />
      </lineSegments>
      <axesHelper args={[25]} position={[-halfW, 0.15, halfD]} />
    </group>
  );
});
