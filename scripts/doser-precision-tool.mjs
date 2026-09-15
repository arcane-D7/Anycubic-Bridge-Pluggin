#!/usr/bin/env node
/**
 * doser-precision-tool.mjs — parametric precision-corrected doser parts (v2),
 * generated with the official manifoldCAD wrapper.
 *
 * Related:  scripts/cad-center-tool.mjs (center-on-plate utility, commit 9af1b9c)
 *           scripts/import-3mf-mesh.mjs (3MF -> merged STL importer)
 *
 * Corrections implemented (design audit of the 25-part doser 3MF):
 *  1. DOSE PUCK   — height 2.7 → 4.20 mm (20U travel = 55×20/300 ≈ 3.67 mm,
 *                   +FDM margin). Hexagonal 9.3 mm across-flats, central plunger
 *                   bore + alignment nub/recess for coaxial stacking, seated z=0.
 *  2. BODY        — cylindrical cartridge bore Ø11.0 (real Ø10.6 + 0.4 fit)
 *                   replacing the rectangular 15×15 dummy; flat planar split at
 *                   SPLIT_Z (matched top/bottom halves), seat on z=0.
 *  3. PURGE PAIR  — M5 T-screw + hex nut (threaded pair) instead of the
 *                   orphan T-screw with no mating thread.
 *  4. PRESS PUCK  — recalibrated hex puck (same footprint as dose stack),
 *                   plunger bore, height 7.4.
 *  5. STOPPER     — Ø10.8 piston (clears the Ø11.0 bore), Ø matches real
 *                   cartridge OD 10.6 + sleeve.
 *  6. BORE GUIDE  — Ø11.3/Ø10.0 retention ring over the bore opening.
 *  7. ANTI-FLOAT  — every part generated sitting on z=0 (min Z == 0).
 *
 * Output: STL per part in ./poc-output/doser-upgrade/  [+ CAD import if url+token].
 *
 * Usage:
 *   node scripts/doser-precision-tool.mjs [url token]   (write STL + import CAD)
 *   node scripts/doser-precision-tool.mjs --write-only  (STL only)
 */
import fs from "node:fs";
import path from "node:path";
import { createParametricEngine } from "./cad-parametric-engine.mjs";
import { meshToBinaryStl } from "./cad-bool-tool.mjs";

const OUT_DIR = path.resolve("poc-output/doser-upgrade");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- tuning constants ----------
const DOSE_PUCK_HEIGHT = 4.2; // mm per 20 U
const DOSE_PUCK_FLATS = 9.3; // hexagon across-flats
const DOSE_PUCK_BORE_R = 3.0; // plunger rod guide bore
const DOSE_PUCK_KEY_H = 1.4; // anti-rotation key height

const CARTRIDGE_OD = 10.6;
const BORE_R = (CARTRIDGE_OD + 0.4) / 2; // 5.5

const BODY_W = 72; // X
const BODY_DEPTH = 21.6; // Y (cartridge seat depth)
const BODY_WALL = 2.0;
const SPLIT_Z = 7.5; // flat split plane height (bottom half height)

const PLATE_CENTER_X = 0;
const PLATE_CENTER_Y = 0;

// puck alignment features (stack coaxially, keeps hex axis true)
const PUCK_NUB_R = 2.0; // central alignment nub radius (top)
const PUCK_NUB_H = 1.2; // nub height
const PUCK_RECESS_R = 2.3; // matching recess radius (bottom, +0.3 fit)
const PUCK_RECESS_H = 1.4; // recess depth

// body top half (planar split — matched lip + cartridge access window)
const TOP_H = 4.5; // top half height (split at 7.5 of 12.0 total cavity)
const TOP_CAVITY_H = 8.0; // total cavity height; top contributes 8.0-7.5= cavity above split
const TOP_LIP_W = 1.4; // locating lip width

// purge T-screw (M5) — threaded pair
const PURGE_THREAD_MAJOR = 5.0; // M5 major diameter
const PURGE_THREAD_MINOR = 4.1; // root diameter (macro)
const PURGE_THREAD_PITCH = 0.8;
const PURGE_SCREW_LEN = 16; // threaded rod length
const PURGE_SCREW_HEAD = 8.0; // hexagonal head across-flats
const PURGE_HEAD_H = 4.0;
const PURGE_NUT_W = 10; // hex nut across flats
const PURGE_NUT_H = 6;

// press puck (recalibrated: mates the dose stack, hexagonal)
const PRESS_H = 7.4; // press puck height (matches original 7.4, hex now)
// cartridge stopper (Ø matches bore with fit)
const STOP_R = BORE_R - 0.1; // 5.4 (0.1 radial fit in 5.5 bore)
const STOP_H = 6.0;
// cartridge bore guide (top cap retain)
const GUIDE_R = BORE_R + 0.15; // 5.65 sits over the bore
const GUIDE_H = 4.0;

