import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/state/i18n";
import { usePrinters } from "@/state/printers";
import { usePrinterDevice } from "@/state/printer-device";
import {
  defaultLiveJobBindingProvider,
  type LiveArtifactReadResult,
  type LiveJobView,
} from "@/bridge/live-job";
import type { IrDocument } from "@/bridge/ir";
import {
  buildTelemetryView,
  cameraActivationAllowed,
  cameraProviderFor,
  cameraUnavailableReasonKey,
  resolveLiveArtifactLink,
  type LiveArtifactLink,
} from "@/state/workbench-live-core";

/**
 * S9.17-004 — Workbench Live (NAV-04 / DEV-08 / DEV-09, backend slice).
 *
 * Three semantic live views — telemetry, camera, artifact — rendered from
 * pure state (`workbench-live-core.ts`) and the ONE registered read-only
 * backend view (`live_job_binding`). The Tauri command always replies with a
 * typed view; when no physical job source exists it is `available: false`
 * (`unavailable_reason: "no-physical-job-source"`) and the panel shows that
 * EXPLICITLY — absence is never a swallowed unknown command. Honesty rules
 * enforced at render time:
 *   • telemetry shows observed origin/freshness/capture time only; the
 *     printer filename is display-only and NEVER becomes a job identity, and
 *     the physical task id comes ONLY from the backend view;
 *   • the camera tab has NO adapter in this build: the activation button is
 *     always disabled, the source is "none", and NO placeholder picture,
 *     video or canvas is ever invented;
 *   • the artifact tab renders "Artifact preview" ONLY when the backend
 *     published an exact physical-task-id binding (same project scope + fresh
 *     source revision) and the artifact was STRICTLY parsed via a project-
 *     owned CAS read (`live_artifact_read`) before the preview route fires.
 *     Unknown job / no binding / other project ⇒ no link, no invented model.
 */

export interface WorkbenchLivePreviewPayload {
  readonly projectId: string;
  readonly artifactId: string;
  readonly sourceRevision: number;
  readonly ir: IrDocument;
}

export interface WorkbenchLivePanelProps {
  /**
   * Only fetch while the panel is the visible page. A fetch started while
   * hidden is cancelled via the update sequence (never applied late).
   */
  readonly active: boolean;
  /** Active project scope (null when no project is open). */
  readonly projectId: string | null;
  /** Route a VALIDATED artifact to the Preview page (App re-checks scope). */
  readonly onOpenPreview?: (payload: WorkbenchLivePreviewPayload) => void;
}

type LiveLoadState = "idle" | "loading" | "ready" | "error";
type OpenStatus = "idle" | "opening" | "error" | "revoked";

