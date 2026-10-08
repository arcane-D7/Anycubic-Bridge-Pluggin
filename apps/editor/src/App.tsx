import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeProjectProvider, activeProjectScene } from "./bridge/project-provider";
import type { IrDocument } from "./bridge/ir";
import { parseIrDocument } from "./bridge/ir";
import type { SlicingMode } from "./contract";
import { PanelDivider } from "./layout/PanelDivider";
import { ChatPanelLazy } from "./panels/ChatPanelLazy";
import { ImportDialog } from "./panels/ImportDialog";
import { ObjectTree } from "./panels/ObjectTree";
import { ObjectSettingsPanel } from "./panels/ObjectSettingsPanel";
import { BooleanToolPanel } from "./panels/BooleanToolPanel";
import { Timeline } from "./panels/Timeline";
import { SettingsPanel } from "./panels/SettingsPanel";
import { buildPreviewModel } from "./viewport/preview-model";
import type { PreviewModel } from "./viewport/preview-model";
import { Viewport } from "./viewport/Viewport";
import { PlateTabs } from "./viewport/PlateTabs";
import { resolveNonPlanarEligibility } from "./profile/capabilities";
import { useOperatorProfile } from "./profile/useOperatorProfile";
import { ThemeToggle } from "./components/theme-toggle";
import { StatusBar } from "./components/status-bar";
import { PrinterStatusBar } from "./components/PrinterStatusBar";
import { ToastViewport } from "./components/toast-viewport";
import { ContextMenu } from "./components/ContextMenu";
import { DirtyChip } from "./components/dirty-chip";
import { ShortcutHelp } from "./components/shortcut-help";
import { SliceButton } from "./components/SliceButton";
import { SliceProgress } from "./components/SliceProgress";
import { SliceStatsPanel } from "./panels/SliceStatsPanel";
import { DevicePanelHost } from "./components/dock/DevicePanelHost";
import { TransformPanelHost } from "./components/dock/TransformPanelHost";
import { useDock } from "./state/dock";
import { PrinterPicker } from "./components/PrinterPicker";
import { PrintJobDialog } from "./dialogs/PrintJobDialog";
import { useShortcuts } from "./hooks/useShortcuts";
import { DockLayer } from "./components/dock/dock-layer";
import { DockPanel } from "./components/dock/dock-panel";
import { useScene } from "./state/scene";
import { useUi } from "./state/ui";
import { useI18n } from "./state/i18n";
import { usePlates } from "./state/plates";
import { usePrinters } from "./state/printers";
import { activePlate as activePlateOf } from "./state/plates-core";
import { CATALOG_MACHINES } from "./profile/operatorProfile";
import { useViewport } from "./state/viewport";
import { isTauriRuntime } from "./bridge/project-provider";
import {
  createLocalProject,
  continueLocalProject,
  listLocalProjects,
  listLocalSliceJobs,
  openLocalProject,
  preflightLocalReprintIntent,
  recoverLocalProject,
  resolveSliceArtifactStatus,
  type LocalProjectSummary,
  type LocalSliceJob,
} from "./bridge/home";

/**
 * Editor shell — single-window, resizable panels per §7.2:
 *
 *   left    object tree ............ + viewport ............... right chat
 *   bottom  timeline / slicing progress / job queue (R2)
 *
 * The center viewport is the ONLY geometry surface and reads from the bridge
 * query (provider = mock in R0). Title/branding is self-owned — the shell is
 * independent of Blender/Anycubic Slicer Next (this is OUR editor, preserving
 * the legacy CAD UI read-only via the S6-005 bridge).
 */

const QUERY_KEY = ["bridge", "scene"] as const;
const PROVIDER_QUERY_KEY = ["project", "provider"] as const;
const MAX_IR_FILE_BYTES = 20 * 1024 * 1024;

