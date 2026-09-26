/**
 * Convert an Anycubic/Bambu 3MF plate assembly to a single binary STL.
 *
 * The recovery 3MF (Corner_Shower_Shelf_..._Z30.2mm.3mf) has:
 *   - 3D/Objects/OpenSCAD Model_2.model : XML model doc, object id=1 and id=2,
 *     inline <vertices> / <triangles> indices shared across objects? NO — 3MF
 *     indexes are per-object, so we split vertices per <object> block.
 *   - 3D/3dmodel.model : plate assembly (object id=3) that instantiates
 *     object 1 once and object 2 four times with different 3x4 transforms,
 *     plus a final build transform (usually translate to 125,125 + z offset).
 *
 * We parse both objects, apply each component transform + build transform,
 * merge every triangle into one binary STL (little-endian, 80-byte header,
 * UINT32 count, 50 bytes per triangle: normal + 3 verts + UINT16 attribute).
 *
 * Usage:
 *   node convert-3mf-mesh-to-stl.mjs <mesh.model.xml> [plate.model.xml] <out.stl> [zCut]
 *
 * When zCut (a float Z, e.g. 12.4) is given, only geometry with Z >= zCut
 * survives, and a bottom cap is generated (the Z==zCut cross-section filled
 * with triangles) so the top part is a watertight solid from the cut plane
 * upward. This produces exactly the "missing layers" object the failed print
 * needs (layers 62-150 of a 0.2 mm job start at Z = 62*0.2 = 12.4 mm).
 */
import fs from "node:fs";

const [, , meshPath, platePath, outPath, zCutArg] = process.argv;
if (!meshPath || !outPath) {
  console.error(
    "usage: node convert-3mf-mesh-to-stl.mjs <mesh.model.xml> [plate.model.xml] <out.stl> [zCut] [cap=1|0]",
  );
  process.exit(2);
}
const Z_CUT = zCutArg !== undefined ? Number(zCutArg) : null;
if (Z_CUT !== null && !Number.isFinite(Z_CUT)) {
  console.error("zCut must be a number (mm).");
  process.exit(2);
}
// Optional 5th arg: cap (default 1 when zCut given)
const capArg = process.argv[5];
const DO_CAP = capArg === undefined ? true : capArg !== "0";
if (Z_CUT !== null)
  console.log(`zCut=${Z_CUT} mm (only geometry >= Z_CUT${DO_CAP ? " + bottom cap" : ""})`);

function parseObjects(xml) {
  // Split by <object ...> ... </object> to keep per-object vertex indexing.
  const objects = [];
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objectRe.exec(xml)) !== null) {
    const attrs = m[1];
    const idMatch = attrs.match(/id="(\d+)"/);
    const id = idMatch ? Number(idMatch[1]) : 0;
    const body = m[2];
    const vertices = [];
    const vertRe = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
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
    objects.push({ id, vertices, triangles });
  }
  return objects;
}

// Parse a 12-value 3MF transform (3x3 row-major linear + 3x1 translation)
// into a row-major 4x4 matrix. 3MF: "a b c d e f g h i tx ty tz"
//   | a b c tx |
//   | d e f ty |
//   | g h i tz |
//   | 0 0 0  1 |
function parseTransform(str) {
  const parts = (str ?? "").trim().split(/\s+/).map(Number);
  if (parts.length < 12) return identity();
  return [
    parts[0],
    parts[1],
    parts[2],
    parts[9],
    parts[3],
    parts[4],
    parts[5],
    parts[10],
    parts[6],
    parts[7],
    parts[8],
    parts[11],
    0,
    0,
    0,
    1,
  ];
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function mul4(a, b) {
  const r = new Array(16);
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[row * 4 + k] * b[k * 4 + col];
      r[row * 4 + col] = s;
    }
  return r;
}

