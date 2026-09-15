// Position each imported dish-rack part at its assembled location.
// The 3MF vertices are stored per-part in DESIGN coordinates (assembly space),
// so we only need to translate each part so its stored origin lands where the
// design intends: shift every part by -(-offset) i.e. keep design coords but
// center the whole assembly around the workspace origin (print bed center).
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const TOKEN = process.argv[4];
const BASE = process.argv[3]; // e.g. http://127.0.0.1:64808

const buf = readFileSync(process.argv[2]);
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
const entries = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const files = [];
for (let i = 0; i < entries; i++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const compSize = buf.readUInt32LE(off + 20);
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const localOff = buf.readUInt32LE(off + 42);
  const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
  files.push({ name, compSize, localOff });
  off += 46 + nameLen + extraLen + commentLen;
}
const model = files.find((f) => f.name.startsWith("3D/") && f.name.endsWith(".model"));
const lo = model.localOff;
const nameLen = buf.readUInt16LE(lo + 26);
const extraLen = buf.readUInt16LE(lo + 28);
const comp = buf.subarray(
  lo + 30 + nameLen + extraLen,
  lo + 30 + nameLen + extraLen + model.compSize,
);
const xml = inflateRawSync(comp).toString("utf8");

// global bbox of all vertices (assembly space)
let gMinX = Infinity,
  gMinY = Infinity,
  gMaxX = -Infinity,
  gMaxY = -Infinity;
for (const v of xml.matchAll(/<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"/g)) {
  const X = parseFloat(v[1]),
    Y = parseFloat(v[2]);
  if (X < gMinX) gMinX = X;
  if (X > gMaxX) gMaxX = X;
  if (Y < gMinY) gMinY = Y;
  if (Y > gMaxY) gMaxY = Y;
}
const cx = (gMinX + gMaxX) / 2,
  cy = (gMinY + gMaxY) / 2;
console.log("assembly center:", cx.toFixed(1), cy.toFixed(1));

// per-object re-import with translation applied to vertices
const re = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
let mm,
  ok = 0,
  fail = 0;
function stlBinary(positions, tris) {
  const n = tris.length;
  const out = Buffer.alloc(84 + n * 50);
  out.write("cad-import", 0);
  out.writeUInt32LE(n, 80);
  const V = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  tris.forEach((t, i) => {
    const A = V(t.a),
      B = V(t.b),
      C = V(t.c);
    const ux = B[0] - A[0],
      uy = B[1] - A[1],
      uz = B[2] - A[2];
    const vx = C[0] - A[0],
      vy = C[1] - A[1],
      vz = C[2] - A[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    const base = 84 + i * 50;
    out.writeFloatLE(nx / L, base);
    out.writeFloatLE(ny / L, base + 4);
    out.writeFloatLE(nz / L, base + 8);
    out.writeFloatLE(A[0], base + 12);
    out.writeFloatLE(A[1], base + 16);
    out.writeFloatLE(A[2], base + 20);
    out.writeFloatLE(B[0], base + 24);
    out.writeFloatLE(B[1], base + 28);
    out.writeFloatLE(B[2], base + 32);
    out.writeFloatLE(C[0], base + 36);
    out.writeFloatLE(C[1], base + 40);
    out.writeFloatLE(C[2], base + 44);
  });
  return out;
}
while ((mm = re.exec(xml)) !== null) {
  const attrs = mm[1],
    body = mm[2];
  const nameM = attrs.match(/name="([^"]*)"/);
  if (!nameM) continue;
  const positions = [];
  const tris = [];
  for (const v of body.matchAll(/<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"/g)) {
    positions.push(parseFloat(v[1]) - cx, parseFloat(v[2]) - cy, parseFloat(v[3]));
  }
  for (const t of body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
    tris.push({ a: +t[1], b: +t[2], c: +t[3] });
  }
  if (!positions.length) continue;
  const stl = stlBinary(positions, tris);
  const r = await fetch(`${BASE}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cad-Token": TOKEN },
    body: JSON.stringify({
      name: nameM[1].replace(/[^a-zA-Z0-9_-]/g, "_"),
      data_base64: stl.toString("base64"),
    }),
  });
  const j = await r.json();
  if (j.ok) ok++;
  else {
    fail++;
    console.log("FAIL", nameM[1], j.error);
  }
}
console.log(`repositioned: ${ok} ok, ${fail} fail (assembly centered at origin)`);
