/**
 * Reliable 3MF (ZIP) reader using the End-of-Central-Directory + central directory.
 * Handles both stored (method 0) and deflated (method 8) entries.
 *
 * Usage:  node scripts/read-3mf.mjs <file.3mf> [--extract <outdir>] [nameFilter]
 */
import fs from "node:fs";
import zlib from "node:zlib";

export function read3mf(path) {
  const buf = fs.readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no EOCD");
  const cdPos = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt32LE(eocd + 10);
  let pos = cdPos;
  const files = [];
  for (let n = 0; n < cdCount; n++) {
    if (pos + 46 > buf.length) break;
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      pos++;
      n--;
      if (pos > buf.length) break;
      continue;
    }
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nlen = buf.readUInt16LE(pos + 28);
    const elen = buf.readUInt16LE(pos + 30);
    const clen = buf.readUInt16LE(pos + 32);
    const loff = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nlen);
    // read local header
    let data = null;
    try {
      if (buf.readUInt32LE(loff) === 0x04034b50) {
        const lFlags = buf.readUInt16LE(loff + 6);
        const lMethod = buf.readUInt16LE(loff + 8);
        const lCsize = buf.readUInt32LE(loff + 18);
        const lUsize = buf.readUInt32LE(loff + 22);
        const lNlen = buf.readUInt16LE(loff + 26);
        const lElen = buf.readUInt16LE(loff + 28);
        const dstart = loff + 30 + lNlen + lElen;
        const useCsize = lCsize || csize;
        const raw = buf.slice(dstart, dstart + useCsize);
        if ((lMethod || method) === 8) data = zlib.inflateRawSync(raw);
        else if ((lMethod || method) === 0) data = raw;
        else throw new Error("unsupported method " + (lMethod || method));
      }
    } catch (e) {
      data = Buffer.from("ERR:" + e.message);
    }
    files.push({ name, csize, usize, size: data ? data.length : 0, data });
    pos = pos + 46 + nlen + elen + clen;
  }
  return files;
}

// CLI path
const [, , path, flag, flagArg, filter] = process.argv;
if (path) {
  const files = read3mf(path);
  if (flag === "--extract" && flagArg) {
    const out = flagArg;
    fs.mkdirSync(out, { recursive: true });
    for (const f of files) {
      if (filter && !f.name.includes(filter)) continue;
      const dest = `${out}/${f.name.replace(/\//g, "_")}`;
      fs.writeFileSync(dest, f.data ?? Buffer.alloc(0));
      console.log("wrote", dest, f.data?.length ?? 0);
    }
    console.log("extracted", files.length, "members to", out);
  } else {
    for (const f of files) {
      if (filter && !f.name.includes(filter)) continue;
      const head =
        f.data && f.data.length > 0 ? f.data.slice(0, 40).toString("utf8").replace(/\n/g, " ") : "";
      console.log(`${f.name}  (${f.size} bytes)  ${head}`);
    }
  }
}
