/**
 * S9.8-004 (G44) — dirty state + local persistence: pure headless core.
 *
 * Dependency-free (no React/zustand/three) so Node 24 runs it via the plain
 * test harness (same pattern as statusbar-core / measure-core).
 *
 * ## What it models
 *
 * The editor scene has an AUTHORITATIVE revision (viewport store — driven by
 * bridge commit events). "Dirty" = a revision delta the user produced but
 * never explicitly saved. The header chip shows:
 *   - `unsavedOps`: revision delta vs the last committed/saved point;
 *   - `lastCommitTime`: wall-clock ISO string of the last save.
 *
 * Persistence round-trip is a plain JSON envelope (`serializeScene` /
 * `parseSceneBackup`) with a fixed `kind` + `version` so a corrupted or
 * foreign payload is rejected deterministically (never a crash loop).
 * Storage is ENV-AGNOSTIC by contract: the adapter (React layer) writes to
 * localStorage — never a filesystem path, so nothing machine-specific can
 * ever be committed (AGENTS.md golden rule).
 */

import type { SceneObjectSnapshot } from "../bridge/types";

/** Saved backup envelope (frozen shape, bumped on breaking changes). */
export const DIRTY_BACKUP_KIND = "anycubic:scene-backup";
export const DIRTY_BACKUP_VERSION = 1;

/** Serialized scene backup (what the storage adapter round-trips). */
export interface SceneBackup {
  readonly kind: typeof DIRTY_BACKUP_KIND;
  readonly version: number;
  readonly savedAt: string; // ISO — last-commit time for the chip
  readonly revision: number;
  readonly objects: readonly SceneObjectSnapshot[];
}

/** Unsaved delta descriptor for the header chip. */
export interface DirtyChipState {
  readonly unsavedOps: number;
  readonly isDirty: boolean;
  readonly lastCommitTime: string | null; // ISO — null = never saved
}

export const NEVER_SAVED = "never";

/** Unsaved ops count = revision delta (clamped ≥ 0). Revision may be ahead
 *  of the saved point (unsaved) or equal/behind (clean). */
export function unsavedOpsDelta(currentRevision: number, savedRevision: number): number {
  return Math.max(0, currentRevision - savedRevision);
}

/** Derive the header chip state from the live revision + the saved point. */
export function dirtyChip(
  currentRevision: number,
  savedRevision: number,
  lastCommitTime: string | null,
): DirtyChipState {
  const unsavedOps = unsavedOpsDelta(currentRevision, savedRevision);
  return {
    unsavedOps,
    isDirty: unsavedOps > 0,
    lastCommitTime,
  };
}

/** Build the backup envelope from the live snapshot (pure, no IO). */
export function serializeScene(
  revision: number,
  objects: readonly SceneObjectSnapshot[],
  savedAt = new Date().toISOString(),
): SceneBackup {
  return {
    kind: DIRTY_BACKUP_KIND,
    version: DIRTY_BACKUP_VERSION,
    savedAt,
    revision,
    objects,
  };
}

/** Validate + decode a raw stored string into a `SceneBackup`, or null. */
export function parseSceneBackup(raw: string | null | undefined): SceneBackup | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null; // corrupted string — deterministically rejected
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== DIRTY_BACKUP_KIND) return null;
  if (v.version !== DIRTY_BACKUP_VERSION) return null; // incompatible format
  const revision = v.revision;
  const savedAt = v.savedAt;
  const objects = v.objects;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  if (typeof savedAt !== "string" || Number.isNaN(Date.parse(savedAt))) return null;
  if (!Array.isArray(objects)) return null;
  // Light structural validation — every object must at least name itself.
  if (
    !objects.every(
      (o) =>
        typeof o === "object" && o !== null && typeof (o as { name?: unknown }).name === "string",
    )
  ) {
    return null;
  }
  return {
    kind: DIRTY_BACKUP_KIND,
    version: DIRTY_BACKUP_VERSION,
    savedAt,
    revision,
    objects: objects as readonly SceneObjectSnapshot[],
  };
}

/** Human label for the last-commit time (chip tooltip): "HH:MM" from ISO,
 *  or "never" when null/absent. Deterministic, locale-independent. */
export function lastCommitLabel(lastCommitTime: string | null | undefined): string {
  if (!lastCommitTime) return NEVER_SAVED;
  const t = new Date(lastCommitTime);
  if (Number.isNaN(t.getTime())) return NEVER_SAVED;
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
