import { useEffect, useRef } from "react";
import { useDock, type PanelId } from "../../state/dock";

/**
 * use-dock (S9.1a-002) — ref-based drag with rAF-throttled DOM transform and
 * zustand commit on drag-stop only. No re-render storm:
 *   - during drag: px offsets applied as a `translate3d` on the panel element
 *     (pure DOM, zero React renders).
 *   - on drag-stop: final viewport-fraction rect committed to the dock store
 *     (persists + re-renders subscribers once).
 */

export interface DockDragHandlers {
  onPointerDown: (e: {
    pointerId: number;
    clientX: number;
    clientY: number;
    target: EventTarget | null;
  }) => void;
}

export function useDockDrag(id: PanelId) {
  const setPanelRect = useDock((s) => s.setPanelRect);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const elRef = useRef<HTMLElement | null>(null);

  /** Anchor the drag: element must already be positioned via store rect. */
  function onPointerDown(e: {
    pointerId: number;
    clientX: number;
    clientY: number;
    target: EventTarget | null;
  }) {
    const el = elRef.current;
    if (!el) return;
    // Only drag when grabbing the header bar itself, not its buttons
    // (dock/collapse) — setPointerCapture redirects pointerup+click to the
    // captured element, which would swallow button clicks.
    const target = e.target as HTMLElement | null;
    if (target && target.closest("button, a, input, textarea, select, [data-resize]")) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    el.setPointerCapture?.(e.pointerId);
  }

  function bindElement(el: HTMLElement | null) {
    elRef.current = el;
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const start = startRef.current;
      const el = elRef.current;
      if (!start || !el) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      });
    }
    function onUp() {
      const start = startRef.current;
      const el = elRef.current;
      if (!start || !el) return;
      const viewport = el.closest(".viewport-host");
      const base = viewport?.getBoundingClientRect() ?? document.body.getBoundingClientRect();
      const vw = Math.max(1, base.width);
      const vh = Math.max(1, base.height);
      const abs = el.getBoundingClientRect();
      const rect = useDock.getState().panels[id].rect;
      setPanelRect(id, {
        x: (abs.left - base.left) / vw,
        y: (abs.top - base.top) / vh,
        w: rect.w,
        h: rect.h,
      });
      el.style.transform = "";
      startRef.current = null;
    }
    const onCancel = () => {
      const el = elRef.current;
      if (el) el.style.transform = "";
      startRef.current = null;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [id, setPanelRect]);

  return { onPointerDown, bindElement };
}
