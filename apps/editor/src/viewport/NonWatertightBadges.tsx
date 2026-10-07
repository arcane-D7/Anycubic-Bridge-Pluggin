import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";
import { useI18n } from "../state/i18n";
import { Icon } from "../components/icons";

/**
 * S9.7-003 (G46) — viewport repair affordance. Objects that are NOT watertight
 * get a compact frame-corner trigger with a count badge; clicking it opens a
 * popover listing each offending object — one click = Auto-repair (replace in
 * place); the tree context menu still offers replace-as-copy. Purely additive
 * — never blocks selection/rendering, so the e2e object count is unaffected.
 *
 * 2026-10-07 layout fix: the old corner chip (`.viewport-repair-badges`
 * top-left, max-width 88px, overflow-x:auto) clipped its chip UNDER the
 * floating toolbar — elementFromPoint returned the toolbar's active button,
 * so the chip was effectively unclickable ("the modal that cannot be clicked"
 * the user hit). Repair is now a compact trigger + popover pinned to the
 * frame's top-left (the slot the old strip freed, outside the centered toolbar
 * whose right edge slides under the top-right plate rail): always clickable,
 * never covering another control. */
export function NonWatertightBadges({ bridge }: { readonly bridge: BridgeHandle | undefined }) {
  const t = useI18n((s) => s.t);
  const queryClient = useQueryClient();
  const objects = useScene((s) => s.objects);
  const pushToast = useUi((s) => s.pushToast);
  const bad = objects.filter((o) => !o.watertight);

  const onRepair = async (name: string) => {
    if (!bridge) return;
    try {
      const res = await bridge.repair({ name, mode: "replace" });
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      if (!res.ok) {
        pushToast({ kind: "error", title: t("objectTree.toast.repair.title"), message: res.error });
        return;
      }
      pushToast({
        kind: "success",
        title: t("objectTree.toast.repair.title"),
        message: t("objectTree.toast.repair.watertight", { name, target: "" }),
      });
    } catch (err) {
      console.warn("[viewport] repair failed", err);
      pushToast({
        kind: "error",
        title: t("objectTree.toast.repair.title"),
        message: t("objectTree.toast.repair.bridgeError"),
      });
    }
  };

  // Zero bad objects → nothing to render at all (the toolbar shows no repair
  // entry, matching the old behavior where the corner chip simply vanished).
  if (bad.length === 0) return null;

  return (
    <details className="repair-control-wrap" data-testid="repair-control">
      <summary
        className="toolbar-btn toolbar-toggle"
        aria-label={t("viewport.repairLabel")}
        title={t("objectTree.repair.title")}
      >
        <Icon name="wrench" size={18} />
        <span className="repair-badge" data-testid="repair-count" aria-hidden="true">
          {bad.length}
        </span>
      </summary>
      <div className="repair-popover" role="list" aria-label={t("viewport.repairLabel")}>
        <header className="repair-popover-head">
          <span className="repair-popover-title">{t("viewport.repairLabel")}</span>
        </header>
        {bad.map((o) => (
          <button
            key={o.name}
            type="button"
            className="repair-item"
            role="listitem"
            data-testid={`repair-item-${o.name}`}
            title={t("objectTree.repair.title")}
            onClick={() => void onRepair(o.name)}
          >
            <Icon name="wrench" size={12} />
            {o.name}
          </button>
        ))}
      </div>
    </details>
  );
}
