import { useEffect } from "react";
import type { BridgeHandle } from "../bridge/mock";
import { useScene } from "../state/scene";
import { useViewport } from "../state/viewport";
import { checkRendererSnapshotConsistency } from "../state/viewport-core";

/**
 * S7-004 renderer-vs-snapshot guard (pure rule in viewport-core:
 * `checkRendererSnapshotConsistency`). The native snapshot is AUTHORITATIVE —
 * a renderer that disagrees with it is a renderer BUG, and the editor must
 * surface it as an error rather than re-render a twin (never a silent merge).
 *
 * Component wiring: after each authoritative snapshot (revision > 0), compute
 * what the renderer ACTUALLY emitted and compare against the snapshot's
 * triangle count. On mismatch → `invalidate(reason)` (session invalidated,
 * re-import offered). The pure rule is unit-tested headless.
 */
export function RendererGuard({ scene }: { readonly scene: BridgeHandle | undefined }) {
  const revision = useViewport((s) => s.revision);
  const invalidate = useViewport((s) => s.invalidate);

  const snapshotTriangleCount = scene?.objects.reduce((acc, o) => acc + o.triangles, 0) ?? null;

  // S9.2-003: the renderer emits one triangle list per object — the scene
  // store owns the ACTUAL emitted count (real buffers, not unit boxes).
  const emittedTriangleCount = useScene((s) => s.objects.reduce((acc, o) => acc + o.triangles, 0));

  useEffect(() => {
    if (revision === 0 || snapshotTriangleCount === null) return;
    const mismatch = checkRendererSnapshotConsistency(emittedTriangleCount, snapshotTriangleCount);
    if (mismatch) {
      invalidate({ expected: mismatch.expected, actual: mismatch.actual });
    }
  }, [revision, snapshotTriangleCount, emittedTriangleCount, invalidate]);

  return null;
}
