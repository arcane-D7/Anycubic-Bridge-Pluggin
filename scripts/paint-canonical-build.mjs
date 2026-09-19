// Build a canonical Anycubic-accepted 3MF project with per-triangle MMU paint,
// replicating the full entry set of Peça-final.3mf (mesh inline in 3dmodel.model).
// Encoders: legacy (0/1/2/3), nib (0/1/2/3), modern (0/1/03), prusa (0/1/2/3)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "poc-output", "paint-roundtrip", "canonical");
mkdirSync(outDir, { recursive: true });

// ---- cube geometry: 8 corners, 12 triangles outward ----
const V = [
  [-10, -10, -10], [10, -10, -10], [10, 10, -10], [-10, 10, -10], // bottom -10
  [-10, -10, 10], [10, -10, 10], [10, 10, 10], [-10, 10, 10],     // top +10
];
// outward-facing triangles (CCW seen from outside)
const T = [
  [0, 2, 1], [0, 3, 2], // bottom z=-10 (facing down)
  [4, 5, 6], [4, 6, 7], // top z=+10 (facing up)
  [0, 5, 4], [0, 1, 5], // -y
  [1, 6, 5], [1, 2, 6], // +x
  [2, 7, 6], [2, 3, 7], // +y
  [3, 0, 7], [3, 4, 7], // -x  (note [3,4,7] reversed winding -> check)
];
// paint: base = no attr (or "0"); gold (T2) = 3; black (T3) = 4
// triangles 0-3 (bottom+top) base "0"; gold on +x/+y faces; black on -x/-y faces
const paintMap = {
  0: "base", 1: "base", 2: "base", 3: "base",
  4: "base", 5: "gold", 6: "gold", 7: "gold",
  8: "gold", 9: "black", 10: "black", 11: "black",
};

// ---- encoders ----
const encoders = {
  legacy: st => ({ base: "0", gold: "3" , black: "4" }[st] ?? "0"),
  nib:    st => ({ base: "0", gold: "3" , black: "4" }[st] ?? "0"),
  modern: st => ({ base: "0", gold: "03", black: "04" }[st] ?? "0"),
  prusa:  st => ({ base: "0", gold: "3" , black: "4" }[st] ?? "0"),
};

const xmlEscape = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- Anycubic CLI 1:1 format (from poc-output/cli-native/cube-cli2.3mf) ----
// object id 1 = mesh in 3D/Objects/<name>_1.model (per-triangle paint here)
// object id 2 = wrapper in 3D/3dmodel.model with <components> ref + <build> item
const UUID1 = "00010000-81cb-4c03-9d28-80fed5dfa1dc";   // mesh object
const UUID2 = "00000001-61cb-4c03-9d28-80fed5dfa1dc";   // wrapper object
const UUIDB = "2c7c17d8-22b5-4d84-8835-1976022ea369";   // build
const UUIDI = "00000002-b1ec-4553-aec9-835e5b724bb4";   // build item
const UUIDC = "00010000-b206-40ff-9872-83e8017abed1";   // component ref

