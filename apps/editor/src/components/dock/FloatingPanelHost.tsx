import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useDock, type PanelId } from "../../state/dock";
import { useI18n } from "../../state/i18n";
import { useDockDrag } from "./use-dock";
import { useDockRail, useViewportDockRoot } from "./dock-layer";

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
 * header chrome (title + dock/collapse) and Alt+Shift+arrows
 * move the panel, visible focus ring via CSS. Position comes from the dock
 * store (viewport fractions); the drag applies a translate3d and commits
 * fractions on drag-stop.
 *
 * Focus-return (chat panels): Radix non-modal dialogs close with
 * `event.preventDefault()` and rely on `triggerRef` for focus restore — we
 * render no `Dialog.Trigger`, so the default would drop focus to <body>.
 * `onOpenAutoFocus` fires BEFORE Radix moves focus into the panel, so the
 * opener (pointer or keyboard trigger) is captured there; `onCloseAutoFocus`
 * restores it if it is still connected/visible/interactive, else falls back
 * to the always-visible global `.header-chat-toggle`. Device/transform panels
 * (`kind !== "chat"`) keep Radix's default close behavior untouched.
 */

export type FloatingPanelKind = "chat" | "device" | "transform";

interface FloatingPanelHostProps {
  readonly id: PanelId;
  readonly title: string;
  readonly kind: FloatingPanelKind;
  readonly children: ReactNode;
  readonly onDock: () => void;
  readonly onCollapse: () => void;
  /** Optional right-side header node (S9.6-006: conversation quick-switch Popover). */
  readonly headerExtra?: ReactNode;
}

const MOVE_STEP = 0.05; // viewport fraction per Alt+Shift+arrow press

/** A focus target is restorable when it is still mounted, paints (zero client
 *  rects ⇒ display:none/[hidden] ancestor) and is not a disabled control.
 *  <body> is never restorable: it is the browser's default fallback (e.g. the
 *  collapsed pill we opened from is unmounted the instant the panel mounts, so
 *  onOpenAutoFocus may capture BODY) — BODY must fall through to the global
 *  header chat toggle. */
function isRestorableFocusTarget(el: Element | null, ownerDocument: Document): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (el === ownerDocument.body) return false;
  if (el.getClientRects().length === 0) return false;
  if (el instanceof HTMLButtonElement && el.disabled) return false;
  if (el instanceof HTMLInputElement && el.disabled) return false;
  return true;
}

