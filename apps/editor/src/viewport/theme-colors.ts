/**
 * S9.4 UI-check helper — bridge CSS custom properties (design tokens) into
 * three.js numeric colors at render time.
 *
 * three's `THREE.Color` does NOT understand CSS `var(--token)` strings (it
 * logs "Unknown color model" and falls back to black). This module reads the
 * active theme's resolved token value from getComputedStyle and returns a
 * concrete hex/Color so the webgl scene follows the design system (light/dark,
 * selection accent, grid, etc.).
 */

import * as THREE from "three";

/** Resolve a CSS custom property to its computed string ("" if missing). */
export function cssVar(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Resolve a CSS token to an #rrggbb string THREE.Color can parse.
 * Accepts `#hex`, `rgb(...)`, and `var(--token)` indirection.
 */
export function themeColor(name: string, fallback = "#88a0b0"): string {
  const raw = cssVar(name, fallback);
  // var(--token) indirection: resolve the referenced token once.
  const m = /^var\((--[^)]+)\)$/.exec(raw);
  if (m && m[1] !== undefined) return themeColor(m[1], fallback);
  // rgb()/rgba() → hex (three parses #hex fine, but keep rgb() compatible too)
  const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw);
  if (rgb && rgb[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return raw.startsWith("#") ? raw : fallback;
}

/** Handy constant reuse for outline + glow reads the SAME token each render. */
export function selectionOutline(): THREE.Color {
  return new THREE.Color(themeColor("--sel-outline-3d", "#4f9cf7"));
}
export function selectionGlow(): THREE.Color {
  return new THREE.Color(themeColor("--sel-outline-glow", "#4f9cf780"));
}
