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

test("Slicer presents solid surfaces without mesh edges or wireframe selection boxes", () => {
  const info = makeInfo("solid", { geometry: GEOMETRY });
  const state = model.resolveModelRenderState(info, {
    isSelected: true,
    isHovered: true,
    viewMode: "slicer",
    edgesVisible: true,
  });
  assert.equal(state.hasRealGeometry, true);
  assert.equal(state.visible, true);
  assert.equal(state.showEdges, false);
  assert.equal(state.selectionOutline, false);
});

test("Mesh retains optional edges and selection bounds independently of Slicer", () => {
  const info = makeInfo("mesh", { geometry: GEOMETRY });
  const options = { isSelected: true, isHovered: false, viewMode: "mesh" };
  assert.equal(
    model.resolveModelRenderState(info, { ...options, edgesVisible: true }).showEdges,
    true,
  );
  assert.equal(
    model.resolveModelRenderState(info, { ...options, edgesVisible: false }).showEdges,
    false,
  );
  assert.equal(model.resolveModelRenderState(info, options).selectionOutline, true);
});

test("legacy Live presentation also uses solid surfaces", () => {
  const info = makeInfo("legacy", { geometry: GEOMETRY });
  const state = model.resolveModelRenderState(info, {
    isSelected: true,
    isHovered: false,
    viewMode: "live",
    edgesVisible: true,
  });
  assert.equal(state.showEdges, false);
  assert.equal(state.selectionOutline, false);
});

function assertOutwardFaces(object) {
  const { positions, normals, indices } = object.geometry;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  let signedVolume = 0;
  let faceCount = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const vertexIds = Array.from(indices.slice(offset, offset + 3));
    const [first, second, third] = vertexIds.map((id) =>
      Array.from(positions.slice(id * 3, id * 3 + 3)),
    );
    const firstEdge = second.map((value, axis) => value - first[axis]);
    const secondEdge = third.map((value, axis) => value - first[axis]);
    const faceNormal = [
      firstEdge[1] * secondEdge[2] - firstEdge[2] * secondEdge[1],
      firstEdge[2] * secondEdge[0] - firstEdge[0] * secondEdge[2],
      firstEdge[0] * secondEdge[1] - firstEdge[1] * secondEdge[0],
    ];
    assert.ok(
      Math.hypot(...faceNormal) >= 1e-6,
      `${object.name} triangle ${offset / 3} must not be degenerate`,
    );
    const outward = center.map(
      (value, axis) => (first[axis] + second[axis] + third[axis]) / 3 - value,
    );
    assert.ok(
      faceNormal.reduce((sum, value, axis) => sum + value * outward[axis], 0) > 0,
      `${object.name} triangle ${offset / 3} must face outside`,
    );
    for (const id of vertexIds) {
      const vertexNormal = Array.from(normals.slice(id * 3, id * 3 + 3));
      assert.ok(
        faceNormal.reduce((sum, value, axis) => sum + value * vertexNormal[axis], 0) > 0,
        `${object.name} vertex normal must agree with the face orientation`,
      );
      assert.ok(Math.abs(Math.hypot(...vertexNormal) - 1) < 1e-5);
      if (object.name !== "sphere-non-watertight") {
        const alignment =
          faceNormal.reduce((sum, value, axis) => sum + value * vertexNormal[axis], 0) /
          Math.hypot(...faceNormal);
        assert.ok(alignment > 0.9999, `${object.name} flat normals must match the triangle slope`);
      }
    }
    signedVolume +=
      (first[0] * (second[1] * third[2] - second[2] * third[1]) +
        first[1] * (second[2] * third[0] - second[0] * third[2]) +
        first[2] * (second[0] * third[1] - second[1] * third[0])) /
      6;
    faceCount += 1;
  }
  assert.ok(faceCount > 0);
  assert.ok(signedVolume > 0, `${object.name} must have outward-oriented signed volume`);
  return signedVolume;
}

test("Demo cone, cube and sphere face outward with consistent lighting normals", async () => {
  const bridge = await import(
    pathToFileURL(require.resolve("../apps/editor/src/bridge/mock.ts")).href
  );
  const scene = await bridge.fetchSceneSnapshot();
  for (const name of ["cone", "cube", "sphere-non-watertight"]) {
    const object = scene.objects.find((entry) => entry.name === name);
    assert.ok(object, `${name} must be present in the Demo geometry`);
    const volume = assertOutwardFaces(object);
    if (name === "cube") assert.ok(Math.abs(volume - 8000) < 1e-5);
  }
});

test("Demo boolean result faces outward rather than displaying the inside of the box", async () => {
  const bridge = await import(
    pathToFileURL(require.resolve("../apps/editor/src/bridge/mock.ts")).href
  );
  const scene = await bridge.fetchSceneSnapshot();
  const result = await scene.boolean({
    name_a: "cone",
    name_b: "cube",
    op: "add",
    hide_sources: false,
  });
  assert.equal(result.ok, true);
  const object = result.objectSnapshot;
  assert.ok(object);
  assertOutwardFaces(object);
});
