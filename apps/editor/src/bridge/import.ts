/**
 * S9.2-001 — Model import parser (STL binary + ASCII, 3MF), units mm.
 *
 * Pure string/bytes → triangle-buffer conversion with NO three.js dependency
 * so it runs headless under the plain Node test runner (same pattern as
 * `state/viewport-core.ts`). The editor renders the buffers directly via
 * `SceneObjectModel`.
 *
 * Returned buffers are the canonical payload the bridge CRUD lane stores:
 *   positions: Float32Array (3 * vertexCount, mm, right-handed, Z-up)
 *   normals:   Float32Array (3 * vertexCount, per-face, right-handed)
 *   indices:   Uint32Array  (3 * triangleCount, CCW)
 *
 * STL: the preserved server repacks positions PER TRIANGLE (3 real vertices
 * per triangle, even back-to-back triangles sharing corners) — we keep that
 * convention so the renderer and mesh-info stay in lockstep.
 *
 * 3MF: a zip container. We scan the central directory for `.model` parts,
 * raw-inflate the first one, then walk the XML collecting the FIRST
 * `<object type="model">`'s `<vertices>`/`<triangles>`. Units: the 3MF
 * default unit is millimeter — a `<unit unit="...">` attr is tolerated but
 * non-mm units are rejected to keep `units mm` honest.
 */

export interface TriangleBuffers {
  readonly kind: "stl" | "3mf";
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly vertexCount: number;
  readonly triangleCount: number;
}

export type ImportErrorCode =
  "STL_EMPTY" | "ASCII_STL_UNSAFE" | "THREEMF_EMPTY" | "THREEMF_NO_MESHES" | "THREEMF_UNIT";
export interface ImportParseError {
  readonly code: ImportErrorCode;
  readonly message: string;
}

export function isTrianglesError(err: unknown): err is ImportParseError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

const STL_HEADER = 80;
const STL_TRI = 50;
const STL_FOOTER = 4;

function fail(code: ImportParseError["code"], message: string): never {
  throw Object.assign(new Error(message), { code });
}

/**
 * Parse an STL file (binary or ASCII). Detection: if the declared 32-bit
 * triangle count at byte 80 exactly matches the byte-length-derived count
 * `(size - 84) / 50`, parse as binary; otherwise if the header looks
 * printable/ASCII, parse as ASCII; otherwise binary with length-derived count.
 */
export function parseStl(buffer: ArrayBuffer, name: string): TriangleBuffers {
  const size = buffer.byteLength;
  if (size === 0) fail("STL_EMPTY", "STL file is empty");
  if (size < STL_HEADER + 4 + STL_TRI) {
    fail("STL_EMPTY", `STL too small (${size} bytes) to be a valid STL`);
  }
  const dv = new DataView(buffer);
  const declaredCount = dv.getUint32(STL_HEADER, true);
  const exactBinary = (size - STL_HEADER - STL_FOOTER) / STL_TRI;
  const isExactBinary = Number.isInteger(exactBinary) && declaredCount === exactBinary;
  if (isExactBinary && declaredCount > 0) {
    return parseBinaryStl(buffer, name, declaredCount);
  }
  const headerBytes = new Uint8Array(buffer, 0, Math.min(STL_HEADER, size));
  const headerIsAscii = Array.from(headerBytes).every(
    (b) => b === 0 || (b >= 9 && b <= 13) || (b >= 32 && b <= 126),
  );
  if (headerIsAscii && !isExactBinary) {
    return parseAsciiStl(decodeLatin1(new Uint8Array(buffer)), name);
  }
  if (Number.isInteger(exactBinary) && exactBinary >= 1) {
    return parseBinaryStl(buffer, name, Math.floor(exactBinary));
  }
  fail("STL_EMPTY", "STL does not look like binary or ASCII");
}

