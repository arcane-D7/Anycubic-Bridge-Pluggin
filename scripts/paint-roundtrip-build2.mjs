/**
 * paint-roundtrip-build2.mjs
 * Same as paint-roundtrip-build.mjs but tests LEGACY Prusa-style 2-bit state
 * codes: state 1 -> '0', state 2 -> '1', state 3 -> '3' (nibble '3' = bits 11).
 * Also writes a variant with states as '1','3','7' (single-nibble states).
 * Purpose: find which encoding the Orca/Anycubic engine recognizes as MMU paint.
 */
import fs from "node:fs";

// ---- Encoders to test ----
// A) legacy 2-bit packed into nibble LSB (Prusa): state n -> bits (n-1) in 2 bits
function encLegacy(n) {
  const v = n - 1;
  const bits = [(v & 1) === 1, ((v >> 1) & 1) === 1];
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let nib = 0;
    for (let j = 3; j >= 0; j--) nib = (nib << 1) | (bits[i + (3 - j)] ? 1 : 0);
    hex = "0123456789ABCDEF"[nib] + hex;
  }
  return hex.padStart(1, "0");
}
// B) single nibble = state-1 (i.e. state 1->'0', 2->'1' ... up to 16->'F')
function encNib(n) {
  return "0123456789ABCDEF"[n - 1];
}
// C) state-1 processed as the modern 6-bit: [1,1] + 4 bits LSB of (n-3)
function enc6(n) {
  const bits = [1, 1];
  const v = n - 3;
  for (let i = 0; i < 4; i++) bits.push(((v >> i) & 1) === 1 ? 1 : 0);
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib |= bits[i + j] << j;
    hex = "0123456789ABCDEF"[nib] + hex;
  }
  return hex;
}

const c = 10;
const V = [
  [-c, -c, -c], [c, -c, -c], [c, c, -c], [-c, c, -c],
  [-c, -c, c], [c, -c, c], [c, c, c], [-c, c, c],
];
const T = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
  [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
];
// state per triangle: 1->state1, 2->state2, 3->state3 (paint 3 different states)
const paintState = (i) => (i % 3) + 1;
// triangle -> state 1,2,3 => 2 triangles per state (pair)

function build(encoder, name, label) {
  const xv = V.map((v) => `    <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("\n");
  const xt = T.map((t, i) => {
    const st = paintState(i);
    const attr = ` slic3rpe:mmu_segmentation="${encoder(st)}"`;
    return `   <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${attr}/>`;
  }).join("\n");
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">paint-veins-${label}</metadata>
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
  fs.mkdirSync("poc-output/paint-roundtrip", { recursive: true });
  writeZip(name, [
    { name: "[Content_Types].xml", content: CT },
    { name: "_rels/.rels", content: RELS },
    { name: "3D/3dmodel.model", content: model },
  ]);
  console.log(`wrote ${name} (${label}) states=${[1, 2, 3].map((s) => `${s}:${encoder(s)}`).join(" ")}`);
}

const CT = `<?xml version="1.0" encoding="UTF-8"?>
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
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

function csum(buf) {
  let table = csum.table;
  if (!table) {
    table = csum.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let cc = i;
      for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1;
      table[i] = cc;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function writeZip(pathName, entries) {
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
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0, 12);
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
  fs.writeFileSync(pathName, Buffer.concat([...data, ...cd, eocd]));
}

build(encLegacy, "poc-output/paint-roundtrip/painted-cube-legacy1.3mf", "legacy");
build(encNib, "poc-output/paint-roundtrip/painted-cube-nib1.3mf", "nib");
build(enc6, "poc-output/paint-roundtrip/painted-cube-enc6.3mf", "enc6");
