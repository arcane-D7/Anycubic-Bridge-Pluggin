import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useDock } from "../../state/dock";
import { useI18n } from "../../state/i18n";
import { FloatingPanelHost, CollapsedPill } from "./FloatingPanelHost";
import { DevicePanelMonitor } from "../../panels/DevicePanel";

/**
 * DevicePanelHost (S9.9-004) — the printer "Device" panel's dock/float
 * orchestrator, mirroring DockPanel (S9.1a-003) for the chat panel:
 *   - mode "floating": non-modal Radix Dialog hosting FloatingPanelHost
 *     with the DevicePanelMonitor content.
 *   - mode "collapsed": pill at the docked edge; click re-opens floating.
 *   - mode "docked": the host renders a docked strip variant here.
 *
 * A11y mirrors the chat panel (modal={false}, Esc collapses, no body lock).
 */
export function DevicePanelHost() {
  const t = useI18n((s) => s.t);
  const panel = useDock((s) => s.panels.device);
  const setPanelMode = useDock((s) => s.setPanelMode);
  const focusPanel = useDock((s) => s.focusPanel);

  const dock = () => setPanelMode("device", "docked");
  const collapse = () => setPanelMode("device", "collapsed");
  const expand = () => {
    focusPanel("device");
    setPanelMode("device", "floating");
  };
  const panelTitle = t("device.panel.title");

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
          id="device"
          title={panelTitle}
          kind="device"
          onDock={dock}
          onCollapse={collapse}
        >
          <DevicePanelMonitor />
        </FloatingPanelHost>
      </DialogPrimitive.Root>
      {panel.mode === "collapsed" && (
        <CollapsedPill id="device" title={panelTitle} onExpand={expand} />
      )}
    </>
  );
}
