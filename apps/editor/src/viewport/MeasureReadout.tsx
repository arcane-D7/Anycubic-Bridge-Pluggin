import { useMeasure } from "../state/measure";
import { formatMeasure, type MeasureKind } from "./measure-core";

/**
 * S9.8-003 (G42) — measure readout overlay (OUT-OF-CANVAS).
 *
 * Sibling of the R3F canvas (like ViewCube / ObjectLabels / SnapReadout):
 * a mono strip bottom-left with the kind switcher (distance / radius /
 * angle), the live value (or probe progress) and a clear button. All state
 * is read from the `useMeasure` store that the in-canvas `MeasureTool`
 * writes — no canvas re-renders for a text change.
 */

const KIND_LABELS: readonly { readonly kind: MeasureKind; readonly label: string }[] = [
  { kind: "distance", label: "Dist" },
  { kind: "radius", label: "R" },
  { kind: "angle", label: "∠" },
];

const KIND_PROMPTS: readonly {
  readonly kind: MeasureKind;
  readonly need: number;
  readonly prompt: string;
}[] = [
  { kind: "distance", need: 2, prompt: "Pick first point" },
  { kind: "radius", need: 3, prompt: "Pick 3 points on a circular edge" },
  { kind: "angle", need: 3, prompt: "Pick apex then two edges" },
];

export function MeasureReadout() {
  const active = useMeasure((s) => s.active);
  const kind = useMeasure((s) => s.kind);
  const probes = useMeasure((s) => s.probes);
  const result = useMeasure((s) => s.result);
  const setKind = useMeasure((s) => s.setKind);
  const clear = useMeasure((s) => s.clear);

  if (!active) return null;

  const prompt = KIND_PROMPTS.find((p) => p.kind === kind);
  const pending = prompt ? `${probes.length}/${prompt.need} pts` : "";
  const value =
    probes.length === 1 && !result
      ? ` ${pending} — ${prompt?.prompt ?? ""}`
      : result
        ? formatMeasure(result)
        : ` ${pending || ""}`;

  return (
    <div className="measure-readout" data-testid="measure-readout" role="status">
      <div className="measure-kind" role="group" aria-label="Measure kind">
        {KIND_LABELS.map(({ kind: k, label }) => (
          <button
            type="button"
            key={k}
            data-testid={`measure-kind-${k}`}
            className={`measure-kind-btn${kind === k ? " is-active" : ""}`}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="measure-value" data-testid="measure-value">
        {value}
      </span>
      <button
        type="button"
        className="measure-clear"
        data-testid="measure-clear"
        aria-label="Clear measurement"
        disabled={probes.length === 0 && result === null}
        onClick={() => clear()}
      >
        clear
      </button>
    </div>
  );
}
