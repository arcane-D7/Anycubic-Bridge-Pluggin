import type { BridgeHandle } from "../bridge/mock";
import type { SlicingMode } from "../contract";

/**
 * Bottom panel — timeline/undo graph + slicing mode (R0 shell).
 *
 * The slicing-mode selector is a real piece of the contract (§3.0a dual-mode
 * slicing, persisted per project) — it renders as a disabled control until a
 * machine profile declares non-planar capabilities, and shows the named reason
 * why when it is unavailable (never a silent fallback). The timeline itself
 * (undo graph, slicing progress, job queue) is an R2+ placeholder.
 */

interface TimelineProps {
  readonly scene: BridgeHandle | undefined;
  readonly mode: SlicingMode;
  readonly onModeChange: (m: SlicingMode) => void;
}

export function Timeline({ scene, mode, onModeChange }: TimelineProps) {
  const capabilities = new Set(scene?.capabilities ?? []);
  const nonPlanarAvailable = capabilities.has("continuous_z");

  return (
    <section className="panel-timeline" aria-label="Timeline and slicing">
      <header className="panel-title">Timeline</header>
      <div className="timeline-row">
        <label className="timeline-label" htmlFor="slicing-mode">
          Slicing mode
        </label>
        <select
          id="slicing-mode"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as SlicingMode)}
          disabled={!nonPlanarAvailable}
        >
          <option value="standard">Standard (planar)</option>
          <option value="nonplanar">Non-planar (experimental)</option>
        </select>
        {!nonPlanarAvailable && (
          <span className="panel-hint">
            Non-planar disabled — machine profile does not declare <code>continuous_z</code>.
          </span>
        )}
      </div>
      <p className="panel-hint">Undo graph, slicing progress and job queue land here (R2).</p>
    </section>
  );
}
