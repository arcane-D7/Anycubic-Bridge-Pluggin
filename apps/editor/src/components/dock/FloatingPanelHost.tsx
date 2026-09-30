import {
  useCallback,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useDock, type PanelId } from "../../state/dock";
import { useDockDrag } from "./use-dock";

/**
 * FloatingPanelHost (S9.1a-002/004) — renders a floating panel's content.
 *
 * The outer element is Radix `Dialog.Content` (`modal={false}`, wired in
 * `dock-panel.tsx`) so the panel behaves as a NON-MODAL dialog: `role="dialog"`,
 * Esc → onOpenChange(false) → collapse-to-pill, focus management, NO body
 * scroll-lock and NO focus trap (events outside the rect still reach the R3F
 * canvas — Consultor §3.1).
 *
 * Owns the drag (useDockDrag, ref-based + rAF), the SE resize handle, the
 * header chrome (title + dock/collapse) and the a11y extras added in
 * S9.1a-004: soft Tab trap (only while focus is inside), Alt+Shift+arrows
 * move the panel, visible focus ring via CSS. Position comes from the dock
 * store (viewport fractions); the drag applies a translate3d and commits
 * fractions on drag-stop.
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

const MOVE_STEP = 0.05; // viewport fraction per Alt+Shift+arrow press

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
    (e: ReactPointerEvent, which: string) => {
      if (which === "se") {
        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = panel.rect;
        // Track the resized rect in a closure so `up` commits the final
        // (not the stale store) value.
        let cur = { ...startRect };
        setInlineRect({ w: startRect.w, h: startRect.h });

        const move = (ev: PointerEvent) => {
          const dw = (ev.clientX - startX) / window.innerWidth;
          const dh = (ev.clientY - startY) / window.innerHeight;
          cur = { ...startRect, w: startRect.w + dw, h: startRect.h + dh };
          setInlineRect({ w: cur.w, h: cur.h });
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          setPanelRect(id, cur);
          setInlineRect(null);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }
    },
    [id, panel.rect, setPanelRect],
  );

  /** Soft focus trap: only wraps Tab while focus is inside the panel. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Alt+Shift+arrows move the panel (S9.1a-004 AC-2).
      if (e.altKey && e.shiftKey) {
        let dx = 0;
        let dy = 0;
        switch (e.key) {
          case "ArrowLeft":
            dx = -MOVE_STEP;
            break;
          case "ArrowRight":
            dx = MOVE_STEP;
            break;
          case "ArrowUp":
            dy = -MOVE_STEP;
            break;
          case "ArrowDown":
            dy = MOVE_STEP;
            break;
          default:
            break;
        }
        if (dx !== 0 || dy !== 0) {
          e.preventDefault();
          const r = useDock.getState().panels[id].rect;
          setPanelRect(id, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
          return;
        }
      }

      // Soft Tab trap (only active while focus is inside this panel).
      if (e.key === "Tab") {
        const el = e.currentTarget as HTMLElement;
        const focusables = Array.from(
          el.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((n) => n.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || active === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [id, setPanelRect],
  );

  return (
    <DialogPrimitive.Content
      ref={bindElement}
      className="floating-panel-host data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-200"
      data-panel={id}
      data-testid={`floating-panel-${id}`}
      style={{
        position: "fixed",
        left: `${panel.rect.x * 100}%`,
        top: `${panel.rect.y * 100}%`,
        width: `${(inlineRect?.w ?? panel.rect.w) * 100}%`,
        height: `${(inlineRect?.h ?? panel.rect.h) * 100}%`,
        // Ladder: baseline --z-panel (40) + focus-bumps keep us in the panel band (< dialog 50 / toast 60).
        zIndex: `calc(var(--z-panel) + ${panel.z - 1})`,
      }}
      // Drag uses setPointerCapture: Radix modal={false} fires pointerdown-
      // outside as soon as the pointer is captured, which would collapse the
      // panel the moment you grab the header. Pointer-based interaction is
      // owned by the drag/resize handlers, so dismiss stays Esc/API-only.
      onPointerDownOutside={(e) => e.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onFocusCapture={() => focusPanel(id)}
      onKeyDown={handleKeyDown}
    >
      <div className="floating-header" data-drag>
        <DialogPrimitive.Title className="floating-title" title={title}>
          {title}
        </DialogPrimitive.Title>
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
      <div className="floating-body">
        {children}
        <DialogPrimitive.Description className="sr-only">
          Floating {title} panel
        </DialogPrimitive.Description>
      </div>
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
    </DialogPrimitive.Content>
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
