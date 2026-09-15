// Quick diagnostic: per-instance bounding boxes of the recovery plate
import fs from "node:fs";

const [, , meshPath, platePath] = process.argv;

function parseObjects(xml) {
  const objects = [];
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objectRe.exec(xml)) !== null) {
    const idMatch = m[1].match(/id="(\d+)"/);
    const id = idMatch ? Number(idMatch[1]) : 0;
    const body = m[2];
    const vertices = [];
    const vertRe = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
    let v;
    while ((v = vertRe.exec(body)) !== null)
      vertices.push([Number(v[1]), Number(v[2]), Number(v[3])]);
    objects.push({ id, vertices });
  }
  return objects;
}

function parseTransform(str) {
  const parts = (str ?? "").trim().split(/\s+/).map(Number);
  if (parts.length < 12) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return [
    parts[0],
    parts[1],
    parts[2],
    parts[9],
    parts[3],
    parts[4],
    parts[5],
    parts[10],
    parts[6],
    parts[7],
    parts[8],
    parts[11],
    0,
    0,
    0,
    1,
  ];
}

function applyMatrix(v, m) {
  const x = v[0],
    y = v[1],
    z = v[2];
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

function bbox(verts, m) {
  let bmin = [Infinity, Infinity, Infinity],
    bmax = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    const p = applyMatrix(v, m);
    for (let i = 0; i < 3; i++) {
      if (p[i] < bmin[i]) bmin[i] = p[i];
      if (p[i] > bmax[i]) bmax[i] = p[i];
    }
  }
  return { min: bmin.map((x) => x.toFixed(2)), max: bmax.map((x) => x.toFixed(2)) };
}

const meshXml = fs.readFileSync(meshPath, "utf8");
const objects = parseObjects(meshXml);
for (const o of objects) {
  console.log(
    `object ${o.id}: ${o.vertices.length} verts, local bbox:`,
    JSON.stringify(bbox(o.vertices, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
  );
}

const plateXml = fs.readFileSync(platePath, "utf8");
const compRe = /<component\b([^>]*)\bobjectid="(\d+)"[^>]*transform="([^"]*)"/g;
let c,
  idx = 0;
while ((c = compRe.exec(plateXml)) !== null) {
  const id = Number(c[2]);
  const t = parseTransform(c[3]);
  const obj = objects.find((o) => o.id === id);
  if (obj) {
    idx++;
    console.log(
      `instance ${idx}: obj${id} plate-frame bbox:`,
      JSON.stringify(bbox(obj.vertices, t)),
    );
  } else {
    console.log(`instance ${idx}: obj${id} NOT FOUND in mesh doc`);
  }
}
const buildRe = /<item\b([^>]*)\bobjectid="(\d+)"[^>]*transform="([^"]*)"/g;
let b;
while ((b = buildRe.exec(plateXml)) !== null) {
  console.log(`build item: objectid=${b[2]} transform=${b[3]}`);
}
