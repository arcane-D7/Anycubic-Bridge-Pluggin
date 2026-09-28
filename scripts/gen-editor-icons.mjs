#!/usr/bin/env node
/**
 * Temporary generator for the R0 shell default icon set. Produces a simple
 * squared PNG (dark background + light "AB" monogram) and runs
 * `tauri icon` to emit the platform icons (icon.ico, icon.png 32x32, etc.).
 * This is generated artefact — not a design asset.
 *
 * Output: apps/editor/src-tauri/icons/ (gitignored? no — Tauri dev NEEDS the
 * ico at build time on Windows; the icon is generic, no account/machine data).
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const root = resolve(here, "..", "apps", "editor");
const srcPng = resolve(root, "app-icon.png");
const iconsDir = resolve(root, "src-tauri", "icons");

/** Minimal PNG encoder (RGBA, no interlace). */
function writePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    let c = 0xffffffff;
    for (const b of body) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const px = (x, y) => (y * 4 + x) * 4;
const bg = [18, 20, 26, 255]; // #12141a
const fg = [79, 156, 247, 255]; // --accent #4f9cf7

// 512x512 square: rounded dark tile + centered accent "AB" block (2 bars + bridge).
const S = 512;
const rgba = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // rounded corners (radius ~64)
    const r = 64;
    const cr =
      x < r && y < r
        ? Math.hypot(x - r + 0.5, y - r + 0.5) <= r
        : x >= S - r && y < r
          ? Math.hypot(x - (S - r) + 0.5, y - r + 0.5) <= r
          : x < r && y >= S - r
            ? Math.hypot(x - r + 0.5, y - (S - r) + 0.5) <= r
            : x >= S - r && y >= S - r
              ? Math.hypot(x - (S - r) + 0.5, y - (S - r) + 0.5) <= r
              : true;
    if (!cr) {
      rgba.set([0, 0, 0, 0], px(x, y));
      continue;
    }
    // accent "A" + "B" bars: two vertical bars with a bridge at 1/3 height
    const cx = x - S / 2;
    const cy = y - S / 2;
    const barW = 64;
    const barGap = 160;
    const inBar = Math.abs(cx - -barGap / 2) <= barW / 2 || Math.abs(cx - barGap / 2) <= barW / 2;
    const inBridge =
      Math.abs(cx) <= barGap / 2 + barW / 2 &&
      Math.abs(cy - S * 0.12) <= 36 &&
      Math.abs(cx) > barGap / 2 - barW / 2 - 8;
    const barTop = cy < -S * 0.22;
    if (inBar && !barTop) {
      rgba.set(fg, px(x, y));
    } else if (inBridge && Math.abs(cx) <= barGap / 2 + barW / 2 - 12) {
      rgba.set(fg, px(x, y));
    } else {
      rgba.set(bg, px(x, y));
    }
  }
}

mkdirSync(iconsDir, { recursive: true });
writeFileSync(srcPng, writePng(S, S, rgba));

const r = spawnSync(
  process.platform === "win32" ? resolve(root, "node_modules", ".bin", "tauri.cmd") : "tauri",
  ["icon", srcPng, "-o", iconsDir],
  { stdio: "inherit", shell: false },
);
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("icons generated in", iconsDir);
