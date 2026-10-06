import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useDock } from "../../state/dock";
import { useI18n } from "../../state/i18n";
import { FloatingPanelHost, CollapsedPill } from "./FloatingPanelHost";
import { TransformInspector } from "../../panels/TransformInspector";
import type { BridgeHandle } from "../../bridge/mock";

/**
 * TransformPanelHost (P1-6) — the numeric transform inspector rehosted as a
 * floating viewport panel (Consultor: it belongs next to the object, not
 * buried under the object tree in the sidebar).
 *
 * Mirrors DevicePanelHost: floating via non-modal Radix Dialog + pill when
 * collapsed. The Toolbar's "transform" button opens it; panel content is the
 * existing TransformInspector (same bridge lane, same tests) wrapped in a
 * compact shell.
 */
interface TransformPanelHostProps {
  readonly scene: BridgeHandle | undefined;
}

export function TransformPanelHost({ scene }: TransformPanelHostProps) {
  const t = useI18n((s) => s.t);
  const panel = useDock((s) => s.panels.transform);
  const setPanelMode = useDock((s) => s.setPanelMode);
  const focusPanel = useDock((s) => s.focusPanel);

  const dock = () => setPanelMode("transform", "docked");
  const collapse = () => setPanelMode("transform", "collapsed");
  const expand = () => {
    focusPanel("transform");
    setPanelMode("transform", "floating");
  };
  const panelTitle = t("transform.panel.title");

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
          id="transform"
          title={panelTitle}
          kind="transform"
          onDock={dock}
          onCollapse={collapse}
        >
          <div className="transform-floating-body">
            <TransformInspector scene={scene} />
          </div>
        </FloatingPanelHost>
      </DialogPrimitive.Root>
      {panel.mode === "collapsed" && (
        <CollapsedPill id="transform" title={panelTitle} onExpand={expand} />
      )}
    </>
  );
}
