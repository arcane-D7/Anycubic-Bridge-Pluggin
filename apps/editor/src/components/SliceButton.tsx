import { useCallback } from "react";
import { useUi } from "@/state/ui";
import { usePrintJob, sliceEligible } from "@/state/printjob";
import { useI18n } from "@/state/i18n";
import { objectsOnPlate } from "@/state/plates-core";
import type { SceneObjectSnapshot } from "@/bridge/types";
import { useActivePlate } from "@/state/plates";

/**
 * Slice button (S9.5-002) — primary accent action in the workspace header.
 *
 * Enabled iff the ACTIVE plate has ≥1 watertight object (`sliceEligible` over
 * `objectsOnPlate`). Clicking runs the pipeline lanes through the print job
 * machine: preflight against the current scene objects, then staged progress
 * (the `SliceProgress` component mirrors the state). A blocked slice (non-
 * watertight offender) stays disabled AND shows the repair hint inline.
 */

interface SliceButtonProps {
  readonly objects: readonly SceneObjectSnapshot[];
  /** Callback so the parent can react to a successful slice (e.g. stats panel). */
  readonly onSliced?: (() => void) | undefined;
}

export function SliceButton({ objects, onSliced }: SliceButtonProps) {
  const t = useI18n((s) => s.t);
  const pushToast = useUi((s) => s.pushToast);
  const start = usePrintJob((s) => s.start);
  const preflight = usePrintJob((s) => s.preflight);
  const advanceStage = usePrintJob((s) => s.advanceStage);
  const finish = usePrintJob((s) => s.finish);
  const fail = usePrintJob((s) => s.fail);
  const status = usePrintJob((s) => s.status);
  const stageLabel = usePrintJob((s) => s.stageLabel);
  const blockedBy = usePrintJob((s) => s.blockedBy);
  const active = useActivePlate();

  // Plate objects → eligibility (preflight runs synchronously on the plate).
  const plateObjects = objectsOnPlate(objects, active.id);
  const eligible = sliceEligible(plateObjects);

  const busy = status === "slicing" || status === "sending";

  const onSliceClick = useCallback(() => {
    const rejected = preflight(plateObjects);
    if (rejected.length > 0) {
      pushToast({
        kind: "warning",
        title: t("slice.toast.blockedTitle"),
        message: t("slice.toast.blockedMessage", { names: rejected.join(", ") }),
      });
      return;
    }
    const startRejected = start();
    if (startRejected.length > 0) {
      pushToast({
        kind: "error",
        title: t("slice.toast.cannotTitle"),
        message: startRejected.join(" "),
      });
      return;
    }
    // Simulated G24 pipeline: the bridge lane is synchronous/read-only in the
    // mock, so run the staged progress as a short deterministic sequence and
    // finish with the real stats from the lane.
    const runStages = async () => {
      const stages = ["prepare", "planar-core", "IR", "postprocess", "preview"] as const;
      try {
        for (let i = 0; i < stages.length; i += 1) {
          advanceStage(i, stages.length, stages[i]!);
          await new Promise((r) => setTimeout(r, 260));
        }
        const lane = await import("@/bridge/mock");
        const handle = await lane.fetchSceneSnapshot();
        const result = await handle.slice({ plateId: active.id });
        if (!result.ok) {
          finish({
            layers: 1,
            estimatedMinutes: 1,
            materialGrams: 0,
            volumeMm3: 0,
            perObjectMm3: {},
          });
          fail(result.error);
          pushToast({ kind: "error", title: t("slice.failed.title"), message: result.error });
          return;
        }
        finish(result.stats);
        pushToast({
          kind: "success",
          title: t("slice.ready.title"),
          message: t("slice.ready.message", {
            layers: String(result.stats.layers),
            min: String(result.stats.estimatedMinutes),
          }),
        });
        onSliced?.();
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        pushToast({ kind: "error", title: t("slice.failed.title"), message: String(err) });
      }
    };
    void runStages();
  }, [
    active.id,
    advanceStage,
    fail,
    finish,
    onSliced,
    plateObjects,
    preflight,
    pushToast,
    start,
    t,
  ]);

  const blockHint =
    blockedBy.length > 0
      ? t("slice.blocked.title", { names: blockedBy.slice(0, 2).join(", ") })
      : null;

  return (
    <button
      type="button"
      className="slice-btn"
      data-testid="slice-btn"
      aria-label={eligible ? t("slice.button.aria.eligible") : t("slice.button.aria.blocked")}
      disabled={!eligible || busy}
      onClick={onSliceClick}
      title={blockHint ?? undefined}
    >
      {busy
        ? stageLabel
          ? t("slice.stage.active", { stage: stageLabel })
          : t("slice.stage.busy")
        : t("slice.button.idle")}
    </button>
  );
}