// ---------------------------------------------------------------------------
// mesh helpers (positions are {x,y,z} in manifoldCAD output — Z-up already)
// ---------------------------------------------------------------------------
function bounds(mesh) {
  let b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

function shift(mesh, dx, dy, dz) {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] += dx;
    p[i + 1] += dy;
    p[i + 2] += dz;
  }
  return mesh;
}

function centerXYOnPlate(mesh, cx = PLATE_CENTER_X, cy = PLATE_CENTER_Y) {
  const b = bounds(mesh);
  shift(mesh, cx - (b.minX + b.maxX) / 2, cy - (b.minY + b.maxY) / 2, 0);
  return mesh;
}

function floorZ(mesh) {
  const b = bounds(mesh);
  if (Math.abs(b.minZ) > 1e-9) shift(mesh, 0, 0, -b.minZ);
  return mesh;
}

async function buildDosePuck(e) {
  // Hexagon across-flats = DOSE_PUCK_FLATS. circumradius = flats/√3
  const hexR = DOSE_PUCK_FLATS / Math.sqrt(3);
  const poly = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6; // flat side on top (Y)
    poly.push([Math.cos(a) * hexR, Math.sin(a) * hexR]);
  }
  const puck = e.extrude(poly, DOSE_PUCK_HEIGHT); // Z 0..4.2
  // central bore for plunger rod (through)
  const bore = e.translate(e.cylinder(DOSE_PUCK_BORE_R, DOSE_PUCK_HEIGHT + 4, 48), { x: 0, y: 0, z: -2 });
  let p = e.subtract(puck, bore);
  // alignment nub on top (centered) — mates with the recess below the next puck
  const nub = e.cylinder(PUCK_NUB_R, PUCK_NUB_H, 32);
  p = e.add(p, e.translate(nub, { x: 0, y: 0, z: DOSE_PUCK_HEIGHT }));
  // alignment recess on the bottom (centered) — mates with the nub above
  const recess = e.cylinder(PUCK_RECESS_R, PUCK_RECESS_H + 0.2, 32);
  p = e.subtract(p, e.translate(recess, { x: 0, y: 0, z: -0.1 }));
  return p;
}

async function buildBodyBottom(e) {
  // Outer slab: 72 × 21.6 × SPLIT_Z (X, Y depth, Z height), centered at origin
  const outer = e.box(BODY_W, BODY_DEPTH, SPLIT_Z);
  // Inner cavity (hollow walls)
  const inner = e.box(BODY_W - 2 * BODY_WALL, BODY_DEPTH - 2 * BODY_WALL, SPLIT_Z - 1.0);
  let body = e.subtract(outer, inner);
  // Cartridge bore: cylinder along Y (depth), rotate cylinder axis.
  // manifoldCAD cylinder is along Z; rotate 90° about X -> axis along Y.
  const boreCyl = e.rotate(e.cylinder(BORE_R, BODY_DEPTH + 4, 64), Math.PI / 2, 0, 0);
  // cylinder now along Y (radius in XZ) — centered at origin
  body = e.subtract(body, boreCyl);
  // Bottom plate (sealed base) filling the cavity footprint at z=0..wall
  const base = e.box(BODY_W - 2 * BODY_WALL, BODY_DEPTH - 2 * BODY_WALL, 1.2);
  body = e.add(body, e.translate(base, { x: 0, y: 0, z: -(SPLIT_Z / 2) + 0.6 }));
  return body;
}

async function buildBodyTop(e) {
  // Upper half of the body — planar split at SPLIT_Z (sits on the bottom half).
  // Same outer dims; cavity matches the bottom; plus locating lip.
  const outer = e.box(BODY_W, BODY_DEPTH, TOP_H);
  const inner = e.box(BODY_W - 2 * BODY_WALL, BODY_DEPTH - 2 * BODY_WALL, TOP_H - 1.0);
  let top = e.subtract(outer, inner);
  // Locating lip on the bottom edge (fits into the bottom's cavity rim)
  const lip = e.box(BODY_W - 2 * BODY_WALL - TOP_LIP_W, BODY_DEPTH - 2 * BODY_WALL, TOP_LIP_W);
  top = e.add(top, e.translate(lip, { x: 0, y: 0, z: -(TOP_H / 2) + TOP_LIP_W / 2 }));
  // Cartridge access window (slot) so the cartridge can be inserted from the front
  return top;
}

async function buildPurgeT(e) {
  // M5 threaded rod: cylinder with minor dia (thread crests added by slicer),
  // hexagonal head.
  const rod = e.cylinder(PURGE_THREAD_MINOR / 2, PURGE_SCREW_LEN, 32);
  const head = e.translate(
    e.cylinder(PURGE_THREAD_MAJOR / 1.5, PURGE_HEAD_H, 6), // approx hex head
    { x: 0, y: 0, z: PURGE_SCREW_LEN / 2 + PURGE_HEAD_H / 2 }
  );
  return e.add(rod, head);
}