/** Single demo toast on boot so the bus is visibly alive (S9.1-005 AC). */
function useDemoToast() {
  const pushToast = useUi((s) => s.pushToast);
  const t = useI18n((s) => s.t);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      pushToast({
        kind: "info",
        title: t("app.toast.demo.title"),
        message: t("app.toast.demo.message"),
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [pushToast, t]);
}

export function App() {
  useDemoToast();
  const queryClient = useQueryClient();
  const t = useI18n((s) => s.t);
  const providerQuery = useQuery({
    queryKey: PROVIDER_QUERY_KEY,
    queryFn: activeProjectProvider,
    staleTime: 30_000,
  });
  const provider = providerQuery.data;
  const sceneQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: activeProjectScene,
    enabled: provider?.available === true,
    staleTime: 30_000,
  });
  const scene = sceneQuery.data;

  // S9.3-003: global keyboard shortcut layer (G32). One keydown listener owns
  // the whole map (G/R/S grabs, X/Y/Z axis constrain, Enter/Esc, Q/W/E/R tools,
  // F frame, Delete/Ctrl+D, Ctrl+Z/Y soft journal) — decisions in the pure
  // `shortcuts-core`, actions here against the stores + bridge mutation lane.
  useShortcuts(scene);
  const objects = useScene((s) => s.objects);
  const projectRevision = useViewport((s) => s.revision);

  // S9.2-004: hydrate the scene store from the authoritative snapshot. The
  // ObjectTree/SceneObjectModel consume the store, so the snapshot must flow
  // into it exactly once per fetch — selection is remapped by stable object ID.
  const hydrate = useScene((s) => s.hydrate);
  useEffect(() => {
    if (!scene) return;
    const { objects, selectedNames, anchorName } = useScene.getState();
    const selectedIds = new Set(
      objects
        .filter((object) => selectedNames.includes(object.name))
        .map((object) => object.objectId),
    );
    const nextSelectedNames = scene.objects
      .filter((object) => object.objectId && selectedIds.has(object.objectId))
      .map((object) => object.name);
    const nextAnchor = objects.find((object) => object.name === anchorName)?.objectId;
    const nextAnchorName = nextAnchor
      ? scene.objects.find((object) => object.objectId === nextAnchor)?.name
      : null;
    hydrate(scene.objects, {
      selectedNames: nextSelectedNames,
      anchorName: nextAnchorName ?? null,
    });
  }, [scene, hydrate]);

  const [operatorProfile, setOperatorProfile] = useOperatorProfile();
  // P1-8 — headline printer label: armed LAN printer → IP; else the
  // operator profile machine name (matches the header picker label).
  const printerLabel = usePrinters(
    (s) => s.printers.find((p) => p.id === s.selectedId)?.ip ?? null,
  );
  const deviceTitle = printerLabel ?? operatorProfile.displayName ?? null;
  const eligibility = useMemo(
    () => resolveNonPlanarEligibility(scene?.capabilities, operatorProfile),
    [scene?.capabilities, operatorProfile],
  );

  const [mode, setMode] = useState<SlicingMode>("standard");
  const [leftSize, setLeftSize] = useState(330);
  const [bottomSize, setBottomSize] = useState(116);
  const [sidebarView, setSidebarView] = useState<"settings" | "objects" | "chat">("settings");
  const [workspaceView, setWorkspaceView] = useState<"home" | "prepare" | "preview">("home");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // S9.4-003 — plate membership from the scene store (authoritative snapshot)
  // + active plate name from the plate store (drives per-plate filter label).
  const activePlateName = usePlates((s) => activePlateOf(s).name);
  // S9.2-005: import dialog (footer Add entry point).
  const [importOpen, setImportOpen] = useState(false);
  const [previewIr, setPreviewIr] = useState<IrDocument | null>(null);
  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  const [previewSourceRevision, setPreviewSourceRevision] = useState<number | null>(null);
  const [irError, setIrError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const selectedMachine = CATALOG_MACHINES.find(
    (machine) => machine.displayName === operatorProfile.displayName,
  );
  const previewStale = previewSourceRevision !== null && projectRevision !== previewSourceRevision;
  const [localProjects, setLocalProjects] = useState<LocalProjectSummary[]>([]);
  const [localJobs, setLocalJobs] = useState<LocalSliceJob[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [homeBusy, setHomeBusy] = useState(false);
  const [reprintResults, setReprintResults] = useState<Record<string, string>>({});

  const refreshHome = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const projects = await listLocalProjects(invoke);
      setLocalProjects(projects);
      const selectedId = projects.some((project) => project.id === selectedProjectId)
        ? selectedProjectId
        : (projects[0]?.id ?? null);
      setSelectedProjectId(selectedId);
      setLocalJobs(selectedId ? await listLocalSliceJobs(invoke, selectedId) : []);
      setHomeError(null);
    } catch {
      setHomeError(t("home.localUnavailable"));
    }
  }, [selectedProjectId, t]);

  const preflightReprint = useCallback(
    async (sourceJobId: string) => {
      setReprintResults((current) => ({ ...current, [sourceJobId]: "checking" }));
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await preflightLocalReprintIntent(invoke, {
          sourceJobId,
          intentId: `reprint-intent-${crypto.randomUUID()}`,
        });
        setReprintResults((current) => ({
          ...current,
          [sourceJobId]:
            result.status === "proposed"
              ? t("home.reprint.proposed", {
                  intentId: result.proposalId,
                  sourceJobId: result.sourceJobId,
                })
              : t("home.reprint.blockedReason", { reason: result.reason }),
        }));
      } catch {
        setReprintResults((current) => ({
          ...current,
          [sourceJobId]: t("home.reprint.blockedReason", { reason: "preflight-unavailable" }),
        }));
      }
    },
    [t],
  );

  useEffect(() => {
    void refreshHome();
  }, [refreshHome]);

  const activateProject = useCallback(
    async (action: "create" | "open" | "continue" | "recover", project?: LocalProjectSummary) => {
      if (!isTauriRuntime()) return;
      const projectId = project?.id ?? selectedProjectId;
      if (
        action !== "create" &&
        (!projectId || !localProjects.some((item) => item.id === projectId))
      ) {
        setHomeError(t("home.selectProject"));
        return;
      }
      setHomeBusy(true);
      setHomeError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const name =
          action === "create"
            ? window.prompt(t("home.newProjectPrompt"), t("home.untitledProject"))
            : null;
        if (action === "create" && name === null) return;
        const projectName = name?.trim() ?? "";
        if (action === "create" && !projectName) {
          setHomeError(t("home.nameRequired"));
          return;
        }
        const snapshot =
          action === "create"
            ? await createLocalProject(invoke, `project-${crypto.randomUUID()}`, projectName)
            : action === "continue"
              ? await continueLocalProject(invoke, projectId!)
              : action === "recover"
                ? await recoverLocalProject(invoke, projectId!)
                : await openLocalProject(invoke, projectId!);
        setSelectedProjectId(snapshot.project.id);
        useScene.getState().hydrate(snapshot.project.objects as never[]);
        useViewport.setState({ revision: snapshot.revision });
        if (
          action === "recover" &&
          (snapshot.diagnostics ?? []).some((diagnostic) => diagnostic.code.startsWith("ARTIFACT_"))
        ) {
          useUi.getState().pushToast({
            kind: "warning",
            title: t("home.recoverProject"),
            message: t("home.recovery.geometryMissing"),
          });
        }
        if (action !== "recover") {
          await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        }
        setWorkspaceView("prepare");
        await refreshHome();
      } catch (error) {
        setHomeError(error instanceof Error ? error.message : String(error));
      } finally {
        setHomeBusy(false);
      }
    },
    [localProjects, refreshHome, selectedProjectId, t],
  );

  const localBackendAvailable = isTauriRuntime() && provider?.mode === "real" && provider.available;
  const backendUnavailableReason =
    provider?.reason === "real-project-provider-not-connected"
      ? t("home.backendReason.notConnected")
      : provider?.reason === "project-authority-unavailable"
        ? t("home.backendReason.authorityUnavailable")
        : t("home.backendReason.unknown");

  const preview = useMemo<PreviewModel | null>(
    () => (previewIr ? buildPreviewModel(previewIr) : null),
    [previewIr],
  );

  const onIrFile = useCallback(async (file: File) => {
    const seq = ++loadSeq.current;
    if (file.size > MAX_IR_FILE_BYTES) {
      setPreviewIr(null);
      setIrError(t("app.ir.sizeError", { name: file.name }));
      return;
    }
    try {
      const text = await file.text();
      if (seq !== loadSeq.current) return;
      const parsed: unknown = JSON.parse(text);
      if (seq !== loadSeq.current) return;
      const document = parseIrDocument(parsed);
      setPreviewIr(document);
      setPreviewArtifactId(null);
      setPreviewSourceRevision(null);
      setMode(document.mode);
      setWorkspaceView("preview");
      setIrError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setPreviewIr(null);
      setIrError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onNativeSliced = useCallback(
    (document: IrDocument, artifactId: string, sourceRevision: number) => {
      setPreviewIr(document);
      setPreviewArtifactId(artifactId);
      setPreviewSourceRevision(sourceRevision);
      setMode(document.mode);
      setWorkspaceView("preview");
      setIrError(null);
    },
    [],
  );

  const onIrClear = useCallback(() => {
    loadSeq.current += 1;
    setPreviewIr(null);
    setPreviewArtifactId(null);
    setPreviewSourceRevision(null);
    setIrError(null);
  }, []);

  const onModeChange = useCallback(
    (m: SlicingMode) => {
      if (previewIr && previewIr.mode !== m) {
        setIrError(t("app.ir.modeSwitchRejected", { mode: previewIr.mode }));
        return;
      }
      setMode(m);
    },
    [previewIr, t],
  );

  const modeLockReason = previewIr
    ? t("app.ir.modeLockReason", { mode: previewIr.mode })
    : undefined;

  return (
    <div
      className={`app-shell${sidebarOpen ? "" : " sidebar-collapsed"}`}
      style={
        {
          "--left-panel-size": `${leftSize}px`,
          "--bottom-panel-size": `${bottomSize}px`,
        } as React.CSSProperties
      }
    >
      <header className="app-header">
        <span className="app-brand">{t("app.brand")}</span>
        <nav className="workspace-tabs" aria-label={t("app.workspaceView.aria")}>
          <button
            type="button"
            aria-pressed={workspaceView === "home"}
            onClick={() => {
              setWorkspaceView("home");
              void refreshHome();
            }}
          >
            {t("app.tab.home")}
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "prepare"}
            onClick={() => setWorkspaceView("prepare")}
          >
            {t("app.tab.prepare")}
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "preview"}
            onClick={() => setWorkspaceView("preview")}
          >
            {t("app.tab.preview")}
          </button>
        </nav>
        <SliceButton
          objects={objects}
          revision={Math.max(scene?.revision ?? 0, projectRevision)}
          slicingMode={mode}
          providerMode={provider?.mode ?? "unavailable"}
          machineName={operatorProfile.displayName}
          buildVolume={selectedMachine?.buildVolume ?? operatorProfile.buildVolume}
          onSliced={onNativeSliced}
        />
        <PrinterPicker />
        <button
          type="button"
          className="device-panel-toggle"
          aria-label={t("device.button.aria")}
          title={t("device.button.title")}
          data-testid="device-panel-toggle"
          onClick={() => {
            const state = useDock.getState().panels.device;
            if (state.mode === "floating") {
              useDock.getState().setPanelMode("device", "collapsed");
            } else {
              useDock.getState().focusPanel("device");
              useDock.getState().setPanelMode("device", "floating");
            }
          }}
        >
          <span className="device-panel-toggle-label">{t("device.panel.title")}</span>
          {deviceTitle ? (
            <span className="device-panel-toggle-ctx" data-testid="device-panel-toggle-ctx">
              {deviceTitle}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((current) => !current)}
        >
          {t("app.sidebarToggle")}
        </button>
        <span className="app-sub" data-testid="bridge-state" data-provider={provider?.mode}>
          {sceneQuery.isFetching
            ? t("app.bridgeState.fetching")
            : provider?.available && provider.mode === "demo"
              ? t("app.bridgeState.demo")
              : provider?.available && provider.mode === "real"
                ? t("app.bridgeState.real")
                : t("app.bridgeState.unavailable")}
          {provider?.reason ? ` · ${provider.reason}` : ""}
        </span>
        <DirtyChip />
        <ToastViewport />
        <details className="shortcut-help-popover" data-testid="shortcut-help-toggle">
          <summary aria-label={t("app.shortcutHelp.aria")} title={t("app.shortcutHelp.title")}>
            ?
          </summary>
          <ShortcutHelp />
        </details>
        <ThemeToggle />
      </header>

      <main className="app-main">
        <section
          className="home-page"
          data-testid="home-page"
          aria-label={t("home.title")}
          hidden={workspaceView !== "home"}
        >
          <header className="home-heading">
            <div>
              <h1>{t("home.title")}</h1>
              <p>{t("home.subtitle")}</p>
            </div>
            <button
              type="button"
              className="home-primary"
              data-testid="home-new-project"
              disabled={!localBackendAvailable || homeBusy}
              onClick={() => void activateProject("create")}
            >
              {t("home.newProject")}
            </button>
          </header>
          {!isTauriRuntime() ? <p className="home-empty">{t("home.demoMode")}</p> : null}
          {isTauriRuntime() && provider && !localBackendAvailable ? (
            <p className="home-error" role="status">
              {t("home.backendUnavailable", { reason: backendUnavailableReason })}
            </p>
          ) : null}
          {homeError ? (
            <p className="home-error" role="alert">
              {homeError}
            </p>
          ) : null}
          <div className="home-columns">
            <section className="home-section" aria-labelledby="home-projects-title">
              <header className="home-section-heading">
                <h2 id="home-projects-title">{t("home.projects")}</h2>
                <span>{isTauriRuntime() ? t("home.localSource") : t("home.demoMode")}</span>
              </header>
              <div className="home-project-actions">
                <button
                  type="button"
                  data-testid="home-continue"
                  disabled={!localBackendAvailable || !selectedProjectId || homeBusy}
                  onClick={() => void activateProject("continue")}
                >
                  {t("home.continueProject")}
                </button>
                <button
                  type="button"
                  data-testid="home-recover"
                  disabled={!localBackendAvailable || !selectedProjectId || homeBusy}
                  onClick={() => void activateProject("recover")}
                >
                  {t("home.recoverProject")}
                </button>
              </div>
              {localProjects.length ? (
                <ul className="home-project-list">
                  {localProjects.map((project) => (
                    <li key={project.id} data-testid={`home-project-${project.id}`}>
                      <div className="home-project-copy">
                        <button
                          type="button"
                          aria-pressed={selectedProjectId === project.id}
                          disabled={!localBackendAvailable || homeBusy}
                          onClick={() => setSelectedProjectId(project.id)}
                        >
                          <strong>{project.name}</strong>
                        </button>
                        <span>
                          {project.id} · {t("home.localSource")}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={!localBackendAvailable || homeBusy}
                        onClick={() => void activateProject("open", project)}
                      >
                        {t("home.openProject")}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="home-empty">
                  {isTauriRuntime() ? t("home.noProjects") : t("home.localUnavailable")}
                </p>
              )}
            </section>
            <div className="home-history-column">
              <section className="home-section" aria-labelledby="home-jobs-title">
                <header className="home-section-heading">
                  <h2 id="home-jobs-title">{t("home.sliceJobs")}</h2>
                  <span>{selectedProjectId ?? t("home.noProjects")}</span>
                </header>
                {localJobs.length ? (
                  <ul className="home-history-list">
                    {localJobs.map((job, index) => (
                      <li key={job.job_id ?? index}>
                        <strong>{job.job_id ?? "Slice job"}</strong>
                        <span>
                          {job.status ?? "unknown"} · rev {job.source_revision ?? "unknown"}
                        </span>
                        <span>{t(`home.artifact.${resolveSliceArtifactStatus(job)}`)}</span>
                        <span data-testid={`home-reprint-status-${job.job_id ?? index}`}>
                          {reprintResults[job.job_id ?? ""] ?? t("home.reprint.blocked")}
                        </span>
                        <button
                          type="button"
                          data-testid={`home-reprint-${job.job_id ?? index}`}
                          disabled={
                            !localBackendAvailable ||
                            homeBusy ||
                            !job.job_id ||
                            reprintResults[job.job_id] === "checking"
                          }
                          title={t("home.reprint.unavailable")}
                          onClick={() => job.job_id && void preflightReprint(job.job_id)}
                        >
                          {t("home.reprint.propose")}
                        </button>
                        {!reprintResults[job.job_id ?? ""] ||
                        reprintResults[job.job_id ?? ""] === "checking" ? (
                          <span>{t("home.reprint.unavailable")}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="home-empty">{t("home.noSliceJobs")}</p>
                )}
              </section>
              <section className="home-section" aria-labelledby="home-print-history-title">
                <header className="home-section-heading">
                  <h2 id="home-print-history-title">{t("home.printHistory")}</h2>
                  <span>{t("home.cloudHistoryUnavailable")}</span>
                </header>
                <p className="home-empty">{t("home.cloudHistoryUnavailable")}</p>
              </section>
            </div>
          </div>
        </section>
        <div className="editor-workspace" hidden={workspaceView === "home"}>
          <aside className="panel-left">
            <nav className="sidebar-nav" aria-label={t("app.sidebarNav.aria")}>
              {(
                [
                  ["settings", "app.view.settings"],
                  ["objects", "app.view.objects"],
                  ["chat", "app.view.chat"],
                ] as const
              ).map(([view, key]) => (
                <button
                  type="button"
                  key={view}
                  aria-pressed={sidebarView === view}
                  onClick={() => setSidebarView(view)}
                >
                  {t(key)}
                </button>
              ))}
              <button
                type="button"
                className="sidebar-detach"
                title={t("app.chat.detachTitle")}
                aria-label={t("app.chat.detachAria")}
                data-testid="chat-detach"
                onClick={() => {
                  useDock.getState().focusPanel("chat");
                  useDock.getState().setPanelMode("chat", "floating");
                }}
              >
                ⇱
              </button>
            </nav>
            <div hidden={sidebarView !== "settings"}>
              <SettingsPanel profile={operatorProfile} onProfileChange={setOperatorProfile} />
            </div>
            {sidebarView === "objects" ? (
              <>
                <ObjectTree scene={scene} onOpenImport={() => setImportOpen(true)} />
                <ObjectSettingsPanel scene={scene} />
                <BooleanToolPanel scene={scene} />
              </>
            ) : null}{" "}
            {sidebarView === "chat" ? <ChatPanelLazy /> : null}
            <section className="panel-section" aria-label={t("app.ir.aria")}>
              <header className="panel-title">{t("app.ir.title")}</header>
              <div className="panel-body">
                <label className="ir-file-label" htmlFor="ir-file-input">
                  {t("app.ir.fileLabel")}
                </label>
                <input
                  id="ir-file-input"
                  data-testid="ir-file-input"
                  className="ir-file-input"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (file) void onIrFile(file);
                  }}
                />
                <button
                  type="button"
                  data-testid="ir-clear"
                  onClick={onIrClear}
                  disabled={!previewIr && !irError}
                >
                  {t("app.ir.clear")}
                </button>
                <p
                  data-testid="ir-status"
                  role="status"
                  aria-live="polite"
                  className={irError ? "ir-status ir-status-error" : "ir-status"}
                >
                  {irError
                    ? irError
                    : preview
                      ? t("app.ir.loaded", {
                          n: String(preview.layerCount),
                          s: preview.layerCount === 1 ? "" : "s",
                          mode: preview.mode,
                        })
                      : t("app.ir.empty")}
                </p>
              </div>
            </section>
          </aside>
          <PanelDivider
            axis="vertical"
            ariaLabel={t("app.divider.ariaVertical")}
            size={leftSize}
            minSize={180}
            maxSize={520}
            onSizeChange={setLeftSize}
          />
          <section className="viewport-host" aria-label={t("app.viewport.aria")}>
            <PlateTabs scene={scene} objects={objects} />
            <div className="plate-heading">
              <strong data-testid="plate-heading-name">{activePlateName}</strong>
              <span>{operatorProfile.displayName || t("app.plate.operatorFallback")}</span>
              <span data-testid="viewport-volume">
                {operatorProfile.buildVolume
                  ? t("app.plate.volume", {
                      w: String(operatorProfile.buildVolume.widthMm),
                      d: String(operatorProfile.buildVolume.depthMm),
                      h: String(operatorProfile.buildVolume.heightMm),
                    })
                  : t("app.plate.volumeFallback")}
              </span>
            </div>
            <Viewport
              scene={scene}
              preview={workspaceView === "preview" ? preview : null}
              buildVolume={operatorProfile.buildVolume ?? undefined}
            />
          </section>
        </div>
      </main>

      <PanelDivider
        axis="horizontal"
        size={bottomSize}
        minSize={90}
        maxSize={420}
        onSizeChange={setBottomSize}
      />
      <footer className="app-footer">
        <PrinterStatusBar />
        <StatusBar scene={scene} buildVolume={operatorProfile.buildVolume ?? undefined} />
        {previewStale ? (
          <div className="slice-stale" role="status" data-testid="slice-stale">
            {t("slice.stale.message", { revision: String(previewSourceRevision) })}
            {previewArtifactId ? <code>{previewArtifactId}</code> : null}
          </div>
        ) : null}
        {previewArtifactId && !previewStale ? (
          <div className="slice-artifact-status" role="status" data-testid="slice-preview-only">
            {t("slice.previewOnly", { id: previewArtifactId })}
          </div>
        ) : null}
        <SliceProgress nativeProvider={provider?.mode === "real"} />
        <SliceStatsPanel />
        {provider?.mode === "demo" ? <PrintJobDialog /> : null}
        <Timeline
          scene={scene}
          mode={mode}
          onModeChange={onModeChange}
          operatorProfile={operatorProfile}
          eligibility={eligibility}
          modeLockReason={modeLockReason}
        />
      </footer>
      <ContextMenu />
      <DockLayer>
        <DockPanel />
        <DevicePanelHost />
        <TransformPanelHost scene={scene} />
      </DockLayer>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} scene={scene} />
    </div>
  );
}
