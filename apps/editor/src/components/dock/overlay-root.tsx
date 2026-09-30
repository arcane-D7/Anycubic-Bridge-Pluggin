import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Overlay root (S9.1a-001) — single top-level portal target for ALL floating
 * chrome (floating dock panels). Lives OUTSIDE the app shell so the viewport
 * stacking context (`isolation: isolate` on .viewport-frame) never captures it.
 *
 * Global `pointer-events: none` on the root wrapper; floating panels opt back
 * in with `pointer-events: auto` on their own rect. This lets the R3F canvas
 * (gizmo, OrbitControls) keep receiving events anywhere the panel isn't.
 */

export const OVERLAY_ROOT_ID = "overlay-root";

let overlayRootEl: HTMLElement | null = null;

/** Lazily create and cache the `#overlay-root` element (idempotent). */
export function ensureOverlayRoot(): HTMLElement {
  if (overlayRootEl && overlayRootEl.isConnected) return overlayRootEl;
  let el = document.getElementById(OVERLAY_ROOT_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ROOT_ID;
    document.body.appendChild(el);
  }
  overlayRootEl = el;
  return overlayRootEl;
}

interface OverlayRootProps {
  readonly children?: ReactNode;
}

/**
 * Mounted once in App; renders a pointer-events:none wrapper div with negative
 * z-index so ALL floating chrome layered above it still receives events where
 * the panel rect is (panels set pointer-events:auto themselves).
 */
export function OverlayRoot({ children }: OverlayRootProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = ensureOverlayRoot();
    setHost(el);
  }, []);

  if (!host) return null;

  return createPortal(
    <div className="overlay-root" data-testid="overlay-root" style={{ pointerEvents: "none" }}>
      {children}
    </div>,
    host,
  );
}
