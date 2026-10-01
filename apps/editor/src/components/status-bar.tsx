import type { BuildVolume, SceneSnapshot } from "@/bridge/types";
import { useViewport } from "@/state/viewport";
import { useUi } from "@/state/ui";

/**
 * Status bar (S9.1-005) — 28px strip above the timeline, mono tabular-nums.
 * Fields: object count, units, build volume, snapshot revision.
 * S9.3-002 (AC-3): a pending transform-inspector draft surfaces as a dirty
 * kinds chip (position|rotation|scale) scoped to the object being edited.
 */

interface StatusBarProps {
  readonly scene: SceneSnapshot | undefined;
  readonly buildVolume: BuildVolume | undefined;
}

export function StatusBar({ scene, buildVolume: volume }: StatusBarProps) {
  const revision = useViewport((s) => s.revision);
  const dirtyTransformName = useUi((s) => s.dirtyTransformName);
  const dirtyKinds = useUi((s) => s.dirtyKinds);
  const objects = scene?.objects ?? [];

  return (
    <div className="status-bar" data-testid="status-bar">
      <span className="status-item" data-testid="status-objects">
        {objects.length} object{objects.length === 1 ? "" : "s"}
      </span>
      <span className="status-sep" aria-hidden="true">
        ·
      </span>
      <span className="status-item mono-num" data-testid="status-units">
        mm
      </span>
      <span className="status-sep" aria-hidden="true">
        ·
      </span>
      <span className="status-item mono-num" data-testid="status-volume">
        {volume ? `${volume.widthMm}×${volume.depthMm}×${volume.heightMm}` : "—"}
      </span>
      <span className="status-sep" aria-hidden="true">
        ·
      </span>
      <span className="status-item mono-num" data-testid="status-revision">
        rev {revision}
      </span>
      {dirtyTransformName && dirtyKinds && dirtyKinds.length > 0 ? (
        <>
          <span className="status-sep" aria-hidden="true">
            ·
          </span>
          <span
            className="status-item status-dirty"
            data-testid="status-dirty"
            title={`${dirtyTransformName}: uncommitted ${dirtyKinds.join(", ")} edit`}
          >
            {dirtyTransformName}: {dirtyKinds.join(",")}
          </span>
        </>
      ) : null}
    </div>
  );
}
