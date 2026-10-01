import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSceneSnapshot } from "./bridge/mock";
import type { IrDocument } from "./bridge/ir";
import { parseIrDocument } from "./bridge/ir";
import type { SlicingMode } from "./contract";
import { PanelDivider } from "./layout/PanelDivider";
import { ChatPanel } from "./panels/ChatPanel";
import { ImportDialog } from "./panels/ImportDialog";
import { ObjectTree } from "./panels/ObjectTree";
import { TransformInspector } from "./panels/TransformInspector";
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
import { ToastViewport } from "./components/toast-viewport";
import { ShortcutHelp } from "./components/shortcut-help";
import { SliceButton } from "./components/SliceButton";
import { SliceProgress } from "./components/SliceProgress";
import { SliceStatsPanel } from "./panels/SliceStatsPanel";
import { PrinterPicker } from "./components/PrinterPicker";
import { useShortcuts } from "./hooks/useShortcuts";
import { OverlayRoot } from "./components/dock/overlay-root";
import { DockPanel } from "./components/dock/dock-panel";
import { useDock } from "./state/dock";
import { useScene } from "./state/scene";
import { useUi } from "./state/ui";
import { usePlates } from "./state/plates";
import { activePlate as activePlateOf } from "./state/plates-core";

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
const MAX_IR_FILE_BYTES = 20 * 1024 * 1024;

