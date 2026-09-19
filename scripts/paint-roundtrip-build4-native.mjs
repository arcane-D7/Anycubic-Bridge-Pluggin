/**
 * paint-roundtrip-build4.mjs
 * Adds filament_colour to project_settings.config so the Orca importer sees
 * "filament colors" and can map states -> materials. Uses the flat structure
 * (mesh inline in 3D/3dmodel.model) which the first round-trip proved loads.
 * Tests the modern encoder (state>=3: bits 11 + (n-3) LSB; pack LSB-first;
 * hex = reversed nibble order) against the n+2 hypothesis.
 */
import fs from "node:fs";
import path from "node:path";

const OUT = "poc-output/paint-roundtrip/proj-native";
fs.mkdirSync(OUT, { recursive: true });

// ---- Encoders under test ----
// A) legacy Prusa 2-bit: state1='0', state2='1', state3='3'
function encPrusa(n) {
  const v = n - 1;
  const bits = [(v & 1) === 1, ((v >> 1) & 1) === 1]; // LSB-first
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib |= (bits[i + j] ?? 0) << j;
    hex = "0123456789ABCDEF"[nib] + hex;
  }
  return hex.padStart(1, "0");
}
// B) modern 6-bit: state>=3 -> [1,1]+4bits(n-3) LSB; state<3 -> old 2-bit
function encModern(n) {
  const bits = [];
  if (n >= 3) {
    bits.push(1, 1);
    const v = n - 3;
    for (let i = 0; i < 4; i++) bits.push(((v >> i) & 1) === 1 ? 1 : 0);
  } else {
    const v = n - 1;
    bits.push((v & 1) === 1 ? 1 : 0, ((v >> 1) & 1) === 1 ? 1 : 0);
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib |= (bits[i + j] ?? 0) << j;
    hex = "0123456789ABCDEF"[nib] + hex;
  }
  return hex;
}
// C) 4-bit direct: state n -> single nibble (n-1)
function encNib(n) {
  return "0123456789ABCDEF"[n - 1];
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
const paintState = (i) => (i % 3) + 1;

function build(name, encoder, label, versions = [{ mk: "slic3rpe:MmPaintingVersion", v: "1" }]) {
  const xv = V.map((v) => `    <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("\n");
  const xt = T.map((t, i) => {
    const attr = ` slic3rpe:mmu_segmentation="${encoder(paintState(i))}"`;
    return `   <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${attr}/>`;
  }).join("\n");
  const metas = versions.map((x) => ` <metadata name="${x.mk}">${x.v}</metadata>`).join("\n");
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">BambuStudio-02.08.01.55</metadata>\r\n <metadata name="OrcaSlicer">2.5.0-dev</metadata>\r\n <metadata name="BambuStudio:3mfVersion">1</metadata>\r\n <metadata name="Application-old">paint-veins-${label}</metadata>
${metas}
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
  // project_settings.config with explicit filament colours (so Orca finds colors)
  const ps = `{
  "printer_model": "Anycubic Kobra S1",
  "default_filament_colour": ["#EEEEEE", "#FFD700", "#FF0000", "#0000FF"],
  "filament_colour": ["#EEEEEE", "#FFD700", "#FF0000", "#0000FF"],
  "nozzle_diameter": ["0.4"],
  "spiral_mode": "0",
  "single_extruder_multi_material": "1",
  "enable_prime_tower": "1",
  "flush_into_infill": "1",
  "flush_into_support": "0"
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
  console.log(`wrote ${name} (${label}) states=${[1, 2, 3].map((s) => `${s}:${encoder(s)}`).join(" ")}`);
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

build("proj-prusa.3mf", encPrusa, "prusa");
build("proj-modern.3mf", encModern, "modern");
build("proj-nib.3mf", encNib, "nib");

