/**
 * Patch a native (Bambu/Anycubic) 3MF to remove geometry below a Z plane by
 * inserting a negative box part, letting the slicer's native CSG produce a
 * clean capped top piece.
 *
 * Usage:
 *   node tools/3mf/patch-3mf-cut.mjs <input.3mf> <output.3mf> <worldZtop-mm>
 *
 *   worldZtop = world Z (mm) above which geometry is KEPT.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { read3mf } from "../../scripts/read-3mf.mjs";

// ---- ZIP writing -----------------------------------------------------------
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

// ---- Unit cube mesh file ----------------------------------------------------
const CUTTER_OBJECT = 10;
const CUTTER_FILE = "3D/Objects/Cutter.model";

function cutterModelXml() {
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
    .map(
      (p) => `    <vertex x="${p[0].toFixed(6)}" y="${p[1].toFixed(6)}" z="${p[2].toFixed(6)}"/>`,
    )
    .join("\n");
  const tri = faces.map(([a, b, c]) => `    <triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="${CUTTER_OBJECT}" type="model">
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
</model>
`;
}

// ---- main -------------------------------------------------------------------
const [, , inPath, outPath, zTopArg] = process.argv;
if (!inPath || !outPath || zTopArg === undefined) {
  console.error("usage: node tools/3mf/patch-3mf-cut.mjs <input.3mf> <output.3mf> <worldZtop-mm>");
  process.exit(2);
}
const Z_TOP = Number(zTopArg);
if (!Number.isFinite(Z_TOP)) {
  console.error("worldZtop must be a number");
  process.exit(2);
}

const files = read3mf(inPath);
const modelEntry = files.find((f) => f.name === "3D/3dmodel.model");
const settingsEntry = files.find((f) => f.name === "Metadata/model_settings.config");
const ctEntry = files.find((f) => f.name === "[Content_Types].xml");
const relsEntry = files.find((f) => f.name === "3D/_rels/3dmodel.model.rels");
if (!modelEntry || !settingsEntry) {
  console.error(
    "input is not a native 3MF (missing 3D/3dmodel.model or Metadata/model_settings.config)",
  );
  process.exit(2);
}
const modelText = modelEntry.data.toString("utf8");
const settingsText = settingsEntry.data.toString("utf8");

// Cut box in MESH-local coordinates (part matrices act on mesh coords).
// Notes on the transform chain (native file):
//   3dmodel.model object 3 hosts components; each component applies its own
//   transform to the shared mesh. build item then translates object 3 by
//   (125,125,0.109334) to world.
//   Component for object 1 (shelf) adds +14.9996672 z INSIDE object 3; the part
//   matrix in model_settings.config is the SAME placement (mesh->object3-local).
//   => world Z = buildZ(0.109334) + componentZ (cutter has none) + meshZ.
// We want the cutter's top (mesh z = +0.5*H + tzPart) to sit at world
// Z_TOP - MARGIN, i.e. 0.5*H + tzPart + 0.109334 = Z_TOP - MARGIN.
const H = 60; // box height in mesh units; covers well below -15.1
const MARGIN = 0.02;
const buildZ = 0.109333992;
const tzPart = Z_TOP - MARGIN - 0.5 * H - buildZ;
const bottomMesh = -0.5 * H + tzPart;
const bottomWorld = bottomMesh + buildZ;

// Rebase the BUILD translate so the cut cap lands ~on the bed (like the
// native model, whose bottom was slightly below Z=0). This is REQUIRED for
// CLI slicing: otherwise the kept geometry starts at Z=12.17, the first layer
// at Z=0 is empty and the export fails at skirt/brim generation.
//   old: worldZ = buildZ + (0.5H+tzPart)  (box top = Z_TOP - MARGIN)
//   new: want box top at -MARGIN  =>  newBuildZ = buildZ - (Z_TOP - MARGIN) - MARGIN
//      = buildZ - Z_TOP
const newBuildZ = buildZ - Z_TOP; // e.g. -12.080666008 for Z_TOP=12.19
console.log(`build translate Z rebased: ${buildZ} -> ${newBuildZ.toFixed(6)}`);
console.log(
  `cutter box world Z: ${bottomWorld.toFixed(2)} .. ${(Z_TOP - MARGIN).toFixed(2)} (keeps Z >= ${Z_TOP - 0.005})`,
);

// Shelf-local (mesh-local) component transform: scale 250,250,H; translate z=tzPart
// 3MF 12-value: a b c d e f g h i tx ty tz
const compTransform = `250 0 0 0 250 0 0 0 ${H} 0 0 ${tzPart.toFixed(6)}`;

// ---- 1. 3dmodel.model --------------------------------------------------------
// Cutter is added ONLY as an extra <component> inside object 3 (line 6th).
// No separate reference object needed: 3MF part id = mesh object id.
const compInObj3 = `    <component p:path="/${CUTTER_FILE}" objectid="${CUTTER_OBJECT}" p:UUID="0002000a-b206-40ff-9872-83e8017abed1" transform="${compTransform}"/>
   </components>`;

let patchedModel = modelText;
const compClose = patchedModel.lastIndexOf("</components>");
if (compClose < 0) {
  console.error("no </components> found in 3dmodel.model");
  process.exit(2);
}
patchedModel =
  patchedModel.slice(0, compClose) +
  compInObj3 +
  patchedModel.slice(compClose + "</components>".length);

// Rebase build item Z so the cap sits on the bed.
patchedModel = patchedModel.replace(
  /(transform="[^"]*?125 125 )[\d.eE+-]+(")/,
  (_m, head, tail) => head + newBuildZ.toFixed(6) + tail,
);

// ---- 2. model_settings.config ------------------------------------------------
// part id MUST equal the mesh object id the part instantiates (see native file:
// object 1 -> part id="1", object 2 (holes) -> part id="2").
// Part matrix is in MESH-local coords, same as the component transform above.
const partId = CUTTER_OBJECT;
const partMatrix = `250 0 0 0 250 0 0 0 ${H} 0 0 ${tzPart.toFixed(6)}`;
const newPart = `    <part id="${partId}" subtype="negative_part">
      <metadata key="name" value="CutBelow${Z_TOP}"/>
      <metadata key="matrix" value="${partMatrix}"/>
      <metadata key="extruder" value="1"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
`;
const patchedSettings = settingsText.replace("</object>", newPart + "</object>");

// ---- 3. [Content_Types].xml --------------------------------------------------
let patchedCt = null;
if (ctEntry) {
  patchedCt = ctEntry.data
    .toString("utf8")
    .replace(
      "</Types>",
      ` <Override PartName="/${CUTTER_FILE}" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>`,
    );
}

// ---- 4. 3D/_rels/3dmodel.model.rels ------------------------------------------
let patchedRels = null;
if (relsEntry) {
  patchedRels = relsEntry.data
    .toString("utf8")
    .replace(
      "</Relationships>",
      ` <Relationship Target="/${CUTTER_FILE}" Id="rel-cutter" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>`,
    );
}

// ---- Rebuild zip --------------------------------------------------------------
const filesNew = files.map((f) => ({ name: f.name, data: f.data }));
for (const f of filesNew) {
  if (f.name === "3D/3dmodel.model") f.data = Buffer.from(patchedModel, "utf8");
  if (f.name === "Metadata/model_settings.config") f.data = Buffer.from(patchedSettings, "utf8");
  if (f.name === "[Content_Types].xml" && patchedCt) f.data = Buffer.from(patchedCt, "utf8");
  if (f.name === "3D/_rels/3dmodel.model.rels" && patchedRels)
    f.data = Buffer.from(patchedRels, "utf8");
}
filesNew.push({ name: CUTTER_FILE, data: Buffer.from(cutterModelXml(), "utf8") });

fs.writeFileSync(outPath, writeZip(filesNew));
console.log("wrote", outPath, `(${fs.statSync(outPath).size} bytes)`);