function applyMatrix(v, m) {
  const x = v[0],
    y = v[1],
    z = v[2];
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

function normal(a, b, c) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ---- Triangle clipping to the print volume ----
// A plate instance may hang outside the printable area (the recovery brackets
// extend below the bed / off the front edge). The slicer rejects the whole
// plate if no object is fully inside the volume (error -50). We clip every
// triangle against the 5 planes that keep geometry inside:
//   x >= 0, y >= 0, x <= 250, y <= 250, z >= 0
// (z upper bound is unconstrained/clamped to printable_height by the slicer).
// ---- Triangle clipping to the print volume ----
const CLIP_PLANE_FLOOR = { axis: 2, min: 0 }; // z >= 0 (bed)

// Build plane list; optionally the Z cut plane is added AFTER bed floor.
function buildClipPlanes() {
  const planes = [
    { axis: 0, min: 0 }, // x >= 0
    { axis: 1, min: 0 }, // y >= 0
    { axis: 0, max: 250 }, // x <= 250
    { axis: 1, max: 250 }, // y <= 250
    CLIP_PLANE_FLOOR,
  ];
  if (Z_CUT !== null) planes.push({ axis: 2, min: Z_CUT });
  return planes;
}

function insidePlane(p, plane) {
  if (plane.max !== undefined) return p[plane.axis] <= plane.max + 1e-6;
  return p[plane.axis] >= plane.min - 1e-6;
}

function intersectPlane(a, b, plane) {
  // parametric t where segment a->b crosses plane.axis == bound
  const bound = plane.max !== undefined ? plane.max : plane.min;
  const da = plane.max !== undefined ? a[plane.axis] - bound : bound - a[plane.axis];
  const db = plane.max !== undefined ? b[plane.axis] - bound : bound - b[plane.axis];
  const t = da / (da - db);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}

function clipPolygonToPlane(poly, plane, capSegments) {
  if (poly.length < 3) return [];
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const curIn = insidePlane(cur, plane);
    const nxtIn = insidePlane(nxt, plane);
    // When a segment is cut by the Z_CUT plane, record the cap edge.
    if (capSegments && plane.axis === 2 && plane.min === Z_CUT) {
      if (curIn !== nxtIn) {
        const ip = intersectPlane(cur, nxt, plane);
        const inA = insidePlane(cur, plane);
        const p0 = inA ? cur : ip;
        const p1 = inA ? ip : nxt;
        capSegments.push([p0[0], p0[1], p1[0], p1[1]]); // xy pair at Z_CUT
      } else if (Math.abs(cur[2] - Z_CUT) < 1e-6 && Math.abs(nxt[2] - Z_CUT) < 1e-6) {
        capSegments.push([cur[0], cur[1], nxt[0], nxt[1]]); // segment exactly on the cut
      }
    }
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) out.push(intersectPlane(cur, nxt, plane));
  }
  return out;
}

function clipTriangle(verts, capSegments) {
  let poly = [verts[0], verts[1], verts[2]];
  for (const plane of buildClipPlanes()) {
    poly = clipPolygonToPlane(poly, plane, capSegments);
    if (poly.length < 3) return null;
  }
  // Fan-triangulate the resulting polygon.
  const tris = [];
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0],
      b = poly[i],
      c = poly[i + 1];
    const area2 =
      Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) *
      Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    if (area2 > 1e-10) tris.push([a, b, c]);
  }
  return tris;
}

