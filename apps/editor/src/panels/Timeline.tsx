import { useEffect } from "react";
import type { BridgeHandle } from "../bridge/mock";
import type { SlicingMode } from "../contract";
import type { NonPlanarEligibility } from "../profile/capabilities";
import { resolveNonPlanarEligibility } from "../profile/capabilities";
import type { OperatorProfile } from "../profile/operatorProfile";
import { attachJournal, journalNavState, useJournal } from "../state/journal";
import {
  journalDeltaLabel,
  journalEventLabel,
  journalEventsByRevision,
} from "../state/journal-core";

/**
 * Bottom panel — timeline/undo graph + slicing mode (R0 shell / S9.6-004).
 *
 * The slicing-mode selector is a real piece of the contract (§3.0a dual-mode
 * slicing, persisted per project). Eligibility is NOT inferred from the scene
 * handle's capability token list alone: callers pass an explicit profile /
 * eligibility so "profile not loaded / unknown" is distinguishable from an
 * explicit "unsupported" verdict. Selecting non-planar here enables authoring
 * only — it never claims the engine output is print-qualified.
 *
 * S9.6-004 (G30): the journal strip renders the S7-005 transform journal as a
 * filmstrip — one commit dot per revision, delta chips (`+move`, `+rotate`,
 * `+scale`) + mono revision labels. Clicking a revision seeks the viewport to
 * that revision (click-to-seek, soft re-import via the scene store); Ctrl+Z/Y
 * step the same cursor. The cursor stays in sync with the strip highlight.
 */

interface TimelineProps {
  readonly scene: BridgeHandle | undefined;
  readonly mode: SlicingMode;
  readonly onModeChange: (m: SlicingMode) => void;
  readonly modeLockReason?: string;
  readonly operatorProfile?: OperatorProfile;
  readonly eligibility?: NonPlanarEligibility;
}

export function Timeline({
  scene,
  mode,
  onModeChange,
  modeLockReason,
  operatorProfile,
  eligibility,
}: TimelineProps) {
  const resolved =
    eligibility ??
    resolveNonPlanarEligibility(
      scene?.capabilities,
      operatorProfile === undefined ? undefined : operatorProfile,
    );
  const { canAuthor, printQualified, explanation, capability } = resolved;
  const modeLocked = modeLockReason !== undefined;

  // S9.6-004 — journal navigation wiring.
  const cursor = useJournal((s) => s.cursor);
  const seekTo = useJournal((s) => s.seekTo);
  const reset = useJournal((s) => s.reset);

  const journal = scene?.journal ?? [];
  const byRevision = journalEventsByRevision(journal);
  const head = journalNavState(journal, cursor).head;

  // Re-attach the authoritative journal and reset the cursor to head when
  // the handle changes (new fetch / hydrate).
  useEffect(() => {
    attachJournal(journal);
    reset();
  }, [journal, reset]);

  return (
    <section className="panel-timeline" aria-label="Timeline and slicing">
      {journal.length > 0 ? (
        <div className="journal-strip" role="list" aria-label="Transform journal">
          <button
            type="button"
            className="journal-nav"
            data-testid="journal-undo"
            disabled={journalNavState(journal, cursor).atBase}
            title="Undo (Ctrl+Z)"
            onClick={() => useJournal.getState().step("undo")}
          >
            Undo
          </button>
          <div className="journal-chips" role="list">
            {[...byRevision.keys()]
              .sort((a, b) => a - b)
              .map((rev) => (
                <button
                  key={rev}
                  type="button"
                  className={`journal-commit${cursor === rev ? " active" : ""}${
                    head === rev ? " head" : ""
                  }`}
                  data-testid={`journal-rev-${rev}`}
                  data-revision={rev}
                  title={`Seek to revision ${rev}`}
                  aria-pressed={cursor === rev}
                  role="listitem"
                  onClick={() => seekTo(rev)}
                >
                  <span className="commit-dot" aria-hidden="true" />
                  <span className="journal-rev mono">{rev}</span>
                  <span className="journal-deltas" aria-label={`Events at ${rev}`}>
                    {(byRevision.get(rev) ?? []).map((e) => (
                      <span
                        key={`${e.kind}-${e.name}`}
                        className={`delta-chip ${e.kind.slice(1)}`}
                        title={journalEventLabel(e)}
                      >
                        {journalDeltaLabel(e)}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
          </div>
          <button
            type="button"
            className="journal-nav"
            data-testid="journal-redo"
            disabled={journalNavState(journal, cursor).atHead}
            title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
            onClick={() => useJournal.getState().step("redo")}
          >
            Redo
          </button>
        </div>
      ) : null}
      <header className="panel-title">Slicing mode</header>
      <div className="timeline-row">
        <label className="timeline-label" htmlFor="slicing-mode">
          Slicing mode
        </label>
        <select
          id="slicing-mode"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as SlicingMode)}
          disabled={modeLocked}
        >
          <option value="standard">Standard (planar)</option>
          <option value="nonplanar" disabled={!canAuthor}>
            Non-planar (experimental)
          </option>
        </select>
        {!canAuthor ? (
          <span className="panel-hint" data-testid="nonplanar-blocked" title={explanation}>
            Continuous Z declared unsupported. Imported paths remain viewable.
          </span>
        ) : printQualified ? (
          <span className="panel-hint" data-testid="nonplanar-qualified">
            {explanation}
          </span>
        ) : (
          <span className="panel-hint" data-testid="nonplanar-pending" title={explanation}>
            {capability.status === "supported"
              ? "Continuous Z supported"
              : "Continuous Z not yet declared"}
            {capability.source === "operator-declared" ? " (operator)" : ""}. Non-planar editing
            enabled; print generation pending validation.
          </span>
        )}
      </div>
      {modeLocked ? <p className="panel-hint">{modeLockReason}</p> : null}
    </section>
  );
}
