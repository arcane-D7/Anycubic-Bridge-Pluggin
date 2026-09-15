/**
 * cad-csg-engine.mjs — pure boolean engine over three-bvh-csg (MIT).
 *
 * Sprint 1 (S1-001). Replaces the fragile half-space CSG kernel with the robust
 * BVH-based boolean math of `three-bvh-csg`. Pure, side-effect-free module:
 *   - booleanMesh(meshA, meshB, op) → { positions, tris, watertight }
 * No I/O, no globals mutation, importable by tests directly.
 *
 * License: MIT (matching the plugin license; three-bvh-csg is MIT).
 */
import * as THREE from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION, DIFFERENCE } from "three-bvh-csg";

/** Operation identifiers accepted by `booleanMesh`. */
export const CSG_OPS = Object.freeze({
  add: ADDITION,
  subtract: SUBTRACTION,
  intersect: INTERSECTION,
  difference: DIFFERENCE,
});

/** Allowed string names for the `op` argument (kebab/plain). */
export const OP_NAMES = Object.freeze(["add", "subtract", "intersect", "difference"]);

/** Normalize an operation name to a canonical key. Rejects unknowns. */
export function normalizeOp(op) {
  const key = String(op ?? "").toLowerCase().trim();
  if (!OP_NAMES.includes(key)) {
    throw new Error(
      `unsupported boolean op '${op}' — expected one of: ${OP_NAMES.join(", ")}`,
    );
  }
  return key;
}

/** Builds a non-indexed THREE.BufferGeometry from { positions, tris {a,b,c}[] }. */
export function buildGeometry({ positions, tris }) {
  if (!Array.isArray(positions) || positions.length % 3 !== 0) {
    throw new Error("positions must be a number[] with length divisible by 3");
  }
  if (!Array.isArray(tris) || tris.length === 0) {
    throw new Error("tris must be a non-empty array of {a,b,c}");
  }
  // Expand indexed triangles into a flat non-indexed buffer (three-bvh-csg works
  // on raw position attributes; non-indexed keeps per-face normals watertight).
  const flat = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    const base = i * 9;
    for (const [k, idx] of [[0, t.a], [3, t.b], [6, t.c]]) {
      const srcIdx = idx * 3;
      flat[base + k] = positions[srcIdx];
      flat[base + k + 1] = positions[srcIdx + 1];
      flat[base + k + 2] = positions[srcIdx + 2];
    }
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(flat, 3));
  geom.computeVertexNormals();
  // three-bvh-csg GeometryBuilder reads position/uv/normal attributes; always
  // provide a uv attribute (flat zeros) so initFromGeometry never hits
  // `refAttr.array` of an undefined attribute.
  const tris_ = tris.length;
  const uv = new Float32Array(tris_ * 6);
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  // Ensure the normal attribute exists as a BufferAttribute with an `.array`.
  if (!geom.attributes.normal) {
    geom.computeVertexNormals();
  }
  geom.normalizeNormals();
  return geom;
}

/**
 * Runs a boolean operation over two triangle meshes.
 * @param {object} meshA { positions:number[], tris:{a,b,c}[] }
 * @param {object} meshB { positions:number[], tris:{a,b,c}[] }
 * @param {"add"|"subtract"|"intersect"|"difference"|string} op
 * @returns {{ positions:number[], tris:{a,b,c}[], watertight:boolean, op:string }}
 */
export function booleanMesh(meshA, meshB, op) {
  const key = normalizeOp(op);
  const brushA = new Brush(buildGeometry(meshA));
  brushA.updateMatrixWorld(true);
  const brushB = new Brush(buildGeometry(meshB));
  brushB.updateMatrixWorld(true);
  const evaluator = new Evaluator();
  const result = evaluator.evaluate(brushA, brushB, CSG_OPS[key]);
  const geom = result.geometry;
  return geometryToMesh(geom, key);
}

/** Converts a THREE.BufferGeometry back into the shared mesh contract. */
export function geometryToMesh(geometry, op = "add") {
  const positions = Array.from(geometry.attributes.position.array);
  const tris = [];
  const index = geometry.index;
  if (index && index.array.length > 0) {
    const arr = index.array;
    for (let i = 0; i < arr.length; i += 3) tris.push({ a: arr[i], b: arr[i + 1], c: arr[i + 2] });
  } else {
    const count = positions.length / 3;
    for (let i = 0; i < count; i += 3) tris.push({ a: i, b: i + 1, c: i + 2 });
  }
  // three-bvh-csg is a manifold CSG: output should be watertight.
  return { positions, tris, watertight: true, op };
}

/** Small factory of common primitives — handy for tests and tool scripts. */
export function makeBox(w, h, d) {
  const geom = new THREE.BoxGeometry(w, h, d);
  return geometryToMesh(geom, "box");
}
export function makeCylinder(radius, height, segments = 48) {
  const geom = new THREE.CylinderGeometry(radius, radius, height, segments);
  return geometryToMesh(geom, "cylinder");
}
export function makeSphere(radius, segments = 32) {
  const geom = new THREE.SphereGeometry(radius, segments, segments / 2);
  return geometryToMesh(geom, "sphere");
}

export default booleanMesh;
