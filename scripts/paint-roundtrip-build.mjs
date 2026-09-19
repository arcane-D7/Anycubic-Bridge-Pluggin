/**
 * paint-roundtrip-build.mjs
 * Builds a minimal painted 3MF (20mm cube, 12 triangles) with
 * `slic3rpe:mmu_segmentation` attributes written per the engine encoder
 * (TriangleSelector::serialize + get_triangle_as_string), for Orca/Anycubic
 * round-trip validation.
 *
 * Usage:
 *   node scripts/paint-roundtrip-build.mjs <out.3mf>
 */
import fs from "node:fs";
import path from "node:path";

// ---- Encoder replicating TriangleSelector::serialize (bits) then
//      FacetsAnnotation::get_triangle_as_string (hex nibbles) ----
// State counts: states are 1-based; <=2 use the old 2-bit Prusa-compat code,
// >=3 use escape '11' + 4-bit LSB of (n-3).
function serializeState(n) {
  const bits = [];
  if (n >= 3) {
    bits.push(true, true);
    const v = n - 3;
    for (let i = 0; i < 4; i++) bits.push(((v >> i) & 1) === 1);
  } else {
    // legacy 2-bit; not used when painting extruders 1..4 with n>=3
    bits.push(((n - 1) & 1) === 1, ((n - 1) >> 1) === 1);
  }
  return bits;
}
// get_triangle_as_string: reads 4-bit chunks MSB-first (i=3..0), digit = value,
// inserts at the BEGINNING of the string (string = reverse of chunk order).
function bitsToHex(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let nib = 0;
    for (let j = 3; j >= 0; j--) {
      nib = (nib << 1) | (bits[i + (3 - j)] ? 1 : 0);
    }
    hex = "0123456789ABCDEF"[nib] + hex;
  }
  return hex;
}
function encodeState(n) {
  return bitsToHex(serializeState(n));
}

// ---- Mesh: 20mm cube centered at origin, 8 verts / 12 tris ----
const c = 10;
const V = [
  [-c, -c, -c], [c, -c, -c], [c, c, -c], [-c, c, -c],
  [-c, -c, c], [c, -c, c], [c, c, c], [-c, c, c],
];
const T = [
  [0, 2, 1], [0, 3, 2], // bottom -z
  [4, 5, 6], [4, 6, 7], // top +z
  [0, 1, 5], [0, 5, 4], // front -y
  [3, 7, 6], [3, 6, 2], // back +y
  [0, 4, 7], [0, 7, 3], // left -x
  [1, 2, 6], [1, 6, 5], // right +x
];
// States (extruder indices 1-based): top(4,5)=2, right(10,11)=3, rest none (unpainted -> attr omitted)
const paintState = (i) => (i === 4 || i === 5 ? 2 : i === 10 || i === 11 ? 3 : null);

// ---- Build model XML ----
const xv = V.map(
  (v) => `    <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`,
).join("\n");
const xt = T.map((t, i) => {
  const st = paintState(i);
  const attr = st ? ` slic3rpe:mmu_segmentation="${encodeState(st)}"` : "";
  return `   <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${attr}/>`;
}).join("\n");
const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">paint-veins-test</metadata>
 <metadata name="slic3rpe:MmPaintingVersion">1</metadata>
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
${xv}
    </vertices>
    <triangles>
${xt}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 110 110 0"/>
 </build>
</model>
`;

const ct = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="json" ContentType="application/json"/>
 <Default Extension="config" ContentType="application/json"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
 <Default Extension="md5" ContentType="text/plain"/>
 <Default Extension="metadata" ContentType="text/plain"/>
 <Default Extension="webp" ContentType="image/webp"/>
 <Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>
`;

const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

// ---- Write ZIP (3MF): entries stored (no compression needed for small file; mimic slicer) ----
function makeZip(entries) {
  // Minimal ZIP writer (store method 0) — enough for the slicers to read.
  const { crc32 } = globalThis;
  const enc = new TextEncoder();
  let data = [];
  let cd = [];
  let offset = 0;
  for (const e of entries) {
    const b = enc.encode(e.content);
    const crc = csum(b);
    const nameBytes = enc.encode(e.name);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);  // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lfh.writeUInt16LE(0, 8);   // store
    lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0, 12); // time/date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(b.length, 18);
    lfh.writeUInt32LE(b.length, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(0, 28);
    data.push(lfh, nameBytes, b);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10); cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(b.length, 20); cdh.writeUInt32LE(b.length, 24);
    cdh.writeUInt16LE(nameBytes.length, 28);
    cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32); cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(offset, 42);
    cd.push(cdh, nameBytes);
    offset += lfh.length + nameBytes.length + b.length;
  }
  const cdLen = cd.reduce((s, x) => s + x.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdLen, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...data, ...cd, eocd]);
}
function csum(buf) {
  let table = csum.table;
  if (!table) {
    table = csum.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const out = process.argv[2];
fs.writeFileSync(
  out,
  makeZip([
    { name: "[Content_Types].xml", content: ct },
    { name: "_rels/.rels", content: rels },
    { name: "3D/3dmodel.model", content: model },
  ]),
);
console.log(`wrote ${out}`);
console.log("encoded state 2 ->", encodeState(2), " state 3 ->", encodeState(3));
