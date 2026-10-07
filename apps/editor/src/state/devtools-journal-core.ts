/**
 * S9.12-002 — DevTools session journal — dependency-free pure core.
 *
 * Every DevTools action is logged to a session journal (auditable): "raw
 * snapshot expanded/collapsed", "catalog searched", "raw command requested
 * with its args hash". The journal is in-memory and session-scoped (no
 * persistence — this is a diagnostic surface, not a history store; the
 * MCP layer keeps its own durable capture elsewhere).
 *
 * Same headless pattern as the other cores; the store wrapper
 * (`state/devtools-journal.ts`) is a thin zustand enum.
 */

export type DevtoolsJournalKind =
  | "devtools.open"
  | "devtools.rawView"
  | "devtools.catalog.search"
  | "devtools.commands.search"
  | "devtools.raw.request"
  | "devtools.raw.accepted"
  | "devtools.raw.failed";

export interface DevtoolsJournalEntry {
  readonly id: number;
  readonly at: number;
  readonly kind: DevtoolsJournalKind;
  readonly detail: string;
}

export interface DevtoolsJournalState {
  readonly entries: readonly DevtoolsJournalEntry[];
  readonly nextId: number;
}

export function initialDevtoolsJournal(): DevtoolsJournalState {
  return { entries: [], nextId: 1 };
}

/** Append one entry; returns the new state (immutable). */
export function journalAppend(
  state: DevtoolsJournalState,
  kind: DevtoolsJournalKind,
  detail: string,
): DevtoolsJournalState {
  const entry: DevtoolsJournalEntry = { id: state.nextId, at: Date.now(), kind, detail };
  return { entries: [...state.entries, entry], nextId: state.nextId + 1 };
}

/** Clear the journal (DevTools "clear" button). */
export function journalClear(_state: DevtoolsJournalState): DevtoolsJournalState {
  return initialDevtoolsJournal();
}

/** Format one entry as a human line for the journal list. */
export function journalLine(entry: DevtoolsJournalEntry): string {
  const time = new Date(entry.at).toLocaleTimeString();
  return `#${entry.id} ${time} ${entry.kind} ${entry.detail}`;
}
