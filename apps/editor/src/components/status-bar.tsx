import type { BuildVolume, SceneSnapshot } from "@/bridge/types";
import { useViewport } from "@/state/viewport";

/**
 * Status bar (S9.1-005) — 28px strip above the timeline, mono tabular-nums.
 * Fields: object count, units, build volume, snapshot revision.
 */

interface StatusBarProps {
  readonly scene: SceneSnapshot | undefined;
  readonly buildVolume: BuildVolume | undefined;
}

export function StatusBar({ scene, buildVolume: volume }: StatusBarProps) {
  const revision = useViewport((s) => s.revision);
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
    </div>
  );
}