/** Single demo toast on boot so the bus is visibly alive (S9.1-005 AC). */
function useDemoToast() {
  const pushToast = useUi((s) => s.pushToast);
  useEffect(() => {
    const t = window.setTimeout(() => {
      pushToast({
        kind: "info",
        title: "Ready",
        message: "Liquid-glass shell initialized.",
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [pushToast]);
}

export function App() {
  useDemoToast();
  const sceneQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchSceneSnapshot,
    staleTime: 30_000,
  });
  const scene = sceneQuery.data;

  // S9.3-003: global keyboard shortcut layer (G32). One keydown listener owns
  // the whole map (G/R/S grabs, X/Y/Z axis constrain, Enter/Esc, Q/W/E/R tools,
  // F frame, Delete/Ctrl+D, Ctrl+Z/Y soft journal) — decisions in the pure
  // `shortcuts-core`, actions here against the stores + bridge mutation lane.
  useShortcuts(scene);

  // S9.2-004: hydrate the scene store from the authoritative snapshot. The
  // ObjectTree/SceneObjectModel consume the store, so the snapshot must flow
  // into it exactly once per fetch — selection is cleared on hydrate.
  const hydrate = useScene((s) => s.hydrate);
  useEffect(() => {
    if (!scene) return;
    hydrate(scene.objects);
  }, [scene, hydrate]);

  const [operatorProfile, setOperatorProfile] = useOperatorProfile();
  const eligibility = useMemo(
    () => resolveNonPlanarEligibility(scene?.capabilities, operatorProfile),
    [scene?.capabilities, operatorProfile],
  );

  const [mode, setMode] = useState<SlicingMode>("standard");
  const [leftSize, setLeftSize] = useState(330);
  const [bottomSize, setBottomSize] = useState(116);
  const [sidebarView, setSidebarView] = useState<"settings" | "objects" | "chat">("settings");
  const [workspaceView, setWorkspaceView] = useState<"prepare" | "preview">("prepare");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // S9.4-003 — plate membership from the scene store (authoritative snapshot)
  // + active plate name from the plate store (drives per-plate filter label).
  const objects = useScene((s) => s.objects);
  const activePlateName = usePlates((s) => activePlateOf(s).name);
  // S9.2-005: import dialog (footer Add entry point).
  const [importOpen, setImportOpen] = useState(false);
  const [previewIr, setPreviewIr] = useState<IrDocument | null>(null);
  const [irError, setIrError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const preview = useMemo<PreviewModel | null>(
    () => (previewIr ? buildPreviewModel(previewIr) : null),
    [previewIr],
  );

  const onIrFile = useCallback(async (file: File) => {
    const seq = ++loadSeq.current;
    if (file.size > MAX_IR_FILE_BYTES) {
      setPreviewIr(null);
      setIrError(`"${file.name}" is larger than the 20 MB IR limit and was not read.`);
      return;
    }
    try {
      const text = await file.text();
      if (seq !== loadSeq.current) return;
      const parsed: unknown = JSON.parse(text);
      if (seq !== loadSeq.current) return;
      const document = parseIrDocument(parsed);
      setPreviewIr(document);
      setMode(document.mode);
      setWorkspaceView("preview");
      setIrError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setPreviewIr(null);
      setIrError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onIrClear = useCallback(() => {
    loadSeq.current += 1;
    setPreviewIr(null);
    setIrError(null);
  }, []);

  const onModeChange = useCallback(
    (m: SlicingMode) => {
      if (previewIr && previewIr.mode !== m) {
        setIrError(
          `Mode switch rejected — the loaded preview is "${previewIr.mode}". Clear it before switching the slicing mode.`,
        );
        return;
      }
      setMode(m);
    },
    [previewIr],
  );

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
        <span className="app-brand">Anycubic Bridge Editor</span>
        <nav className="workspace-tabs" aria-label="Workspace view">
          <button
            type="button"
            aria-pressed={workspaceView === "prepare"}
            onClick={() => setWorkspaceView("prepare")}
          >
            Prepare
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "preview"}
            disabled={!preview}
            onClick={() => setWorkspaceView("preview")}
          >
            Preview
          </button>
        </nav>
        <SliceButton objects={objects} />
        <PrinterPicker />
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((current) => !current)}
        >
          Settings
        </button>
        <span className="app-sub" data-testid="bridge-state">
          {sceneQuery.isFetching
            ? "bridge: loading…"
            : scene
              ? "Demo geometry"
              : "bridge: unavailable"}
        </span>
        <details className="shortcut-help-popover" data-testid="shortcut-help-toggle">
          <summary aria-label="Keyboard shortcuts help" title="Keyboard shortcuts">
            ?
          </summary>
          <ShortcutHelp />
        </details>
        <ThemeToggle />
      </header>

      <main className="app-main">
        <aside className="panel-left">
          <nav className="sidebar-nav" aria-label="Sidebar view">
            {(["settings", "objects", "chat"] as const).map((view) => (
              <button
                type="button"
                key={view}
                aria-pressed={sidebarView === view}
                onClick={() => setSidebarView(view)}
              >
                {view}
              </button>
            ))}
            <button
              type="button"
              className="sidebar-detach"
              title="Detach chat to floating panel"
              aria-label="Detach chat"
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
              <TransformInspector scene={scene} />
            </>
          ) : null}{" "}
          {sidebarView === "chat" ? <ChatPanel /> : null}
          <section className="panel-section" aria-label="IR preview loader">
            <header className="panel-title">IR preview</header>
            <div className="panel-body">
              <label className="ir-file-label" htmlFor="ir-file-input">
                Load IR document (JSON)
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
                Clear preview
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
                    ? `Loaded ${preview.layerCount} layer${preview.layerCount === 1 ? "" : "s"} · mode: ${preview.mode}`
                    : "No IR document loaded."}
              </p>
            </div>
          </section>
        </aside>
        <PanelDivider
          axis="vertical"
          ariaLabel="Resize settings panel"
          size={leftSize}
          minSize={180}
          maxSize={520}
          onSizeChange={setLeftSize}
        />
        <section className="viewport-host" aria-label="3D viewport">
          <PlateTabs scene={scene} objects={objects} />
          <div className="plate-heading">
            <strong data-testid="plate-heading-name">{activePlateName}</strong>
            <span>{operatorProfile.displayName || "Select a printer"}</span>
            <span data-testid="viewport-volume">
              {operatorProfile.buildVolume
                ? `${operatorProfile.buildVolume.widthMm} x ${operatorProfile.buildVolume.depthMm} x ${operatorProfile.buildVolume.heightMm} mm`
                : "Demo plate"}
            </span>
          </div>
          <Viewport
            scene={scene}
            preview={workspaceView === "preview" ? preview : null}
            buildVolume={operatorProfile.buildVolume ?? undefined}
          />
        </section>
      </main>

      <PanelDivider
        axis="horizontal"
        size={bottomSize}
        minSize={90}
        maxSize={420}
        onSizeChange={setBottomSize}
      />
      <footer className="app-footer">
        <StatusBar scene={scene} buildVolume={operatorProfile.buildVolume ?? undefined} />
        <SliceProgress />
        <SliceStatsPanel />
        <Timeline
          scene={scene}
          mode={mode}
          onModeChange={onModeChange}
          operatorProfile={operatorProfile}
          eligibility={eligibility}
          modeLockReason={
            previewIr
              ? `Loaded preview pins the slicing mode (${previewIr.mode}) — clear it to change.`
              : undefined
          }
        />
      </footer>
      <ToastViewport />
      <OverlayRoot>
        <DockPanel />
      </OverlayRoot>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} scene={scene} />
    </div>
  );
}
