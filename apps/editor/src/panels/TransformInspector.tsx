import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";
import {
  type InspectorTransform,
  type TransformAxis,
  type TransformKind,
  axisDisplay,
  axisValue,
  dirtyKinds,
  identityTransform,
  isNonUniformScale,
  isResized,
  normalizeTransform,
  parseAxisValue,
  resolveKind,
  sameTransform,
} from "../state/transform-inspector";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";

/**
 * Numeric transform inspector (S9.3-002).
 *
 * Reads the real transform of the selected object from the scene store
 * snapshot and writes back through the authoritative bridge lane
 * (`scene.mutateObject` setTransform + query invalidate — the ObjectTree
 * persist pattern). Edits commit on Enter or blur; a relative-mode toggle
 * adds deltas to the committed value. Reset returns a kind axis to
 * origin/identity.
 *
 * AC-1  Inspector reads/writes real transform values from/to the bridge
 *       snapshot (mutateObject response drives the store re-hydrate).
 * AC-2  Enter/blur commits; relative mode works; reset returns axis to
 *       0 (or 1 on scale).
 * AC-3  A draft that differs from the committed transform surfaces in the
 *       status bar via `useUi.setDirtyTransform` (dirty kinds list).
 */

interface TransformInspectorProps {
  readonly scene: BridgeHandle | undefined;
}

interface Field {
  readonly name: TransformAxis;
  readonly value: string;
  readonly valid: boolean;
}

interface RowDrafts {
  readonly x: Field;
  readonly y: Field;
  readonly z: Field;
}

export const KINDS: readonly TransformKind[] = ["position", "rotation", "scale"];
export const AXES: readonly TransformAxis[] = ["x", "y", "z"];

