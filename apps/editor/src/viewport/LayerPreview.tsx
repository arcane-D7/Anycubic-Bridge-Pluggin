import { useMemo } from "react";
import { sliceIrToEditorWorld } from "../state/coordinate-frames";
import type { PreviewModel, PreviewToolpath } from "./preview-model";

const WALL_COLOR = "#4f9cf7";
const INFILL_COLOR = "#22c55e";
const TRAVEL_COLOR = "#59616f";
const ADHESION_COLOR = "#e0a24a";
const SUPPORT_COLOR = "#b8860b";
const AUXILIARY_COLOR = "#a56b9f";

type ScenePoint = readonly [number, number, number];

interface LayerPreviewProps {
  readonly layerIndex: number;
  readonly paths: readonly PreviewToolpath[];
  readonly colorMode:
    | "function"
    | "material"
    | "speed"
    | "flow"
    | "beadWidth"
    | "lineWidth"
    | "layerHeight"
    | "temperature";
  readonly currentSegment: PreviewToolpath | null;
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

export function LayerPreview({ layerIndex, paths, colorMode, currentSegment }: LayerPreviewProps) {
  const buffers = useMemo(() => {
    const byBatch = new Map<string, { kind: string; color: string; positions: number[] }>();
    for (const path of paths) {
      const from = toScene(path.from);
      const to = toScene(path.to);
      const color = pathColor(path, colorMode);
      const key = `${path.kind}|${color}`;
      const batch = byBatch.get(key) ?? { kind: path.kind, color, positions: [] };
      batch.positions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      byBatch.set(key, batch);
    }
    return [...byBatch.values()].map(({ kind, color, positions }) => ({
      kind,
      color,
      positions: new Float32Array(positions),
    }));
  }, [paths, colorMode]);

  const currentBuffer = useMemo(() => {
    if (!currentSegment) return null;
    const from = toScene(currentSegment.from);
    const to = toScene(currentSegment.to);
    return new Float32Array([...from, ...to]);
  }, [currentSegment]);
  const plannedHead = currentSegment ? toScene(currentSegment.to) : null;

  return (
    <group>
      {buffers.map((buffer) => {
        return (
          <PathLines
            key={`${buffer.kind}|${buffer.color}`}
            positions={buffer.positions}
            color={buffer.color}
            layerKey={layerIndex}
          />
        );
      })}
      {currentBuffer ? (
        <PathLines positions={currentBuffer} color="#f4dc65" layerKey={layerIndex} width={3} />
      ) : null}
      {plannedHead ? (
        <mesh position={plannedHead}>
          <sphereGeometry args={[0.8, 8, 6]} />
          <meshBasicMaterial color="#f4dc65" depthTest={false} />
        </mesh>
      ) : null}
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

const ATTRIBUTE_COLORS = ["#267e78", "#5fa875", "#c6b74f", "#d77a4a", "#b64f55"] as const;

function pathColor(path: PreviewToolpath, mode: LayerPreviewProps["colorMode"]): string {
  if (mode === "function") return colorForKind(path.kind);
  if (mode === "material") {
    if (!path.materialId) return "#747b78";
    let hash = 0;
    for (const char of path.materialId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return ATTRIBUTE_COLORS[hash % ATTRIBUTE_COLORS.length]!;
  }
  const value =
    mode === "speed"
      ? path.speedMmS
      : mode === "flow"
        ? path.flowMm3S
        : mode === "beadWidth"
          ? path.beadAreaMm2
          : mode === "lineWidth"
            ? path.lineWidthMm
            : mode === "layerHeight"
              ? path.layerHeightMm
              : path.nozzleTemperatureC;
  if (value === null || !Number.isFinite(value)) return "#747b78";
  const scale =
    mode === "speed"
      ? 120
      : mode === "flow"
        ? 12
        : mode === "beadWidth"
          ? 0.6
          : mode === "lineWidth"
            ? 1.2
            : mode === "layerHeight"
              ? 0.5
              : 300;
  const index = Math.max(
    0,
    Math.min(ATTRIBUTE_COLORS.length - 1, Math.floor((value / scale) * ATTRIBUTE_COLORS.length)),
  );
  return ATTRIBUTE_COLORS[index]!;
}

function PathLines({
  positions,
  color,
  layerKey,
  width = 1,
}: {
  readonly positions: Float32Array;
  readonly color: string;
  readonly layerKey: number;
  readonly width?: number;
}) {
  if (positions.length === 0) return null;
  return (
    <lineSegments key={layerKey}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={0.95}
        linewidth={width}
        depthTest={width === 1}
      />
    </lineSegments>
  );
}
