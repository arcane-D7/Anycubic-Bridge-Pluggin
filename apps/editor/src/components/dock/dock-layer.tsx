import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ensureOverlayRoot } from "./overlay-root";

/**
 * Viewport dock layer (2026-10-06 layout fix, Consultor) — the canvas-local
 * surface for ALL dock chrome (floating panels + collapsed pills).
 *
 * Root element `#viewport-dock-root` is rendered by `ViewportFrame` INSIDE
 * `.viewport-frame` (stable across Prepare/Preview, because the frame owns
 * the R3F surface). The layer is `position:absolute; inset:0;
 * pointer-events:none`; specific chrome opts back in with `pointer-events:
 * auto`. Panels and pills then position with fractions of THE CANVAS (not the
 * window) — the coordinate-reference fix for pills that floated over the
 * header/footer.
 *
 * A `.dock-rail` (bottom-left column) is rendered here; collapsed pills
 * portal themselves into it via `useDockRail`.
 */

export const VIEWPORT_DOCK_ROOT_ID = "viewport-dock-root";

/** Lazy canonical fallback for pre-mount states (tests/SSR/first paint):
 *  reuse the shared window overlay root as a transparent fallback host. */
function ensureFallbackRoot(): HTMLElement {
  return ensureOverlayRoot();
}

/** Canvas dock root when mounted, else the fallback overlay root. */
export function ensureViewportDockRoot(): HTMLElement {
  const el = document.getElementById(VIEWPORT_DOCK_ROOT_ID);
  return el?.isConnected ? el : ensureFallbackRoot();
}

/** The collapsed-pill rail container (bottom-left column) exposed via context. */
const DockRailContext = createContext<HTMLDivElement | null>(null);

export function useDockRail(): HTMLDivElement | null {
  return useContext(DockRailContext);
}

/** The canvas-local portal HOST (`#viewport-dock-root` or fallback overlay),
 *  exposed so floating panels can portal themselves into the frame. */
const DockRootContext = createContext<HTMLElement | null>(null);

export function useViewportDockRoot(): HTMLElement | null {
  return useContext(DockRootContext);
}

interface DockLayerProps {
  readonly children?: ReactNode;
}

export function DockLayer({ children }: DockLayerProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const refCallback = (el: HTMLDivElement | null) => setRailEl(el);

  useEffect(() => {
    // Resolve the canvas dock root; re-resolve whenever the DOM gains the
    // #viewport-dock-root (the ViewportFrame may mount after this component),
    // plus on resize (frame box changes).
    const tryResolve = () => setHost(ensureViewportDockRoot());
    tryResolve();
    const observer = new MutationObserver(tryResolve);
    observer.observe(document.body, { childList: true, subtree: true });
    const raf = requestAnimationFrame(tryResolve);
    window.addEventListener("resize", tryResolve, { passive: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", tryResolve);
    };
  }, []);

  if (!host) return null;

  return createPortal(
    <div
      className="viewport-dock-layer"
      data-testid="viewport-dock-layer"
      style={{ pointerEvents: "none" }}
    >
      <div className="dock-rail" data-testid="dock-rail" ref={refCallback} />
      <DockRootContext.Provider value={host}>
        <DockRailContext.Provider value={railEl}>{children}</DockRailContext.Provider>
      </DockRootContext.Provider>
    </div>,
    host,
  );
}