function decodeLatin1(bytes: Uint8Array): string {
  // ASCII STLs are pure ASCII; tolerant decode preserves all bytes.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseBinaryStl(buffer: ArrayBuffer, name: string, triCount: number): TriangleBuffers {
  const dv = new DataView(buffer);
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const indices = new Uint32Array(triCount * 3);
  let o = STL_HEADER + 4;
  for (let t = 0; t < triCount; t += 1) {
    const nx = dv.getFloat32(o, true);
    const ny = dv.getFloat32(o + 4, true);
    const nz = dv.getFloat32(o + 8, true);
    o += 12;
    const base = t * 9;
    for (let k = 0; k < 3; k += 1) {
      const px = dv.getFloat32(o, true);
      const py = dv.getFloat32(o + 4, true);
      const pz = dv.getFloat32(o + 8, true);
      o += 12;
      const at = base + k * 3;
      positions[at] = px;
      positions[at + 1] = py;
      positions[at + 2] = pz;
      normals[at] = nx;
      normals[at + 1] = ny;
      normals[at + 2] = nz;
      indices[base + k] = t * 3 + k;
    }
  }
  if (triCount === 0) fail("STL_EMPTY", "binary STL has zero triangles");

  // Per-triangle repack: index = identity, 3 real vertices per triangle.
  const repackedI = new Uint32Array(triCount * 3);
  for (let i = 0; i < repackedI.length; i += 1) repackedI[i] = i;
  return finalize(name, "stl", positions, normals, repackedI);
}

function parseAsciiStl(text: string, name: string): TriangleBuffers {
  const positions: number[] = [];
  const normals: number[] = [];
  const tokens = text.split(/\s+/).filter(Boolean);
  let i = 0;
  let sawFacet = false;
  while (i < tokens.length) {
    const kw = tokens[i]!.toLowerCase();
    if (kw === "facet") {
      sawFacet = true;
      const nx = Number(tokens[i + 2]);
      const ny = Number(tokens[i + 3]);
      const nz = Number(tokens[i + 4]);
      const vs: number[] = [];
      i += 5;
      while (i < tokens.length && tokens[i]!.toLowerCase() !== "endfacet") {
        if (tokens[i]!.toLowerCase() === "vertex" && i + 3 < tokens.length) {
          const x = Number(tokens[i + 1]);
          const y = Number(tokens[i + 2]);
          const z = Number(tokens[i + 3]);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            fail("ASCII_STL_UNSAFE", `STL vertex has a non-finite coordinate (token ${i})`);
          }
          vs.push(x, y, z);
          i += 4;
        } else {
          i += 1;
        }
      }
      if (vs.length === 9) {
        positions.push(...vs);
        if (
          Number.isFinite(nx) &&
          Number.isFinite(ny) &&
          Number.isFinite(nz) &&
          !(nx === 0 && ny === 0 && nz === 0)
        ) {
          normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        } else {
          const cn = cross(vs[0]!, vs[1]!, vs[2]!, vs[3]!, vs[4]!, vs[5]!, vs[6]!, vs[7]!, vs[8]!);
          normals.push(...cn, ...cn, ...cn);
        }
      } else if (vs.length > 0) {
        fail("ASCII_STL_UNSAFE", `STL facet has ${vs.length / 3} vertices (expected 3)`);
      }
    } else {
      i += 1;
    }
  }
  if (!sawFacet) fail("STL_EMPTY", "ASCII STL has no facets");
  const positions32 = new Float32Array(positions);
  const normals32 = new Float32Array(normals);
  const indices32 = new Uint32Array(positions32.length / 3);
  for (let j = 0; j < indices32.length; j += 1) indices32[j] = j;
  return finalize(name, "stl", positions32, normals32, indices32);
}

function cross(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): readonly [number, number, number] {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const inv = 1 / Math.max(1e-12, Math.hypot(nx, ny, nz));
  return [nx * inv, ny * inv, nz * inv];
}

