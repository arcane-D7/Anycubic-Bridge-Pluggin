/**
 * cad-parametric-tool.mjs — MCP tool running declarative parametric scripts
 * (S2-003) over the manifold engine (S2-001).
 *
 * Input { script, params?, export_format?, object_name? }:
 *   - script: JS expression body running against the engine's declarative API.
 *     Available bindings (sandbox): box, cylinder, sphere, cone, tetrahedron,
 *     add, subtract, intersect, translate, rotate, scale, mirror, extrude,
 *     return → the final manifold handle (its mesh is materialized).
 *   - params: optional plain object merged into the script scope.
 *   - export_format: "none" (default) | "stl" | "step" — returns base64 payload.
 *   - object_name: name of the imported workspace object (default "param").
 *
 * Sandbox: forbids process/require/import/fetch/eval/Function by rejecting the
 * source upfront (no eval of arbitrary code — we run via `new Function` with a
 * restricted parameter list and a denylist check on illegal tokens).
 */
import { createParametricEngine } from "./cad-parametric-engine.mjs";
import { exportStep } from "./cad-step-export.mjs";
import { meshToBinaryStl, importMesh } from "./cad-bool-tool.mjs";
import { redact } from "./cloud-readonly-diagnostics.mjs";
import { validateParametricScript } from "./cad-script-validator.mjs";

// Re-export shared validator (DRY: S2 tool + S3 AI translator use the same).
export { validateParametricScript };

let _eng = null;
async function engine() {
  if (!_eng) _eng = await createParametricEngine();
  return _eng;
}

/**
 * Runs a parametric script and returns the resulting mesh + optional export.
 * @param {{script:string, params?:object, export_format?:string,
 *          object_name?:string, url?:string, token?:string}} args
 */
export async function runParametric({
  script,
  params = {},
  export_format = "none",
  object_name = "param",
  url,
  token,
}) {
  const check = validateParametricScript(script ?? "");
  if (!check.ok) throw new Error(check.error);

  const e = await engine();
  // Wrapper function: the script's body is `return <expr>`; we restore args
  // into a restricted function of exactly the allowed API + params.
  const allowed = Object.keys(e);
  const allowedGlobals = {};
  for (const k of allowed) allowedGlobals[k] = e[k];
  Object.assign(allowedGlobals, params);

  let handle;
  try {
    const fn = new Function(...Object.keys(allowedGlobals), `"use strict";\n${script}`);
    handle = fn.apply(null, Object.values(allowedGlobals));
  } catch (error) {
    throw new Error(`parametric script failed: ${error?.message ?? error}`);
  }
  if (!handle || typeof handle?._GetMeshJS !== "function") {
    throw new Error(
      "parametric script must return a manifold handle (e.g. `return box(10,10,10)`)",
    );
  }

  const mesh = e.meshFromHandle(handle, object_name);
  const files = [];

  // Materialize into the CAD workspace (if url+token given) via binary STL import.
  let revision = null;
  if (url && token) {
    const stl = meshToBinaryStl(mesh, object_name);
    try {
      const imported = await importMesh(url, token, object_name, mesh);
      revision = imported.revision ?? null;
    } catch {
      // workspace unavailable — still return mesh payload
    }
  }

  // Export payload (base64) per export_format.
  let stl_base64 = null;
  let step_base64 = null;
  if (export_format === "stl") {
    stl_base64 = meshToBinaryStl(mesh, object_name).toString("base64");
    files.push({ name: `${object_name}.stl`, format: "stl", bytes: (stl_base64.length * 3) / 4 });
  } else if (export_format === "step") {
    stl_base64 = meshToBinaryStl(mesh, object_name).toString("base64");
    files.push({ name: `${object_name}.stl`, format: "stl", bytes: (stl_base64.length * 3) / 4 });
    const stepRes = await exportStep(mesh, `${object_name}.step`, { name: object_name });
    if (stepRes.ok) {
      const fs = await import("node:fs/promises");
      step_base64 = (await fs.readFile(stepRes.file_path)).toString("base64");
      files.push({ name: `${object_name}.step`, format: "step", bytes: stepRes.bytes });
    } else {
      files.push({ name: `${object_name}.step`, format: "step", error: stepRes.error, bytes: 0 });
    }
  }

  return {
    ok: true,
    object: object_name,
    revision,
    vertices: mesh.positions.length / 3,
    triangles: mesh.tris.length,
    watertight: mesh.watertight,
    volume_mm3: mesh.volumeMm3,
    files,
    stl_base64,
    step_base64,
  };
}

export function registerCadParametricTool(server, z) {
  server.registerTool(
    "cad_generate_parametric",
    {
      title: "Generate a parametric model via declarative script (manifold engine)",
      description:
        "Runs a small declarative parametric script against the manifold-3d engine and materializes the resulting mesh into the CAD workspace (requires url+token from cad_open_workspace). Script bindings: box(w,h,d), cylinder(r,h,segs), sphere(r,segs), cone(rb,rt,h,segs), tetrahedron(edge), add(a,b), subtract(a,b), intersect(a,b), translate(h,{x,y,z}), rotate(h,rx,ry,rz), scale(h,{x,y,z}), mirror(h,{x,y,z}), extrude(points,height). Script must `return` a manifold handle. Sandboxed: process/require/import/fetch/eval are rejected. export_format 'stl' returns the STL base64; 'step' additionally returns STEP base64 (fallback: stl only when OCCT unavailable).",
      inputSchema: {
        url: z.string().optional(),
        token: z.string().optional(),
        script: z.string().min(1),
        params: z.record(z.unknown()).optional(),
        export_format: z.enum(["none", "stl", "step"]).default("none"),
        object_name: z.string().min(1).default("param"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await runParametric(args);
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

export default registerCadParametricTool;
