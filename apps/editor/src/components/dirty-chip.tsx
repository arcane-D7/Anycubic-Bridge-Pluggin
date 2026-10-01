import { useDirty } from "../state/dirty";
import { dirtyChip, lastCommitLabel } from "../state/dirty-core";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";
import { useViewport } from "../state/viewport";

/**
 * S9.8-004 (G44) — header dirty chip + save/restore.
 *
 * Mounted in the app header next to the bridge state. Shows:
 *   - `● N unsaved` — N = live revision delta vs the last SAVED point
 *     (derived live from the viewport store → the same source the status
 *     bar uses; reacts to every commit event);
 *   - last-commit time (mono HH:MM, "never" before the first save);
 *   - Save → persist the current scene to localStorage (gitignored by
 *     nature — never a filesystem path);
 *   - Restore → re-hydrate the scene store from the stored backup and
 *     rebase the saved revision (chip flips clean; an invalid/no backup
 *     surfaces a readable toast instead of a crash).
 */

export function DirtyChip() {
  const revision = useViewport((s) => s.revision);
  const savedRevision = useDirty((s) => s.savedRevision);
  const lastCommitTime = useDirty((s) => s.lastCommitTime);
  const save = useDirty((s) => s.save);
  const restore = useDirty((s) => s.restore);
  const hydrate = useScene((s) => s.hydrate);
  const pushToast = useUi((s) => s.pushToast);

  const chip = dirtyChip(revision, savedRevision, lastCommitTime);
  const commitLabel = lastCommitLabel(lastCommitTime);

  const onSave = () => {
    const objects = useScene.getState().objects;
    const res = save(objects);
    if (!res.ok) {
      pushToast({ kind: "error", title: "Save scene", message: res.error ?? "save failed" });
      return;
    }
    pushToast({ kind: "success", title: "Scene saved", message: "Scene persisted locally." });
  };

  const onRestore = () => {
    const res = restore(hydrate);
    if (!res.ok) {
      pushToast({ kind: "warning", title: "Restore scene", message: res.error ?? "no backup" });
      return;
    }
    pushToast({
      kind: "success",
      title: "Scene restored",
      message: `${res.restoredObjects.length} object${res.restoredObjects.length === 1 ? "" : "s"} restored from local backup.`,
    });
  };

  return (
    <span className="dirty-chip" data-testid="dirty-chip">
      <span className={chip.isDirty ? "dirty-dot" : "dirty-dot is-clean"} aria-hidden="true" />
      <span className="dirty-label" data-testid="dirty-label">
        {chip.isDirty ? `${chip.unsavedOps} unsaved` : "saved"}
      </span>
      <span className="dirty-time" data-testid="dirty-time" title="Last local commit">
        {commitLabel}
      </span>
      <button
        type="button"
        className="dirty-save"
        data-testid="dirty-save"
        aria-label="Save scene locally"
        title="Save scene locally"
        onClick={onSave}
      >
        save
      </button>
      <button
        type="button"
        className="dirty-restore"
        data-testid="dirty-restore"
        aria-label="Restore scene from local backup"
        title="Restore scene from local backup"
        disabled={savedRevision === 0}
        onClick={onRestore}
      >
        restore
      </button>
    </span>
  );
}