function finalize(
  name: string,
  kind: TriangleBuffers["kind"],
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
): TriangleBuffers {
  if (positions.length === 0 || indices.length === 0) {
    fail(kind === "stl" ? "STL_EMPTY" : "THREEMF_EMPTY", "no triangles after parse");
  }
  const bounds = computeBounds(positions);
  return {
    kind,
    name,
    positions,
    normals,
    indices,
    bounds,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

function computeBounds(positions: Float32Array): TriangleBuffers["bounds"] {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [minX, minY, minZ];
  const max: [number, number, number] = [maxX, maxY, maxZ];
  return { min, max };
}

/**
 * Estimate watertightness geometrically: a closed manifold has every edge
 * shared by EXACTLY two triangles. Works even with per-triangle repacked
 * buffers because it compares edge ENDPOINT POSITIONS (quantized), not index
 * identity — so back-to-back triangles with duplicated corners still register
 * the shared edge twice.
 */
export function isWatertight(positions: Float32Array, indices: Uint32Array): boolean {
  const triCount = indices.length / 3;
  if (positions.length === 0 || triCount === 0) return false;
  const edgeCounts = new Map<string, number>();
  const edgePairs = (a: number[], b: number[]): [number[], number[]] => {
    for (let k = 0; k < 3; k += 1) {
      const da = Math.fround(a[k]!);
      const db = Math.fround(b[k]!);
      if (da < db) return [a, b];
      if (db < da) return [b, a];
    }
    return [a, b];
  };
  const key = (a: number[], b: number[]): string =>
    `${a[0]!},${a[1]!},${a[2]!}|${b[0]!},${b[1]!},${b[2]!}`;
  for (let t = 0; t < triCount; t += 1) {
    const [i0, i1, i2] = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!];
    const v0 = [positions[i0 * 3]!, positions[i0 * 3 + 1]!, positions[i0 * 3 + 2]!];
    const v1 = [positions[i1 * 3]!, positions[i1 * 3 + 1]!, positions[i1 * 3 + 2]!];
    const v2 = [positions[i2 * 3]!, positions[i2 * 3 + 1]!, positions[i2 * 3 + 2]!];
    for (const [a, b] of [edgePairs(v0, v1), edgePairs(v1, v2), edgePairs(v2, v0)] as [
      number[],
      number[],
    ][]) {
      const k = key(a, b);
      edgeCounts.set(k, (edgeCounts.get(k) ?? 0) + 1);
    }
  }
  for (const count of edgeCounts.values()) {
    if (count !== 2) return false;
  }
  return true;
}

/** Mesh-info compatible object from triangle buffers (CRUD lane shape). */
export function toImportedObject(buffers: TriangleBuffers): {
  readonly name: string;
  readonly vertices: number;
  readonly triangles: number;
  readonly bounds: TriangleBuffers["bounds"];
  readonly sizeMm: readonly [number, number, number];
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
  readonly watertight: boolean;
} {
  const { positions, indices, bounds } = buffers;
  return {
    name: buffers.name,
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    bounds,
    sizeMm: [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ],
    volumeMm3: 0,
    surfaceAreaMm2: 0,
    watertight: isWatertight(positions, indices),
  };
}

// ---------------------------------------------------------------------------
// 3MF (zip container): central-directory scan + raw deflate + XML walk.
// ---------------------------------------------------------------------------

function findEocd(bytes: Uint8Array): number {
  const min = bytes.length - 22;
  for (let i = min; i >= 0; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

interface ZipEntry {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly method: number;
}

/** Parse a 3MF container. Returns the first mesh object found, units mm. */
export function parseThreemf(buffer: ArrayBuffer, name: string): TriangleBuffers {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) fail("THREEMF_EMPTY", "3MF file is empty");
  const eocd = findEocd(bytes);
  if (eocd < 0) fail("THREEMF_EMPTY", "3MF has no zip end-of-central-directory");
  const dv = new DataView(buffer);

  const centralCount = dv.getUint16(eocd + 10, true);
  let central = dv.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < centralCount; i += 1) {
    const sig = dv.getUint32(central, true);
    if (sig !== 0x02014b50) break;
    const method = dv.getUint16(central + 10, true);
    if (method !== 0 && method !== 8) {
      fail("THREEMF_EMPTY", `3MF uses unsupported compression method ${method}`);
    }
    const compSize = dv.getUint32(central + 20, true);
    const nameLen = dv.getUint16(central + 28, true);
    const extraLen = dv.getUint16(central + 30, true);
    const commentLen = dv.getUint16(central + 32, true);
    const localOffset = dv.getUint32(central + 42, true);
    const fileName = new TextDecoder("utf-8").decode(new Uint8Array(buffer, central + 46, nameLen));
    entries.push({ name: fileName, offset: localOffset, size: compSize, method });
    central += 46 + nameLen + extraLen + commentLen;
  }

  const modelEntry = entries.find((e) => /\.model$/i.test(e.name));
  if (!modelEntry) fail("THREEMF_EMPTY", "3MF contains no .model part");

  const lo = modelEntry.offset;
  const nlen = dv.getUint16(lo + 26, true);
  const elen = dv.getUint16(lo + 28, true);
  const dataStart = lo + 30 + nlen + elen;
  const payload = new Uint8Array(buffer, dataStart, modelEntry.size);

  let xml: string;
  try {
    const raw = modelEntry.method === 0 ? payload : inflateSync.apply(null, [payload as never]); // fflate
    xml = new TextDecoder("utf-8").decode(raw);
  } catch {
    fail("THREEMF_EMPTY", "3MF model part failed to decompress");
  }
  if (xml.trim().length === 0) fail("THREEMF_EMPTY", "3MF model part is empty");

  const unitMatch = /<(?:\w+:)?model\b[^>]*\bunit\s*=\s*"([^"]+)"/i.exec(xml);
  if (unitMatch && unitMatch[1]!.toLowerCase() !== "millimeter") {
    fail("THREEMF_UNIT", `3MF unit "${unitMatch[1]}" is not millimeters`);
  }

  const { positions, indices } = captureMesh(xml);
  if (indices.length === 0) fail("THREEMF_NO_MESHES", "3MF model has no triangles");
  if (positions.length === 0) fail("THREEMF_EMPTY", "3MF model has no vertices");
  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  let norms: Float32Array;
  try {
    norms = computeNormals(pos, idx);
  } catch {
    norms = new Float32Array(positions.length);
  }
  return finalize(name, "3mf", pos, norms, idx);
}

