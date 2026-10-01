/**
 * S9.7-001 — Boolean add UI (G26).
 *
 * A select → op (union/subtract/intersect) → B select → execute → result
 * object. Wires the preserved `cad_v2_boolean` semantics through the bridge
 * boolean lane (`scene.boolean`), which produces a NEW closed result object
 * with a provenance note (`+bool <op> A∩B`) and joins the authoritative
 * snapshot at the new revision.
 *
 * Preview: before commit the op preview geometry is shown (the result's
 * bounds estimated over A∪B — same heuristic the lane applies, so the preview
 * and the committed object agree); the executed op is opt-in (Execute button),
 * never auto-committed.
 *
 * Non-destructive by construction: source objects remain until the user picks
 * "hide sources" (AC-2), and the op advances the journal so the S9.6 seek can
 * step the result's transform — the operation never deletes or rewrites A/B.
 *
 * The panel lives in the objects sidebar (mounted next to TransformInspector);
 * its armed flag (`booleanTool`) is a ToolState in `state/toolbar.ts`.
 */

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import type { BooleanOp } from "../state/toolbar";
import { BOOLEAN_OPS, useToolbar } from "../state/toolbar";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";

interface BooleanToolPanelProps {
  readonly scene: BridgeHandle | undefined;
}

/** i18n label key per op (toolbar-core labels stay untouched — S9.8-005 rule). */
const OP_LABEL_KEYS: Record<BooleanOp, MsgKey> = {
  add: "boolean.op.union",
  subtract: "boolean.op.subtract",
  intersect: "boolean.op.intersect",
};

/** Deterministic preview bounds (A∪B) — mirrors the lane's `booleanResultStats`
 * min/max so the preview agrees with the committed result. */
function previewBounds(
  a: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  },
  b: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  },
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ] as const,
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ] as const,
  };
}

export function BooleanToolPanel({ scene }: BooleanToolPanelProps) {
  const t = useI18n((s) => s.t);
  const queryClient = useQueryClient();
  const pushToast = useUi((s) => s.pushToast);
  const objects = useScene((s) => s.objects);
  const booleanTool = useToolbar((s) => s.booleanTool);
  const toggleFlag = useToolbar((s) => s.toggleFlag);

  const [nameA, setNameA] = useState<string>("");
  const [nameB, setNameB] = useState<string>("");
  const [op, setOp] = useState<BooleanOp>("add");
  const [hideSources, setHideSources] = useState(false);
  const [previewName, setPreviewName] = useState<string | null>(null);

  const a = nameA ? (objects.find((o) => o.name === nameA) ?? null) : null;
  const b = nameB ? (objects.find((o) => o.name === nameB) ?? null) : null;

  const candidates = useMemo(() => objects.filter((o) => o.visible && o.watertight), [objects]);

  // Op preview — the result's bounds over A∪B, watertight (server contract).
  const preview = useMemo(() => {
    if (!a || !b || a.name === b.name) return null;
    const bounds = previewBounds(a.bounds, b.bounds);
    return {
      name: `${a.name}-bool`,
      bounds,
      triangles: a.triangles + b.triangles + 12,
      watertight: true,
    };
  }, [a, b]);

  const canExecute = a !== null && b !== null && a.name !== b.name && preview !== null;

  const execute = useCallback(async () => {
    if (!scene || !a || !b || !preview) {
      pushToast({
        kind: "warning",
        title: t("boolean.toast.warning.title"),
        message: t("boolean.toast.warning.message"),
      });
      return;
    }
    const res = await scene.boolean({
      name_a: a.name,
      name_b: b.name,
      op,
      result_name: preview.name,
      hide_sources: hideSources,
    });
    if (!res.ok) {
      pushToast({ kind: "error", title: t("boolean.toast.warning.title"), message: res.error });
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
    setPreviewName(res.object);
    const verb = t(OP_LABEL_KEYS[op]);
    pushToast({
      kind: "success",
      title: t("boolean.toast.done", { verb }),
      message: `${t("boolean.committed", { name: res.object })} ${hideSources ? t("boolean.toast.sourcesHidden") : t("boolean.toast.sourcesKept")}`,
    });
  }, [scene, a, b, op, hideSources, preview, pushToast, queryClient, t]);

  // Preview chip disappears once the object exists (committed) or arm clears.
  const committed = previewName ? objects.some((o) => o.name === previewName) : false;

  return (
    <section className="panel-boolean-tool" aria-label={t("boolean.label")}>
      <header className="panel-title">
        {t("boolean.title")}
        <button
          type="button"
          className={`panel-boolean-toggle${booleanTool ? " is-active" : ""}`}
          aria-pressed={booleanTool}
          aria-label={t("boolean.arm.label")}
          data-testid="boolean-arm"
          onClick={() => toggleFlag("booleanTool")}
        >
          {booleanTool ? t("boolean.armed") : t("boolean.arm")}
        </button>
      </header>
      {!booleanTool ? (
        <p className="panel-hint">{t("boolean.arm.hint")}</p>
      ) : (
        <div className="panel-boolean-body" data-testid="boolean-tool-body">
          <label className="settings-field" htmlFor="boolean-op">
            {t("boolean.operation")}
            <select
              id="boolean-op"
              className="settings-select"
              data-testid="boolean-op"
              value={op}
              onChange={(e) => setOp(e.target.value as BooleanOp)}
            >
              {BOOLEAN_OPS.map((o) => (
                <option key={o} value={o}>
                  {t(OP_LABEL_KEYS[o])}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field" htmlFor="boolean-a">
            {t("boolean.objectA")}
            <select
              id="boolean-a"
              className="settings-select"
              data-testid="boolean-a"
              value={nameA}
              onChange={(e) => setNameA(e.target.value)}
            >
              <option value="">{t("boolean.selectA")}</option>
              {candidates.map((o) => (
                <option key={o.name} value={o.name} disabled={o.name === nameB}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field" htmlFor="boolean-b">
            {t("boolean.objectB")}
            <select
              id="boolean-b"
              className="settings-select"
              data-testid="boolean-b"
              value={nameB}
              onChange={(e) => setNameB(e.target.value)}
            >
              <option value="">{t("boolean.selectB")}</option>
              {candidates.map((o) => (
                <option key={o.name} value={o.name} disabled={o.name === nameA}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          {preview ? (
            <p className="panel-boolean-preview" data-testid="boolean-preview">
              {t("boolean.preview.template", {
                name: preview.name,
                tri: String(preview.triangles),
                min: String(preview.bounds.min[0]),
                max: String(preview.bounds.max[0]),
              })}
            </p>
          ) : (
            <p className="panel-boolean-preview" data-testid="boolean-preview">
              {t("boolean.preview.pick")}
            </p>
          )}

          <label className="settings-check">
            <input
              type="checkbox"
              checked={hideSources}
              data-testid="boolean-hide-sources"
              onChange={(e) => setHideSources(e.target.checked)}
            />
            {t("boolean.hideSources")}
          </label>

          <button
            type="button"
            className="panel-boolean-execute"
            data-testid="boolean-execute"
            disabled={!canExecute}
            onClick={() => void execute()}
          >
            {t("boolean.execute", { op: op ? t(OP_LABEL_KEYS[op]) : "" })}
          </button>
          {committed ? (
            <p className="panel-boolean-done" data-testid="boolean-committed">
              {t("boolean.committed", { name: previewName ?? "" })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
