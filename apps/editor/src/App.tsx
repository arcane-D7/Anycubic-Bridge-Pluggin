import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { fetchSceneSnapshot } from "./bridge/mock";
import type { SlicingMode } from "./contract";
import { PanelDivider } from "./layout/PanelDivider";
import { ChatPanel } from "./panels/ChatPanel";
import { ObjectTree } from "./panels/ObjectTree";
import { Timeline } from "./panels/Timeline";
import { Viewport } from "./viewport/Viewport";

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

export function App() {
  const queryClient = useQueryClient();
  const sceneQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchSceneSnapshot,
    staleTime: 30_000,
  });
  const scene = sceneQuery.data;

  const [mode, setMode] = useState<SlicingMode>("standard");
  const [leftSize, setLeftSize] = useState(280);
  const [rightSize, setRightSize] = useState(300);
  const [bottomSize, setBottomSize] = useState(180);

  const onModeChange = useCallback(
    (m: SlicingMode) => {
      setMode(m);
      // Mode is persisted per project in R2; here we just surface the selection.
      void queryClient.getQueryData(QUERY_KEY);
    },
    [queryClient],
  );

  return (
    <div
      className="app-shell"
      style={
        {
          "--left-panel-size": `${leftSize}px`,
          "--right-panel-size": `${rightSize}px`,
          "--bottom-panel-size": `${bottomSize}px`,
        } as React.CSSProperties
      }
    >
      <header className="app-header">
        <span className="app-brand">Anycubic Bridge Editor</span>
        <span className="app-sub" data-testid="bridge-state">
          {sceneQuery.isFetching
            ? "bridge: loading…"
            : scene
              ? "bridge: connected"
              : "bridge: unavailable"}
        </span>
      </header>

      <main className="app-main">
        <aside className="panel-left">
          <ObjectTree scene={scene} />
        </aside>
        <PanelDivider
          axis="vertical"
          ariaLabel="Resize object tree panel"
          size={leftSize}
          minSize={180}
          maxSize={520}
          onSizeChange={setLeftSize}
        />
        <section className="viewport-host" aria-label="3D viewport">
          <Viewport scene={scene} />
        </section>{" "}
        <PanelDivider
          axis="vertical"
          ariaLabel="Resize chat panel"
          size={rightSize}
          minSize={180}
          maxSize={560}
          onSizeChange={setRightSize}
        />
        <aside className="panel-right">
          <ChatPanel />
        </aside>
      </main>

      <PanelDivider
        axis="horizontal"
        size={bottomSize}
        minSize={120}
        maxSize={420}
        onSizeChange={setBottomSize}
      />
      <footer className="app-footer">
        <Timeline scene={scene} mode={mode} onModeChange={onModeChange} />
      </footer>
    </div>
  );
}
