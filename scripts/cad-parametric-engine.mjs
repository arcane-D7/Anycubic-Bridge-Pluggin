/**
 * cad-parametric-engine.mjs — pure parametric modeling core over manifold-3d
 * (MIT, WASM). Sprint 2 (S2-001).
 *
 * Declarative API (Blender/OpenSCAD-like):
 *   createParametricEngine() → singleton with:
 *     primitives: box / cylinder / sphere / cone / tetrahedron
 *     transforms: translate / rotate / scale / mirror
 *     booleans:   add / subtract / intersect
 *     extras:     extrude(polygon, height, {center})  (via CrossSection, Z-up)
 *     output:     meshFromHandle(handle) → { positions, tris, watertight, volumeMm3 }
 *
 * NOTE (2026-09): manifold-3d@3.5.3 moved the ergonomic API to the
 * `manifold-3d/manifoldCAD.js` entry (high-level wrapper). The low-level
 * `_Extrude`/`Vector2_vec2` embind surface changed and its `_Extrude` wrapper
 * no longer matches the raw C++ signature — so this engine relies on the
 * official manifoldCAD wrapper (pre-initialized, no `await` needed).
 *
 * Pure module: no I/O, no globals mutation, importable by tests/tool adapters.
 * MIT (matching the plugin license; manifold-3d is Apache-2.0/MIT compatible —
 * manifold-3d itself is Apache-2.0 with MIT-compatible alias per npm metadata).
 */
import * as MC from "manifold-3d/manifoldCAD.js";

const V = (x, y, z) => ({ x, y, z });

/** Always-resolved engine (manifoldCAD is pre-initialized). */
let _engine = null;

/**
 * Lazily initializes the parametric engine singleton (idempotent).
 * @returns {Promise<object>} engine namespace
 */
export async function initManifold() {
  if (!_engine) {
    // Sanity-check that the high-level wrapper exposes what we need.
    const needed = ["Manifold", "CrossSection"];
    for (const k of needed) {
      if (typeof MC[k] !== "function") {
        throw new Error(`manifoldCAD runtime missing ${k} (unsupported build)`);
      }
    }
    _engine = MC;
  }
  return _engine;
}

/** Resets the singleton (used by tests to isolate state). */
export function resetManifold() {
  _engine = null;
}

/** Converts a Manifold mesh handle to the shared {positions, tris, ...} mesh. */
export function meshFromHandle(handle, op = "model") {
  const mesh = handle._GetMeshJS(0);
  const numProp = mesh.numProp * 1;
  const triVerts = mesh.triVerts; // flat Uint32: 3 per triangle
  const vertProps = mesh.vertProperties; // flat Float64: numProp per vertex
  const count = vertProps.length / numProp;
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push(vertProps[i * numProp], vertProps[i * numProp + 1], vertProps[i * numProp + 2]);
  }
  const tris = [];
  for (let i = 0; i < triVerts.length; i += 3) {
    tris.push({ a: triVerts[i], b: triVerts[i + 1], c: triVerts[i + 2] });
  }
  let statusStr = "";
  try {
    statusStr = String(handle.status ? handle.status() : "NoError");
  } catch {
    /* status not exposed on this build */
  }
  const watertight = statusStr === "0" || statusStr === "NoError" ? tris.length > 0 : false;
  let volumeMm3 = 0;
  try {
    volumeMm3 = handle.volume ? Number(handle.volume()) : 0;
  } catch {
    /* volume not exposed on this build */
  }
  return { positions, tris, watertight, volumeMm3, op };
}

/**
 * Creates the parametric engine singleton.
 * @returns {Promise<PEngine>}
 */
export async function createParametricEngine() {
  const MCx = await initManifold();

  /** Primitive: axis-aligned box at origin. box(w, h, d) dims, center at origin. */
  const box = (w, h = w, d = w) => MCx.Manifold.cube([w, h, d], true);

  /** Primitive: cylinder centered at origin. cylinder(r, h, segments). */
  const cylinder = (r, h, segments = 32) => MCx.Manifold.cylinder(h, r, r, segments, true);

  /** Primitive: sphere centered at origin. sphere(r, segments). */
  const sphere = (r, segments = 32) => MCx.Manifold.sphere(r, segments);

  /** Primitive: cone — bottom radius rb, top radius rt (0 = point), height h. */
  const cone = (rb, rt, h, segments = 32) => MCx.Manifold.cylinder(h, rb, rt, segments, true);

  /** Primitive: regular tetrahedron (unit, centered). */
  const tetrahedron = () => MCx.Manifold.tetrahedron();

  /** Boolean ops (binary, watertight). */
  const add = (a, b) => a.add(b);
  const subtract = (a, b) => a.subtract(b);
  const intersect = (a, b) => a.intersect(b);

  /** Transforms (manifold methods are pure; return new handles). */
  const translate = (h, v) => h.translate(v);
  const rotate = (h, rx, ry, rz) => h.rotate(rx, ry, rz);
  const scale = (h, v) => h.scale(v);
  const mirror = (h, v) => h.mirror(v);

  /** Extrudes a closed 2D polygon (array of [x,y]) to height h along +Z. */
  const extrude = (polygon, height, opts = {}) => {
    if (!Array.isArray(polygon) || polygon.length < 3) {
      throw new Error("extrude: polygon must be a closed 2D point list (>=3 pts)");
    }
    const cs = new MCx.CrossSection([polygon]);
    const man = cs.extrude(height, 0, 0, { x: 1, y: 1 }, opts.center === true);
    return man;
  };

  return {
    M: MCx,
    box,
    cylinder,
    sphere,
    cone,
    tetrahedron,
    add,
    subtract,
    intersect,
    translate,
    rotate,
    scale,
    mirror,
    extrude,
    meshFromHandle,
  };
}

export default createParametricEngine;
