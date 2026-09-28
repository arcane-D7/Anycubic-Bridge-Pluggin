/**
 * cad-center-tool.mjs — Tool that "centers an object on the build plate".
 *
 * Persists the working configuration agreed in the CAD workspace:
 *   - XY footprint is centered on the plate origin (0,0)
 *   - Z is raised so the lowest vertex sits exactly on the plate (z = 0)
 *
 * Reads an object from the running CAD workspace (HTTP), applies the
 * transform with the SAME math as vendor/server.mjs `applyTransform`
 * (params.center_on_plate), and materializes it back via /api/import
 * (binary STL). The result matches pressing "Center on plate" in the UI.
 *
 * Inputs: { url, token, name, result_name? }  (url/token come from
 * cad_open_workspace). Exported for direct integration tests.
 */
import { redact } from "./cloud-readonly-diagnostics.mjs";

/** Centering math: XY bbox center -> origin, min Z -> 0. */
export function centerOnPlateGeometry(positions) {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const dx = -cx,
    dy = -cy,
    dz = -minZ;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i] + dx;
    out[i + 1] = positions[i + 1] + dy;
    out[i + 2] = positions[i + 2] + dz;
  }
  return { positions: out, dx, dy, dz };
}

/** Builds a binary STL buffer from a mesh (same layout as the CAD module). */
export function meshToBinaryStl(mesh, name = "model") {
  const header = Buffer.alloc(80);
  header.write(name.slice(0, 79), 0, "latin1");
  const count = mesh.tris.length;
  const buffer = Buffer.alloc(84 + count * 50);
  header.copy(buffer, 0);
  buffer.writeUInt32LE(count, 80);
  let offset = 84;
  const vertex = (idx) => {
    const i = idx * 3;
    return { x: mesh.positions[i], y: mesh.positions[i + 1], z: mesh.positions[i + 2] };
  };
  const normal = (a, b, c) => {
    const ux = b.x - a.x,
      uy = b.y - a.y,
      uz = b.z - a.z;
    const vx = c.x - a.x,
      vy = c.y - a.y,
      vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  };
  for (const t of mesh.tris) {
    const a = vertex(t.a),
      b = vertex(t.b),
      c = vertex(t.c);
    const n = normal(a, b, c);
    buffer.writeFloatLE(n.x, offset);
    buffer.writeFloatLE(n.y, offset + 4);
    buffer.writeFloatLE(n.z, offset + 8);
    offset += 12;
    for (const v of [a, b, c]) {
      buffer.writeFloatLE(v.x, offset);
      buffer.writeFloatLE(v.y, offset + 4);
      buffer.writeFloatLE(v.z, offset + 8);
      offset += 12;
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  return buffer;
}

/** Fetches a mesh (positions+tris) from the CAD workspace HTTP API. */
export async function fetchMesh(url, token, name) {
  const res = await fetch(`${url.replace(/\/$/, "")}/mesh/${encodeURIComponent(name)}`, {
    headers: { "X-Cad-Token": token },
  });
  if (!res.ok) throw new Error(`object '${name}' not found (HTTP ${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? `failed to read '${name}'`);
  return { positions: data.positions, tris: data.tris };
}

/** Materializes `mesh` back into the CAD workspace under `name`. */
export async function importMesh(url, token, name, mesh) {
  const stl = meshToBinaryStl(mesh, name);
  const body = { name, data_base64: stl.toString("base64"), format: "stl" };
  const res = await fetch(`${url.replace(/\/$/, "")}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cad-Token": token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(data.error ?? `import failed (HTTP ${res.status})`);
  }
  return data;
}

/** Runs the center-on-plate tool end-to-end. Exported for integration tests. */
export async function runCenterOnPlate({ url, token, name, result_name = name }) {
  if (!url || !token) throw new Error("url and token are required (call cad_open_workspace first)");
  const mesh = await fetchMesh(url, token, name);
  const before = bounds(mesh.positions);
  const centered = centerOnPlateGeometry(mesh.positions);
  const newMesh = { positions: Array.from(centered.positions), tris: mesh.tris };
  const imported = await importMesh(url, token, result_name, newMesh);
  const after = bounds(newMesh.positions);
  return {
    ok: true,
    object: result_name,
    revision: imported.revision,
    before: { min: before.min, max: before.max, center: before.center },
    after: { min: after.min, max: after.max, center: after.center },
    shifted: { x: centered.dx, y: centered.dy, z: centered.dz },
  };
}

function bounds(positions) {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
  };
}

function usage() {
  return `Usage: node scripts/cad-center-tool.mjs <url> <token> <name> [result_name]

Centers the object's XY footprint on the plate origin and sits Z on z=0
(same math as server applyTransform center_on_plate / UI "Center on plate").`;
}

// CLI entry (also callable as a module).
import { pathToFileURL } from "node:url";
const isCli =
  process.argv[1] &&
  (() => {
    try {
      return pathToFileURL(process.argv[1]).href === import.meta.url;
    } catch {
      return false;
    }
  })();
if (isCli) {
  const [, , url, token, name, result_name] = process.argv;
  if (!url || !token || !name) {
    console.error(usage());
    process.exit(2);
  }
  runCenterOnPlate({ url, token, name, result_name })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(redact(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    });
}

export default runCenterOnPlate;
