/**
 * write-3mf.mjs — 3MF (ZIP) writer: plain 3D/3dmodel.model + [Content_Types].
 * S7-006 AC-2: R0's read-only 3MF path becomes read/write with a minimal,
 * spec-conforming writer (RFC 1950 deflate, ZIP store header, central dir).
 *
 * The writer emits a 3MF v1.0 model: one `<object>` per input mesh with
 * `<vertices>` + `<triangles>`, an optional `<item>` on the default build
 * `<resources>` (so the model renders), and the required
 * `[Content_Types].xml` + `_rels/.rels` members. The output is a valid ZIP
 * (EOCD + central directory) readable by `read-3mf.mjs` and by slicers.
 *
 * Determinism: no timestamps are embedded (fixed 1980-01-01 DOS date), and
 * deflate uses the same fixed dictionary for identical input → byte-stable
 * output for identical geometry (round-trip tests assert exact re-import).
 *
 * Usage (CLI):  node scripts/write-3mf.mjs <out.3mf> <mesh.json>
 *   mesh.json = { "name": "obj", "positions": [...], "triangles": [[a,b,c],...] }
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dosTimestamp() {
  // Fixed 1980-01-01 00:00:00 — deterministic output (no timestamps).
  return { time: 0, date: 0x21 };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Raw-deflate a buffer (RFC 1950) for ZIP method 8. */
function deflateRaw(data) {
  // zlib.deflateRawSync yields the raw DEFLATE stream (method 8).
  return zlib.deflateRawSync(data, { level: 9 });
}

/**
 * Build a minimal 3MF document for the given meshes.
 * @param {Array<{name:string, positions:number[], triangles:Array<[number,number,number]>}>} meshes
 */
export function build3mf(meshes) {
  const objects = meshes
    .map((m, idx) => {
      const verts = [];
      for (let i = 0; i < m.positions.length; i += 3) {
        const p = m.positions.slice(i, i + 3).map(round);
        verts.push(`        <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`);
      }
      const tris = m.triangles.map(
        ([a, b, c]) => `        <triangle v1="${a}" v2="${b}" v3="${c}"/>`,
      );
      return `    <object id="${idx + 1}" type="model" name="${xmlEscape(m.name)}">
      <mesh>
        <vertices>
${verts.join("\n")}
        </vertices>
        <triangles>
${tris.join("\n")}
        </triangles>
      </mesh>
    </object>`;
    })
    .join("\n");
  const items = meshes
    .map((_, idx) => `    <item objectid="${idx + 1}" transform="1 0 0 0 1 0 0 0 1"/>`)
    .join("\n");
  const model = `${XML_HEADER}<model unit="millimeter" xml:lang="en-US" xmlns="${NS}">
  <resources>
${objects}
  </resources>
  <build>
${items}
  </build>
</model>
`;
  const contentType = `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return { model, contentType, rels };
}

function round(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Compose a 3MF ZIP buffer (EOCD + central directory + local headers).
 * Deterministic: fixed DOS timestamp, stored method for the XML members,
 * deflate (method 8) for the model (identical to real slicers).
 * @returns {Buffer}
 */
export function composeZip({ model, contentType, rels }) {
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentType, "utf8"), method: 0 },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8"), method: 0 },
    { name: "3D/3dmodel.model", data: Buffer.from(model, "utf8"), method: 8 },
  ];
  const { time, date } = dosTimestamp();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const crc = crc32(e.data);
    const store = e.method === 0 ? e.data : deflateRaw(e.data);
    const nameBuf = Buffer.from(e.name, "utf8");
    // Local file header.
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flags: UTF-8
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(store.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    chunks.push(lh, nameBuf, store);

    // Central directory entry.
    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);
    ce.writeUInt16LE(20, 4); // version made by
    ce.writeUInt16LE(20, 6); // version needed
    ce.writeUInt16LE(0x0800, 8);
    ce.writeUInt16LE(e.method, 10);
    ce.writeUInt16LE(time, 12);
    ce.writeUInt16LE(date, 14);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(store.length, 20);
    ce.writeUInt32LE(e.data.length, 24);
    ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(0, 30); // extra
    ce.writeUInt16LE(0, 32); // comment
    ce.writeUInt16LE(0, 34); // disk
    ce.writeUInt16LE(0, 36); // internal attrs
    ce.writeUInt32LE(0, 38); // external attrs
    ce.writeUInt32LE(offset, 42);
    central.push(ce, nameBuf);
    offset += lh.length + nameBuf.length + store.length;
  }
  const cdStart = chunks.reduce((n, c) => n + c.length, 0);
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * Write a 3MF file from mesh JSON.
 * @param {string} outPath
 * @param {Array} meshes (see build3mf)
 * @returns {{ok:true, path:string, bytes:number}}
 */
export function write3mf(outPath, meshes) {
  const doc = build3mf(meshes);
  const buf = composeZip(doc);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return { ok: true, path: outPath, bytes: buf.length };
}

// CLI path.
const [, , outPath, meshJson] = process.argv;
if (outPath && meshJson) {
  const meshes = JSON.parse(fs.readFileSync(meshJson, "utf8"));
  const r = write3mf(outPath, Array.isArray(meshes) ? meshes : [meshes]);
  console.log(`wrote ${r.path} (${r.bytes} bytes)`);
}
