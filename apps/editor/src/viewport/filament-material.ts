/**
 * S9.11-002 — procedural filament material (three.js).
 *
 * Builds a `MeshStandardMaterial` for the slicer-style view with bump +
 * roughness derived from the material CLASS — zero image/channel assets
 * (sprint AC: procedural only). `bumpMap`/`roughnessMap` are generated from
 * the THREE.MathUtils noise so the surface reads as real filament, not a
 * flat color. Agnostic to models: only color + class drive the result.
 */

import * as THREE from "three";
import type { MaterialClass } from "../state/material-assign-core";

/** Roughness by material class (higher = more diffuse/noisy). */
const CLASS_ROUGHNESS: Record<MaterialClass, number> = {
  smooth: 0.28,
  matte: 0.6,
  textured: 0.75,
  flex: 0.85,
};

/** Bump depth by class (mm-ish scale, subtle). */
const CLASS_BUMP: Record<MaterialClass, number> = {
  smooth: 0.002,
  matte: 0.008,
  textured: 0.02,
  flex: 0.006,
};

/**
 * One shared 64×64 procedural noise bump/roughness texture per class —
 * created lazily and cached so every object in slicer mode reuses the same
 * GPU texture (memory-safe: one texture per class, not one per object).
 */
const sharedNoise = new Map<MaterialClass, THREE.CanvasTexture>();

function noiseTexture(cls: MaterialClass): THREE.CanvasTexture {
  const existing = sharedNoise.get(cls);
  if (existing) return existing;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    // Deterministic value-noise: hash → smooth value in [0,1).
    const x = (i / 4) % size;
    const y = Math.floor(i / 4 / size);
    const v = (((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) + 1) % 1;
    const byte = Math.round(v * 255);
    data[i] = byte;
    data[i + 1] = byte;
    data[i + 2] = byte;
    data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedNoise.set(cls, tex);
  return tex;
}

/**
 * Procedural filament material (slicer-style).
 * @param colorHex resolved filament color (#hex) or THREE color.
 * @param clsMaterial material class (roughness/bump profile).
 */
export function filamentMaterial(
  colorHex: string,
  clsMaterial: MaterialClass = "matte",
): THREE.MeshStandardMaterial {
  const tex = noiseTexture(clsMaterial);
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    roughness: CLASS_ROUGHNESS[clsMaterial],
    metalness: 0.02,
    bumpMap: tex,
    bumpScale: CLASS_BUMP[clsMaterial],
    roughnessMap: tex,
  });
  material.needsUpdate = true;
  return material;
}

/** Cleanup for tests/unit teardown (never used in prod render loop). */
export function disposeFilamentTextures(): void {
  for (const tex of sharedNoise.values()) {
    tex.dispose();
  }
  sharedNoise.clear();
}
