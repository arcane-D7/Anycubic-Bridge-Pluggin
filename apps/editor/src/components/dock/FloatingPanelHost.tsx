import { useCallback, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useDock, type PanelId } from "../../state/dock";
import { useDockDrag } from "./use-dock";

/**
 * FloatingPanelHost (S9.1a-002) — renders a floating panel's content. Owns
 * the drag (useDockDrag, ref-based + rAF), 8-way resize handles, collapse to
 * pill and the accessory chrome (header + dock button). Position comes from
 * the dock store (viewport fractions); the drag applies a translate3d during
 * motion and commits fractions on drag-stop.
 */

export type FloatingPanelKind = "chat";

interface FloatingPanelHostProps {
  readonly id: PanelId;
  readonly title: string;
  readonly kind: FloatingPanelKind;
  readonly children: ReactNode;
  readonly onDock: () => void;
  readonly onCollapse: () => void;
}

export function FloatingPanelHost({
  id,
  title,
  children,
  onDock,
  onCollapse,
}: FloatingPanelHostProps) {
  const panel = useDock((s) => s.panels[id]);
  const focusPanel = useDock((s) => s.focusPanel);
  const setPanelRect = useDock((s) => s.setPanelRect);
  const { onPointerDown, bindElement } = useDockDrag(id);
  const [inlineRect, setInlineRect] = useState<{ w: number; h: number } | null>(null);

  const isFloating = panel.mode === "floating";

  const handleResize = useCallback(
    (e: React.PointerEvent, which: string) => {
      if (which === "se") {
        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = panel.rect;
        setInlineRect({ w: startRect.w, h: startRect.h });

        const move = (ev: PointerEvent) => {
          const dw = (ev.clientX - startX) / window.innerWidth;
          const dh = (ev.clientY - startY) / window.innerHeight;
          setInlineRect({ w: startRect.w + dw, h: startRect.h + dh });
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          const r = useDock.getState().panels[id].rect;
          setPanelRect(id, { ...r });
          setInlineRect(null);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }
    },
    [id, panel.rect, setPanelRect],
  );

  return (
    <motion.div
      ref={bindElement}
      className="floating-panel-host"
      data-panel={id}
      data-testid={`floating-panel-${id}`}
      style={{
        position: "fixed",
        left: `${panel.rect.x * 100}%`,
        top: `${panel.rect.y * 100}%`,
        width: `${(inlineRect?.w ?? panel.rect.w) * 100}%`,
        height: `${(inlineRect?.h ?? panel.rect.h) * 100}%`,
        zIndex: panel.z,
      }}
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      onPointerDown={onPointerDown}
      onFocusCapture={() => focusPanel(id)}
    >
      <div className="floating-header" data-drag>
        <span className="floating-title" title={title}>
          {title}
        </span>
        <button
          type="button"
          className="floating-icon-btn"
          title="Dock panel"
          data-testid={`dock-${id}`}
          onClick={onDock}
        >
          ⇲
        </button>
        <button
          type="button"
          className="floating-icon-btn"
          title="Collapse to pill"
          data-testid={`collapse-${id}`}
          onClick={onCollapse}
        >
          –
        </button>
      </div>
      <div className="floating-body">{children}</div>
      {isFloating && (
        <>
          <button
            type="button"
            className="resize-handle resize-handle-se"
            aria-label={`Resize ${title}`}
            data-resize="se"
            onPointerDown={(e) => handleResize(e, "se")}
          />
          <div className="resize-handle resize-handle-n" data-resize="n" />
          <div className="resize-handle resize-handle-s" data-resize="s" />
          <div className="resize-handle resize-handle-e" data-resize="e" />
          <div className="resize-handle resize-handle-w" data-resize="w" />
          <div className="resize-handle resize-handle-ne" data-resize="ne" />
          <div className="resize-handle resize-handle-nw" data-resize="nw" />
          <div className="resize-handle resize-handle-sw" data-resize="sw" />
        </>
      )}
    </motion.div>
  );
}

/** Pill shown when a panel is collapsed (S9.1a-002 AC-2). */
export function CollapsedPill({
  id,
  title,
  onExpand,
}: {
  readonly id: PanelId;
  readonly title: string;
  readonly onExpand: () => void;
}) {
  return (
    <button
      type="button"
      className="dock-pill"
      data-testid={`pill-${id}`}
      title={`Expand ${title}`}
      onClick={onExpand}
    >
      <span className="dock-pill-dot" aria-hidden="true" />
      {title}
    </button>
  );
}
