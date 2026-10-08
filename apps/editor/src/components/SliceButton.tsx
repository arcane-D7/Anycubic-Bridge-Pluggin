import { useCallback } from "react";
import { useUi } from "@/state/ui";
import { usePrintJob, sliceEligible } from "@/state/printjob";
import { useI18n } from "@/state/i18n";
import { objectsOnPlate } from "@/state/plates-core";
import type { SceneObjectSnapshot } from "@/bridge/types";
import { useActivePlate } from "@/state/plates";
import { activeProjectScene } from "@/bridge/project-provider";
import { createNativeSliceRequest, runNativeSliceJob } from "@/bridge/slice-job";
import { parseIrDocument } from "@/bridge/ir";
import type { IrDocument } from "@/bridge/ir";
import { usePresets } from "@/state/presets";
import { CATALOG_MACHINES } from "@/profile/operatorProfile";
import type { SlicingMode } from "@/contract";

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
  readonly revision: number;
  readonly slicingMode: SlicingMode;
  readonly providerMode: "demo" | "real" | "unavailable";
  readonly machineName: string;
  readonly buildVolume: {
    readonly widthMm: number;
    readonly depthMm: number;
    readonly heightMm: number;
  } | null;
  readonly onSliced?:
    ((document: IrDocument, artifactId: string, sourceRevision: number) => void) | undefined;
}

export function SliceButton({
  objects,
  revision,
  slicingMode,
  providerMode,
  machineName,
  buildVolume,
  onSliced,
}: SliceButtonProps) {
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
  const settings = usePresets((s) => s.sliceSettings);
  const supports = usePresets((s) => s.supports);
  const brimWidthMm = usePresets((s) => s.brimWidthMm);
  const filamentId = usePresets((s) => s.filamentId);

  // Plate objects → eligibility (preflight runs synchronously on the plate).
  const plateObjects = objectsOnPlate(objects, active.id).filter((object) => object.visible);
  const eligible = sliceEligible(plateObjects);
  const profile = CATALOG_MACHINES.find((machine) => machine.displayName === machineName);

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
    const runStages = async () => {
      try {
        if (providerMode === "real") {
          if (!buildVolume || !profile) {
            throw new Error(
              "slice preflight: select a machine profile with a declared build volume",
            );
          }
          if (plateObjects.some((object) => !object.objectId)) {
            throw new Error("slice preflight: a target is missing its stable project ID");
          }
          advanceStage(0, 0, "Native planar slice");
          const request = createNativeSliceRequest({
            revision,
            slicingMode,
            plateId: active.id,
            profileId: profile.id,
            buildVolume,
            materialId: filamentId,
            materialType: settings.material,
            settings,
            supports,
            brimWidthMm,
            targetIds: plateObjects.map((object) => object.objectId!),
          });
          const result = await runNativeSliceJob(request);
          const document = parseIrDocument(result.ir);
          finish({
            layers: result.stats.layers,
            estimatedMinutes: result.stats.estimated_minutes,
            materialGrams: result.stats.material_grams,
            volumeMm3: result.stats.volume_mm3,
            perObjectMm3: result.stats.per_object_mm3,
          });
          pushToast({
            kind: "success",
            title: t("slice.ready.title"),
            message: t("slice.ready.message", {
              layers: String(result.stats.layers),
              min: String(result.stats.estimated_minutes),
            }),
          });
          onSliced?.(document, result.artifact_id, result.source_revision);
          return;
        }
        if (providerMode !== "demo") throw new Error("slice provider is unavailable");
        const stages = ["prepare", "planar-core", "IR", "postprocess", "preview"] as const;
        for (let i = 0; i < stages.length; i += 1) {
          advanceStage(i, stages.length, stages[i]!);
          await new Promise((r) => setTimeout(r, 260));
        }
        const handle = await activeProjectScene();
        const result = await handle.slice({ plateId: active.id });
        if (!result.ok) {
          fail(result.error);
          pushToast({ kind: "error", title: t("slice.failed.title"), message: result.error });
          return;
        }
        finish(result.stats);
        pushToast({
          kind: "info",
          title: t("slice.demo.title"),
          message: t("slice.demo.message"),
        });
      } catch (err) {
        if (usePrintJob.getState().status === "cancelled") return;
        fail(err instanceof Error ? err.message : String(err));
        pushToast({ kind: "error", title: t("slice.failed.title"), message: String(err) });
      }
    };
    void runStages();
  }, [
    active.id,
    advanceStage,
    brimWidthMm,
    buildVolume,
    fail,
    filamentId,
    finish,
    machineName,
    onSliced,
    plateObjects,
    profile,
    preflight,
    providerMode,
    pushToast,
    revision,
    slicingMode,
    settings,
    supports,
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
      disabled={!eligible || busy || providerMode === "unavailable"}
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
