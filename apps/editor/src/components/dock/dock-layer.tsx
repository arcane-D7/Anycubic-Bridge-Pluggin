import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ensureOverlayRoot } from "./overlay-root";

/**
 * Dock layer (2026-10-06 layout fix, Consultor) — canvas-local by default,
 * with an optional window-sized surface for chrome available on Home.
 *
 * Root element `#viewport-dock-root` is rendered by `ViewportFrame` INSIDE
 * `.viewport-frame` (stable across Prepare/Preview, because the frame owns
 * the R3F surface). The layer is `position:absolute; inset:0;
 * pointer-events:none`; specific chrome opts back in with `pointer-events:
 * auto`. Panels and pills then position with fractions of THE CANVAS (not the
 * window) on canvas scope; window scope uses the viewport as its reference.
 *
 * A `.dock-rail` (bottom-left column) is rendered here; collapsed pills
 * portal themselves into it via `useDockRail`.
 */

export const VIEWPORT_DOCK_ROOT_ID = "viewport-dock-root";
export const WINDOW_DOCK_ROOT_ID = "window-dock-root";

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

function ensureWindowDockRoot(): HTMLElement {
  let el = document.getElementById(WINDOW_DOCK_ROOT_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = WINDOW_DOCK_ROOT_ID;
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      overflow: "clip",
      zIndex: "var(--z-panel)",
    });
    document.body.appendChild(el);
  }
  return el;
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
  readonly scope?: "canvas" | "window";
}

export function DockLayer({ children, scope = "canvas" }: DockLayerProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const refCallback = (el: HTMLDivElement | null) => setRailEl(el);

  useEffect(() => {
    // Resolve the canvas dock root; re-resolve whenever the DOM gains the
    // #viewport-dock-root (the ViewportFrame may mount after this component),
    // plus on resize (frame box changes).
    const tryResolve = () =>
      setHost(scope === "window" ? ensureWindowDockRoot() : ensureViewportDockRoot());
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
  }, [scope]);

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
