import { useMeasure } from "../state/measure";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";
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

const KIND_LABELS: readonly { readonly kind: MeasureKind; readonly labelKey: MsgKey }[] = [
  { kind: "distance", labelKey: "measure.kind.distance" },
  { kind: "radius", labelKey: "measure.kind.radius" },
  { kind: "angle", labelKey: "measure.kind.angle" },
];

const KIND_PROMPTS: readonly {
  readonly kind: MeasureKind;
  readonly need: number;
  readonly promptKey: MsgKey;
}[] = [
  { kind: "distance", need: 2, promptKey: "measure.prompt.distance" },
  { kind: "radius", need: 3, promptKey: "measure.prompt.radius" },
  { kind: "angle", need: 3, promptKey: "measure.prompt.angle" },
];

export function MeasureReadout() {
  const t = useI18n((s) => s.t);
  const active = useMeasure((s) => s.active);
  const kind = useMeasure((s) => s.kind);
  const probes = useMeasure((s) => s.probes);
  const result = useMeasure((s) => s.result);
  const setKind = useMeasure((s) => s.setKind);
  const clear = useMeasure((s) => s.clear);

  if (!active) return null;

  const prompt = KIND_PROMPTS.find((p) => p.kind === kind);
  const pending = prompt
    ? t("measure.pts", { n: String(probes.length), need: String(prompt.need) })
    : "";
  const value =
    probes.length === 1 && !result
      ? t("measure.pending", {
          pending: ` ${pending}`,
          prompt: prompt ? ` — ${t(prompt.promptKey)}` : "",
        })
      : result
        ? formatMeasure(result)
        : ` ${pending || ""}`;

  return (
    <div className="measure-readout" data-testid="measure-readout" role="status">
      <div className="measure-kind" role="group" aria-label={t("measure.kind.label")}>
        {KIND_LABELS.map(({ kind: k, labelKey }) => (
          <button
            type="button"
            key={k}
            data-testid={`measure-kind-${k}`}
            className={`measure-kind-btn${kind === k ? " is-active" : ""}`}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >
            {t(labelKey)}
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
        aria-label={t("measure.clear.aria")}
        disabled={probes.length === 0 && result === null}
        onClick={() => clear()}
      >
        {t("measure.clear")}
      </button>
    </div>
  );
}
