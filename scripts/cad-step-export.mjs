/**
 * cad-step-export.mjs — STEP export helper via Replicad (MIT).
 * Sprint 2 (S2-002).
 *
 * Replicad needs the OCCT WASM injected via setOC. On some runtimes (Node 24
 * here) OCCT initialization throws `WebAssembly.Exception` — the helper must
 * (a) try to init lazily, (b) catch failures gracefully, and (c) fall back to
 * STL-only with a clear note. Never throws to the caller.
 */
import { meshToBinaryStl } from "./cad-bool-tool.mjs";

let _occt = null; // OCCT module (loaded lazily)
let _replicad = null; // replicad module

/**
 * Lazily initializes replicad + OCCT. Returns null on any init failure.
 * Never throws.
 * @returns {Promise<object|null>} { exportSTEP, makeBox, ... } or null
 */
export async function tryInitReplicad() {
  if (_replicad) return _replicad;
  if (_occt === false) return null; // previously failed — don't retry hot
  try {
    const occt = await import("replicad-opencascadejs");
    const oc = await occt.default();
    const replicad = await import("replicad");
    replicad.setOC(oc);
    _replicad = replicad;
    _occt = oc;
    return replicad;
  } catch (error) {
    // OCCT WASM unavailable on this runtime (e.g. Node throws
    // WebAssembly.Exception). Permanently disable; callers fall back to STL.
    _occt = false;
    _replicad = null;
    return null;
  }
}

/**
 * Exports a mesh (shared contract) to a STEP file at targetPath.
 *
 * S7-006 (AC-3): STEP is **conversion-only** — the generic mesh→B-rep path
 * here degrades to a bbox-cuboid solid when OCCT is unavailable, and that
 * path is explicitly labeled `conversion_only:true` + `deprecation_note`.
 * Never present bbox-cuboid as a real mesh→STEP (no silent success).
 *
 * @param {{positions:number[], tris:{a,b,c}[]}} mesh
 * @param {string} targetPath absolute output path (e.g. plugin output dir)
 * @param {object} [opts] { name, tolerance }
 * @returns {Promise<object>}
 *   { ok:true, file_path, bytes, engine:"replicad", conversion_only:false } on real STEP,
 *   { ok:true, file_path, bytes, engine:"replicad", conversion_only:true,
 *     deprecation_note, fidelity_budget } on bbox-cuboid STEP,
 *   { ok:false, error, engine:"replicad", fallback:"stl" } on graceful failure.
 */
export async function exportStep(mesh, targetPath, opts = {}) {
  const name = opts.name ?? "model";
  try {
    const replicad = await tryInitReplicad();
    if (!replicad) {
      return {
        ok: false,
        error: "OCCT WASM unavailable on this runtime — STEP export skipped (falling back to STL).",
        engine: "replicad",
        fallback: "stl",
      };
    }
    // S7-006: the generic mesh→STEP path is conversion-only business logic.
    // Build a solid from the mesh bounding box was the ONLY generic path.
    const bounds = meshBounds(mesh);
    const { makeBox, exportSTEP } = replicad;
    const solid = makeBox(bounds.x, bounds.y, bounds.z);
    // Center the solid to the mesh centroid.
    if (solid && typeof solid.translate === "function") {
      solid.translate(bounds.cx, bounds.cy, bounds.cz);
    }
    const { blob } = await exportSTEP(solid, { tolerance: opts.tolerance ?? 0.1 });
    const bytes = Buffer.from(await blob.arrayBuffer());
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes);
    return {
      ok: true,
      file_path: targetPath,
      bytes: bytes.length,
      engine: "replicad",
      // AC-3: always labeled — this IS the degraded bbox-cuboid path, and the
      // fidelity budget documents the degradation is never silent.
      conversion_only: true,
      fidelity_budget:
        "bbox-cuboid solid: dihedral error unbounded; topology is a box, not the source mesh; volume within mesh bbox extents exactly; DEPRECATED — do not extend, replace with real mesh→B-rep",
      deprecation_note:
        "bbox-cuboid STEP is deprecated (S7-006); real mesh→STEP conversion is research-only at R3",
    };
  } catch (error) {
    // AC-3: the degradation is never silent — the error names the bbox-cuboid
    // fallback explicitly (e.g. OCCT WebAssembly.Exception on Node 24).
    return {
      ok: false,
      error: `STEP bbox-cuboid export failed: ${error?.message ?? String(error)}`,
      engine: "replicad",
      fallback: "stl",
    };
  }
}

/** Computes the bbox + centroid of a mesh (shared contract). */
export function meshBounds(mesh) {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i],
      y = mesh.positions[i + 1],
      z = mesh.positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    x: maxX - minX,
    y: maxY - minY,
    z: maxZ - minZ,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    cz: (minZ + maxZ) / 2,
  };
}

/** Re-export of the STL binary writer (DRY: tools use the same writer). */
export { meshToBinaryStl };

export default exportStep;
