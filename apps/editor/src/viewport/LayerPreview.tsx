import { useMemo } from "react";
import { sliceIrToEditorWorld } from "../state/coordinate-frames";
import type { PreviewModel } from "./preview-model";
import { previewLayerAt } from "./preview-model";

const WALL_COLOR = "#4f9cf7";
const INFILL_COLOR = "#22c55e";
const TRAVEL_COLOR = "#59616f";
const ADHESION_COLOR = "#e0a24a";
const SUPPORT_COLOR = "#b8860b";
const AUXILIARY_COLOR = "#a56b9f";

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
  return sliceIrToEditorWorld(point);
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
    const byKind = new Map<string, number[]>();
    for (const path of paths) {
      const from = toScene(path.from);
      const to = toScene(path.to);
      const bucket = byKind.get(path.kind) ?? [];
      bucket.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      byKind.set(path.kind, bucket);
    }
    return [...byKind.entries()].map(([kind, positions]) => ({
      kind,
      positions: new Float32Array(positions),
      color: colorForKind(kind),
    }));
  }, [paths]);

  return (
    <group data-testid="preview-lines">
      {buffers.map((buffer) => {
        if (buffer.kind.includes("WALL") && !showWalls) return null;
        if (buffer.kind.includes("INFILL") && !showInfill) return null;
        return (
          <PathLines
            key={buffer.kind}
            positions={buffer.positions}
            color={buffer.color}
            layerKey={layerIndex}
          />
        );
      })}
    </group>
  );
}

function colorForKind(kind: string): string {
  if (kind.includes("WALL")) return WALL_COLOR;
  if (kind.includes("INFILL")) return INFILL_COLOR;
  if (kind.includes("SUPPORT")) return SUPPORT_COLOR;
  if (["BRIM", "SKIRT", "PRIME", "PURGE"].includes(kind)) return ADHESION_COLOR;
  if (["RETRACTION", "SEAM", "TOOL_CHANGE"].includes(kind)) return AUXILIARY_COLOR;
  return TRAVEL_COLOR;
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
