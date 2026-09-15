/**
 * Import any 3MF (standard build items instantiating <object>s directly) into
 * the CAD workspace as a single positioned binary STL.
 *
 * Unlike convert-3mf-mesh-to-stl.mjs (which expects an Anycubic/Bambu split
 * mesh-XML + plate-XML with <component> hierarchy), this script reads the .3mf
 * archive directly, parses every <object id name> with inline vertices and
 * triangles, applies each <build><item objectid transform> (12-value 3MF
 * matrix, row-major 3x3 linear + translation), and writes ONE binary STL with
 * the parts kept at their plate coordinates.
 *
 * Usage:
 *   node scripts/import-3mf-mesh.mjs <file.3mf> <out.stl> [--keep-position]
 *
 * By DEFAULT the merged mesh is centered on the printer plate: the XY bbox
 * center goes to the plate center (110,110 for a 220x220 bed) and the floor
 * (Z min) is laid on the plate surface (Z=0). Pass --keep-position to instead
 * keep the original 3MF build coordinates untouched.
 */
import fs from "node:fs";
import { read3mf } from "./read-3mf.mjs";

const [, , srcPath, outPath, flag] = process.argv;
if (!srcPath || !outPath) {
  console.error("usage: node scripts/import-3mf-mesh.mjs <file.3mf> <out.stl> [--keep-position]");
  process.exit(2);
}
const KEEP_POSITION = flag === "--keep-position";

const files = read3mf(srcPath);
const modelEntry = files.find((f) => f.name.endsWith(".model") || /\.model$/.test(f.name));
if (!modelEntry) {
  console.error("no .model found in 3MF archive");
  process.exit(2);
}
const xml = modelEntry.data.toString("utf8");

// ---- 1. Parse resources: objects with inline meshes ----
const objects = new Map();
const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
let om;
while ((om = objRe.exec(xml)) !== null) {
  const attrs = om[1];
  const id = Number(attrs.match(/id="(\d+)"/)?.[1] ?? -1);
  const name = attrs.match(/name="([^"]*)"/)?.[1] ?? `object_${id}`;
  const body = om[2];
  const vertices = [];
  const vertRe = /<vertex\s+x="(-?[\d.eE+-]+)"\s+y="(-?[\d.eE+-]+)"\s+z="(-?[\d.eE+-]+)"/g;
  let v;
  while ((v = vertRe.exec(body)) !== null) {
    vertices.push([Number(v[1]), Number(v[2]), Number(v[3])]);
  }
  const triangles = [];
  const triRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;
  let t;
  while ((t = triRe.exec(body)) !== null) {
    triangles.push([Number(t[1]), Number(t[2]), Number(t[3])]);
  }
  if (vertices.length && triangles.length) objects.set(id, { id, name, vertices, triangles });
}
console.log(`objects parsed: ${objects.size}`);

// ---- 2. Parse build items (standard 3MF: item objectid transforms) ----
const instances = [];
const itemRe = /<item\b([^>]*)>/g;
let im;
while ((im = itemRe.exec(xml)) !== null) {
  const attrs = im[1];
  const objectId = Number(attrs.match(/objectid="(\d+)"/)?.[1] ?? -1);
  const transform = attrs.match(/transform="([^"]+)"/)?.[1] ?? null;
  if (objectId > 0 && transform) {
    const t = transform.trim().split(/\s+/).map(Number);
    if (t.length >= 12) instances.push({ objectId, transform: t, part: attrs.match(/partnumber="([^"]*)"/)?.[1] ?? "" });
  } else if (objectId > 0) {
    instances.push({ objectId, transform: identity(), part: "" });
  }
}
console.log(`build items: ${instances.length}`);
if (instances.length === 0) {
  // Fallback: every object once, identity transform.
  for (const o of objects.values()) instances.push({ objectId: o.id, transform: identity(), part: o.name });
}