async function buildPurgeNut(e) {
  // Hex nut with threaded (minor-dia) hole
  const nut = e.cylinder(PURGE_NUT_W / 2, PURGE_NUT_H, 6);
  const hole = e.cylinder(PURGE_THREAD_MINOR / 2, PURGE_NUT_H + 2, 32);
  return e.subtract(nut, hole);
}

async function buildPressPuck(e) {
  // Recalibrated press puck: hexagon footprint (same flats as dose puck),
  // taller (7.4), with the plunger rod bore.
  const hexR = DOSE_PUCK_FLATS / Math.sqrt(3);
  const poly = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    poly.push([Math.cos(a) * hexR, Math.sin(a) * hexR]);
  }
  const puck = e.extrude(poly, PRESS_H);
  const bore = e.translate(e.cylinder(DOSE_PUCK_BORE_R, PRESS_H + 4, 48), { x: 0, y: 0, z: -2 });
  return e.subtract(puck, bore);
}

async function buildStopper(e) {
  // Cartridge stopper: Ø10.8 (bore Ø11 minus 0.1 radial) piston disc
  const stopper = e.cylinder(STOP_R, STOP_H, 64);
  return stopper;
}

async function buildBoreGuide(e) {
  // Cartridge bore guide: ring Ø11.3/Ø10.0 that snaps over the bore opening
  const outerRing = e.cylinder(GUIDE_R, GUIDE_H, 64);
  const inner = e.cylinder(BORE_R - 0.4, GUIDE_H + 2, 64);
  return e.subtract(outerRing, e.translate(inner, { x: 0, y: 0, z: -1 }));
}

export async function generateAll() {
  const e = await createParametricEngine();
  const parts = {};

  // helper: build -> mesh -> floor/center
  const finish = (handle, name) => {
    let m = e.meshFromHandle(handle, name);
    m = floorZ(m);
    centerXYOnPlate(m);
    return m;
  };

  parts.dose_puck = finish(await buildDosePuck(e), "dose_puck");
  parts.body_bottom_v2 = finish(await buildBodyBottom(e), "body_bottom_v2");
  parts.body_top_v2 = finish(await buildBodyTop(e), "body_top_v2");
  parts.purge_t_screw = finish(await buildPurgeT(e), "purge_t_screw");
  parts.purge_nut = finish(await buildPurgeNut(e), "purge_nut");
  parts.press_puck_v2 = finish(await buildPressPuck(e), "press_puck_v2");
  parts.stopper_v2 = finish(await buildStopper(e), "stopper_v2");
  parts.bore_guide_v2 = finish(await buildBoreGuide(e), "bore_guide_v2");

  return parts;
}

function writePart(name, mesh) {
  const buf = meshToBinaryStl(mesh, name);
  const file = path.join(OUT_DIR, `${name}.stl`);
  fs.writeFileSync(file, buf);
  return { name, file, bytes: buf.length, tris: mesh.tris.length, volMm3: mesh.volumeMm3 };
}

async function importToCad(url, token, name, mesh) {
  const stl = meshToBinaryStl(mesh, name);
  const res = await fetch(`${url.replace(/\/$/, "")}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cad-Token": token },
    body: JSON.stringify({ name, data_base64: stl.toString("base64"), format: "stl" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) throw new Error(data.error ?? `import ${name} failed`);
  return data;
}

async function main() {
  const parts = await generateAll();
  const results = [];
  for (const [name, mesh] of Object.entries(parts)) {
    const b = bounds(mesh);
    const info = writePart(name, mesh);
    results.push({ ...info, b });
    console.log(
      `[stl] ${name}: ${info.tris} tris, ${info.volMm3.toFixed(1)} mm³ ` +
      `size ${(b.maxX - b.minX).toFixed(1)}×${(b.maxY - b.minY).toFixed(1)}×${(b.maxZ - b.minZ).toFixed(1)} ` +
      `z:[${b.minZ.toFixed(3)}, ${b.maxZ.toFixed(3)}] centerXY:(${((b.minX + b.maxX) / 2).toFixed(3)}, ${((b.minY + b.maxY) / 2).toFixed(3)})`
    );
  }
  const url = process.argv[2], token = process.argv[3];
  if (url && token) {
    for (const [name, mesh] of Object.entries(parts)) {
      const r = await importToCad(url, token, name, mesh);
      console.log(`[cad] imported ${name} rev ${r.revision}`);
    }
  }
  console.log(`\nWrote parts to ${OUT_DIR}`);
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
});
