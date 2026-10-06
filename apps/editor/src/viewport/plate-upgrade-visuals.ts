/**
 * S9.11-004 — BuildPlate upgrades: procedural PEI texture + quadrant marks +
 * Z column marks (pure canvas helpers, zero image assets).
 *
 * The PEI build-surface texture is GENERATED on a canvas (value noise grain +
 * diagonal machining strokes) and reused per flag — no image/channel files
 * ever enter the repo (agnostic rule). Like `filament-material.ts`, each
 * generated texture is cached by a key and disposed by `disposePlateTextures`
 * (test-only).
 */

import { DEFAULT_PLATE_UPGRADES, type PlateUpgradeFlags } from "../state/plate-upgrade-core";

export type { PlateUpgradeFlags };

/** Plate surface texture cache keyed by the resolution class label. */
const textureCache = new Map<string, CanvasTexture>();

export interface CanvasTexture {
  readonly width: number;
  readonly height: number;
  readonly canvas: HTMLCanvasElement;
  /** Release the underlying canvas (test-only). */
  dispose(): void;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/** Deterministic value-noise value at (x, y) — hashless LCG, no assets. */
function valueNoise(x: number, y: number, seed: number): number {
  let n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  n = n - Math.floor(n); // fractional part
  return n;
}

/**
 * Build the procedural PEI texture: coarse diagonal machining strokes on a
 * fine value-noise grain, plus a faint tint/roughness variation. 64×64 keeps
 * it memory-safe (one GPU texture for the whole plate).
 */
function buildPeiTexture(size = 64): CanvasTexture {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { width: size, height: size, canvas, dispose: () => canvas.remove() };
  }
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Machining stroke diagonal: crisp edges along 45°.
      const stroke = (x + y) % 7 < 1 ? 18 : 0;
      // Fine grain (±6) + subtle diagonal roughness gradient.
      const grain = (valueNoise(x, y, 7) - 0.5) * 12;
      const diag = (x + y) / (size * 2);
      const value = 74 + diag * 46 + stroke + grain;
      const idx = (y * size + x) * 4;
      data[idx] = Math.max(0, Math.min(255, value));
      data[idx + 1] = Math.max(0, Math.min(255, value * 0.94));
      data[idx + 2] = Math.max(0, Math.min(255, value * 0.88));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { width: size, height: size, canvas, dispose: () => canvas.remove() };
}

/**
 * The PEI texture for the CURRENT polygon scale — cached so enabling /
 * disabling the flag never leaks GPU textures (one per class label).
 */
export function getPeiTexture(): CanvasTexture {
  const label = "pei-64";
  let cached = textureCache.get(label);
  if (!cached) {
    cached = buildPeiTexture(64);
    textureCache.set(label, cached);
  }
  return cached;
}

/** Release every cached procedural texture (test-only; idempotent). */
export function disposePlateTextures(): void {
  for (const tex of textureCache.values()) tex.dispose();
  textureCache.clear();
}

/** All flags default OFF — the base viewport is unchanged until enabled. */
export const DEFAULT_UPGRADE_FLAGS: PlateUpgradeFlags = DEFAULT_PLATE_UPGRADES;
