/**
 * paint-roundtrip-build5.mjs
 * Builds control/slicing-test 3MFs directly:
 *   - plain-cube.3mf          : cube WITHOUT any paint attrs (control for CLI)
 *   - painted-enc6.3mf        : cube WITH 4-state paint encoded as modern 6-bit
 *   - painted-prusa.3mf       : cube WITH paint encoded as Prusa legacy nibbles
 * Each also gets proper metadata (BambuStudio-native) so the Anycubic CLI
 * treats it as a first-party 3MF and processes the paint.
 */
import fs from "node:fs";
import path from "node:path";

const OUT = "poc-output/paint-roundtrip/slice";
fs.mkdirSync(OUT, { recursive: true });

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

// encModern6: state n -> bits [1,1] + 4 bits LSB (n-3), pack LSB-first nibbles, hex reversed
function encModern6(n) {
  const bits = n >= 3 ? [1, 1, ...Array.from({ length: 4 }, (_, i) => ((n - 3) >> i) & 1)] : [];
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib |= (bits[i + j] ?? 0) << j;
    hex = "0123456789ABCDEF"[nib] + hex;
  }
  return hex;
}
// encPrusa: state n -> 2-bit (n-1) LSB
function encPrusa(n) {
  const v = n - 1;
  const bits = [(v & 1), ((v >> 1) & 1)];
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib |= (bits[i + j] ?? 0) << j;
    hex = "0123456789ABCDEF"[nib] + hex;
  }
  return hex.padStart(1, "0");
}
// state per triangle: cycle 1..4 (state 1 base, 2,3,4 each 3 tris)
const paintState = (i) => (i % 4) + 1;

function build(name, encoder, label) {
  const xv = V.map((v) => `    <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("\n");
  const xt = T.map((t, i) => {
    const st = paintState(i);
    const attr = encoder ? ` slic3rpe:mmu_segmentation="${encoder(st)}"` : "";
    return `   <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${attr}/>`;
  }).join("\n");
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">BambuStudio-02.08.01.55</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="slic3rpe:MmPaintingVersion">1</metadata>
 <metadata name="Title">paint-veins-${label}</metadata>
 <resources>
  <object id="1" type="model" name="paint-cube-${label}">
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
  const ps = `{
  "printer_model": "Anycubic Kobra S1",
  "default_filament_colour": ["#EEEEEE", "#FFD700", "#FF0000", "#0000FF"],
  "filament_colour": ["#EEEEEE", "#FFD700", "#FF0000", "#0000FF"],
  "nozzle_diameter": ["0.4"],
  "single_extruder_multi_material": "1",
  "enable_prime_tower": "1",
  "flush_into_infill": "1"
}
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
 <Override PartName="/Metadata/project_settings.config" ContentType="application/json"/>
 <Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  writeZip(path.join(OUT, name), [
    { name: "[Content_Types].xml", content: ct },
    { name: "_rels/.rels", content: rels },
    { name: "3D/3dmodel.model", content: model },
    { name: "Metadata/project_settings.config", content: ps },
  ]);
  console.log(`wrote ${name} ${label} states=${["1", "2", "3", "4"].map((s) => `${s}:${encoder ? encoder(Number(s)) : "-"}`).join(" ")}`);
}

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

build("plain-cube.3mf", null, "plain");
build("painted-enc6.3mf", encModern6, "enc6");
build("painted-prusa.3mf", encPrusa, "prusa");
