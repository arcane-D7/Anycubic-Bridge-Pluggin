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
import { journalMenuItems } from "../components/context-menu-core";
import { openContextMenuAt } from "../components/context-menu-core";
import { useContextMenuStore } from "../state/context-menu";
import { useI18n } from "../state/i18n";

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
  const t = useI18n((s) => s.t);

  // S9.6-004 — journal navigation wiring.
  const cursor = useJournal((s) => s.cursor);
  const seekTo = useJournal((s) => s.seekTo);
  const reset = useJournal((s) => s.reset);
  const openMenu = useContextMenuStore((s) => s.open);

  const journal = scene?.journal ?? [];
  const byRevision = journalEventsByRevision(journal);
  const nav = journalNavState(journal, cursor);
  const head = nav.head;

  /** S9.8-001: right-click a revision chip → shared ContextMenu with
   * seek-to-revision / reset-to-head (both no-op when already at head). */
  const onChipContextMenu = (rev: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(
      openContextMenuAt(
        e,
        journalMenuItems({
          revision: rev,
          atHead: nav.atHead && head === rev,
          onSeek: (r) => seekTo(r),
          onReset: () => reset(),
        }),
      ),
    );
  };

  // Re-attach the authoritative journal and reset the cursor to head when
  // the handle changes (new fetch / hydrate).
  useEffect(() => {
    attachJournal(journal);
    reset();
  }, [journal, reset]);

  return (
    <section className="panel-timeline" aria-label={t("timeline.label")}>
      {journal.length > 0 ? (
        <div className="journal-strip" role="list" aria-label={t("timeline.journal.aria")}>
          <button
            type="button"
            className="journal-nav"
            data-testid="journal-undo"
            disabled={journalNavState(journal, cursor).atBase}
            title={t("timeline.undo.title")}
            onClick={() => useJournal.getState().step("undo")}
          >
            {t("timeline.undo")}
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
                  title={t("timeline.seek.title", { n: String(rev) })}
                  aria-pressed={cursor === rev}
                  role="listitem"
                  onClick={() => seekTo(rev)}
                  onContextMenu={(e) => onChipContextMenu(rev, e)}
                >
                  <span className="commit-dot" aria-hidden="true" />
                  <span className="journal-rev mono">{rev}</span>
                  <span
                    className="journal-deltas"
                    aria-label={t("timeline.events.aria", { rev: String(rev) })}
                  >
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
            title={t("timeline.redo.title")}
            onClick={() => useJournal.getState().step("redo")}
          >
            {t("timeline.redo")}
          </button>
        </div>
      ) : null}
      <header className="panel-title">{t("timeline.slicing.title")}</header>
      <div className="timeline-row">
        <label className="timeline-label" htmlFor="slicing-mode">
          {t("timeline.slicing.label")}
        </label>
        <select
          id="slicing-mode"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as SlicingMode)}
          disabled={modeLocked}
        >
          <option value="standard">{t("slicing.mode.standard")}</option>
          <option value="nonplanar" disabled={!canAuthor}>
            {t("slicing.mode.nonplanar")}
          </option>
        </select>
        {!canAuthor ? (
          <span className="panel-hint" data-testid="nonplanar-blocked" title={explanation}>
            {t("timeline.nonplanar.blocked")}
          </span>
        ) : printQualified ? (
          <span className="panel-hint" data-testid="nonplanar-qualified">
            {explanation}
          </span>
        ) : (
          <span className="panel-hint" data-testid="nonplanar-pending" title={explanation}>
            {t(
              capability.status === "supported"
                ? "timeline.nonplanar.supported"
                : "timeline.nonplanar.undeclared",
            )}
            {capability.source === "operator-declared" ? t("timeline.nonplanar.operator") : ""}.{" "}
            {t("timeline.nonplanar.enabled")}
          </span>
        )}
      </div>
      {modeLocked ? <p className="panel-hint">{modeLockReason}</p> : null}
    </section>
  );
}
