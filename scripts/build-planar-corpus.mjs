// build-planar-corpus.mjs — deterministic STL fixture generator for the
// S8-001 planar parity corpus (cube/cylinder/bracket).
//
// Writing fixtures programmatically (rather than committing a random .stl)
// keeps them sanitizer-clean and reviewable: each triangle is explicit and
// deterministic (fixed seed, exact float values). The generated files are
// committed under tests/fixtures/ — the generator is idempotent (same input
// → byte-identical file).
//
// Usage:  node scripts/build-planar-corpus.mjs
// Writes: tests/fixtures/cube-20mm.stl (existing, untouched if --only-new),
//         tests/fixtures/cylinder-20x25.stl, tests/fixtures/bracket.stl
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "tests", "fixtures");

// ---- minimal deterministic binary STL writer ------------------------------
export function writeBinaryStl(triangles, outPath, header = "planar-corpus") {
  // triangles: [{n: [nx,ny,nz], v: [[x,y,z],[x,y,z],[x,y,z]]}]
  const head = Buffer.alloc(80);
  head.write(header, "ascii");
  const count = Buffer.alloc(4);
  count.writeUInt32LE(triangles.length, 0);
  const per = 50; // 12 normal + 12*3 verts + 2 attr
  const buf = Buffer.alloc(84 + triangles.length * per);
  head.copy(buf, 0);
  count.copy(buf, 80);
  let off = 84;
  for (const t of triangles) {
    off = writeVec3(t.n, buf, off);
    for (const v of t.v) off = writeVec3(v, buf, off);
    buf.writeUInt16LE(0, off);
    off += 2;
  }
  writeFileSync(outPath, buf);
  return outPath;
}

function writeVec3(v, buf, off) {
  buf.writeFloatLE(v[0], off);
  buf.writeFloatLE(v[1], off + 4);
  buf.writeFloatLE(v[2], off + 8);
  return off + 12;
}

// ---- mesh helpers ---------------------------------------------------------
/** Unit cube → 12 triangles at [ox,oy,oz], size s. */
export function cubeMesh(s = 20, o = [0, 0, 0]) {
  const [ox, oy, oz] = o;
  const p = (x, y, z) => [ox + x * s, oy + y * s, oz + z * s];
  // 6 faces, 2 tris each, outward normals
  const faces = [
    // +Z
    {
      n: [0, 0, 1],
      v: [
        [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1)],
        [p(0, 0, 1), p(1, 1, 1), p(0, 1, 1)],
      ],
    },
    // -Z
    {
      n: [0, 0, -1],
      v: [
        [p(0, 0, 0), p(1, 1, 0), p(1, 0, 0)],
        [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0)],
      ],
    },
    // +X
    {
      n: [1, 0, 0],
      v: [
        [p(1, 0, 0), p(1, 0, 1), p(1, 1, 1)],
        [p(1, 0, 0), p(1, 1, 1), p(1, 1, 0)],
      ],
    },
    // -X
    {
      n: [-1, 0, 0],
      v: [
        [p(0, 0, 0), p(0, 1, 1), p(0, 0, 1)],
        [p(0, 0, 0), p(0, 1, 0), p(0, 1, 1)],
      ],
    },
    // +Y
    {
      n: [0, 1, 0],
      v: [
        [p(0, 1, 0), p(1, 1, 1), p(1, 1, 0)],
        [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1)],
      ],
    },
    // -Y
    {
      n: [0, -1, 0],
      v: [
        [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1)],
        [p(0, 0, 0), p(1, 0, 1), p(0, 0, 1)],
      ],
    },
  ];
  // Flatten: writeBinaryStl expects one triangle per entry ({n, v:[3 verts]});
  // the faces above each carry two triangles.
  return faces.flatMap((f) => f.v.map((v) => ({ n: f.n, v })));
}

/** Cylinder radius r, height h, nseg segments — side + caps lattice. */
export function cylinderMesh(r, h, nseg = 32) {
  const tris = [];
  const ang = (i) => (i / nseg) * Math.PI * 2;
  const sideN = [];
  for (let i = 0; i < nseg; i++) {
    const a0 = ang(i);
    const a1 = ang(i + 1);
    const c0 = [Math.cos(a0), Math.sin(a0)];
    const c1 = [Math.cos(a1), Math.sin(a1)];
    const p00 = [c0[0] * r, c0[1] * r, 0];
    const p10 = [c1[0] * r, c1[1] * r, 0];
    const p01 = [c0[0] * r, c0[1] * r, h];
    const p11 = [c1[0] * r, c1[1] * r, h];
    const n0 = [c0[0], c0[1], 0];
    const n1 = [c1[0], c1[1], 0];
    sideN.push(n0, n1);
    tris.push({ n: n0, v: [p00, p01, p11] }, { n: n1, v: [p00, p11, p10] });
  }
  // caps
  for (let i = 0; i < nseg; i++) {
    const a0 = ang(i);
    const a1 = ang(i + 1);
    const c0 = [Math.cos(a0) * r, Math.sin(a0) * r];
    const c1 = [Math.cos(a1) * r, Math.sin(a1) * r];
    tris.push({
      n: [0, 0, 1],
      v: [
        [0, 0, h],
        [c1[0], c1[1], h],
        [c0[0], c0[1], h],
      ],
    });
    tris.push({
      n: [0, 0, -1],
      v: [
        [0, 0, 0],
        [c0[0], c0[1], 0],
        [c1[0], c1[1], 0],
      ],
    });
  }
  return tris;
}

