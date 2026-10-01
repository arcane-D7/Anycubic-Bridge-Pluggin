import { useDirty } from "../state/dirty";
import { dirtyChip, lastCommitLabel } from "../state/dirty-core";
import { useScene } from "../state/scene";
import { useI18n } from "../state/i18n";
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
  const t = useI18n((s) => s.t);
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
      pushToast({
        kind: "error",
        title: t("dirty.toast.saveError.title"),
        message: res.error ?? t("dirty.toast.saveError.message"),
      });
      return;
    }
    pushToast({
      kind: "success",
      title: t("dirty.toast.saved.title"),
      message: t("dirty.toast.saved.message"),
    });
  };

  const onRestore = () => {
    const res = restore(hydrate);
    if (!res.ok) {
      pushToast({
        kind: "warning",
        title: t("dirty.toast.restoreError.title"),
        message: res.error ?? t("dirty.toast.restoreError.message"),
      });
      return;
    }
    const n = res.restoredObjects.length;
    pushToast({
      kind: "success",
      title: t("dirty.toast.restored.title"),
      message: t("dirty.toast.restored.message", { n: String(n), s: n === 1 ? "" : "s" }),
    });
  };

  return (
    <span className="dirty-chip" data-testid="dirty-chip">
      <span className={chip.isDirty ? "dirty-dot" : "dirty-dot is-clean"} aria-hidden="true" />
      <span className="dirty-label" data-testid="dirty-label">
        {chip.isDirty ? t("dirty.unsaved", { n: String(chip.unsavedOps) }) : t("dirty.saved")}
      </span>
      <span className="dirty-time" data-testid="dirty-time" title={t("dirty.tooltip")}>
        {commitLabel}
      </span>
      <button
        type="button"
        className="dirty-save"
        data-testid="dirty-save"
        aria-label={t("dirty.save.aria")}
        title={t("dirty.save.title")}
        onClick={onSave}
      >
        {t("dirty.save.label")}
      </button>
      <button
        type="button"
        className="dirty-restore"
        data-testid="dirty-restore"
        aria-label={t("dirty.restore.aria")}
        title={t("dirty.restore.title")}
        disabled={savedRevision === 0}
        onClick={onRestore}
      >
        {t("dirty.restore.label")}
      </button>
    </span>
  );
}
