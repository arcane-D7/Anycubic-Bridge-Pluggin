import { useDock } from "../../state/dock";
import { FloatingPanelHost, CollapsedPill } from "./FloatingPanelHost";
import { ChatPanel } from "../../panels/ChatPanel";

/**
 * DockPanel (S9.1a-003) — the chat panel's dock/float orchestrator. Renders:
 *   - mode "floating": FloatingPanelHost portaled via OverlayRoot with the
 *     existing single-conversation ChatPanel as content.
 *   - mode "collapsed": pill at the docked edge; click re-opens floating.
 *   - mode "docked": renders nothing here (the sidebar chat tab owns it).
 */
export function DockPanel() {
  const panel = useDock((s) => s.panels.chat);
  const setPanelMode = useDock((s) => s.setPanelMode);
  const focusPanel = useDock((s) => s.focusPanel);

  const dock = () => setPanelMode("chat", "docked");
  const collapse = () => setPanelMode("chat", "collapsed");
  const expand = () => {
    focusPanel("chat");
    setPanelMode("chat", "floating");
  };

  if (panel.mode === "floating") {
    return (
      <FloatingPanelHost id="chat" title="AI Chat" kind="chat" onDock={dock} onCollapse={collapse}>
        <ChatPanel />
      </FloatingPanelHost>
    );
  }

  if (panel.mode === "collapsed") {
    return <CollapsedPill id="chat" title="AI Chat" onExpand={expand} />;
  }

  return null;
}
