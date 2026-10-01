import type { BuildVolume, SceneSnapshot } from "@/bridge/types";
import { useViewport } from "@/state/viewport";
import { useUi } from "@/state/ui";
import { useScene } from "@/state/scene";
import { useActivePlate, usePlates } from "@/state/plates";
import { objectsOnPlate } from "@/state/plates-core";
import {
  formatCoords,
  formatPlateDims,
  plateBounds,
  positionOf,
  unsavedCount,
} from "@/state/statusbar-core";

/**
 * Status bar (S9.1-005) — 28px strip above the timeline, mono tabular-nums.
 * Fields: object count, units, build volume, snapshot revision.
 *
 * S9.3-002 (AC-3): a pending transform-inspector draft surfaces as a dirty
 * kinds chip (position|rotation|scale) scoped to the object being edited.
 *
 * S9.4-005: extended with selected-object coords (mono), current plate dims
 * (scene-space AABB of the ACTIVE plate's objects) and the revision + dirty
 * chip (`● N unsaved`, N = unsaved objects on the active plate).
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

  // S9.4-005 — live selection + plate members (scene store is authoritative;
  // the viewport filters with the same membership helper).
  const storeObjects = useScene((s) => s.objects);
  const selectedNames = useScene((s) => s.selectedNames);
  const anchorName = useScene((s) => s.anchorName);
  const active = useActivePlate();
  const activeId = usePlates((s) => s.activeId);
  const activeObjects = objectsOnPlate(storeObjects, activeId);
  const anchor =
    (anchorName && storeObjects.find((o) => o.name === anchorName)) ||
    (selectedNames.length === 1
      ? storeObjects.find((o) => o.name === selectedNames[0])
      : undefined);
  const bounds = plateBounds(activeObjects);
  const unsaved = unsavedCount(active.dirty, activeObjects, dirtyTransformName, storeObjects);

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
      {anchor ? (
        <>
          <span className="status-sep" aria-hidden="true">
            ·
          </span>
          <span
            className="status-item mono-num"
            data-testid="status-coords"
            title={`${anchor.name} position (mm)`}
          >
            {formatCoords(positionOf(anchor))}
          </span>
        </>
      ) : null}
      {activeObjects.length > 0 ? (
        <>
          <span className="status-sep" aria-hidden="true">
            ·
          </span>
          <span
            className="status-item mono-num"
            data-testid="status-plate-dims"
            title={`${active.name} scene bounds (mm)`}
          >
            {bounds ? formatPlateDims(bounds) : "—"}
          </span>
        </>
      ) : null}
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
      {!dirtyTransformName && unsaved > 0 ? (
        <>
          <span className="status-sep" aria-hidden="true">
            ·
          </span>
          <span
            className="status-item status-dirty"
            data-testid="status-dirty-chip"
            title={`${active.name}: ${unsaved} unsaved object${unsaved === 1 ? "" : "s"}`}
          >
            ● {unsaved} unsaved
          </span>
        </>
      ) : null}
    </div>
  );
}
