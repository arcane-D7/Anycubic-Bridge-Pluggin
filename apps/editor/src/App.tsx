import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { fetchSceneSnapshot } from "./bridge/mock";
import type { IrDocument } from "./bridge/ir";
import { parseIrDocument } from "./bridge/ir";
import type { SlicingMode } from "./contract";
import { PanelDivider } from "./layout/PanelDivider";
import { ChatPanel } from "./panels/ChatPanel";
import { ObjectTree } from "./panels/ObjectTree";
import { Timeline } from "./panels/Timeline";
import { SettingsPanel } from "./panels/SettingsPanel";
import { buildPreviewModel } from "./viewport/preview-model";
import type { PreviewModel } from "./viewport/preview-model";
import { Viewport } from "./viewport/Viewport";
import { resolveNonPlanarEligibility } from "./profile/capabilities";
import { useOperatorProfile } from "./profile/useOperatorProfile";
import { ThemeToggle } from "./components/theme-toggle";

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

export function App() {
  const sceneQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchSceneSnapshot,
    staleTime: 30_000,
  });
  const scene = sceneQuery.data;

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
          </nav>
          <div hidden={sidebarView !== "settings"}>
            <SettingsPanel profile={operatorProfile} onProfileChange={setOperatorProfile} />
          </div>
          {sidebarView === "objects" ? <ObjectTree scene={scene} /> : null}
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
          <div className="plate-heading">
            <strong>Plate 01</strong>
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
    </div>
  );
}
