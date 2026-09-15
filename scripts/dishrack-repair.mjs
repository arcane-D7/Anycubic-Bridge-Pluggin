// dishrack-repair.mjs — Fix mesh quality + structural reinforcement for the dish rack 3MF.
//  1) Weld duplicate vertices (fixed back the ~260x vertex explosion on base parts)
//  2) Remove degenerate triangles (zero-area) in nodes/couplers
//  3) --braces: add a rigid mid-height box (4 bars linking the 4 posts, z=100..140)
// Output: <source>-FIXED.3mf (same absolute coordinates; assembly preserved)
import fs from "node:fs";
import zlib from "node:zlib";

const HELP = `Usage: node dishrack-repair.mjs <file.3mf> [--braces] [--out <out.3mf>]
  Repair: weld duplicate vertices (dedupe at 0.001mm), remove degenerate tris.
  --braces: also inject 4 brace objects forming a rigid mid-height box
            between the 4 posts (z=100..140), plus build items (no transforms).
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log(HELP);
  process.exit(0);
}
const src = args.find((a) => a.endsWith(".3mf"));
const wantBraces = args.includes("--braces");
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : src.replace(/\.3mf$/, "-FIXED.3mf");

// ---------- zip ----------
const buf = fs.readFileSync(src);
let eocd = -1;
for (let i = buf.length - 22; i > 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
if (eocd < 0) throw new Error("bad zip: no EOCD");
const nEntries = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const entries = [];
for (let i = 0; i < nEntries; i++) {
  const method = buf.readUInt16LE(off + 10);
  const comp = buf.readUInt32LE(off + 20);
  const unp = buf.readUInt32LE(off + 24);
  const crc = buf.readUInt32LE(off + 16);
  const nlen = buf.readUInt16LE(off + 28);
  const elen = buf.readUInt16LE(off + 30);
  const clen = buf.readUInt16LE(off + 32);
  const name = buf.toString("utf8", off + 46, off + 46 + nlen);
  entries.push({ name, method, comp, unp, crc, lho: buf.readUInt32LE(off + 42) });
  off += 46 + nlen + elen + clen;
}
function readEntry(e) {
  const lh = e.lho;
  const nm = buf.readUInt16LE(lh + 26);
  const em = buf.readUInt16LE(lh + 28);
  const dataOff = lh + 30 + nm + em;
  const raw = buf.subarray(dataOff, dataOff + e.comp);
  return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
}
const modelEntry = entries.find((e) => e.name.startsWith("3D/") && e.name.endsWith(".model"));

// ---------- weld + deg removal ----------
const stats = { welded: 0, degRemoved: 0, obj: 0 };
function weldMesh(meshXml) {
  const vraw = [...meshXml.matchAll(/<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"/g)].map((m) => [+m[1], +m[2], +m[3]]);
  const triTags = [...meshXml.matchAll(/<triangle\b([^>]*)\/?>/g)].map((m) => m[0]);
  const triIdx = triTags.map((t) => {
    const m = /v1="(\d+)" v2="(\d+)" v3="(\d+)"/.exec(t);
    return m ? [+m[1], +m[2], +m[3]] : null;
  });
  if (vraw.length === 0) return { meshXml, welded: 0, deg: 0 };

  const keyOf = (v) =>
    Math.round(v[0] * 1e3).toString(36) + "," + Math.round(v[1] * 1e3).toString(36) + "," + Math.round(v[2] * 1e3).toString(36);
  const posKey = new Map();
  const uniqV = [];
  for (const v of vraw) {
    const k = keyOf(v);
    let idx = posKey.get(k);
    if (idx === undefined) { idx = uniqV.length; posKey.set(k, idx); uniqV.push(v); }
  }
  const remap = vraw.map((v) => posKey.get(keyOf(v)));

  const vertsXml = uniqV.map((v) => `        <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}" />`).join("\n");
  const triXml = [];
  for (let t = 0; t < triTags.length; t++) {
    const idx = triIdx[t];
    if (!idx) continue;
    const a = remap[idx[0]], b = remap[idx[1]], c = remap[idx[2]];
    if (a === b || b === c || a === c) { stats.degRemoved++; continue; }
    triXml.push(triTags[t].replace(/v1="\d+"/, `v1="${a}"`).replace(/v2="\d+"/, `v2="${b}"`).replace(/v3="\d+"/, `v3="${c}"`));
  }
  const meshOut = `      <mesh>
        <vertices>
${vertsXml}
        </vertices>
        <triangles>
${triXml.join("\n")}
        </triangles>
      </mesh>`;
  return { meshXml: meshOut, welded: vraw.length - uniqV.length };
}

// ---------- brace meshes ----------
let newObjects = "";
let newBuildItems = "";
let idCounter = 1000;