/** Parsed numeric values for a kind row (X/Y/Z). */
export interface RowValues {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function fieldsFrom(t: InspectorTransform, kind: TransformKind): RowDrafts {
  return {
    x: { name: "x", value: axisDisplay(kind, axisValue(kind, "x", t)), valid: true },
    y: { name: "y", value: axisDisplay(kind, axisValue(kind, "y", t)), valid: true },
    z: { name: "z", value: axisDisplay(kind, axisValue(kind, "z", t)), valid: true },
  };
}

/** Parse the three axis fields of a kind row → numbers, or null on invalid. */
export function parseRow(row: RowDrafts): RowValues | null {
  const x = parseAxisValue(row.x.value);
  const y = parseAxisValue(row.y.value);
  const z = parseAxisValue(row.z.value);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function withValue(row: RowDrafts, axis: TransformAxis, value: string, valid: boolean): RowDrafts {
  return { ...row, [axis]: { name: axis, value, valid } };
}

/** Resolve the full typed draft (all kinds) to a transform (for dirty check). */
export function resolveDrafts(
  committed: InspectorTransform,
  drafts: Record<TransformKind, RowDrafts>,
  relative: Partial<Record<TransformKind, boolean>>,
): InspectorTransform {
  let out = committed;
  for (const kind of KINDS) {
    const parsed = parseRow(drafts[kind]);
    if (parsed) out = resolveKind(out, kind, parsed, relative[kind] === true);
  }
  return out;
}

export function TransformInspector({ scene }: TransformInspectorProps) {
  const t = useI18n((s) => s.t);
  const queryClient = useQueryClient();
  const selected = useScene((s) => s.selected);
  const objects = useScene((s) => s.objects);
  const setDirtyTransform = useUi((s) => s.setDirtyTransform);
  const clearDirtyTransform = useUi((s) => s.clearDirtyTransform);
  const pushToast = useUi((s) => s.pushToast);

  const name = selected?.name ?? null;
  const committed = useMemo<InspectorTransform | null>(() => {
    if (!name) return null;
    const obj = objects.find((o) => o.name === name);
    return obj ? normalizeTransform(obj.transform) : null;
  }, [name, objects]);

  const [drafts, setDrafts] = useState<Record<TransformKind, RowDrafts>>(() => ({
    position: fieldsFrom(identityTransform(), "position"),
    rotation: fieldsFrom(identityTransform(), "rotation"),
    scale: fieldsFrom(identityTransform(), "scale"),
  }));
  const [relative, setRelative] = useState<Partial<Record<TransformKind, boolean>>>({});
  const lastCommittedRef = useRef<InspectorTransform | null>(null);
  const lastNameRef = useRef<string | null>(null);

  // Hydrate drafts from the snapshot, only when the committed transform
  // changed OR the selected object changed (never stomping in-progress edits
  // on unrelated re-renders).
  useEffect(() => {
    if (!committed) {
      lastCommittedRef.current = null;
      return;
    }
    const prev = lastCommittedRef.current;
    const nameChanged = lastNameRef.current !== name;
    lastCommittedRef.current = committed;
    lastNameRef.current = name;
    if (prev && !nameChanged && sameTransform(prev, committed)) return;
    setDrafts({
      position: fieldsFrom(committed, "position"),
      rotation: fieldsFrom(committed, "rotation"),
      scale: fieldsFrom(committed, "scale"),
    });
    setRelative({});
  }, [committed, name]);

  // AC-3 dirty propagation: compare the typed (absolute/relative-resolved)
  // draft vs the committed snapshot. Clearing happens on ANY deselection or
  // when the draft equals the committed values (never leaves a stale chip).
  useEffect(() => {
    if (!committed || !name) {
      clearDirtyTransform();
      return;
    }
    const draftTransform = resolveDrafts(committed, drafts, relative);
    const kinds = dirtyKinds(committed, draftTransform);
    if (kinds) setDirtyTransform(name, kinds);
    else clearDirtyTransform();
  }, [drafts, committed, name, relative, setDirtyTransform, clearDirtyTransform]);

  /** Persist via the authoritative bridge lane (ObjectTree persist pattern). */
  const persist = async (mutation: Parameters<BridgeHandle["mutateObject"]>[0]) => {
    if (!scene) return;
    try {
      const res = await scene.mutateObject(mutation);
      if (!res.ok) {
        pushToast({
          kind: "warning",
          title: t("transform.toast.rejected.title"),
          message: res.error,
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        title: t("transform.toast.failed"),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
    }
  };

  const commit = (kind: TransformKind) => {
    if (!committed || !name) return;
    const parsed = parseRow(drafts[kind]);
    if (!parsed) {
      pushToast({
        kind: "warning",
        title: t("transform.toast.invalid.title"),
        message: t("transform.toast.invalid.message"),
      });
      return;
    }
    const transform = resolveKind(committed, kind, parsed, relative[kind] === true);
    void persist({ kind: "setTransform", name, transform });
    // The snapshot rehydrates via invalidate; the hydration effect re-fills
    // the fields from the new authoritative values and clears dirty.
  };

  const onFieldChange = (kind: TransformKind, axis: TransformAxis, raw: string) => {
    const parsed = parseAxisValue(raw);
    setDrafts((d) => ({
      ...d,
      [kind]: withValue(d[kind], axis, raw, parsed !== null),
    }));
  };

  const commitOnBlur = (kind: TransformKind) => {
    if (drafts[kind].x.value === "" && drafts[kind].y.value === "" && drafts[kind].z.value === "")
      return;
    commit(kind);
  };

  const onKeyDown = (kind: TransformKind, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(kind);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (!committed) return;
      setDrafts((d) => ({ ...d, [kind]: fieldsFrom(committed, kind) }));
      setRelative((r) => ({ ...r, [kind]: false }));
    }
  };

  const resetKind = (kind: TransformKind) => {
    if (!committed || !name) return;
    const resetTarget: RowValues = kind === "scale" ? { x: 1, y: 1, z: 1 } : { x: 0, y: 0, z: 0 };
    const transform = resolveKind(committed, kind, resetTarget, false);
    void persist({ kind: "setTransform", name, transform });
  };

  const copyToAll = (kind: TransformKind) => {
    const row = drafts[kind]!;
    if (parseAxisValue(row.x.value) === null) return;
    setDrafts((d) => ({
      ...d,
      [kind]: {
        ...d[kind],
        y: { name: "y", value: row.x.value, valid: true },
        z: { name: "z", value: row.x.value, valid: true },
      },
    }));
  };

  const toggleRelative = (kind: TransformKind) => {
    setRelative((r) => {
      const next = !r[kind];
      if (!next && committed) {
        // Switching back to absolute: re-fill from the committed snapshot.
        setDrafts((d) => ({ ...d, [kind]: fieldsFrom(committed, kind) }));
      } else if (next && committed) {
        // Entering relative: seed the input fields with the delta baseline
        // (0 for position/rotation, 1 for scale) so delta typing is natural.
        setDrafts((d) => ({
          ...d,
          [kind]: fieldsFrom(identityTransform(), kind),
        }));
      }
      return { ...r, [kind]: next };
    });
  };

  const scaleWarning = committed ? isNonUniformScale(committed) : false;
  const resized = committed ? isResized(committed) : false;

  if (!name || !committed) {
    return (
      <section className="panel-transform-inspector" aria-label={t("transform.label")}>
        <header className="panel-title">{t("transform.title")}</header>
        <p className="panel-hint">{t("transform.emptyHint")}</p>
      </section>
    );
  }

  return (
    <section className="panel-transform-inspector" aria-label={t("transform.label")}>
      <header className="panel-title">{t("transform.title")}</header>

      {KINDS.map((kind) => {
        const row = drafts[kind]!;
        const kindKey: MsgKey =
          kind === "position"
            ? "transform.kind.position"
            : kind === "rotation"
              ? "transform.kind.rotation"
              : "transform.kind.scale";
        return (
          <fieldset
            key={kind}
            className={`inspector-row-group${relative[kind] ? " rel-mode" : ""}`}
            aria-label={kind}
          >
            <legend className="inspector-row-head">
              <span className="inspector-kind">{kind.charAt(0).toUpperCase()}</span>
              <span className="inspector-kind-name">{t(kindKey)}</span>
              <span className="inspector-kind-actions">
                <button
                  type="button"
                  className={`inspector-rel-toggle${relative[kind] ? " active" : ""}`}
                  aria-pressed={!!relative[kind]}
                  title={t("transform.mode.title", {
                    mode: t(relative[kind] ? "transform.mode.relative" : "transform.mode.absolute"),
                  })}
                  onClick={() => toggleRelative(kind)}
                >
                  {relative[kind] ? t("transform.rel") : t("transform.abs")}
                </button>
                <button
                  type="button"
                  className="inspector-copy"
                  title={t("transform.copy.title")}
                  aria-label={t("transform.copy.label", { kind: t(kindKey) })}
                  onClick={() => copyToAll(kind)}
                >
                  ⇥
                </button>
                <button
                  type="button"
                  className="inspector-reset"
                  title={t("transform.reset.title", {
                    kind: t(kindKey),
                    n: kind === "scale" ? "1" : "0",
                  })}
                  aria-label={t("transform.reset.label", { kind: t(kindKey) })}
                  onClick={() => resetKind(kind)}
                >
                  ↺
                </button>
              </span>
            </legend>
            <div className="inspector-rows">
              {AXES.map((axis) => {
                const field = row[axis]!;
                return (
                  <label key={axis} className="inspector-row">
                    <span className="inspector-axis">{axis}</span>
                    <input
                      className={`inspector-input mono-num${field.valid ? "" : " invalid"}`}
                      type="text"
                      inputMode="decimal"
                      aria-label={t("transform.axis.label", { kind: t(kindKey), axis })}
                      value={field.value}
                      onChange={(e) => onFieldChange(kind, axis, e.currentTarget.value)}
                      onBlur={() => commitOnBlur(kind)}
                      onKeyDown={(e) => onKeyDown(kind, e)}
                    />
                    {relative[kind] ? <span className="inspector-delta">Δ</span> : null}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {scaleWarning ? (
        <p className="inspector-warning" role="status">
          {t("transform.warning.nonUniform")}
        </p>
      ) : null}
      {resized && !scaleWarning ? (
        <p className="inspector-note" role="status">
          {t("transform.note.resized")}
        </p>
      ) : null}
    </section>
  );
}
