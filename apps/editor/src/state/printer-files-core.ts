/**
 * S9.12-001 printer file listing — dependency-free pure core.
 *
 * Same pattern as printers-core / printjob-core: no React / zustand imports
 * so Node 24 runs it headless under the `node --test` harness. The bridge
 * lane (`bridge/mock.ts` `listFiles`) and the DevicePanel Files tab are thin
 * wrappers over these pure functions.
 *
 * Normalisation (G-9.12-001): the device reports file entries with a WIDE
 * variety of shapes across sources (cloud `local_files` order 103 vs `usb_files`
 * order 101 vs the LAN `listLocal`/`listUdisk` replies). This core normalises
 * ANY of those payloads to the `PrinterFileEntry` shape — name basename,
 * stable id, nullable size/date, deterministic thumbhint — so the UI and the
 * agent share ONE contract.
 *
 * AGENTS.md §6: real device ids appear ONLY in `tests/` fixtures, never in
 * this source; ids are treated as opaque strings.
 */

import type { PrinterFileEntry } from "../bridge/types";

export type { PrinterFileEntry };

const BYTES_NUMBER = /^[0-9]+(\.[0-9]+)?$/;

/** Extract a numeric byte value from any of the device field spellings the
 * discovery probes have seen (`size`, `file_size`, `sizeBytes`, …). Returns
 * null when absent or not a finite number. */
export function toBytesOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && BYTES_NUMBER.test(value)) return Number(value);
  return null;
}

/** Extract a last-modified epoch ms from the device fields (`date`,
 * `modified`, `uploadTime`, `timestamp` seconds). Returns null when absent
 * or unparseable. */
export function toModifiedAtOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds precision (device timestamps) vs ms: normalize to ms.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return Date.parse(value);
  }
  return null;
}

/** Deterministic thumbnail color hint from a string key — the device has no
 * image URLs; the UI renders a swatch, never a broken <img>. A 1- or
 * 2-segment hash keeps it stable across refreshes. Returns null for empty
 * names so the UI can fall back to a neutral swatch. */
export function thumbHintFor(name: string): string | null {
  if (!name) return null;
  const PALETTE = ["#c25938", "#3d7ea6", "#5d8f5a", "#9a6fb0", "#c99a3a", "#5a6ec9"];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0x7fffffff;
  }
  return PALETTE[hash % PALETTE.length] ?? null;
}

/**
 * Normalise a file entry payload from ANY known source shape into
 * `PrinterFileEntry`. `kind` is fixed by the caller (the source is known —
 * local vs usb); `id` defaults to the name (a device that reports only a
 * display name still yields a stable key); path-bearing fields collapse to
 * `name` via basename.
 */
export function normaliseFileEntry(
  raw: object | null | undefined,
  kind: "local" | "usb",
): PrinterFileEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Readonly<Record<string, unknown>>;
  const rawName =
    record.name ?? record.fileName ?? record.file_name ?? record.path ?? record.filename ?? "";
  const name = String(rawName).split("/").pop()?.split("\\").pop();
  const cleanName = name?.trim() ?? "";
  if (!cleanName) return null;
  const id =
    record.id != null
      ? String(record.id)
      : record.fileId != null
        ? String(record.fileId)
        : record.path != null
          ? String(record.path)
          : cleanName;
  const sizeBytes =
    toBytesOrNull(record.size) ??
    toBytesOrNull(record.file_size) ??
    toBytesOrNull(record.sizeBytes) ??
    toBytesOrNull(record.length);
  const modifiedAt =
    toModifiedAtOrNull(record.date) ??
    toModifiedAtOrNull(record.modified) ??
    toModifiedAtOrNull(record.uploadTime) ??
    toModifiedAtOrNull(record.timestamp);
  return {
    kind,
    id,
    name: cleanName,
    sizeBytes,
    modifiedAt,
    thumbHint: thumbHintFor(cleanName),
  };
}

/**
 * Normalise a whole listing payload (any source shape) into a sorted
 * `PrinterFileEntry[]`. Accepts an array payload, `{files: [...]}`,
 * `{list: [...]}`, `{data: [...]}` — whatever the discovery probes saw.
 * Entries that fail normalisation are DROPPED (a null entry is not a file);
 * the name/size sort is deterministic (name asc, then size desc) so the UI
 * row order never flickers between refreshes.
 */
export function normaliseFileListing(
  payload: unknown,
  kind: "local" | "usb",
): readonly PrinterFileEntry[] {
  let rawItems: unknown[] = [];
  if (Array.isArray(payload)) rawItems = payload;
  else if (payload && typeof payload === "object") {
    const record = payload as Readonly<Record<string, unknown>>;
    for (const key of ["files", "list", "data", "entries", "items", "fileList"]) {
      if (Array.isArray(record[key])) {
        rawItems = record[key];
        break;
      }
    }
  }
  return rawItems
    .map((item) => normaliseFileEntry(item as object | null | undefined, kind))
    .filter((entry): entry is PrinterFileEntry => entry !== null)
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1);
    });
}

export interface FileListBuildingResult {
  ok: boolean;
  source: "local" | "usb";
  files: readonly PrinterFileEntry[];
  loadedAt: number | null;
  stale: boolean;
}

/** Build a `PrinterFileListResult` from a raw listing payload; honours the
 * honesty rule: `stale` is true when a refresh is expected (the caller
 * passes `expected`) but `loadedAt` is older than the passed window. */
export function fileListResult(
  kind: "local" | "usb",
  payload: unknown,
  opts?: { readonly loadedAt: number | null; readonly windowMs?: number },
): FileListBuildingResult {
  const loadedAt = opts?.loadedAt ?? null;
  const windowMs = opts?.windowMs ?? 60_000;
  const stale = loadedAt === null || Date.now() - loadedAt > windowMs;
  return {
    ok: true,
    source: kind,
    files: normaliseFileListing(payload, kind),
    loadedAt,
    stale,
  };
}

/** Deduped fixture file list for the OFFLINE mock lane (AGENTS.md §6 — fake
 * names, fake bytes; no real device ids). */
export function mockFileEntries(kind: "local" | "usb"): readonly PrinterFileEntry[] {
  const names =
    kind === "local"
      ? ["Benchy_0.2mm.gcode", "calibration_cube.gcode", "spool_holder_2x.stl", "TopCase_v3.3mf"]
      : ["travel_clip.3mf", "bracket_left.stl", "nozzle_guard.gcode"];
  return names.map((name) => ({
    kind,
    id: name,
    name,
    sizeBytes: 4096 + name.length * 1024,
    modifiedAt: Date.now() - 3_600_000,
    thumbHint: thumbHintFor(name),
  }));
}