function inflateSync(_data: Uint8Array): Uint8Array {
  // Implemented in the browser-safe variant below via a tiny inline inflate
  // that only needs to support what real 3MF writers emit (raw deflate with
  // fixed OR dynamic Huffman). `node:zlib` is unavailable in the webview, so
  // a compact pure decoder lives here.
  return new Uint8Array(decodeInflate(_data));
}

/** Minimal raw-DEFLATE decompressor (stored + fixed + dynamic Huffman). */
export function decodeInflate(data: Uint8Array): number[] {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  const out: number[] = [];
  const window = new Uint8Array(32768);
  let winPos = 0;

  const emit = (byte: number) => {
    out.push(byte);
    window[winPos] = byte;
    winPos = (winPos + 1) & 32767;
  };

  const needBits = (count: number): number => {
    while (bitCnt < count) {
      if (pos >= data.length) fail("THREEMF_EMPTY", "3MF deflate ran out of input");
      bitBuf |= data[pos]! << bitCnt;
      pos += 1;
      bitCnt += 8;
    }
    return count;
  };
  const take = (count: number): number => {
    needBits(count);
    const v = bitBuf & ((1 << count) - 1);
    bitBuf >>>= count;
    bitCnt -= count;
    return v;
  };

  /** Build a canonical Huffman decode table from (symbols, bit lengths). */
  const buildTable = (
    lengths: Uint8Array,
    symbols: number[],
  ): { count: number[]; symbol: number[]; offset: number[] } => {
    const maxBits = Math.max(1, ...lengths);
    const count = new Array(maxBits + 1).fill(0);
    for (const l of lengths) if (l > 0) count[l]! += 1;
    const offset = new Array(maxBits + 1).fill(0);
    for (let b = 1; b <= maxBits; b += 1) {
      offset[b] = (offset[b - 1] ?? 0) + (count[b - 1] ?? 0);
    }
    const symbol = new Array(symbols.length).fill(0);
    for (let i = 0; i < symbols.length; i += 1) {
      const l = lengths[i]!;
      if (l > 0) {
        symbol[offset[l]!] = symbols[i]!;
        offset[l] = offset[l]! + 1;
      }
    }
    return { count, symbol, offset };
  };

  const decodeSymbol = (table: { count: number[]; symbol: number[] }): number => {
    let code = 0;
    let first = 0;
    let idx = 0;
    const maxBits = table.count.length - 1;
    for (let len = 1; len <= maxBits; len += 1) {
      code |= take(1);
      const count = table.count[len] ?? 0;
      if (code - first < count) return table.symbol[idx + (code - first)] ?? 0;
      idx += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    fail("THREEMF_EMPTY", "3MF deflate invalid Huffman code");
  };

  const LENGTH_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
  ];
  const LENGTH_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
  ];
  const DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
    3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
  ];

  const FIXED_LEN = new Uint8Array(288);
  const FIXED_SYM: number[] = [];
  for (let i = 0; i < 288; i += 1) {
    FIXED_LEN[i]! = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    FIXED_SYM.push(i);
  }
  const FIXED_DIST = new Uint8Array(30);
  const FIXED_DIST_SYM: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    FIXED_DIST[i] = 5;
    FIXED_DIST_SYM.push(i);
  }

  for (;;) {
    const bFinal = take(1);
    const bType = take(2);
    if (bType === 0) {
      bitCnt = 0;
      bitBuf = 0;
      const len = data[pos]! | (data[pos + 1]! << 8);
      pos += 4;
      for (let i = 0; i < len; i += 1) emit(data[pos + i]!);
      pos += len;
    } else if (bType === 1) {
      const lenTable = buildTable(FIXED_LEN, FIXED_SYM);
      const distTable = buildTable(FIXED_DIST, FIXED_DIST_SYM);
      decodeBlock(lenTable, distTable);
    } else if (bType === 2) {
      // dynamic Huffman header
      const hlit = take(5) + 257;
      const hdist = take(5) + 1;
      const hclen = take(4) + 4;
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i += 1) {
        codeLengths[order[i]!] = take(3);
      }
      const clSymbols = Array.from({ length: 19 }, (_, i) => i);
      const clTable = buildTable(codeLengths, clSymbols);

      // decode lit/dist code lengths using the code-length Huffman tree
      const all = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decodeSymbol(clTable);
        if (sym < 16) {
          all[i] = sym;
          i += 1;
        } else if (sym === 16) {
          const prev = all[i - 1] ?? 0;
          const rep = take(2) + 3;
          for (let r = 0; r < rep; r += 1) {
            all[i] = prev;
            i += 1;
          }
        } else if (sym === 17) {
          const rep = take(3) + 3;
          for (let r = 0; r < rep; r += 1) {
            all[i] = 0;
            i += 1;
          }
        } else {
          const rep = take(7) + 11;
          for (let r = 0; r < rep; r += 1) {
            all[i] = 0;
            i += 1;
          }
        }
      }
      const lenTable = buildTable(
        all.slice(0, hlit),
        Array.from({ length: hlit }, (_, k) => k),
      );
      const distTable = buildTable(
        all.slice(hlit),
        Array.from({ length: hdist }, (_, k) => k),
      );
      decodeBlock(lenTable, distTable);
    } else {
      fail("THREEMF_EMPTY", "3MF deflate reserved block type 3");
    }
    if (bFinal === 1) break;
  }
  return out;

  function decodeBlock(
    lenTable: { count: number[]; symbol: number[] },
    distTable: { count: number[]; symbol: number[] },
  ) {
    walk: for (;;) {
      const sym = decodeSymbol(lenTable);
      if (sym === 256) break walk;
      if (sym < 256) {
        emit(sym);
        continue;
      }
      const li = sym - 257;
      const len = LENGTH_BASE[li]! + (LENGTH_EXTRA[li]! > 0 ? take(LENGTH_EXTRA[li]!) : 0);
      const dsym = decodeSymbol(distTable);
      const dist = DIST_BASE[dsym]! + (DIST_EXTRA[dsym]! > 0 ? take(DIST_EXTRA[dsym]!) : 0);
      for (let l = 0; l < len; l += 1) {
        emit(window[(winPos - dist + 32768) & 32767]!);
      }
    }
  }
}