// ---- 3. Merge triangles with transforms ----
function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
// 3MF 12-value transform is a row-major 4x4 with the last row implicit, stored
// interleaved: [m00 m01 m02 | m10 m11 m12 | m20 m21 m22 | m30 m31 m32].
// Indices: linear m[0..8] (row0:0-2, row1:3-5, row2:6-8), translation m[9]=tx,
// m[10]=ty, m[11]=tz.  v' = M·v + t
function applyMatrix(v, m) {
  const x = v[0],
    y = v[1],
    z = v[2];
  return [
    m[0] * x + m[1] * y + m[2] * z + m[9],
    m[3] * x + m[4] * y + m[5] * z + m[10],
    m[6] * x + m[7] * y + m[8] * z + m[11],
  ];
}
function normal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const outTris = [];
let bmin = [Infinity, Infinity, Infinity];
let bmax = [-Infinity, -Infinity, -Infinity];
for (const inst of instances) {
  const obj = objects.get(inst.objectId);
  if (!obj) {
    console.warn(`skip missing object ${inst.objectId}`);
    continue;
  }
  const m = inst.transform;
  for (const [ai, bi, ci] of obj.triangles) {
    const va = applyMatrix(obj.vertices[ai], m);
    const vb = applyMatrix(obj.vertices[bi], m);
    const vc = applyMatrix(obj.vertices[ci], m);
    for (const v of [va, vb, vc]) {
      for (let i = 0; i < 3; i++) {
        if (v[i] < bmin[i]) bmin[i] = v[i];
        if (v[i] > bmax[i]) bmax[i] = v[i];
      }
    }
    outTris.push({ n: normal(va, vb, vc), verts: [va, vb, vc] });
  }
}
console.log(`merged triangles: ${outTris.length}`);

// ---- 4. Position on the plate (default): center XY on the plate and floor at Z=0. ----
// The CAD plate (PlaneGeometry 220x220) is centered at world (0, 0); the
// modelGroup applies only rotation (Z-up -> Y-up), no translation, so server
// coords (0, 0) map exactly onto the plate center. Center the mesh bbox there.
const PLATE_CENTER_X = 0;
const PLATE_CENTER_Y = 0;
if (!KEEP_POSITION) {
  const dx = PLATE_CENTER_X - (bmin[0] + bmax[0]) / 2;
  const dy = PLATE_CENTER_Y - (bmin[1] + bmax[1]) / 2;
  const dz = -bmin[2];
  for (const tri of outTris) {
    for (const v of tri.verts) {
      v[0] += dx;
      v[1] += dy;
      v[2] += dz;
    }
  }
  bmin = [bmin[0] + dx, bmin[1] + dy, bmin[2] + dz];
  bmax = [bmax[0] + dx, bmax[1] + dy, bmax[2] + dz];
  console.log(
    `centered on plate (${PLATE_CENTER_X}, ${PLATE_CENTER_Y}): shifted by (${dx.toFixed(2)}, ${dy.toFixed(2)}, ${dz.toFixed(2)})`,
  );
}

// ---- 5. Write binary STL ----
const stl = Buffer.alloc(84 + outTris.length * 50);
stl.write("3mf-import", 0, "ascii");
stl.writeUInt32LE(outTris.length, 80);
let off = 84;
for (const tri of outTris) {
  stl.writeFloatLE(tri.n[0], off);
  stl.writeFloatLE(tri.n[1], off + 4);
  stl.writeFloatLE(tri.n[2], off + 8);
  for (let i = 0; i < 3; i++) {
    const base = off + 12 + i * 12;
    stl.writeFloatLE(tri.verts[i][0], base);
    stl.writeFloatLE(tri.verts[i][1], base + 4);
    stl.writeFloatLE(tri.verts[i][2], base + 8);
  }
  off += 50;
}
fs.writeFileSync(outPath, stl);
console.log(`wrote ${outPath} (${(stl.length / 1048576).toFixed(1)} MB, ${outTris.length} tris)`);
console.log(`bbox min: [${bmin.map((v) => v.toFixed(2)).join(", ")}]  max: [${bmax.map((v) => v.toFixed(2)).join(", ")}]`);
