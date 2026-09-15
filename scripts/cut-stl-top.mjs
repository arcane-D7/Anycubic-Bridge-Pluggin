/**
 * Cut a binary STL at a Z plane, keeping geometry with Z >= zCut, and cap the
 * cut plane with a watertight triangulated cap, producing a new binary STL.
 *
 * The algorithm:
 *   1. Read binary STL triangles.
 *   2. Clip each triangle against z >= zCut (keeping fragments above).
 *   3. Collect "cap segments" — the XY line segments where each triangle's
 *      edge crosses the cut plane (i.e. the exact loop(s) of the cross-section).
 *   4. Sew cap segments into closed loops and triangulate each loop with ear
 *      clipping. Result forms the bottom cap at z = zCut.
 *   5. Write the new binary STL.
 *
 * Works reliably when the input mesh is manifold/watertight (cross-sections
 * are closed loops); for non-manifold input the cap may be incomplete.
 *
 * Usage:
 *   node scripts/cut-stl-top.mjs <in.stl> <out.stl> <zCut-mm> [cap=1|0] [eps]
 *
 *   eps defaults to 1e-3 (segment-sew tolerance, mm).
 */
import fs from "node:fs";

const [, , inPath, outPath, zCutArg, capArg, epsArg] = process.argv;
if (!inPath || !outPath || zCutArg === undefined) {
  console.error("usage: node scripts/cut-stl-top.mjs <in.stl> <out.stl> <zCut-mm> [cap=1|0] [eps]");
  process.exit(2);
}
const Z_CUT = Number(zCutArg);
const DO_CAP = capArg === undefined ? true : capArg !== "0";
const EPS = epsArg ? Number(epsArg) : 1e-3;
if (!Number.isFinite(Z_CUT)) {
  console.error("zCut must be a number");
  process.exit(2);
}

function readStl(path) {
  const buf = fs.readFileSync(path);
  const count = buf.readUInt32LE(80);
  const tris = [];
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50;
    const v = [];
    for (let j = 0; j < 3; j++) {
      const base = o + 12 + j * 12;
      v.push([buf.readFloatLE(base), buf.readFloatLE(base + 4), buf.readFloatLE(base + 8)]);
    }
    tris.push(v);
  }
  return tris;
}

// ---- plane clipping ----------------------------------------------------------
function inside(p) {
  return p[2] >= Z_CUT - 1e-7;
}
function intersects(a, b) {
  return (a[2] >= Z_CUT && b[2] < Z_CUT) || (a[2] < Z_CUT && b[2] >= Z_CUT);
}
function lerp(a, b, t) {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}
function cutPoint(a, b) {
  // t where z == Z_CUT
  const t = (Z_CUT - a[2]) / (b[2] - a[2]);
  return lerp(a, b, t);
}

function clipPolygon(poly, capSegs) {
  // poly: array of [x,y,z]; returns clipped polygon (z>=Z_CUT)
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const curIn = inside(cur);
    const nxtIn = inside(nxt);
    if (curIn !== nxtIn) {
      const ip = cutPoint(cur, nxt);
      if (capSegs) {
        // cap edge: the cut segment in XY
        if (curIn) capSegs.push([ip[0], ip[1], cur[0], cur[1]]);
        else capSegs.push([cur[0], cur[1], ip[0], ip[1]]);
      }
    }
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) out.push(cutPoint(cur, nxt));
  }
  return out;
}

