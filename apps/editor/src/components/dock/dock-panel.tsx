import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useDock } from "../../state/dock";
import { FloatingPanelHost, CollapsedPill } from "./FloatingPanelHost";
import { ConversationQuickSwitcher } from "./ConversationQuickSwitcher";
import { ChatPanel } from "../../panels/ChatPanel";

/**
 * DockPanel (S9.1a-003) — the chat panel's dock/float orchestrator. Renders:
 *   - mode "floating": non-modal Radix Dialog (S9.1a-004) hosting the
 *     FloatingPanelHost with the existing single-conversation ChatPanel.
 *   - mode "collapsed": pill at the docked edge; click re-opens floating.
 *   - mode "docked": renders nothing here (the sidebar chat tab owns it).
 *
 * A11y (S9.1a-004, Consultor §3.1): `modal={false}` — Esc fires
 * onOpenChange(false) → collapse-to-pill, no body scroll-lock, focus
 * management + role="dialog" from Radix without trapping focus.
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

  return (
    <>
      <DialogPrimitive.Root
        open={panel.mode === "floating"}
        onOpenChange={(open) => {
          if (!open) collapse();
        }}
        modal={false}
      >
        <FloatingPanelHost
          id="chat"
          title="AI Chat"
          kind="chat"
          onDock={dock}
          onCollapse={collapse}
          headerExtra={<ConversationQuickSwitcher />}
        >
          <ChatPanel />
        </FloatingPanelHost>
      </DialogPrimitive.Root>
      {panel.mode === "collapsed" && <CollapsedPill id="chat" title="AI Chat" onExpand={expand} />}
    </>
  );
}
