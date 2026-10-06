import { useI18n } from "../state/i18n";
import { usePlates } from "../state/plates";
import { useToolbar } from "../state/toolbar";
import { Icon } from "../components/icons";
import type { BuildVolume } from "../bridge/types";
import { FRAME_SELECTED_EVENT } from "../state/shortcuts-core";
import { VIEW_PRESET_EVENT } from "./Toolbar";

/**
 * P1-5 — compact plate identity + quick-action rail (DOM, top-right inside
 * the viewport frame — NOT raycast 3D buttons).
 *
 * Shows the ACTIVE plate ordinal + name (identity without an inline input:
 * rename happens via double-click in the PlateTabs chip), the build-volume
 * specs from the active profile (same source the plate-heading row shows),
 * and three one-click actions:
 *  - fit view (F / FRAME_SELECTED_EVENT — identical to the toolbar button),
 *  - top view (numpad 2 preset — identical to the view cube),
 *  - reference grid toggle (shared with the toolbar snap/grid flag so both
 *    controls stay in sync, active state reflects `useToolbar.grid`).
 *
 * No new state: it reads the same stores as Toolbar/PlateTabs so the UI can
 * never drift out of sync. Icons inherit currentColor (1.5 stroke set).
 */

interface PlateRailProps {
  readonly volume?: BuildVolume;
}

export function PlateRail({ volume }: PlateRailProps) {
  const t = useI18n((s) => s.t);
  const plates = usePlates((s) => s.plates);
  const activeId = usePlates((s) => s.activeId);
  const grid = useToolbar((s) => s.grid);
  const toggleFlag = useToolbar((s) => s.toggleFlag);

  const ordinal = plates.findIndex((p) => p.id === activeId) + 1;
  const activePlate = plates.find((p) => p.id === activeId) ?? plates[0];

  const onFit = () => {
    window.dispatchEvent(new CustomEvent(FRAME_SELECTED_EVENT));
  };
  const onTop = () => {
    window.dispatchEvent(
      new CustomEvent(VIEW_PRESET_EVENT, { detail: { preset: "top" as const } }),
    );
  };

  const specs =
    volume && Number.isFinite(volume.widthMm) && volume.widthMm > 0
      ? t("plate.specifications", {
          w: String(volume.widthMm),
          d: String(volume.depthMm),
          h: String(volume.heightMm),
        })
      : null;

  return (
    <div
      className="plate-rail"
      data-testid="plate-rail"
      role="toolbar"
      aria-label={t("plate.rail.aria")}
    >
      <span
        className="plate-rail-id"
        data-testid="plate-rail-number"
        title={t("plate.number.title", { n: String(ordinal), name: activePlate?.name ?? "" })}
      >
        <span className="plate-rail-ordinal" aria-hidden>
          {String(ordinal)}
        </span>
        <span className="plate-rail-name">{activePlate?.name ?? ""}</span>
      </span>

      {specs ? (
        <span className="plate-rail-specs" data-testid="plate-rail-specs">
          {specs}
        </span>
      ) : null}

      <span className="plate-rail-actions" role="group" aria-label={t("plate.rail.aria")}>
        <button
          type="button"
          className="toolbar-btn"
          aria-label={t("plate.rail.fit")}
          title={t("plate.rail.fit")}
          data-testid="plate-rail-fit"
          onClick={onFit}
        >
          <Icon name="fit" size={16} />
        </button>
        <button
          type="button"
          className="toolbar-btn"
          aria-label={t("plate.rail.top")}
          title={t("plate.rail.top")}
          data-testid="plate-rail-top"
          onClick={onTop}
        >
          <Icon name="eye" size={16} />
        </button>
        <button
          type="button"
          className={`toolbar-btn toolbar-toggle${grid ? " is-active" : ""}`}
          aria-pressed={grid}
          aria-label={t("plate.rail.grid")}
          title={t("plate.rail.grid")}
          data-testid="plate-rail-grid"
          onClick={() => toggleFlag("grid")}
        >
          <Icon name="grid" size={16} />
        </button>
      </span>
    </div>
  );
}
