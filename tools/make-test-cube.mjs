#!/usr/bin/env node
/**
 * make-test-cube.mjs — gera um STL de teste de 20x10x5 mm (caixa) para o PoC
 * de renderização headless. Dimensões conhecidas permitem verificar a fidelidade
 * da bounding box reportada pelo Blender.
 *
 * Usage: node tools/make-test-cube.mjs [out.stl]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const L = 20, W = 10, H = 5; // mm
const out = resolve(process.argv[2] ?? "tools/testdata/test-cube-20x10x5.stl");

// box corners: z from 0..H, y 0..W, x 0..L
const v = [
  [0,0,0],[L,0,0],[L,W,0],[0,W,0],   // bottom z=0
  [0,0,H],[L,0,H],[L,W,H],[0,W,H],   // top    z=H
];
// 12 triangles (2 per face), outward normals (right-hand rule)
const f = [
  [0,2,1],[0,3,2],   // bottom (z=0) normal -Z
  [4,5,6],[4,6,7],   // top    (z=H) normal +Z
  [0,1,5],[0,5,4],   // front  (y=0) normal -Y
  [3,7,6],[3,6,2],   // back   (y=W) normal +Y
  [0,4,7],[0,7,3],   // left   (x=0) normal -X
  [1,2,6],[1,6,5],   // right  (x=L) normal +X
];

function facet(n, tri) {
  const [a, b, c] = tri;
  const p = (i) => `${v[i][0].toFixed(6)} ${v[i][1].toFixed(6)} ${v[i][2].toFixed(6)}`;
  return `  facet normal ${n[0]} ${n[1]} ${n[2]}\n` +
    `    outer loop\n      vertex ${p(a)}\n      vertex ${p(b)}\n      vertex ${p(c)}\n` +
    `    endloop\n  endfacet\n`;
}

let stl = "solid testcube\n";
const N = {
  bottom: [0,0,-1], top: [0,0,1], front: [0,-1,0], back: [0,1,0], left: [-1,0,0], right: [1,0,0],
};
stl += facet(N.bottom, f[0]) + facet(N.bottom, f[1]);
stl += facet(N.top, f[2]) + facet(N.top, f[3]);
stl += facet(N.front, f[4]) + facet(N.front, f[5]);
stl += facet(N.back, f[6]) + facet(N.back, f[7]);
stl += facet(N.left, f[8]) + facet(N.left, f[9]);
stl += facet(N.right, f[10]) + facet(N.right, f[11]);
stl += "endsolid testcube\n";

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, stl);
console.log(`test STL written: ${out} (${L}x${W}x${H} mm)`);
