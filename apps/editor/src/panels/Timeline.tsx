import type { BridgeHandle } from "../bridge/mock";
import type { SlicingMode } from "../contract";
import type { NonPlanarEligibility } from "../profile/capabilities";
import { resolveNonPlanarEligibility } from "../profile/capabilities";
import type { OperatorProfile } from "../profile/operatorProfile";

/**
 * Bottom panel — timeline/undo graph + slicing mode (R0 shell).
 *
 * The slicing-mode selector is a real piece of the contract (§3.0a dual-mode
 * slicing, persisted per project). Eligibility is NOT inferred from the scene
 * handle's capability token list alone: callers pass an explicit profile /
 * eligibility so "profile not loaded / unknown" is distinguishable from an
 * explicit "unsupported" verdict. Selecting non-planar here enables authoring
 * only — it never claims the engine output is print-qualified.
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

  return (
    <section className="panel-timeline" aria-label="Timeline and slicing">
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