export function FloatingPanelHost({
  id,
  title,
  kind,
  children,
  onDock,
  onCollapse,
  headerExtra,
}: FloatingPanelHostProps) {
  const t = useI18n((s) => s.t);
  const panel = useDock((s) => s.panels[id]);
  const focusPanel = useDock((s) => s.focusPanel);
  const setPanelRect = useDock((s) => s.setPanelRect);
  const { onPointerDown, bindElement } = useDockDrag(id);
  const [inlineRect, setInlineRect] = useState<{ w: number; h: number } | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Chat panels (S9.18-003 follow-up): the opener focused at open time, to be
  // restored when Escape collapses the panel. Captured in onOpenAutoFocus so
  // it runs before Radix's autofocus moves focus inside the dialog.
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocusOnClose = kind === "chat";

  // Panels use the root provided by DockLayer as their fraction reference.
  const dockRoot = useViewportDockRoot();
  const portalTarget = typeof document !== "undefined" && dockRoot ? dockRoot : undefined;

  const isFloating = panel.mode === "floating";

  const handleResize = useCallback(
    (e: ReactPointerEvent, which: string) => {
      if (which === "se") {
        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = panel.rect;
        const base =
          dockRoot?.getBoundingClientRect() ?? document.documentElement.getBoundingClientRect();
        const vw = Math.max(1, base.width);
        const vh = Math.max(1, base.height);
        // Track the resized rect in a closure so `up` commits the final
        // (not the stale store) value.
        let cur = { ...startRect };
        setInlineRect({ w: startRect.w, h: startRect.h });

        const move = (ev: PointerEvent) => {
          const dw = (ev.clientX - startX) / vw;
          const dh = (ev.clientY - startY) / vh;
          cur = { ...startRect, w: startRect.w + dw, h: startRect.h + dh };
          setInlineRect({ w: cur.w, h: cur.h });
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          resizeCleanupRef.current = null;
          setPanelRect(id, cur);
          setInlineRect(null);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        resizeCleanupRef.current = up;
      }
    },
    [dockRoot, id, panel.rect, setPanelRect],
  );

  useEffect(() => () => resizeCleanupRef.current?.(), []);

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
    },
    [id, setPanelRect],
  );

  return (
    <DialogPrimitive.Portal container={portalTarget}>
      <DialogPrimitive.Content
        ref={bindElement}
        className="floating-panel-host data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-200"
        data-panel={id}
        data-testid={`floating-panel-${id}`}
        style={{
          position: "absolute",
          left: `${panel.rect.x * 100}%`,
          top: `${panel.rect.y * 100}%`,
          width: `${(inlineRect?.w ?? panel.rect.w) * 100}%`,
          height: `${(inlineRect?.h ?? panel.rect.h) * 100}%`,
          // Ladder: baseline --z-panel (40) + focus-bumps keep us in the panel band (< dialog 50 / toast 60).
          zIndex: `calc(var(--z-panel) + ${panel.z - 1})`,
          pointerEvents: "auto",
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
        onOpenAutoFocus={(_event) => {
          // Radix runs this before focusing the first tabbable inside the
          // panel, so the trigger that opened the panel is still the focused
          // element here — save it and allow the default autofocus.
          if (restoreFocusOnClose) {
            const active = document.activeElement;
            openerRef.current = active instanceof HTMLElement ? active : null;
          }
        }}
        onCloseAutoFocus={(event) => {
          // Radix non-modal close always ends with preventDefault() and only
          // restores via triggerRef (none mounted): without this, Escape would
          // drop focus to <body>. Restore the captured opener when it is still
          // usable, else the always-visible global header chat toggle.
          if (!restoreFocusOnClose) return; // device/transform: Radix default
          event.preventDefault();
          const opener = openerRef.current;
          if (isRestorableFocusTarget(opener, document)) {
            opener.focus();
            return;
          }
          const header = document.querySelector<HTMLElement>(".header-chat-toggle");
          if (isRestorableFocusTarget(header, document)) header.focus();
        }}
      >
        <div className="floating-header" data-drag>
          <DialogPrimitive.Title className="floating-title" title={title}>
            {title}
          </DialogPrimitive.Title>
          {headerExtra}
          <button
            type="button"
            className="floating-icon-btn"
            aria-label={t("dock.dockTitle")}
            title={t("dock.dockTitle")}
            data-testid={`dock-${id}`}
            onClick={onDock}
          >
            ⇲
          </button>
          <button
            type="button"
            className="floating-icon-btn"
            aria-label={t("dock.collapseTitle")}
            title={t("dock.collapseTitle")}
            data-testid={`collapse-${id}`}
            onClick={onCollapse}
          >
            –
          </button>
        </div>
        <div className="floating-body">
          {children}
          <DialogPrimitive.Description className="sr-only">
            {t("dock.floatingDesc", { title })}
          </DialogPrimitive.Description>
        </div>
        {isFloating && (
          <>
            <button
              type="button"
              className="resize-handle resize-handle-se"
              aria-label={t("dock.resizeTitle", { title })}
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
    </DialogPrimitive.Portal>
  );
}

/** Pill shown when a panel is collapsed (S9.1a-002 AC-2). Since 2026-10-06,
 *  the pill portals into the CANVAS rail (.dock-rail, bottom-left of the
 *  frame) — no more window-anchored pills over the header/footer. */
export function CollapsedPill({
  id,
  title,
  onExpand,
}: {
  readonly id: PanelId;
  readonly title: string;
  readonly onExpand: () => void;
}) {
  const t = useI18n((s) => s.t);
  const rail = useDockRail();
  const pill = (
    <button
      type="button"
      className="dock-pill"
      aria-label={t("dock.expandTitle", { title })}
      data-testid={`pill-${id}`}
      title={t("dock.expandTitle", { title })}
      onClick={onExpand}
    >
      <span className="dock-pill-dot" aria-hidden="true" />
      {title}
    </button>
  );
  // When the rail isn't ready (first paint / tests), fall back to rendering
  // inline so the pill still works as the overlay fallback.
  return rail ? createPortal(pill, rail) : pill;
}
