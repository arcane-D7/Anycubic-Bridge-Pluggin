import { create } from "zustand";
import type { SceneObjectSnapshot } from "../bridge/types";
import { parseSceneBackup, serializeScene, type SceneBackup } from "./dirty-core";
import { useViewport } from "./viewport";

/**
 * S9.8-004 (G44) — dirty state + local persistence store (browser side).
 *
 * Holds ONLY the persisted baseline (saved revision + last-commit time).
 * The header chip derives the LIVE unsaved delta from the viewport store's
 * authoritative revision — the SAME source the status bar uses — through the
 * pure `dirtyChip` helper, so numbers never disagree and react to every
 * commit event without manual sync.
 *
 * Save/restore: the pure `dirty-core` builds/validates a `SceneBackup`
 * envelope; this store persists it to `localStorage` under a fixed key
 * (`anycubic:scene-backup`) — NEVER a filesystem path (AGENTS.md golden
 * rule: nothing machine-specific may ever be committed; localStorage is
 * per-context and cannot leak a path into the repo).
 *
 * Restore re-hydrates the scene store AND rebases the saved revision so the
 * chip flips clean. A corrupted/foreign payload is rejected deterministically
 * (core returns null) and surfaced as a readable "no backup" state, never a
 * crash loop.
 */

const STORAGE_KEY = "anycubic:scene-backup:v1";

export interface SaveResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly restoredObjects: readonly SceneObjectSnapshot[];
  readonly revision: number;
  readonly savedAt: string;
  readonly error?: string;
}

export interface DirtyStore {
  /** Saved revision (baseline). 0 = never saved. */
  readonly savedRevision: number;
  /** ISO of the last save (chip tooltip); null = never saved. */
  readonly lastCommitTime: string | null;
  /** Persist the CURRENT authoritative revision + objects to localStorage. */
  readonly save: (objects: readonly SceneObjectSnapshot[]) => SaveResult;
  /** Read + validate the stored backup; return the envelope (or null). */
  readonly peek: () => SceneBackup | null;
  /** Restore the stored backup (re-hydrate scene + rebase saved revision). */
  readonly restore: (
    hydrateObjects: (objects: readonly SceneObjectSnapshot[]) => void,
  ) => RestoreResult;
}

function readRaw(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, value);
    return true;
  } catch {
    return false; // quota / private mode — surface, don't crash
  }
}

function currentRevision(): number {
  return useViewport.getState().revision;
}

export const useDirty = create<DirtyStore>()((set) => {
  // Boot from any previously stored backup so the baseline survives reloads
  // (localStorage persists across navigations within the same origin).
  const boot = parseSceneBackup(readRaw());
  return {
    savedRevision: boot?.revision ?? 0,
    lastCommitTime: boot?.savedAt ?? null,

    save: (objects) => {
      const revision = currentRevision();
      const envelope = serializeScene(revision, objects);
      if (!writeRaw(JSON.stringify(envelope))) {
        return { ok: false, error: "localStorage unavailable (quota / private mode)" };
      }
      set({ savedRevision: revision, lastCommitTime: envelope.savedAt });
      return { ok: true };
    },

    peek: () => parseSceneBackup(readRaw()),

    restore: (hydrateObjects) => {
      const backup = parseSceneBackup(readRaw());
      if (!backup) {
        return {
          ok: false as const,
          restoredObjects: [],
          revision: currentRevision(),
          savedAt: "",
          error: "no stored scene backup",
        };
      }
      hydrateObjects(backup.objects);
      // Rebase: the restored revision is now the saved point; the chip flips
      // clean (delta 0). Live ops AFTER restore re-dirty it.
      set({ savedRevision: backup.revision, lastCommitTime: backup.savedAt });
      return {
        ok: true as const,
        restoredObjects: backup.objects,
        revision: backup.revision,
        savedAt: backup.savedAt,
      };
    },
  };
});