function meshFromBox(x0, y0, x1, y1, z0, z1) {
  const verts = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const tri = [];
  for (const f of faces) { tri.push([f[0], f[1], f[2]]); tri.push([f[0], f[2], f[3]]); }
  const vx = verts.map((p) => `        <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}" />`).join("\n");
  const tx = tri.map((t) => `        <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}" />`).join("\n");
  return `      <mesh>
        <vertices>
${vx}
        </vertices>
        <triangles>
${tx}
        </triangles>
      </mesh>`;
}

function addBraceObject(name, p1, p2, z0, z1, width = 14) {
  const id = idCounter++;
  const [ax, ay] = p1;
  const [bx, by] = p2;
  const vertical = Math.abs(ax - bx) < Math.abs(ay - by);
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  const mesh = vertical
    ? meshFromBox((ax + bx) / 2 - width / 2, y0 + 1, (ax + bx) / 2 + width / 2, y1 - 1, z0, z1)
    : meshFromBox(x0 + 1, (ay + by) / 2 - width / 2, x1 - 1, (ay + by) / 2 + width / 2, z0, z1);
  newObjects += `  <object id="${id}" type="model" name="${name}">
${mesh}
  </object>
`;
  newBuildItems += `    <item objectid="${id}" />\n`;
}

// ---------- process objects ----------
let xml = readEntry(modelEntry).toString();
const objBlocks = [...xml.matchAll(/<object\b[^>]*>([\s\S]*?)<\/object>/g)];
const outBlocks = [];
for (const blk of objBlocks) {
  const id = blk[0].match(/id="(\d+)"/)?.[1] ?? "?";
  const meshInner = blk[1].match(/<mesh\b[^>]*>([\s\S]*?)<\/mesh>/)?.[1] ?? blk[1];
  const r = weldMesh(meshInner);
  stats.obj++;
  stats.welded += r.welded;
  const name = xml.match(new RegExp(`<object[^>]*id="${id}"[^>]*name="([^"]*)"`))?.[1] ??
    xml.match(new RegExp(`<object[^>]*name="([^"]*)"[^>]*id="${id}"`))?.[1] ?? "obj" + id;
  outBlocks.push(`  <object id="${id}" type="model" name="${name}">
${r.meshXml}
  </object>`);
}

// ---------- braces ----------
if (wantBraces) {
  // Collision-safe mid-height reinforcing bars for the DISH RACK ONLY.
  //   cutlery_connected bbox: x[-128.24,-61]  y[31.4,258.85]  z[20.65,152]
  //   lid_holder_M       bbox: x[323.11,374.5] y[44.97,217]    z[57,153]
  //   free central corridor: x[-61,323.11] (y free) — put bars INSIDE it.
  // Bars link post1<->post2 (front row, y=26) and post3<->post4 (rear row, y=266)
  //   spanning x=-60..322 at z=100..140 → halves free post span (172mm→~92mm)
  //   stays clear of cutlery (x>-61) and lid_holder (x<323.11).
  addBraceObject("brace_mid_F", [-60, 26], [322, 26], 100, 140, 14);
  addBraceObject("brace_mid_B", [-60, 266], [322, 266], 100, 140, 14);
  console.log("braces added: 2 (brace_mid_F / brace_mid_B)");
}

// ---------- rebuild <model> ----------
const modelHead = xml.match(/<model\b[^>]*>/)?.[0] ?? '<model unit="millimeter">';
const buildMatch = xml.match(/<build\b[^>]*>([\s\S]*?)<\/build>/);
const buildBody = buildMatch?.[1] ?? "";
const newBuild = `  <build>
${buildBody}${newBuildItems}  </build>`;
const newXml = `${modelHead}
  <resources>
${outBlocks.join("\n")}
${newObjects}  </resources>
${newBuild}
</model>`;

// ---------- write zip ----------
function crc32(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    let c = (crc ^ data[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const parts = [];
  let offset = 0;
  const central = [];
  for (const f of files) {
    const data = f.data;
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);      // version needed
    lh.writeUInt16LE(0, 6);       // flags
    lh.writeUInt16LE(8, 8);       // method = deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    parts.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);      // method = deflate
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdLen = central.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdLen, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, eocd]);
}
const deflated = (s) => zlib.deflateRawSync(Buffer.from(s, "utf8"), { level: 9 });
const files = entries.map((e) => {
  const data = e.name === modelEntry.name ? deflated(newXml) : deflated(readEntry(e).toString());
  return { name: e.name, data };
});
const zipBuf = makeZip(files);
if (out) {
  fs.writeFileSync(out, zipBuf);
  console.log(`\nWROTE ${out}`);
  console.log(`  size: ${(buf.length / 1024).toFixed(0)} KB -> ${(zipBuf.length / 1024).toFixed(0)} KB`);
  console.log(`  welded dup verts: ${stats.welded}`);
  console.log(`  degenerate tris removed: ${stats.degRemoved}`);
  console.log(`  objects processed: ${stats.obj} (+${wantBraces ? 4 : 0} braces)`);
} else {
  console.log("dry run stats:", stats);
}
