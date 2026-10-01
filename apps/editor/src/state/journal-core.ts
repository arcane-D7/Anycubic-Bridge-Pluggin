/**
 * S9.6-004 — journal undo/redo core (pure, headless).
 *
 * G30. The S7-005 transform journal is a delta stream of events
 * (`TransformJournalEvent`: `+move`/`+rotate`/`+scale`, `name`, `revision`,
 * `from`/`to` — each event only carries the fields of its own kind). From
 * that stream + the CURRENT head snapshot we re-derive the authoritative
 * state at ANY past revision ("click-to-seek") and the undo/redo seek
 * targets for Ctrl+Z/Y.
 *
 * Reconstruction direction: instead of replaying the journal from an
 * explicit base (the bridge only keeps last-committed + head), we walk
 * BACKWARDS from the head transform of each object: every event with
 * `revision > target` is "undone" by replacing its kind's fields with
 * `from`. The result is the deterministic per-revision object map, so a
 * seek is just `setTransform` per name — no geometry knowledge needed
 * (the S7-005 soft re-import contract).
 *
 * No React/zustand/three.js imports: Node 24 runs this headless.
 */

import type { SceneObjectSnapshot, TransformJournalEvent } from "../bridge/types";

/** Revision list helper — distinct revisions in ascending order. */
export function journalRevisions(journal: readonly TransformJournalEvent[]): readonly number[] {
  const set = new Set<number>();
  for (const e of journal) set.add(e.revision);
  return [...set].sort((a, b) => a - b);
}

/** Highest revision in the journal (head); 0 when the journal is empty. */
export function journalHeadRevision(journal: readonly TransformJournalEvent[]): number {
  const revs = journalRevisions(journal);
  return revs.length > 0 ? (revs[revs.length - 1] ?? 0) : 0;
}

/** Chip label for one event (`+move`, `+rotate`, `+scale`). */
export function journalDeltaLabel(e: TransformJournalEvent): string {
  return e.kind;
}

/** Event summary for the strip — `+move cube` (single line, mono). */
export function journalEventLabel(e: TransformJournalEvent): string {
  return `${e.kind} ${e.name}`;
}

/**
 * Undo/redo target revisions given the current cursor (the revision the
 * viewport currently shows). Undo steps to the previous distinct revision
 * below the cursor (or 0 = pre-journal base); redo steps to the next one
 * (or `null` when already at head).
 */
export function journalSeekTarget(
  journal: readonly TransformJournalEvent[],
  cursor: number,
  direction: "undo" | "redo",
): number | null {
  const revs = journalRevisions(journal);
  if (direction === "undo") {
    const below = [...revs].filter((r) => r < cursor);
    return below.length > 0 ? (below[below.length - 1] ?? 0) : 0;
  }
  const above = revs.filter((r) => r > cursor);
  return above.length > 0 ? (above[0] ?? null) : null;
}

/** Fields a journal kind mutates (used to merge partial deltas). */
type DeltaFields = {
  readonly move: ["x", "y", "z"];
  readonly rotate: ["rx", "ry", "rz"];
  readonly scale: ["sx", "sy", "sz"];
};
const DELTA_FIELDS: DeltaFields = {
  move: ["x", "y", "z"],
  rotate: ["rx", "ry", "rz"],
  scale: ["sx", "sy", "sz"],
};

/** The scene transform shape (all 9 fields, defaults applied — full set). */
export interface SceneTransformFull {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}

/** A fully-normalized transform (all 9 fields present, defaults applied). */
type NormedTransform = SceneTransformFull;

function normTransform(t: SceneObjectSnapshot["transform"]): NormedTransform {
  return {
    x: t?.x ?? 0,
    y: t?.y ?? 0,
    z: t?.z ?? 0,
    rx: t?.rx ?? 0,
    ry: t?.ry ?? 0,
    rz: t?.rz ?? 0,
    sx: t?.sx ?? 1,
    sy: t?.sy ?? 1,
    sz: t?.sz ?? 1,
  };
}

/**
 * Per-revision authoritative transform map (soft seek). For every distinct
 * revision ≤ `target`, returns `Map<name, transform>` that represents the
 * scene at that revision, computed by walking the journal BACKWARDS from
 * the head objects: events with revision > target are undone (fields ←
 * `from`). Names not touched by any undone event keep their head transform.
 *
 * `headObjects` is the CURRENT authoritative snapshot list (the handle's
 * objects) — the source of head transforms.
 */
export function seekTransformsAt(
  journal: readonly TransformJournalEvent[],
  headObjects: readonly SceneObjectSnapshot[],
  target: number,
): ReadonlyMap<string, SceneObjectSnapshot["transform"]> {
  const map = new Map<string, SceneObjectSnapshot["transform"]>();
  for (const o of headObjects) map.set(o.name, normTransform(o.transform));
  // Undo every event strictly AFTER the target, newest revision first.
  const undone = [...journal]
    .filter((e) => e.revision > target)
    .sort((a, b) => b.revision - a.revision || 0);
  for (const e of undone) {
    const current = map.get(e.name);
    if (!current) continue;
    // kind is "+move"/"+rotate"/"+scale" — strip the "+" to index DELTA_FIELDS.
    const fields = DELTA_FIELDS[e.kind.slice(1) as keyof DeltaFields] ?? [];
    const next = { ...current };
    for (const f of fields) {
      const from = e.from[f];
      if (from !== undefined) next[f] = from;
    }
    map.set(e.name, next);
  }
  return map;
}

/** Convenience: transform at revision for a single named object (or null). */
export function seekTransformAt(
  journal: readonly TransformJournalEvent[],
  headObjects: readonly SceneObjectSnapshot[],
  target: number,
  name: string,
): SceneObjectSnapshot["transform"] | null {
  const obj = headObjects.find((o) => o.name === name);
  if (!obj) return null;
  return seekTransformsAt(journal, headObjects, target).get(name) ?? null;
}

/** Events grouped by revision (ascending), for the strip's commit glyphs. */
export function journalEventsByRevision(
  journal: readonly TransformJournalEvent[],
): ReadonlyMap<number, readonly TransformJournalEvent[]> {
  const byRev = new Map<number, TransformJournalEvent[]>();
  for (const e of journal) {
    const list = byRev.get(e.revision);
    if (list) list.push(e);
    else byRev.set(e.revision, [e]);
  }
  // stable ascending order per revision group
  for (const list of byRev.values()) list.sort((a, b) => a.kind.localeCompare(b.kind));
  return byRev;
}

/** Whether the cursor is at the journal head (redo disabled). */
export function isAtHead(journal: readonly TransformJournalEvent[], cursor: number): boolean {
  return cursor >= journalHeadRevision(journal);
}

/** Whether the cursor is at the base (undo disabled) — the pre-journal state. */
export function isAtBase(journal: readonly TransformJournalEvent[], cursor: number): boolean {
  const revs = journalRevisions(journal);
  return revs.length === 0 || cursor < (revs[0] ?? 0);
}
