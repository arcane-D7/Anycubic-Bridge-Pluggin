/**
 * cad-bool-tool.mjs — MCP adapter for the three-bvh-csg boolean engine (S1-002).
 *
 * Reads two objects from the running CAD workspace (HTTP), computes a robust
 * boolean (see cad-csg-engine.mjs), and materializes the result back into the
 * workspace via /api/import (binary STL). Inputs:
 *   { url, token, name_a, name_b, op, result_name }   (url/token come from
 *   cad_open_workspace; defaults are optional and auto-unused)
 *
 * Adapter-only: no CAD math lives here (SOLID — single responsibility).
 */
import { booleanMesh, OP_NAMES } from "./cad-csg-engine.mjs";
import { redact } from "./cloud-readonly-diagnostics.mjs";

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
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  };
  for (const t of mesh.tris) {
    const a = vertex(t.a), b = vertex(t.b), c = vertex(t.c);
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

/** Runs the boolean tool end-to-end. Exported for direct integration tests. */
export async function runBoolean({ url, token, name_a, name_b, op, result_name = "result" }) {
  if (!url || !token) throw new Error("url and token are required (call cad_open_workspace first)");
  const [a, b] = await Promise.all([
    fetchMesh(url, token, name_a),
    fetchMesh(url, token, name_b),
  ]);
  const result = booleanMesh(a, b, op);
  const imported = await importMesh(url, token, result_name, result);
  return {
    ok: true,
    object: result_name,
    revision: imported.revision,
    vertices: result.positions.length / 3,
    triangles: result.tris.length,
    watertight: result.watertight,
    op: result.op,
  };
}

export function registerCadBoolTool(server, z) {
  server.registerTool(
    "cad_v2_boolean",
    {
      title: "Robust boolean CSG on CAD workspace objects (three-bvh-csg)",
      description:
        "Computes a watertight boolean (add/subtract/intersect/difference) between two objects of the running CAD workspace using the robust three-bvh-csg engine, and stores the result as a new object. Unlike the legacy half-space kernel, this handles non-convex operands reliably. Requires the url+token returned by cad_open_workspace; the result appears live in the web UI.",
      inputSchema: {
        url: z.string().min(1),
        token: z.string().min(1),
        name_a: z.string().min(1),
        name_b: z.string().min(1),
        op: z.enum(["add", "subtract", "intersect", "difference"]),
        result_name: z.string().min(1).default("result"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await runBoolean(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          structuredContent: { ok: false, error: message },
        };
      }
    },
  );
}

export default registerCadBoolTool;
