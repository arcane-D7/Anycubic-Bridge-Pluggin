import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeProjectProvider, activeProjectScene } from "./bridge/project-provider";
import {
  createRealProjectBridge,
  sceneObjectsFromProjectSnapshot,
} from "./bridge/real-project-bridge";
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
import { Icon } from "./components/icons";
import { StatusBar } from "./components/status-bar";
import { PrinterStatusBar } from "./components/PrinterStatusBar";
import { ToastViewport } from "./components/toast-viewport";
import { ContextMenu } from "./components/ContextMenu";
import { DirtyChip } from "./components/dirty-chip";
import { ShortcutHelp } from "./components/shortcut-help";
import { SliceButton } from "./components/SliceButton";
import { SliceProgress } from "./components/SliceProgress";
import { SliceStatsPanel } from "./panels/SliceStatsPanel";
import { TransformPanelHost } from "./components/dock/TransformPanelHost";
import { PrinterPicker } from "./components/PrinterPicker";
import { PrintJobDialog } from "./dialogs/PrintJobDialog";
import { useShortcuts } from "./hooks/useShortcuts";
import { DockLayer } from "./components/dock/dock-layer";
import { DockPanel } from "./components/dock/dock-panel";
import { useDock } from "./state/dock";
import { useScene } from "./state/scene";
import { useUi } from "./state/ui";
import { useI18n } from "./state/i18n";
import { usePlates } from "./state/plates";
import { useWorkspaceView, type WorkspaceViewId } from "./state/workspace-view";
import { executeRegistryOperation } from "./state/operation-registry";
import { usePrinters } from "./state/printers";
import { useChatConversations } from "./state/chat-conversations";
import { useProjectScope } from "./state/project-scope";
import { activePlate as activePlateOf } from "./state/plates-core";
import { CATALOG_MACHINES } from "./profile/operatorProfile";
import { useViewport } from "./state/viewport";
import { isTauriRuntime } from "./bridge/project-provider";
import { DevicePanelMonitor } from "./panels/DevicePanel";
import { WorkbenchLivePanel } from "./panels/WorkbenchLivePanel";
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
  const workspaceView = useWorkspaceView((s) => s.view);
  useShortcuts(scene, workspaceView === "prepare");

  // S9.18-001 — single shared navigation entry. The nav buttons and the
  // future AI tool frontend both invoke the EXACT same registry handler
  // (executeRegistryOperation → workspace.navigate), so a tool-driven switch
  // is observable-identical to a pointer tab click. The registry
  // closed-validates and reads LIVE store state on every call — it never
  // mutates project scope, conversation identity or the scene.
  const goWorkspace = useCallback((view: WorkspaceViewId) => {
    return executeRegistryOperation({ id: "workspace.navigate", args: { view } });
  }, []);
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
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const syncSidebar = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    media.addEventListener("change", syncSidebar);
    return () => media.removeEventListener("change", syncSidebar);
  }, []);
  const visibleSidebarView = sidebarView;
  const chatPanelMode = useDock((s) => s.panels.chat.mode);

  const devicePanelMode = useDock((s) => s.panels.device.mode);
  const previousDevicePanelMode = useRef(devicePanelMode);
  useEffect(() => {
    if (devicePanelMode === "floating" && previousDevicePanelMode.current !== "floating") {
      void goWorkspace("workbench");
      useDock.getState().setPanelMode("device", "collapsed");
    }
    previousDevicePanelMode.current = devicePanelMode;
  }, [devicePanelMode]);

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
  const activeProjectIdRef = useRef<string | null>(null);
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
        if (action === "recover") {
          await queryClient.cancelQueries({ queryKey: QUERY_KEY });
          queryClient.setQueryData(QUERY_KEY, await createRealProjectBridge(invoke, snapshot));
        }
        setSelectedProjectId(snapshot.project.id);
        activeProjectIdRef.current = snapshot.project.id;
        // S9.17-004 NAV-05: entering a project activates its chat scope.
        // Synchronous + snapshot-derived (NOT the async scene query, so a
        // stale-cache scene for a PREVIOUS project can never re-write the
        // scope back to the wrong project). Page-tab switches
        // (setWorkspaceView) never touch the chat scope on purpose — the
        // active conversation persists across all four pages.
        useChatConversations.getState().enterProjectScope(snapshot.project.id);
        useProjectScope.getState().setScope(snapshot.project.id, snapshot.project.name ?? null);
        useScene
          .getState()
          .hydrate(sceneObjectsFromProjectSnapshot(snapshot.project.id, snapshot.project.objects));
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
        // View switch only — the chat scope was already entered above and the
        // registry handler never touches it.
        void goWorkspace("prepare");
        await refreshHome();
      } catch (error) {
        setHomeError(error instanceof Error ? error.message : String(error));
      } finally {
        setHomeBusy(false);
      }
    },
    [localProjects, queryClient, refreshHome, selectedProjectId, t],
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
      void goWorkspace("preview");
      setIrError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setPreviewIr(null);
      setIrError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onNativeSliced = useCallback(
    (
      projectId: string | null,
      document: IrDocument,
      artifactId: string,
      sourceRevision: number,
    ) => {
      if (projectId !== activeProjectIdRef.current) return;
      setPreviewIr(document);
      setPreviewArtifactId(artifactId);
      setPreviewSourceRevision(sourceRevision);
      setMode(document.mode);
      setIrError(null);
      if (useWorkspaceView.getState().view === "prepare") {
        void goWorkspace("preview");
      }
    },
    [],
  );

  // S9.17-004 — Workbench live artifact → Preview. The slice backend already
  // STRICTLY parsed the IR (live-job.ts); the App re-checks the ACTIVE
  // project scope (current state id, never a stale ref) and bumps the load
  // sequence so the new document wins over any in-flight read. PreviewIr,
  // artifact id and source revision are written in one atomic state batch.
  const handleLiveArtifactOpen = useCallback(
    (payload: {
      projectId: string;
      artifactId: string;
      sourceRevision: number;
      ir: IrDocument;
    }) => {
      if (useProjectScope.getState().projectId !== payload.projectId) return;
      loadSeq.current += 1;
      setPreviewIr(payload.ir);
      setPreviewArtifactId(payload.artifactId);
      setPreviewSourceRevision(payload.sourceRevision);
      setMode(payload.ir.mode);
      setIrError(null);
      void goWorkspace("preview");
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
      data-workspace-view={workspaceView}
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
              void goWorkspace("home");
              void refreshHome();
            }}
          >
            {t("app.tab.home")}
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "prepare"}
            onClick={() => void goWorkspace("prepare")}
          >
            {t("app.tab.prepare")}
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "preview"}
            onClick={() => void goWorkspace("preview")}
          >
            {t("app.tab.preview")}
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "workbench"}
            onClick={() => void goWorkspace("workbench")}
          >
            {t("app.tab.workbench")}
          </button>
        </nav>
        <div className="header-slice-action" hidden={workspaceView !== "prepare"}>
          <SliceButton
            objects={objects}
            revision={Math.max(scene?.revision ?? 0, projectRevision)}
            slicingMode={mode}
            projectId={activeProjectIdRef.current}
            providerMode={provider?.mode ?? "unavailable"}
            machineName={operatorProfile.displayName}
            buildVolume={selectedMachine?.buildVolume ?? operatorProfile.buildVolume}
            onSliced={onNativeSliced}
          />
        </div>
        <PrinterPicker />
        {workspaceView !== "workbench" ? (
          <button
            type="button"
            className="device-panel-toggle"
            aria-label={t("device.button.aria")}
            title={t("device.button.title")}
            data-testid="device-panel-toggle"
            onClick={() => void goWorkspace("workbench")}
          >
            <span className="device-panel-toggle-label">{t("device.panel.title")}</span>
            {deviceTitle ? (
              <span className="device-panel-toggle-ctx" data-testid="device-panel-toggle-ctx">
                {deviceTitle}
              </span>
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          className="header-chat-toggle"
          aria-label={t("app.chat.open")}
          title={t("app.chat.open")}
          onClick={() => {
            setSidebarView("settings");
            useDock.getState().focusPanel("chat");
            useDock.getState().setPanelMode("chat", "floating");
          }}
        >
          <Icon name="chat" size={16} />
        </button>
        {workspaceView === "prepare" || workspaceView === "preview" ? (
          <button
            type="button"
            className="sidebar-toggle"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((current) => !current)}
          >
            {t(workspaceView === "preview" ? "app.tab.preview" : "app.sidebarToggle")}
          </button>
        ) : null}
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
        {workspaceView === "prepare" ? <DirtyChip /> : null}
        <ToastViewport />
        {workspaceView === "prepare" ? (
          <details className="shortcut-help-popover" data-testid="shortcut-help-toggle">
            <summary aria-label={t("app.shortcutHelp.aria")} title={t("app.shortcutHelp.title")}>
              ?
            </summary>
            <ShortcutHelp />
          </details>
        ) : null}
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
                  disabled={
                    homeBusy ||
                    (provider?.mode === "demo"
                      ? !scene
                      : !localBackendAvailable || !selectedProjectId)
                  }
                  onClick={() => {
                    if (provider?.mode === "demo") {
                      void goWorkspace("prepare");
                    } else {
                      void activateProject("continue");
                    }
                  }}
                >
                  <Icon name="folder" size={16} />
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
              {provider?.mode === "demo" && scene ? (
                <ul className="home-project-list">
                  <li>
                    <div className="home-project-copy">
                      <strong>{t("app.bridgeState.demo")}</strong>
                      <span>{t("home.demoMode")}</span>
                    </div>
                    <button
                      type="button"
                      data-testid="home-demo-prepare"
                      onClick={() => {
                        setSidebarView("objects");
                        void goWorkspace("prepare");
                      }}
                    >
                      <Icon name="cube" size={16} />
                      {t("app.tab.prepare")}
                    </button>
                  </li>
                </ul>
              ) : localProjects.length ? (
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
        <section
          className="workbench-page"
          hidden={workspaceView !== "workbench"}
          aria-label={t("device.panel.title")}
        >
          {/* S9.17-004 Workbench Live — telemetry/camera/artifact views on top,
              the existing read-only device monitor below. The panel is gated
              on the active page + active project, and only routes a preview
              after a project-scoped strict IR parse (handleLiveArtifactOpen). */}
          <WorkbenchLivePanel
            active={workspaceView === "workbench"}
            projectId={activeProjectIdRef.current}
            onOpenPreview={handleLiveArtifactOpen}
          />
          <DevicePanelMonitor />
        </section>
        <div
          className="editor-workspace"
          hidden={workspaceView === "home" || workspaceView === "workbench"}
        >
          <aside className="panel-left">
            <nav className="sidebar-nav" aria-label={t("app.sidebarNav.aria")}>
              {(workspaceView === "prepare"
                ? ([
                    ["settings", "app.view.settings"],
                    ["objects", "app.view.objects"],
                    ["chat", "app.view.chat"],
                  ] as const)
                : sidebarView === "chat"
                  ? ([["chat", "app.view.chat"]] as const)
                  : ([] as const)
              ).map(([view, key]) => (
                <button
                  type="button"
                  key={view}
                  aria-pressed={visibleSidebarView === view}
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
                  setSidebarView("settings");
                  useDock.getState().focusPanel("chat");
                  useDock.getState().setPanelMode("chat", "floating");
                }}
              >
                ⇱
              </button>
            </nav>
            {workspaceView === "prepare" && sidebarView === "settings" ? (
              <SettingsPanel profile={operatorProfile} onProfileChange={setOperatorProfile} />
            ) : null}
            {workspaceView === "prepare" && sidebarView === "objects" ? (
              <>
                <ObjectTree scene={scene} onOpenImport={() => setImportOpen(true)} />
                <ObjectSettingsPanel scene={scene} />
                <BooleanToolPanel scene={scene} />
              </>
            ) : null}{" "}
            {visibleSidebarView === "chat" && chatPanelMode === "docked" ? <ChatPanelLazy /> : null}
            <section className="panel-section" aria-label={t("app.ir.aria")}>
              <header className="panel-title">
                {workspaceView === "preview" ? t("app.tab.preview") : t("app.ir.title")}
              </header>
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
            {workspaceView === "preview" && !preview && !irError ? (
              <section className="preview-empty" data-testid="preview-empty" role="status">
                <strong>{t("app.preview.empty.title")}</strong>
                <span>{t("app.preview.empty.message")}</span>
                <button
                  type="button"
                  aria-label={t("app.preview.empty.prepare")}
                  title={t("app.preview.empty.prepare")}
                  onClick={() => void goWorkspace("prepare")}
                >
                  <Icon name="cube" />
                  {t("app.preview.empty.prepare")}
                </button>
              </section>
            ) : null}
            {workspaceView === "prepare" ? <PlateTabs scene={scene} objects={objects} /> : null}
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
              workspaceMode={workspaceView === "preview" ? "preview" : "prepare"}
              preview={workspaceView === "preview" ? preview : null}
              buildVolume={operatorProfile.buildVolume ?? undefined}
            />
          </section>
        </div>
      </main>

      <div className="workspace-footer-divider" hidden={workspaceView !== "prepare"}>
        <PanelDivider
          axis="horizontal"
          size={bottomSize}
          minSize={90}
          maxSize={420}
          onSizeChange={setBottomSize}
        />
      </div>
      <footer
        className="app-footer"
        hidden={workspaceView === "home" || workspaceView === "workbench"}
      >
        <PrinterStatusBar enabled={workspaceView === "prepare" || workspaceView === "preview"} />
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
        {/* S9.17-003 SimSend: the print-job dialog is mounted ONLY in demo
            mode and is explicitly declared simulation-only — approved cards
            simulate, they never send a real printer command. */}
        {provider?.mode === "demo" ? <PrintJobDialog simulationOnly /> : null}
        {workspaceView === "prepare" ? (
          <Timeline
            scene={scene}
            mode={mode}
            onModeChange={onModeChange}
            operatorProfile={operatorProfile}
            eligibility={eligibility}
            modeLockReason={modeLockReason}
          />
        ) : null}
      </footer>
      <ContextMenu />
      <DockLayer
        scope={workspaceView === "home" || workspaceView === "workbench" ? "window" : "canvas"}
      >
        <DockPanel
          onDock={() => {
            setSidebarView("chat");
            void goWorkspace("prepare");
          }}
        />
        {workspaceView === "prepare" ? <TransformPanelHost scene={scene} /> : null}
      </DockLayer>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} scene={scene} />
    </div>
  );
}
