/**
 * cad-arrange-utils.mjs — helpers puros de mesh usados pelo cad-arrange.mjs.
 * Sem dependências de bundle para permitir testes unitários rápidos.
 */

/** Clona um mesh {positions: number[]|Float32Array, tris: Array} para Float32Array. */
export function cloneMesh(mesh) {
  const positions = mesh.positions instanceof Float32Array
    ? new Float32Array(mesh.positions)
    : Float32Array.from(mesh.positions);
  return { positions, tris: mesh.tris.map((t) => ({ a: t.a, b: t.b, c: t.c })) };
}

/** Bbox do mesh. */
export function computeBoundingBox(mesh) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    const z = mesh.positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: { x: minX === Infinity ? 0 : minX, y: minY === Infinity ? 0 : minY, z: minZ === Infinity ? 0 : minZ },
    max: { x: maxX === -Infinity ? 0 : maxX, y: maxY === -Infinity ? 0 : maxY, z: maxZ === -Infinity ? 0 : maxZ },
  };
}

/** Translada um mesh in-place e o devolve. */
export function translateMesh(mesh, dx, dy, dz) {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] += dx;
    mesh.positions[i + 1] += dy;
    mesh.positions[i + 2] += dz;
  }
  return mesh;
}
