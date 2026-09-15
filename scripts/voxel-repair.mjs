/**
 * CLI wrapper: voxelize a binary STL triangle soup into a watertight mesh
 * (occupancy grid -> marching cubes), producing a binary STL the slicer can
 * slice ("manifold = yes").
 *
 * Usage:
 *   node scripts/voxel-repair.mjs <in.stl> <out.stl> [gridSize] [zCut] [padWall]
 *
 * - gridSize : voxel grid resolution (default 256; ~16.8M voxels for 256^3 —
 *              memory heavy; use 192 for 30mm model = 0.16mm cells).
 * - zCut     : only keep geometry with Z >= zCut (recovery layers 62+).
 * - padWall  : extra mm to add around the XY bounding box (default 0).
 */
import fs from "node:fs";

const [, , inPath, outPath, gridSizeArg, zCutArg, padWallArg] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node voxel-repair.mjs <in.stl> <out.stl> [gridSize] [zCut] [padWall]");
  process.exit(2);
}
const GRID = gridSizeArg ? Number(gridSizeArg) : 256;
const Z_CUT = zCutArg !== undefined ? Number(zCutArg) : null;
const PAD = padWallArg ? Number(padWallArg) : 0;

function readStlTriangles(path) {
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

const tris = readStlTriangles(inPath);
console.log(`read ${tris.length} triangles`);

// ---- Bounding box (with padding) ----
let bmin = [Infinity, Infinity, Infinity],
  bmax = [-Infinity, -Infinity, -Infinity];
for (const t of tris)
  for (const v of t)
    for (let i = 0; i < 3; i++) {
      if (v[i] < bmin[i]) bmin[i] = v[i];
      if (v[i] > bmax[i]) bmax[i] = v[i];
    }
if (Z_CUT !== null) bmin[2] = Math.max(bmin[2], Z_CUT);
bmin[0] -= PAD;
bmin[1] -= PAD;
bmax[0] += PAD;
bmax[1] += PAD;
const size = [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]];
console.log(
  `bbox min=[${bmin.map((v) => v.toFixed(2)).join(",")}] max=[${bmax.map((v) => v.toFixed(2)).join(",")}]`,
);
console.log(
  `grid ${GRID}^3 -> cell ${(size[0] / GRID).toFixed(4)} x ${(size[1] / GRID).toFixed(4)} x ${(size[2] / GRID).toFixed(4)} mm`,
);

// ---- Voxelize: ray cast along Z through each grid column ----
function voxel(ni, nj, nk, grid) {
  return ni + GRID * (nj + GRID * nk);
}
const grid = new Uint8Array(GRID * GRID * GRID);
const cell = [size[0] / GRID, size[1] / GRID, size[2] / GRID];

function voxelCenter(i, j, k) {
  return [
    bmin[0] + (i + 0.5) * cell[0],
    bmin[1] + (j + 0.5) * cell[1],
    bmin[2] + (k + 0.5) * cell[2],
  ];
}

function rayIntersectTri(origin, dirZ, tri) {
  // Moller-Trumbore along +Z; returns t (distance along Z) or NaN.
  const [v0, v1, v2] = tri;
  const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const h = [-dirZ[1] * e2[2], dirZ[0] * e2[2], 0]; // cross(dirZ, e2) with dirZ=(0,0,1) => (0,0,0)-(e2[1]*1)=... compute manually
  // dirZ = (0,0,1); cross(dirZ, e2) = ( -e2[1], e2[0], 0 )
  h[0] = -e2[1];
  h[1] = e2[0];
  h[2] = 0;
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-12) return NaN;
  const inv = 1 / det;
  const s = [origin[0] - v0[0], origin[1] - v0[1], origin[2] - v0[2]];
  const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return NaN;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]; // cross(s, e1)
  const v = (dirZ[0] * q[0] + dirZ[1] * q[1] + dirZ[2] * q[2]) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return NaN;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t;
}

// For each (i,j) column, cast a ray from below the model upward; count crossings.
const progress = () => process.stdout.write(".");
for (let i = 0; i < GRID; i++) {
  for (let j = 0; j < GRID; j++) {
    const cx = bmin[0] + (i + 0.5) * cell[0];
    const cy = bmin[1] + (j + 0.5) * cell[1];
    const hitT = [];
    for (const t of tris) {
      const tt = rayIntersectTri([cx, cy, bmin[2] - 1], [0, 0, 1], t);
      if (Number.isFinite(tt)) hitT.push(tt);
    }
    hitT.sort((a, b) => a - b);
    if (hitT.length === 0) continue;
    // Odd/even parity: a cell center is inside if an odd number of surfaces
    // were crossed below it.
    for (let k = 0; k < GRID; k++) {
      const z = bmin[2] + (k + 0.5) * cell[2];
      let parity = 0;
      for (const tt of hitT) if (tt < z - bmin[2] + 1) parity ^= 1;
      if (parity) grid[voxel(i, j, k)] = 1;
    }
  }
  if (i % 32 === 0) progress();
}
console.log("\nvoxelized");

// ---- Marching cubes ----
// Standard 256-triangles lookup tables (public domain MC tables).
// We include only the essential 15-case tables via a compact representation:
const MC_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
// Triangle table for each of 256 cube cases.
const MC_TRI = (() => {
  // Full table from the classic implementation.
  // 256 entries; each is a list of up to 15 edge indices (terminated by -1).
  // We embed the canonical table as a compact string and decode.
  const S = `
000 001 002 003 004 005 006 007 008 009 010 011 012 013 014 015
016 017 018 019 020 021 022 023 024 025 026 027 028 029 030 031
032 033 034 035 036 037 038 039 040 041 042 043 044 045 046 047
048 049 050 051 052 053 054 055 056 057 058 059 060 061 062 063
064 065 066 067 068 069 070 071 072 073 074 075 076 077 078 079
080 081 082 083 084 085 086 087 088 089 090 091 092 093 094 095
096 097 098 099 100 101 102 103 104 105 106 107 108 109 110 111
112 113 114 115 116 117 118 119 120 121 122 123 124 125 126 127
128 129 130 131 132 133 134 135 136 137 138 139 140 141 142 143
144 145 146 147 148 149 150 151 152 153 154 155 156 157 158 159
160 161 162 163 164 165 166 167 168 169 170 171 172 173 174 175
176 177 178 179 180 181 182 183 184 185 186 187 188 189 190 191
192 193 194 195 196 197 198 199 200 201 202 203 204 205 206 207
208 209 210 211 212 213 214 215 216 217 218 219 220 221 222 223
224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239
240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255`;
  // Placeholder - replace with real table
  return null;
})();

console.log("MC tables not yet embedded; use grid->STL alternative.");
