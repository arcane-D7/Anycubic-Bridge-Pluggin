import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const modelPath = pathToFileURL(
  require.resolve("../apps/editor/src/viewport/scene-model-render.ts"),
);

const model = await import(modelPath.href);

// --- S9.2-003: real-buffer rendering decision matrix ----------------------

function makeInfo(name, overrides = {}) {
  return {
    name,
    vertices: 24,
    triangles: 12,
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    sizeMm: [10, 10, 10],
    volumeMm3: 1000,
    surfaceAreaMm2: 600,
    watertight: true,
    ...overrides,
  };
}

const GEOMETRY = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

test("real geometry present -> hasRealGeometry true, watertight neutral tint", () => {
  const info = makeInfo("cone", { geometry: GEOMETRY, watertight: true });
  const r = model.resolveModelRenderState(info, { isSelected: false, isHovered: false });
  assert.equal(r.visible, true);
  assert.equal(r.hasRealGeometry, true);
  assert.equal(r.baseColor, "#7a8699");
  assert.equal(r.selectionOutline, false);
});

test("non-watertight mesh -> tint #b36a5e (frozen convention)", () => {
  const info = makeInfo("sphere", { geometry: GEOMETRY, watertight: false });
  const r = model.resolveModelRenderState(info, { isSelected: false, isHovered: false });
  assert.equal(r.baseColor, "#b36a5e");
});

test("selected -> SELECTED tint + selection outline", () => {
  const info = makeInfo("cone", { geometry: GEOMETRY });
  const r = model.resolveModelRenderState(info, { isSelected: true, isHovered: false });
  assert.equal(r.baseColor, "#4f9cf7");
  assert.equal(r.selectionOutline, true);
});

test("hover over unlocked watertight -> HOVER tint; locked stays neutral", () => {
  const free = makeInfo("cone", { geometry: GEOMETRY, locked: false });
  assert.equal(
    model.resolveModelRenderState(free, { isSelected: false, isHovered: true }).baseColor,
    "#aeb9c9",
  );
  const locked = makeInfo("cone", { geometry: GEOMETRY, locked: true });
  assert.equal(
    model.resolveModelRenderState(locked, { isSelected: false, isHovered: true }).baseColor,
    "#7a8699",
  );
});

test("visible=false -> model hidden (returns null from component)", () => {
  const info = makeInfo("hidden", { geometry: GEOMETRY, visible: false });
  const r = model.resolveModelRenderState(info, { isSelected: false, isHovered: false });
  assert.equal(r.visible, false);
});

test("no geometry -> falls back to bounds box (hasRealGeometry false)", () => {
  const info = makeInfo("mesh-only", {});
  const r = model.resolveModelRenderState(info, { isSelected: false, isHovered: false });
  assert.equal(r.hasRealGeometry, false);
  assert.equal(r.visible, true);
  // Selection outline requires real geometry (glow derives from bounds only
  // when the object actually renders a mesh — mesh-info-only fallback keeps
  // the simple tint).
  const sel = model.resolveModelRenderState(info, { isSelected: true, isHovered: false });
  assert.equal(sel.selectionOutline, false);
});