function meshObjectModel(encName, version) {
  const enc = encoders[encName];
  const colorisable = [5,6,7,8,9,10,11];
  const tris = T.map((t, i) => {
    const st = paintMap[i];
    const attr = colorisable.includes(i) ? ` slic3rpe:mmu_segmentation="${xmlEscape(enc(st))}"` : "";
    return `     <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${attr}/>`;
  }).join("\n");
  const verts = V.map((v, i) => `     <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="1" p:UUID="${UUID1}" type="model">
   <mesh>
    <vertices>
${verts}
    </vertices>
    <triangles>
${tris}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build/>
</model>
`;
}

function wrapperModelXml(encName, version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">BambuStudio-${version}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Copyright"></metadata>
 <metadata name="CreationDate"></metadata>
 <metadata name="Description"></metadata>
 <metadata name="Designer"></metadata>
 <metadata name="DesignerCover"></metadata>
 <metadata name="DesignerUserId"></metadata>
 <metadata name="License"></metadata>
 <metadata name="ModificationDate"></metadata>
 <metadata name="Origin"></metadata>
 <metadata name="Title">paint-canonical-${encName}</metadata>
 <resources>
  <object id="2" p:UUID="${UUID2}" type="model">
   <components>
    <component p:path="/3D/Objects/paint-cube-${encName}.model" objectid="1" p:UUID="${UUIDC}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build p:UUID="${UUIDB}">
  <item objectid="2" p:UUID="${UUIDI}" transform="1 0 0 0 1 0 0 0 1 125 125 7.5" printable="1"/>
 </build>
</model>
`;
}

const plateJson = `{"bbox_all":[117.5,117.5,132.5,132.5],"bbox_objects":[{"area":225,"bbox":[117.5,117.5,132.5,132.5],"id":28,"layer_height":0.2,"name":"paint-cube"}],"bed_type":"textured_plate","filament_colors":[],"filament_ids":[],"first_extruder":1,"first_layer_time":1,"is_seq_print":false,"nozzle_diameter":0.4,"version":2}`;

function modelSettings(encName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="paint-cube"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="paint-cube-${encName}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="paint-cube-${encName}.model"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="filament_maps" value="1 1 1 1"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="28"/>
    </model_instance>
  </plate>
  <assemble>
  </assemble>
</config>
`;
}

const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-ACNext-Client-Type" value="slicer"/>
    <header_item key="X-ACNext-Client-Version" value="2.0.0.3 20260904033713"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="Anycubic Kobra S1"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="timelapse_type" value="0"/>
    <metadata key="prediction" value="0"/>
    <metadata key="weight" value=""/>
    <metadata key="outside" value="false"/>
    <metadata key="support_used" value="false"/>
    <metadata key="label_object_enabled" value="false"/>
    <metadata key="filament_maps" value="1 1 1 1"/>
    <object identify_id="28" name="paint-cube" skipped="false" />
    <filament id="1" tray_info_idx="" type="PLA" color="#000000" used_m="0" used_g="0" />
    <filament id="2" tray_info_idx="" type="PLA" color="#000000" used_m="0" used_g="0" />
    <filament id="3" tray_info_idx="" type="PLA" color="#000000" used_m="0" used_g="0" />
    <filament id="4" tray_info_idx="" type="PLA" color="#000000" used_m="0" used_g="0" />
  </plate>
</config>
`;

const filamentSeq = `{"plate_1":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="application/xml"/>
 <Default Extension="json" ContentType="application/json"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>
`;

const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

function build(encName, useNibVersion = false) {
  const version = useNibVersion ? "2.0.0.3" : "2.0.0.3";
  const meshRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/paint-cube-${encName}.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  const files = {
    "[Content_Types].xml": Buffer.from(contentTypes, "utf8"),
    "Metadata/plate_1.json": Buffer.from(plateJson, "utf8"),
    "Metadata/project_settings.config": Buffer.from(projectConfig(encName, version), "utf8"),
    "Metadata/model_settings.config": Buffer.from(modelSettings(encName), "utf8"),
    "Metadata/slice_info.config": Buffer.from(sliceInfo, "utf8"),
    "Metadata/filament_sequence.json": Buffer.from(filamentSeq, "utf8"),
    "3D/3dmodel.model": Buffer.from(wrapperModelXml(encName, version), "utf8"),
    "3D/_rels/3dmodel.model.rels": Buffer.from(meshRels, "utf8"),
    ["3D/Objects/paint-cube-" + encName + ".model"]: Buffer.from(meshObjectModel(encName, version), "utf8"),
    "_rels/.rels": Buffer.from(rels, "utf8"),
  };
  const out = path.join(outDir, `canonical-${encName}${useNibVersion ? "-nib" : ""}.3mf`);
  writeZip(files, out);
  return out;
}

// minimal Zip writer (deflate STORE), correct offsets
import zlib from "node:zlib";
function crc32(buf) {
  let c, crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ (-1)) >>> 0;
}
function writeZip(files, outPath) {
  const buffers = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const localStart = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6);  // flags
    local.writeUInt16LE(0, 8);  // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    buffers.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // CEN sig
    cen.writeUInt16LE(20, 4);  // version made by
    cen.writeUInt16LE(20, 6);  // version needed
    cen.writeUInt16LE(0, 8);   // flags
    cen.writeUInt16LE(0, 10);  // method store
    cen.writeUInt16LE(0, 12);  // time
    cen.writeUInt16LE(0, 14);  // date
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra len
    cen.writeUInt16LE(0, 32); // comment len
    cen.writeUInt16LE(0, 34); // disk start
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(localStart, 42); // relative offset of local header
    central.push({ cen, nameBuf });
  }
  const cdStart = offset;
  for (const { cen, nameBuf } of central) {
    buffers.push(cen, nameBuf);
    offset += cen.length + nameBuf.length;
  }
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD sig
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  buffers.push(eocd);
  const all = Buffer.concat(buffers);
  writeFileSync(outPath, all);
}

function projectConfig(encName, version) {
  // The Anycubic engine reads project_settings.config as JSON (not XML!).
  // Base: the CLI-generated cube-abs template with 4 colors pre-set.
  let cfg = JSON.parse(readFileSync(path.join(outDir, "project-settings-template.json"), "utf8"));
  // mark multi-material explicitly
  cfg.single_extruder_multi_material = "1";
  cfg.extruder_count = "4";
  cfg.name = `paint-veins-${encName}`;
  return JSON.stringify(cfg, null, 1);
}

build("prusa");
build("legacy");
build("modern");
build("nib");
build("prusa", true); // nib version
console.log("Built canonical 3MFs in", outDir);