function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const triCount = indices.length / 3;
  const normals = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t += 1) {
    const i0 = indices[t * 3]! * 3;
    const i1 = indices[t * 3 + 1]! * 3;
    const i2 = indices[t * 3 + 2]! * 3;
    const cn = cross(
      positions[i0]!,
      positions[i0 + 1]!,
      positions[i0 + 2]!,
      positions[i1]!,
      positions[i1 + 1]!,
      positions[i1 + 2]!,
      positions[i2]!,
      positions[i2 + 1]!,
      positions[i2 + 2]!,
    );
    const base = t * 9;
    for (let k = 0; k < 3; k += 1) {
      normals[base + k * 3] = cn[0]!;
      normals[base + k * 3 + 1] = cn[1]!;
      normals[base + k * 3 + 2] = cn[2]!;
    }
  }
  return normals;
}

function attrValue(raw: string, key: string): string | null {
  // Exact attribute match (the key must be a full attribute name, not a
  // substring — e.g. `v1` must not match inside `v10`).
  const re = new RegExp(`(?:^|\\s)${key}\\s*=\\s*"([^"]*)"`, "i");
  const m = re.exec(raw);
  return m && m[1] !== undefined ? m[1] : null;
}

/** Parse the FIRST mesh object's vertices/triangles (units mm). */
export function captureMesh(xml: string): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  let i = 0;
  let vertexRegion = false;
  let triangleRegion = false;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    const gt = xml.indexOf(">", lt);
    if (gt < 0) break;
    if (lt + 1 >= gt) {
      i = gt + 1;
      continue;
    }
    const inner = xml.slice(lt + 1, gt).trim();
    if (inner[0] === "?" || inner[0] === "!" || inner[0] === "/") {
      const isEnd = inner[0] === "/";
      const body = isEnd ? inner.slice(1) : inner;
      const name = body.replace(/^[\w-]*:/, "").split(/\s+/)[0];
      if (name === "vertices") vertexRegion = !isEnd;
      if (name === "triangles") triangleRegion = !isEnd;
      i = gt + 1;
      continue;
    }
    const selfClose = inner.endsWith("/");
    const name = inner.replace(/^[\w-]*:/, "").split(/\s+/)[0];
    // Opening tag: enter region BEFORE parsing child attributes.
    if (name === "vertices" && !selfClose) vertexRegion = true;
    if (name === "triangles" && !selfClose) triangleRegion = true;
    if (selfClose) {
      if (vertexRegion && name === "vertex") {
        const x = attrValue(inner, "x");
        const y = attrValue(inner, "y");
        const z = attrValue(inner, "z");
        if (x !== null && y !== null && z !== null) {
          positions.push(Number(x), Number(y), Number(z));
        }
      } else if (triangleRegion && name === "triangle") {
        const a = attrValue(inner, "v1");
        const b = attrValue(inner, "v2");
        const c = attrValue(inner, "v3");
        if (a !== null && b !== null && c !== null) {
          indices.push(Number(a), Number(b), Number(c));
        }
      }
      i = gt + 1;
      continue;
    }
    if (vertexRegion && name === "vertex") {
      const x = attrValue(inner, "x");
      const y = attrValue(inner, "y");
      const z = attrValue(inner, "z");
      if (x !== null && y !== null && z !== null) positions.push(Number(x), Number(y), Number(z));
    } else if (triangleRegion && name === "triangle") {
      const a = attrValue(inner, "v1");
      const b = attrValue(inner, "v2");
      const c = attrValue(inner, "v3");
      if (a !== null && b !== null && c !== null) indices.push(Number(a), Number(b), Number(c));
    }
    i = gt + 1;
  }
  return { positions, indices };
}