// ---- Cap triangulation (ear clipping on the Z_CUT plane) ----
function sewCapSegments(segments) {
  // Return closed loops (arrays of [x,y]).
  const eps = 1e-4;
  const loops = [];
  let segs = segments.map((s) => ({ a: [s[0], s[1]], b: [s[2], s[3]] }));
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  while (segs.length) {
    const start = segs[0].a;
    let curEnd = [segs[0].b[0], segs[0].b[1]];
    const loop = [
      [segs[0].a[0], segs[0].a[1]],
      [segs[0].b[0], segs[0].b[1]],
    ];
    segs = segs.slice(1);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (dist(s.a, curEnd) < eps) {
          loop.push([s.b[0], s.b[1]]);
          curEnd = [s.b[0], s.b[1]];
          segs.splice(i, 1);
          progressed = true;
          break;
        }
        if (dist(s.b, curEnd) < eps) {
          loop.push([s.a[0], s.a[1]]);
          curEnd = [s.a[0], s.a[1]];
          segs.splice(i, 1);
          progressed = true;
          break;
        }
      }
    }
    // Close the loop if the last point returns to the start.
    if (loop.length >= 3 && dist(loop[loop.length - 1], loop[0]) < eps) loop.pop();
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function earClipLoop(loop) {
  // 2D ear-clipping for a simple (ccw or cw) polygon. Returns triangles [[x,y],...]
  const pts = loop.map((p) => [p[0], p[1]]);
  // Remove consecutive duplicate points.
  const dedup = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const last = dedup[dedup.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) > 1e-5) dedup.push(pts[i]);
  }
  if (
    dedup.length > 2 &&
    Math.hypot(dedup[0][0] - dedup[dedup.length - 1][0], dedup[0][1] - dedup[dedup.length - 1][1]) <
      1e-5
  )
    dedup.pop();
  const poly = dedup;
  const n = poly.length;
  if (n < 3) return [];
  // Shoelace signed area to determine orientation.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  // Make CCW for the ear test.
  const sign = area >= 0 ? 1 : -1;
  const tris = [];
  let idx = 0;
  let guard = 0;
  let remaining = poly.slice();
  while (remaining.length > 3 && guard++ < 100000) {
    idx = idx % remaining.length;
    const prev = remaining[(idx + remaining.length - 1) % remaining.length];
    const cur = remaining[idx];
    const nxt = remaining[(idx + 1) % remaining.length];
    // convex check
    const cross = (nxt[0] - cur[0]) * (prev[1] - cur[1]) - (nxt[1] - cur[1]) * (prev[0] - cur[0]);
    if (cross * sign > 1e-12) {
      // point-in-triangle test for all other points
      let isEar = true;
      for (const p of remaining) {
        if (p === prev || p === cur || p === nxt) continue;
        if (pointInTri(p, prev, cur, nxt)) {
          isEar = false;
          break;
        }
      }
      if (isEar) {
        tris.push([prev, cur, nxt]);
        remaining.splice(idx, 1);
        idx = idx % remaining.length;
        continue;
      }
    }
    idx++;
  }
  if (remaining.length === 3) tris.push(remaining);
  return tris;
}

function pointInTri(p, a, b, c) {
  const s = a[0] * b[1] + b[0] * c[1] + c[0] * a[1] - b[0] * a[1] - c[0] * b[1] - a[0] * c[1];
  const s1 =
    (p[0] * b[1] + b[0] * c[1] + c[0] * p[1] - b[0] * p[1] - c[0] * b[1] - p[0] * c[1]) *
    (s >= 0 ? 1 : -1);
  const s2 =
    (a[0] * p[1] + p[0] * c[1] + c[0] * a[1] - p[0] * a[1] - c[0] * p[1] - a[0] * c[1]) *
    (s >= 0 ? 1 : -1);
  const s3 =
    (a[0] * b[1] + b[0] * p[1] + p[0] * a[1] - b[0] * a[1] - p[0] * b[1] - a[0] * p[1]) *
    (s >= 0 ? 1 : -1);
  return s >= 0 ? s1 >= 0 && s2 >= 0 && s3 >= 0 : s1 <= 0 && s2 <= 0 && s3 <= 0;
}

// ---- Load inputs ----
const meshXml = fs.readFileSync(meshPath, "utf8");
const objects = parseObjects(meshXml);
console.log(
  `parsed objects: ${objects.map((o) => `${o.id}[v${o.vertices.length},t${o.triangles.length}]`).join(", ")}`,
);

