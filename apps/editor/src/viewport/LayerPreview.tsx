import { useMemo } from "react";
import type { PreviewModel } from "./preview-model";
import { previewLayerAt } from "./preview-model";

const WALL_COLOR = "#4f9cf7";
const INFILL_COLOR = "#22c55e";
const TRAVEL_COLOR = "#59616f";

type ScenePoint = readonly [number, number, number];

interface LayerPreviewProps {
  readonly model: PreviewModel;
  readonly layerIndex: number;
  readonly showWalls: boolean;
  readonly showInfill: boolean;
}

export interface PreviewFit {
  readonly center: ScenePoint;
  readonly radius: number;
}

function toScene(point: readonly [number, number, number]): ScenePoint {
  return [point[0], point[2], -point[1]];
}

export function previewFit(model: PreviewModel): PreviewFit {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const layer of model.layers) {
    for (const path of layer.toolpaths) {
      for (const p of [toScene(path.from), toScene(path.to)]) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        minZ = Math.min(minZ, p[2]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
        maxZ = Math.max(maxZ, p[2]);
      }
    }
  }
  if (!Number.isFinite(minX)) {
    return { center: [0, 0, 0], radius: 100 };
  }
  const center: ScenePoint = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
  return { center, radius };
}

export function LayerPreview({ model, layerIndex, showWalls, showInfill }: LayerPreviewProps) {
  const paths = useMemo(() => previewLayerAt(model, layerIndex), [model, layerIndex]);

  const buffers = useMemo(() => {
    const walls: number[] = [];
    const infill: number[] = [];
    const travel: number[] = [];
    for (const path of paths) {
      const from = toScene(path.from);
      const to = toScene(path.to);
      const bucket = path.kind === "WALL" ? walls : path.kind === "INFILL" ? infill : travel;
      bucket.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    }
    return {
      walls: new Float32Array(walls),
      infill: new Float32Array(infill),
      travel: new Float32Array(travel),
    };
  }, [paths]);

  return (
    <group data-testid="preview-lines">
      <PathLines positions={buffers.travel} color={TRAVEL_COLOR} layerKey={layerIndex} />
      {showWalls ? (
        <PathLines positions={buffers.walls} color={WALL_COLOR} layerKey={layerIndex} />
      ) : null}
      {showInfill ? (
        <PathLines positions={buffers.infill} color={INFILL_COLOR} layerKey={layerIndex} />
      ) : null}
    </group>
  );
}

function PathLines({
  positions,
  color,
  layerKey,
}: {
  readonly positions: Float32Array;
  readonly color: string;
  readonly layerKey: number;
}) {
  if (positions.length === 0) return null;
  return (
    <lineSegments key={layerKey}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.95} />
    </lineSegments>
  );
}
