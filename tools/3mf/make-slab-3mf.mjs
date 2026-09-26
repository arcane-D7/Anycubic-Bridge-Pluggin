/**
 * Create a simple manifold 3MF containing a single unit box (12 triangles) —
 * proven sliceable by the Anycubic CLI (box 12-tris exit 0). Used as a
 * "solid base slab" generator: any size, positioned at origin, no thumbnails.
 *
 * Usage:
 *   node tools/3mf/make-slab-3mf.mjs <out.3mf> <w> <d> <h>
 *   e.g. node tools/3mf/make-slab-3mf.mjs slab.3mf 250 250 0.8
 */
import fs from "node:fs";
import zlib from "node:zlib";

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeZip(entries) {
  const out = [];
  const cd = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data;
    const method = 8;
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(e.name, "utf8");
    const hdr = Buffer.alloc(30);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(20, 4);
    hdr.writeUInt16LE(0x0800, 6);
    hdr.writeUInt16LE(method, 8);
    hdr.writeUInt16LE(0, 10);
    hdr.writeUInt16LE(0, 12);
    hdr.writeUInt32LE(crc, 14);
    hdr.writeUInt32LE(comp.length, 18);
    hdr.writeUInt32LE(data.length, 22);
    hdr.writeUInt16LE(nameBuf.length, 26);
    hdr.writeUInt16LE(0, 28);
    out.push(hdr, nameBuf, comp);
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4);
    cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(0x0800, 8);
    cent.writeUInt16LE(method, 10);
    cent.writeUInt16LE(0, 12);
    cent.writeUInt16LE(0, 14);
    cent.writeUInt32LE(crc, 16);
    cent.writeUInt32LE(comp.length, 20);
    cent.writeUInt32LE(data.length, 24);
    cent.writeUInt16LE(nameBuf.length, 28);
    cent.writeUInt16LE(0, 30);
    cent.writeUInt16LE(0, 32);
    cent.writeUInt16LE(0, 34);
    cent.writeUInt16LE(0, 36);
    cent.writeUInt32LE(0, 38);
    cent.writeUInt32LE(offset, 42);
    cd.push(cent, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdStart = offset;
  const cdSize = cd.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...out, ...cd, eocd]);
}

const [, , outPath, wArg, dArg, hArg] = process.argv;
if (!outPath || !wArg || !dArg || !hArg) {
  console.error("usage: node tools/3mf/make-slab-3mf.mjs <out.3mf> <w> <d> <h>");
  process.exit(2);
}
const W = Number(wArg),
  D = Number(dArg),
  H = Number(hArg);
if (![W, D, H].every(Number.isFinite) || W <= 0 || D <= 0 || H <= 0) {
  console.error("bad dims");
  process.exit(2);
}

// unit box centered at origin; build transform scales + translates to [0,W]x[0,D]x[0,H]
const v = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, 0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
];
const faces = [
  [3, 2, 1],
  [3, 1, 0],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [6, 2, 3],
  [6, 3, 7],
  [0, 4, 7],
  [0, 7, 3],
  [1, 2, 6],
  [1, 6, 5],
];
const vtx = v
  .map((p) => `    <vertex x="${p[0].toFixed(6)}" y="${p[1].toFixed(6)}" z="${p[2].toFixed(6)}"/>`)
  .join("\n");
const tri = faces.map(([a, b, c]) => `    <triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("\n");

const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
${vtx}
    </vertices>
    <triangles>
${tri}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="${W} 0 0 0 ${D} 0 0 0 ${H} ${W / 2} ${D / 2} ${H / 2}" printable="1"/>
 </build>
</model>
`;

const ctXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
const rootRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

fs.writeFileSync(
  outPath,
  writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(ctXml, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "3D/3dmodel.model", data: Buffer.from(modelXml, "utf8") },
    { name: "3D/_rels/3dmodel.model.rels", data: Buffer.from(relsXml, "utf8") },
  ]),
);
console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes), slab ${W}x${D}x${H}mm`);