function formatClock(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function WorkbenchLivePanel({ active, projectId, onOpenPreview }: WorkbenchLivePanelProps) {
  const t = useI18n((s) => s.t);
  const selectedId = usePrinters((s) => s.selectedId);
  const { snapshot: snap, pollingStatus } = usePrinterDevice();
  const [tab, setTab] = useState("telemetry");
  const [liveView, setLiveView] = useState<LiveJobView | null>(null);
  const [loadState, setLoadState] = useState<LiveLoadState>("idle");
  const [openStatus, setOpenStatus] = useState<OpenStatus>("idle");
  const [openMessage, setOpenMessage] = useState<string | null>(null);

  // S9.17-004 race cancellation: EVERY async flow captures the sequence at
  // start; while a project/printer/page change bumps it first, a stale reply
  // is ignored (never applied, never routed). Deactivation bumps it too, so a
  // reply for a hidden panel cannot land late.
  const updateSeqRef = useRef(0);
  const liveViewRef = useRef<LiveJobView | null>(null);
  liveViewRef.current = liveView;
  const onOpenRef = useRef(onOpenPreview);
  onOpenRef.current = onOpenPreview;

  const refresh = useCallback(async () => {
    const seq = ++updateSeqRef.current;
    // Clear the previous view first: a link valid for the previous
    // printer/job must never carry over (no stale artifact bridge).
    setLiveView(null);
    setOpenStatus("idle");
    setOpenMessage(null);
    setLoadState("loading");
    try {
      const view = await defaultLiveJobBindingProvider.fetchView(
        { projectId },
        async (command, args) => {
          const { invoke: call } = await import("@tauri-apps/api/core");
          return call(command, args);
        },
      );
      if (seq !== updateSeqRef.current) return;
      setLiveView(view);
      setLoadState("ready");
    } catch {
      if (seq !== updateSeqRef.current) return;
      setLiveView(null);
      setLoadState("error");
    }
  }, [projectId]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  // A hidden panel must never apply a late reply: bump the sequence when the
  // panel stops being the visible page.
  useEffect(() => {
    if (!active) updateSeqRef.current += 1;
  }, [active]);

  const now = Date.now();
  const telemetry = buildTelemetryView({
    printerId: selectedId,
    snapPrinterId: snap?.printerId ?? null,
    capturedAt: snap?.capturedAt ?? null,
    now,
    printFilename: snap?.print?.filename ?? null,
    pollingStatus,
  });
  const camera = cameraProviderFor(snap);
  const cameraAllowed = cameraActivationAllowed(camera);

  const artifactLink: LiveArtifactLink = resolveLiveArtifactLink({
    observedJobId: liveView?.observedJobId ?? null,
    // Raw backend identity — NEVER the selected printer (no fallback guess).
    observedPrinterId: liveView?.observedPrinterId ?? null,
    capturedJobBinding: liveView?.jobBinding ?? null,
    artifact: liveView?.artifact ?? null,
    activeProjectId: projectId,
  });

  const ageLabel = (ageMs: number | null): string => {
    if (ageMs === null) return t("workbench.telemetry.age.never");
    const seconds = Math.max(0, Math.round(ageMs / 1000));
    return seconds < 60
      ? t("workbench.telemetry.age.seconds", { n: String(seconds) })
      : t("workbench.telemetry.age.minutes", { n: String(Math.round(seconds / 60)) });
  };

  const originLabel =
    telemetry.origin === "cloud"
      ? t("workbench.telemetry.origin.cloud")
      : telemetry.origin === "demo"
        ? t("workbench.telemetry.origin.demo")
        : t("workbench.telemetry.origin.none");

  const freshnessLabel =
    telemetry.freshness === "fresh"
      ? t("workbench.telemetry.freshness.fresh")
      : telemetry.freshness === "stale"
        ? t("workbench.telemetry.freshness.stale")
        : telemetry.freshness === "offline"
          ? t("workbench.telemetry.freshness.offline")
          : t("workbench.telemetry.freshness.unknown");

  const artifactStatus = (() => {
    if (!artifactLink.linked) {
      switch (artifactLink.reason) {
        case "stale-source-rev":
          return t("workbench.artifact.stale");
        case "artifact-not-parsed":
          return t("workbench.artifact.notParsed");
        case "no-binding":
        case "no-job":
        case "job-mismatch":
        case "project-mismatch":
        case "printer-mismatch":
        case "artifact-unavailable":
        case "artifact-mismatch":
        default:
          return `${t("workbench.artifact.noLink")} — ${t("workbench.artifact.noLinkHint")}`;
      }
    }
    return t("workbench.artifact.linked");
  })();

  const openArtifact = useCallback(async () => {
    const link = resolveLiveArtifactLink({
      observedJobId: liveViewRef.current?.observedJobId ?? null,
      observedPrinterId: liveViewRef.current?.observedPrinterId ?? null,
      capturedJobBinding: liveViewRef.current?.jobBinding ?? null,
      artifact: liveViewRef.current?.artifact ?? null,
      activeProjectId: projectId,
    });
    if (!link.linked || openStatus === "opening" || projectId == null) return;
    const seq = updateSeqRef.current;
    const openProjectId = projectId;
    const openArtifactId = link.artifactId;
    setOpenStatus("opening");
    setOpenMessage(null);
    let result: LiveArtifactReadResult;
    try {
      result = await defaultLiveJobBindingProvider.readArtifact(
        { projectId: openProjectId, artifactId: openArtifactId },
        async (command, args) => {
          const { invoke: call } = await import("@tauri-apps/api/core");
          return call(command, args);
        },
      );
    } catch {
      result = { ok: false, code: "backend-error", message: null };
    }
    if (seq !== updateSeqRef.current) {
      setOpenStatus("revoked");
      setOpenMessage(t("workbench.artifact.open.revoked"));
      return;
    }
    if (!result.ok) {
      setOpenStatus("error");
      setOpenMessage(
        result.code === "invalid"
          ? t("workbench.artifact.open.invalid", { message: result.message ?? "" })
          : t("workbench.artifact.open.unavailable"),
      );
      return;
    }
    // Re-check the link against the CURRENT view before routing: a refresh in
    // flight may have replaced the binding (project/printer/job changed).
    const currentLink = resolveLiveArtifactLink({
      observedJobId: liveViewRef.current?.observedJobId ?? null,
      observedPrinterId: liveViewRef.current?.observedPrinterId ?? null,
      capturedJobBinding: liveViewRef.current?.jobBinding ?? null,
      artifact: liveViewRef.current?.artifact ?? null,
      activeProjectId: projectId,
    });
    if (
      !currentLink.linked ||
      currentLink.artifactId !== openArtifactId ||
      currentLink.sourceRev !== result.sourceRevision
    ) {
      setOpenStatus("revoked");
      setOpenMessage(t("workbench.artifact.open.revoked"));
      return;
    }
    setOpenStatus("idle");
    onOpenRef.current?.({
      projectId: openProjectId,
      artifactId: result.artifactId,
      sourceRevision: result.sourceRevision,
      ir: result.ir,
    });
  }, [openStatus, projectId, t]);

  return (
    <div
      className="workbench-live"
      data-testid="workbench-live"
      aria-label={t("workbench.live.aria")}
    >
      <header className="workbench-live-header">
        <h2 className="workbench-live-title">{t("workbench.live.title")}</h2>
        <button
          type="button"
          className="workbench-live-refresh"
          data-testid="live-refresh"
          aria-label={t("workbench.live.refreshAria")}
          onClick={() => void refresh()}
        >
          {t("workbench.live.refresh")}
        </button>
      </header>

      {liveView && !liveView.available && loadState === "ready" ? (
        <p
          className="workbench-live-unavailable"
          data-testid="live-backend"
          data-reason={liveView.unavailableReason ?? "no-physical-job-source"}
          role="status"
          aria-live="polite"
        >
          {t("workbench.live.unavailable")}
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={setTab} className="workbench-live-tabs">
        <TabsList className="workbench-live-tablist" aria-label={t("workbench.live.aria")}>
          <TabsTrigger
            value="telemetry"
            data-testid="live-tab-telemetry"
            className="workbench-live-tab"
          >
            {t("workbench.live.tab.telemetry")}
          </TabsTrigger>
          <TabsTrigger value="camera" data-testid="live-tab-camera" className="workbench-live-tab">
            {t("workbench.live.tab.camera")}
          </TabsTrigger>
          <TabsTrigger
            value="artifact"
            data-testid="live-tab-artifact"
            className="workbench-live-tab"
          >
            {t("workbench.live.tab.artifact")}
          </TabsTrigger>
        </TabsList>

        {/* Telemetry — observed state only --------------------------------- */}
        <TabsContent value="telemetry" data-testid="live-telemetry">
          {!selectedId ? (
            <p className="workbench-live-empty" data-testid="live-telemetry-empty">
              {t("workbench.telemetry.empty")}
            </p>
          ) : (
            <div className="workbench-live-chips" data-testid="live-telemetry-chips">
              <span className="workbench-live-chip" data-testid="live-telemetry-origin">
                {originLabel}
              </span>
              <span
                className="workbench-live-chip"
                data-testid="live-telemetry-freshness"
                data-freshness={telemetry.freshness}
              >
                {freshnessLabel}
              </span>
              <span className="workbench-live-chip" data-testid="live-telemetry-captured">
                {t("workbench.telemetry.capturedAt", {
                  time: formatClock(telemetry.capturedAt),
                  age: ageLabel(telemetry.ageMs),
                })}
              </span>
              {telemetry.printFilename ? (
                <span className="workbench-live-chip" data-testid="live-telemetry-file">
                  {t("workbench.telemetry.job.filename", { name: telemetry.printFilename })}
                </span>
              ) : null}
              <span
                className="workbench-live-chip"
                data-testid="live-telemetry-task"
                data-present={liveView?.observedJobId ? "true" : "false"}
              >
                {liveView?.observedJobId
                  ? t("workbench.telemetry.job.taskId", { id: liveView.observedJobId })
                  : t("workbench.telemetry.job.taskIdAbsent")}
              </span>
            </div>
          )}
        </TabsContent>

        {/* Camera — availability only, no adapter in this build ------------ */}
        <TabsContent value="camera" data-testid="live-camera">
          <div
            className="workbench-live-section"
            data-testid="live-camera-source"
            data-source="none"
          >
            {t("workbench.camera.source.none")}
          </div>
          <div className="workbench-live-row">
            <button
              type="button"
              className="workbench-live-activate"
              data-testid="live-camera-activate"
              disabled
              aria-disabled="true"
            >
              {t("workbench.camera.activate")}
            </button>
            <span className="workbench-live-reason" data-testid="live-camera-reason">
              {cameraAllowed
                ? t("workbench.camera.title")
                : cameraUnavailableReasonKey(camera) === "no-supported-provider"
                  ? t("workbench.camera.unavailable")
                  : t("workbench.camera.unavailable")}
            </span>
          </div>
          <p className="workbench-live-hint" data-testid="live-camera-hint">
            {t("workbench.camera.hint")}
          </p>
          {loadState === "error" ? (
            <p className="workbench-live-empty" data-testid="live-load-error">
              {t("device.backend.status.noResolver")}
            </p>
          ) : null}
        </TabsContent>

        {/* Artifact — explicit binding only, never invented ---------------- */}
        <TabsContent value="artifact" data-testid="live-artifact">
          <div className="workbench-live-section">
            <span className="workbench-live-label" data-testid="live-artifact-title">
              {t("workbench.artifact.title")}
            </span>
            <span className="workbench-live-sub" data-testid="live-artifact-measured">
              {t("workbench.artifact.measured")}
            </span>
          </div>
          <div
            className="workbench-live-artifact-status"
            data-testid="live-artifact-status"
            data-linked={artifactLink.linked ? "true" : "false"}
            data-reason={artifactLink.linked ? "none" : artifactLink.reason}
          >
            {artifactStatus}
          </div>
          {artifactLink.linked ? (
            <div className="workbench-live-row">
              <span data-testid="live-artifact-id">
                {t("workbench.artifact.id", { id: artifactLink.artifactId })}
                {" · "}
                {t("workbench.artifact.revs", {
                  source: String(artifactLink.sourceRev),
                  current: String(artifactLink.currentRev),
                })}
                {" · "}
                {artifactLink.compatibility === "qualified"
                  ? t("workbench.artifact.qualified")
                  : artifactLink.compatibility === "preview-only"
                    ? t("workbench.artifact.previewOnly")
                    : t("workbench.artifact.unqualified")}
              </span>
              {onOpenPreview ? (
                <button
                  type="button"
                  className="workbench-live-open"
                  data-testid="live-artifact-open"
                  disabled={openStatus === "opening"}
                  onClick={() => void openArtifact()}
                >
                  {openStatus === "opening"
                    ? t("workbench.artifact.open.opening")
                    : t("workbench.artifact.openPreview")}
                </button>
              ) : null}
              {openStatus !== "idle" ? (
                <p
                  className="workbench-live-open-status"
                  data-testid="live-artifact-open-status"
                  data-state={openStatus}
                  role="status"
                  aria-live="polite"
                >
                  {openMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
