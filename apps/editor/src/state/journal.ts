/**
 * S9.6-004 — journal navigation store (G30).
 *
 * Holds the viewport's journal cursor (the revision currently shown) and
 * the seek actions that step it. The journal DATA itself stays on the
 * bridge handle (`scene.journal`) — the bridge is the authority, this store
 * only remembers where the user is looking and applies soft seeks through
 * the scene store (`setTransform` per name from `seekTransformsAt`), so
 * Ctrl+Z/Y and the timeline strip drive the SAME cursor.
 *
 * The scene store is the single source of graph truth; a seek never writes
 * through the mutation lane (soft re-import — the S7-005 contract). The
 * cursor resets to head whenever the scene hydrates (App effect).
 */

import { create } from "zustand";
import type { TransformJournalEvent } from "../bridge/types";
import {
  isAtBase,
  isAtHead,
  journalHeadRevision,
  journalSeekTarget,
  seekTransformsAt,
} from "./journal-core";
import { useScene } from "./scene";

export interface JournalStore {
  /** Revision the viewport currently shows (0 = base / at head when no journal). */
  readonly cursor: number;
  /** Set the cursor without touching the scene (hydration/reset). */
  readonly setCursor: (revision: number) => void;
  /** Seek the viewport to an exact revision (click-to-seek). */
  readonly seekTo: (revision: number) => void;
  /** Step the journal (Ctrl+Z → undo, Ctrl+Y/Shift+Z → redo). */
  readonly step: (direction: "undo" | "redo") => void;
  /** Reset the cursor to the journal head (after hydrate/commit). */
  readonly reset: () => void;
}

export const useJournal = create<JournalStore>()((set, get) => ({
  cursor: 0,

  setCursor: (revision) => set({ cursor: revision }),

  seekTo: (revision) => {
    set({ cursor: revision });
    applySeek(revision);
  },

  step: (direction) => {
    const { cursor } = get();
    const journal = readJournal();
    const target = journalSeekTarget(journal, cursor, direction);
    if (target === null) return; // redo at head — no-op
    set({ cursor: target });
    applySeek(target);
  },

  reset: () => {
    const head = journalHeadRevision(readJournal());
    set({ cursor: head });
  },
}));

function readJournal(): readonly TransformJournalEvent[] {
  // The bridge handle is not in the store; the seek helpers are wired by
  // the callers (Timeline/shortcuts) which pass the handle. The store keeps
  // a module-level ref set at seek time (single window, mock in-process).
  return currentJournalRef;
}

let currentJournalRef: readonly TransformJournalEvent[] = [];

/** Wire the authoritative journal (bridge handle) — called by Timeline/shortcuts. */
export function attachJournal(journal: readonly TransformJournalEvent[]): void {
  currentJournalRef = journal;
}

function applySeek(revision: number): void {
  const journal = currentJournalRef;
  const objects = useScene.getState().objects;
  if (journal.length === 0 || objects.length === 0) return;
  const transforms = seekTransformsAt(journal, objects, revision);
  const scene = useScene.getState();
  for (const [name, transform] of transforms) {
    scene.setTransform(name, transform);
  }
}

/** Convenience guard used by the strip to disable redo at head. */
export function journalNavState(
  journal: readonly TransformJournalEvent[],
  cursor: number,
): { readonly atBase: boolean; readonly atHead: boolean; readonly head: number } {
  return {
    atBase: isAtBase(journal, cursor),
    atHead: isAtHead(journal, cursor),
    head: journalHeadRevision(journal),
  };
}
