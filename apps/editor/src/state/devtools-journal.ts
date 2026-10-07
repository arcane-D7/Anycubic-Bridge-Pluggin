/**
 * S9.12-002 — DevTools session journal store (zustand, thin).
 *
 * Wraps `devtools-journal-core` with an append/clear surface. Every DevTools
 * action is journaled (auditable) before/after any side effect. The store is
 * deliberately tiny — the journal data + logic live in the pure core so unit
 * tests run headless.
 */

import { create } from "zustand";
import {
  initialDevtoolsJournal,
  journalAppend,
  journalClear,
  type DevtoolsJournalKind,
} from "./devtools-journal-core.ts";

export interface DevtoolsJournalApi {
  readonly entries: readonly {
    id: number;
    at: number;
    kind: DevtoolsJournalKind;
    detail: string;
  }[];
  readonly nextId: number;
  log(kind: DevtoolsJournalKind, detail: string): void;
  clear(): void;
}

export const useDevtoolsJournal = create<DevtoolsJournalApi>((set) => ({
  ...initialDevtoolsJournal(),
  log(kind, detail) {
    set((s) => journalAppend(s, kind, detail) as DevtoolsJournalApi);
  },
  clear() {
    set((s) => journalClear(s) as DevtoolsJournalApi);
  },
}));