/**
 * Flat bracket plate 60×30×8mm with 3 through-holes.
 *
 * Deterministic and WATERTIGHT by construction: the top/bottom faces are a
 * 1mm grid of quads whose cells whose centre falls inside a hole are dropped,
 * so the remaining ring cells terminate exactly on the hole edges (integer
 * coordinates) and match the 4 rectangular hole-wall faces. Hole shape is a
 * square (6×6mm) representing a round r=3 hole — hole roundness is irrelevant
 * to the parity baseline.
 */
export function bracketMesh(w = 60, h = 30, thick = 8, holeSize = 6) {
  const tris = [];
  const cx = w / 2;
  const cy = h / 2;
  const hs = holeSize / 2;
  const holes = [
    [cx - 20, cy],
    [cx, cy],
    [cx + 20, cy],
  ];
  const inHole = (x, y) =>
    holes.some(([hx, hy]) => x >= hx - hs && x <= hx + hs && y >= hy - hs && y <= hy + hs);
  const quad = (a, b, c, d, n) => {
    tris.push({ n, v: [a, b, c] }, { n, v: [a, c, d] });
  };
  // top + bottom faces (drop cells whose centre is inside a hole)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x0 = i;
      const x1 = i + 1;
      const y0 = j;
      const y1 = j + 1;
      const ccx = x0 + 0.5;
      const ccy = y0 + 0.5;
      if (inHole(ccx, ccy)) continue;
      quad([x0, y0, thick], [x1, y0, thick], [x1, y1, thick], [x0, y1, thick], [0, 0, 1]);
      quad([x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0], [0, 0, -1]);
    }
  }
  // hole walls (4 rectangular faces each)
  for (const [hx, hy] of holes) {
    const x0 = hx - hs;
    const x1 = hx + hs;
    const y0 = hy - hs;
    const y1 = hy + hs;
    quad([x0, y0, 0], [x1, y0, 0], [x1, y0, thick], [x0, y0, thick], [0, -1, 0]);
    quad([x0, y1, thick], [x1, y1, thick], [x1, y1, 0], [x0, y1, 0], [0, 1, 0]);
    quad([x0, y0, 0], [x0, y1, 0], [x0, y1, thick], [x0, y0, thick], [-1, 0, 0]);
    quad([x1, y0, thick], [x1, y1, thick], [x1, y1, 0], [x1, y0, 0], [1, 0, 0]);
  }
  // outer sides
  quad([0, 0, thick], [w, 0, thick], [w, 0, 0], [0, 0, 0], [0, -1, 0]);
  quad([0, h, 0], [w, h, 0], [w, h, thick], [0, h, thick], [0, 1, 0]);
  quad([0, 0, 0], [0, h, 0], [0, h, thick], [0, 0, thick], [-1, 0, 0]);
  quad([w, 0, 0], [w, h, 0], [w, h, thick], [w, 0, thick], [1, 0, 0]);
  return tris;
}

// ---- CLI ------------------------------------------------------------------
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href;

if (isMain) {
  const only = process.argv.includes("--only-new");
  mkdirSync(outDir, { recursive: true });

  if (!only || !existsSync(join(outDir, "cube-20mm.stl"))) {
    writeBinaryStl(cubeMesh(20), join(outDir, "cube-20mm.stl"), "planar-corpus-cube-20mm");
    console.log("written tests/fixtures/cube-20mm.stl");
  } else {
    console.log("skip cube-20mm.stl (exists + --only-new)");
  }

  writeBinaryStl(
    cylinderMesh(10, 25),
    join(outDir, "cylinder-20x25.stl"),
    "planar-corpus-cylinder-20x25",
  );
  console.log("written tests/fixtures/cylinder-20x25.stl");

  writeBinaryStl(bracketMesh(), join(outDir, "bracket.stl"), "planar-corpus-bracket");
  console.log("written tests/fixtures/bracket.stl");
}