// ---- Plate transforms ----
let instances = [];
if (platePath && fs.existsSync(platePath)) {
  const plateXml = fs.readFileSync(platePath, "utf8");
  const compRe = /<component\b([^>]*)\bobjectid="(\d+)"[^>]*transform="([^"]*)"/g;
  let c;
  while ((c = compRe.exec(plateXml)) !== null) {
    instances.push({ objectId: Number(c[2]), transform: parseTransform(c[3]) });
  }
  const buildRe = /<item\b([^>]*)\bobjectid="(\d+)"[^>]*transform="([^"]*)"/g;
  let b;
  while ((b = buildRe.exec(plateXml)) !== null) {
    const t = parseTransform(b[3]);
    for (const inst of instances) inst.transform = mul4(t, inst.transform);
  }
} else {
  // No plate: use object 1 with identity (best effort).
  instances = objects.map((o) => ({ objectId: o.id, transform: identity() }));
}
console.log(`plate instances: ${instances.map((i) => `obj${i.objectId}`).join(", ")}`);

// ---- Merge into STL ----
const stl = Buffer.alloc(84 + 1); // placeholder header space; real buffer below
stl.write("recovery", 0, "ascii");
const trianglesOut = [];
const capSegments = Z_CUT !== null ? [] : null;
for (const inst of instances) {
  const obj = objects.find((o) => o.id === inst.objectId);
  if (!obj) {
    console.warn(`skip missing object ${inst.objectId}`);
    continue;
  }
  const m = inst.transform;
  for (const [a, b2, c2] of obj.triangles) {
    const va = applyMatrix(obj.vertices[a], m);
    const vb = applyMatrix(obj.vertices[b2], m);
    const vc = applyMatrix(obj.vertices[c2], m);
    // Clip to print volume (and Z_CUT plane); fully-outside triangles drop out.
    const clipped = clipTriangle([va, vb, vc], capSegments);
    if (!clipped) continue;
    for (const tri of clipped) {
      const n = normal(tri[0], tri[1], tri[2]);
      trianglesOut.push({ n, verts: tri });
    }
  }
}

// ---- Build the bottom cap at Z_CUT ----
let capCount = 0;
if (capSegments && capSegments.length >= 3 && DO_CAP) {
  const loops = sewCapSegments(capSegments);
  for (const loop of loops) {
    const tris = earClipLoop(loop);
    for (const t of tris) {
      if (t.length === 3) {
        trianglesOut.push({
          n: [0, 0, -1],
          verts: [
            [t[0][0], t[0][1], Z_CUT],
            [t[1][0], t[1][1], Z_CUT],
            [t[2][0], t[2][1], Z_CUT],
          ],
        });
        capCount++;
      }
    }
  }
  console.log(
    `cap loops: ${loops.length}, cap tris: ${capCount}, cap segments: ${capSegments.length}`,
  );
}

stl.writeUInt32LE(trianglesOut.length, 80);
console.log(`merged triangles: ${trianglesOut.length}`);
const stlOut = Buffer.alloc(84 + trianglesOut.length * 50);
for (let i = 0; i < 84; i++) stlOut[i] = stl[i];
let off = 84;
let bmin = [Infinity, Infinity, Infinity];
let bmax = [-Infinity, -Infinity, -Infinity];
for (const t of trianglesOut) {
  for (const v of t.verts) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < bmin[i]) bmin[i] = v[i];
      if (v[i] > bmax[i]) bmax[i] = v[i];
    }
  }
  stlOut.writeFloatLE(t.n[0], off);
  stlOut.writeFloatLE(t.n[1], off + 4);
  stlOut.writeFloatLE(t.n[2], off + 8);
  for (let i = 0; i < 3; i++) {
    const base = off + 12 + i * 12;
    stlOut.writeFloatLE(t.verts[i][0], base);
    stlOut.writeFloatLE(t.verts[i][1], base + 4);
    stlOut.writeFloatLE(t.verts[i][2], base + 8);
  }
  off += 50;
}
fs.writeFileSync(outPath, stlOut);
console.log(
  `wrote ${outPath} (${(stlOut.length / 1048576).toFixed(1)} MB, ${trianglesOut.length} tris)`,
);
console.log(
  `bbox min: [${bmin.map((v) => v.toFixed(2)).join(", ")}]  max: [${bmax.map((v) => v.toFixed(2)).join(", ")}]`,
);
