/**
 * Generate a solid STL box (8 vertices, 12 triangles) of given size,
 * axis-aligned from origin. Proven sliceable by Anycubic CLI for simple
 * solids without holes (box 100x100x30mm works).
 *
 * Usage:
 *   node tools/3mf/make-box-stl.mjs <out.stl> <w> <d> <h> [<x0> <y0> <z0>]
 */
import fs from "node:fs";

const [, , outPath, wArg, dArg, hArg, x0Arg = "0", y0Arg = "0", z0Arg = "0"] = process.argv;
if (!outPath || !wArg || !dArg || !hArg) {
  console.error("usage: node tools/3mf/make-box-stl.mjs <out.stl> <w> <d> <h> [x0 y0 z0]");
  process.exit(2);
}
const W = Number(wArg),
  D = Number(dArg),
  H = Number(hArg);
const X0 = Number(x0Arg),
  Y0 = Number(y0Arg),
  Z0 = Number(z0Arg);
if (![W, D, H].every(Number.isFinite) || W <= 0 || D <= 0 || H <= 0) {
  console.error("bad dims");
  process.exit(2);
}

// 8 corners
const v = [
  [X0, Y0, Z0],
  [X0 + W, Y0, Z0],
  [X0 + W, Y0 + D, Z0],
  [X0, Y0 + D, Z0],
  [X0, Y0, Z0 + H],
  [X0 + W, Y0, Z0 + H],
  [X0 + W, Y0 + D, Z0 + H],
  [X0, Y0 + D, Z0 + H],
];
// outward-facing triangles (CCW when viewed from outside)
const faces = [
  [0, 2, 1],
  [0, 3, 2], // bottom (normal -Z)
  [4, 5, 6],
  [4, 6, 7], // top (normal +Z)
  [0, 1, 5],
  [0, 5, 4], // front (Y0)
  [3, 7, 6],
  [3, 6, 2], // back (Y0+D)
  [1, 2, 6],
  [1, 6, 5], // right (X0+W)
  [0, 4, 7],
  [0, 7, 3], // left (X0)
];
function normal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const vv = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * vv[2] - u[2] * vv[1], u[2] * vv[0] - u[0] * vv[2], u[0] * vv[1] - u[1] * vv[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => (x / l).toFixed(6));
}
let out = `solid box\n`;
for (const [a, b, c] of faces) {
  const va = v[a],
    vb = v[b],
    vc = v[c];
  out += `  facet normal ${normal(va, vb, vc).join(" ")}\n`;
  out += `    outer loop\n`;
  for (const p of [va, vb, vc]) out += `      vertex ${p.map((x) => x.toFixed(6)).join(" ")}\n`;
  out += `    endloop\n  endfacet\n`;
}
out += `endsolid box\n`;
fs.writeFileSync(outPath, out);
console.log(
  `wrote ${outPath} (${fs.statSync(outPath).size} bytes), ${W}x${D}x${H}mm at (${X0},${Y0},${Z0})`,
);
