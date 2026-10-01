import { usePrintJob, SLICE_STAGES } from "@/state/printjob";

/**
 * Slice progress (S9.5-002) — staged progress bar mirroring the print job
 * machine: shows the five G24 pipeline lanes (prepare → planar-core → IR →
 * postprocess → preview) as a mono stepping bar while `status === "slicing"`,
 * plus a Cancel action (only honoured between stages per the machine guard).
 */

export function SliceProgress() {
  const status = usePrintJob((s) => s.status);
  const stage = usePrintJob((s) => s.stage);
  const stageTotal = usePrintJob((s) => s.stageTotal);
  const stageLabel = usePrintJob((s) => s.stageLabel);
  const cancel = usePrintJob((s) => s.cancel);

  if (status !== "slicing") return null;

  const pct = stageTotal > 0 ? Math.min(100, Math.round((stage / stageTotal) * 100)) : 0;

  return (
    <div className="slice-progress" data-testid="slice-progress" role="status" aria-live="polite">
      <div className="slice-progress-head">
        <span className="slice-progress-title">Slicing {stageLabel || "…"}</span>
        <span className="slice-progress-meta mono-num">
          {stage}/{stageTotal} · {pct}%
        </span>
        <button
          type="button"
          className="slice-progress-cancel"
          data-testid="slice-cancel"
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
      <div className="slice-progress-track" aria-hidden="true">
        {SLICE_STAGES.map((label, i) => (
          <span
            key={label}
            className={`slice-progress-step${i <= stage ? " done" : ""}${i === stage ? " current" : ""}`}
            style={{ flex: 1 }}
          />
        ))}
      </div>
    </div>
  );
}