// ---- cap sewing --------------------------------------------------------------
function sewCapSegments(segments) {
  const eps = EPS;
  let segs = segments.map((s) => ({ a: [s[0], s[1]], b: [s[2], s[3]] }));
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const loops = [];
  while (segs.length) {
    const loop = [
      [segs[0].a[0], segs[0].a[1]],
      [segs[0].b[0], segs[0].b[1]],
    ];
    let curEnd = [segs[0].b[0], segs[0].b[1]];
    const start = [segs[0].a[0], segs[0].a[1]];
    segs = segs.slice(1);
    let progressed = true;
    while (progressed && segs.length) {
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
    if (loop.length >= 3 && dist(loop[loop.length - 1], loop[0]) < eps) loop.pop();
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// ---- ear clipping (2D) --------------------------------------------------------
function pointInTri(p, a, b, c) {
  const s = a[0] * b[1] + b[0] * c[1] + c[0] * a[1] - b[0] * a[1] - c[0] * b[1] - a[0] * c[1];
  const sign = s >= 0 ? 1 : -1;
  const s1 =
    (p[0] * b[1] + b[0] * c[1] + c[0] * p[1] - b[0] * p[1] - c[0] * b[1] - p[0] * c[1]) * sign;
  const s2 =
    (a[0] * p[1] + p[0] * c[1] + c[0] * a[1] - p[0] * a[1] - c[0] * p[1] - a[0] * c[1]) * sign;
  const s3 =
    (a[0] * b[1] + b[0] * p[1] + p[0] * a[1] - b[0] * a[1] - p[0] * b[1] - a[0] * p[1]) * sign;
  return s1 >= -1e-12 && s2 >= -1e-12 && s3 >= -1e-12;
}

function earClipLoop(loop) {
  const pts = loop.map((p) => [p[0], p[1]]);
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
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area >= 0 ? 1 : -1;
  const tris = [];
  let remaining = poly.slice();
  let idx = 0;
  let guard = 0;
  while (remaining.length > 3 && guard++ < 200000) {
    idx = idx % remaining.length;
    const prev = remaining[(idx + remaining.length - 1) % remaining.length];
    const cur = remaining[idx];
    const nxt = remaining[(idx + 1) % remaining.length];
    const cross = (nxt[0] - cur[0]) * (prev[1] - cur[1]) - (nxt[1] - cur[1]) * (prev[0] - cur[0]);
    if (cross * sign > 1e-12) {
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

// ---- main --------------------------------------------------------------------
const tris = readStl(inPath);
console.log(`read ${tris.length} triangles`);

const capSegments = DO_CAP ? [] : null;
const clipped = [];
for (const t of tris) {
  const poly = clipPolygon([t[0], t[1], t[2]], capSegments);
  if (poly.length < 3) continue;
  // fan triangulate
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[0],
      b = poly[i],
      c = poly[i + 1];
    const area =
      Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) *
      Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    if (area > 1e-12) clipped.push([a, b, c]);
  }
}
console.log(
  `clipped tris: ${clipped.length}${capSegments ? `, cap segments: ${capSegments.length}` : ""}`,
);

const outTris = clipped.map((t) => ({ verts: t }));
if (capSegments && capSegments.length >= 3) {
  const loops = sewCapSegments(capSegments);
  let capCount = 0;
  for (const loop of loops) {
    const tris2 = earClipLoop(loop);
    for (const t of tris2) {
      if (t.length === 3) {
        outTris.push({
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
  console.log(`cap loops: ${loops.length}, cap tris: ${capCount}`);
}

// ---- write binary STL ---------------------------------------------------------
function normal(a, b, c) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  let nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const buf = Buffer.alloc(84 + outTris.length * 50);
buf.write("cut-stl-top", 0, "ascii");
buf.writeUInt32LE(outTris.length, 80);
let off = 84;
let bmin = [Infinity, Infinity, Infinity],
  bmax = [-Infinity, -Infinity, -Infinity];
for (const t of outTris) {
  const n = normal(t.verts[0], t.verts[1], t.verts[2]);
  buf.writeFloatLE(n[0], off);
  buf.writeFloatLE(n[1], off + 4);
  buf.writeFloatLE(n[2], off + 8);
  for (let i = 0; i < 3; i++) {
    const base = off + 12 + i * 12;
    for (let j = 0; j < 3; j++) {
      if (t.verts[i][j] < bmin[j]) bmin[j] = t.verts[i][j];
      if (t.verts[i][j] > bmax[j]) bmax[j] = t.verts[i][j];
    }
    buf.writeFloatLE(t.verts[i][0], base);
    buf.writeFloatLE(t.verts[i][1], base + 4);
    buf.writeFloatLE(t.verts[i][2], base + 8);
  }
  off += 50;
}
fs.writeFileSync(outPath, buf);
console.log(`wrote ${outPath} (${(buf.length / 1048576).toFixed(1)} MB, ${outTris.length} tris)`);
console.log(
  `bbox min: [${bmin.map((v) => v.toFixed(2)).join(", ")}]  max: [${bmax.map((v) => v.toFixed(2)).join(", ")}]`,
);
