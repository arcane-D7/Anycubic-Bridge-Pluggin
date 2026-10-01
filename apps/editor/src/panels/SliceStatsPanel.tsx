import { usePrintJob } from "@/state/printjob";

/**
 * Slice stats panel (S9.5-002) — renders the five G24 metrics from the real
 * pipeline output (`SliceStats` carried by the print job machine when it
 * reaches `ready`): layers, estimated time, material, volume, per-object
 * volume. Lives in the footer so it appears as soon as a slice lands, and
 * hides on cancel/reset.
 */

export function SliceStatsPanel() {
  const status = usePrintJob((s) => s.status);
  const stats = usePrintJob((s) => s.stats);

  if (!stats) return null;

  const perObject = Object.entries(stats.perObjectMm3)
    .map(([name, mm3]) => ({ name, mm3 }))
    .sort((a, b) => b.mm3 - a.mm3);

  return (
    <section
      className="slice-stats"
      data-testid="slice-stats"
      aria-label="Slice statistics"
      data-status={status}
    >
      <header className="panel-title">Slice stats</header>
      <div className="slice-stats-grid">
        <div className="slice-stat">
          <span className="slice-stat-label">Layers</span>
          <span className="slice-stat-value mono-num" data-testid="stat-layers">
            {stats.layers}
          </span>
        </div>
        <div className="slice-stat">
          <span className="slice-stat-label">Est. time</span>
          <span className="slice-stat-value mono-num" data-testid="stat-time">
            {stats.estimatedMinutes} min
          </span>
        </div>
        <div className="slice-stat">
          <span className="slice-stat-label">Material</span>
          <span className="slice-stat-value mono-num" data-testid="stat-material">
            {stats.materialGrams.toFixed(1)} g
          </span>
        </div>
        <div className="slice-stat">
          <span className="slice-stat-label">Volume</span>
          <span className="slice-stat-value mono-num" data-testid="stat-volume">
            {Math.round(stats.volumeMm3).toLocaleString()} mm³
          </span>
        </div>
      </div>
      {perObject.length > 0 ? (
        <ul className="slice-stats-per-object" data-testid="stat-per-object">
          {perObject.map(({ name, mm3 }) => (
            <li key={name}>
              <span className="mono-num">{Math.round(mm3).toLocaleString()} mm³</span>
              <span>{name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
