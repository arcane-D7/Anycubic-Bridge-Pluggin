import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";
import { Icon } from "../components/icons";

/**
 * S9.7-003 (G46) — viewport repair affordance. Objects that are NOT watertight
 * get a passive badge chip pinned to the frame corner (AC-1: "repair action
 * available from tree row + viewport badge"). One click = Auto-repair
 * (replace in place); the tree context menu still offers replace-as-copy.
 * Purely additive — never blocks selection/rendering, so the e2e object count
 * is unaffected.
 */
export function NonWatertightBadges({ bridge }: { readonly bridge: BridgeHandle | undefined }) {
  const queryClient = useQueryClient();
  const objects = useScene((s) => s.objects);
  const pushToast = useUi((s) => s.pushToast);
  const bad = objects.filter((o) => !o.watertight);
  if (bad.length === 0) return null;

  const onClick = async (name: string) => {
    if (!bridge) return;
    try {
      const res = await bridge.repair({ name, mode: "replace" });
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      if (!res.ok) {
        pushToast({ kind: "error", title: "Auto-repair", message: res.error });
        return;
      }
      pushToast({
        kind: "success",
        title: "Auto-repair",
        message: `${name} is watertight.`,
      });
    } catch (err) {
      console.warn("[viewport] repair failed", err);
      pushToast({ kind: "error", title: "Auto-repair", message: "Bridge error during repair." });
    }
  };

  return (
    <div className="viewport-repair-badges" data-testid="viewport-repair-badges" role="status">
      <span className="viewport-repair-label">Needs repair:</span>
      {bad.map((o) => (
        <button
          key={o.name}
          type="button"
          className="viewport-repair-badge"
          data-testid={`viewport-repair-${o.name}`}
          title={`${o.name} is not watertight — click to Auto-repair`}
          onClick={() => void onClick(o.name)}
        >
          <Icon name="wrench" size={12} />
          {o.name}
        </button>
      ))}
    </div>
  );
}
