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
import { BOOLEAN_OPS, booleanOpLabel, useToolbar } from "../state/toolbar";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";

interface BooleanToolPanelProps {
  readonly scene: BridgeHandle | undefined;
}

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
        title: "Boolean",
        message: "Pick two distinct watertight objects first.",
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
      pushToast({ kind: "error", title: "Boolean", message: res.error });
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
    setPreviewName(res.object);
    const verb = booleanOpLabel(op);
    pushToast({
      kind: "success",
      title: `Boolean ${verb}`,
      message: `Created "${res.object}" (${res.triangles} tri). ${
        hideSources ? "Sources hidden." : "Sources kept."
      }`,
    });
  }, [scene, a, b, op, hideSources, preview, pushToast, queryClient]);

  // Preview chip disappears once the object exists (committed) or arm clears.
  const committed = previewName ? objects.some((o) => o.name === previewName) : false;

  return (
    <section className="panel-boolean-tool" aria-label="Boolean tool">
      <header className="panel-title">
        Boolean
        <button
          type="button"
          className={`panel-boolean-toggle${booleanTool ? " is-active" : ""}`}
          aria-pressed={booleanTool}
          aria-label="Arm boolean tool"
          data-testid="boolean-arm"
          onClick={() => toggleFlag("booleanTool")}
        >
          {booleanTool ? "Armed" : "Arm"}
        </button>
      </header>
      {!booleanTool ? (
        <p className="panel-hint">Arm the boolean tool to combine two objects.</p>
      ) : (
        <div className="panel-boolean-body" data-testid="boolean-tool-body">
          <label className="settings-field" htmlFor="boolean-op">
            Operation
            <select
              id="boolean-op"
              className="settings-select"
              data-testid="boolean-op"
              value={op}
              onChange={(e) => setOp(e.target.value as BooleanOp)}
            >
              {BOOLEAN_OPS.map((o) => (
                <option key={o} value={o}>
                  {booleanOpLabel(o)}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field" htmlFor="boolean-a">
            Object A
            <select
              id="boolean-a"
              className="settings-select"
              data-testid="boolean-a"
              value={nameA}
              onChange={(e) => setNameA(e.target.value)}
            >
              <option value="">Select A…</option>
              {candidates.map((o) => (
                <option key={o.name} value={o.name} disabled={o.name === nameB}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field" htmlFor="boolean-b">
            Object B
            <select
              id="boolean-b"
              className="settings-select"
              data-testid="boolean-b"
              value={nameB}
              onChange={(e) => setNameB(e.target.value)}
            >
              <option value="">Select B…</option>
              {candidates.map((o) => (
                <option key={o.name} value={o.name} disabled={o.name === nameA}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          {preview ? (
            <p className="panel-boolean-preview" data-testid="boolean-preview">
              Preview: {preview.name} · {preview.triangles} tri · watertight (bounds{" "}
              {preview.bounds.min[0]}…{preview.bounds.max[0]} mm)
            </p>
          ) : (
            <p className="panel-boolean-preview" data-testid="boolean-preview">
              Pick two distinct watertight objects to preview.
            </p>
          )}

          <label className="settings-check">
            <input
              type="checkbox"
              checked={hideSources}
              data-testid="boolean-hide-sources"
              onChange={(e) => setHideSources(e.target.checked)}
            />
            Hide source objects
          </label>

          <button
            type="button"
            className="panel-boolean-execute"
            data-testid="boolean-execute"
            disabled={!canExecute}
            onClick={() => void execute()}
          >
            Execute {op ? booleanOpLabel(op) : ""}
          </button>
          {committed ? (
            <p className="panel-boolean-done" data-testid="boolean-committed">
              Committed — “{previewName}” is added to the scene (provenance noted, journal-safe).
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
