import { useEffect } from "react";
import { useThree } from "@react-three/fiber";

/**
 * S9.8-006 — WebGL context-loss guard.
 *
 * The renderer can lose its GL context (driver reset, GPU hang, tab
 * backgrounding on some platforms). The browser only auto-restores a lost
 * context when every `webglcontextlost` listener calls `preventDefault()`;
 * three.js's WebGLRenderer already does this internally and re-initializes
 * the GL context on `webglcontextrestored` (see `onContextRestore` in
 * WebGLRenderer 0.186). Our listener also calls `preventDefault()` to keep
 * auto-recovery active even if plugin state ordering changes, and we force
 * `invalidate()` so the next frame re-uploads all GPU resources.
 *
 * This guard mounts INSIDE the Canvas so it can use `useThree()` (no DOM
 * plumbing, one re-render of the root only). Idle static cache is handled
 * by WebView2; this covers the animated scene.
 */
export function ContextLossGuard() {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    const canvas = gl.domElement;
    if (!canvas) return;

    const onLost = (e: Event) => {
      // Prevent the browser from auto-restoring a broken context: we want the
      // restore to go through our handler so we can re-init object state.
      e.preventDefault();
    };
    const onRestored = () => {
      // Three.js re-creates the context and re-initializes its GL state on the
      // next render; force a full redraw so GPU resources are re-uploaded.
      invalidate();
    };

    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [gl, invalidate]);

  return null;
}
