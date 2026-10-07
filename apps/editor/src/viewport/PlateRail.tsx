import { useI18n } from "../state/i18n";
import { usePlates } from "../state/plates";
import { useToolbar } from "../state/toolbar";
import { Icon } from "../components/icons";
import type { BuildVolume, SceneObjectSnapshot } from "../bridge/types";
import { VIEW_PRESET_EVENT } from "./Toolbar";
import { PLATE_UPGRADE_KEYS, usePlateUpgrades } from "../state/plate-upgrades";
import { FIT_PLATE_EVENT } from "../state/camera-core";
import type { OperatorProfile } from "../profile/operatorProfile";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

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
  readonly profile: OperatorProfile;
  readonly objects: readonly SceneObjectSnapshot[];
}

export function PlateRail({ volume, profile, objects }: PlateRailProps) {
  const t = useI18n((s) => s.t);
  const plates = usePlates((s) => s.plates);
  const activeId = usePlates((s) => s.activeId);
  const grid = useToolbar((s) => s.grid);
  const toggleFlag = useToolbar((s) => s.toggleFlag);
  const platePei = usePlateUpgrades((s) => s.pei);
  const plateQuadrants = usePlateUpgrades((s) => s.quadrants);
  const plateHotend = usePlateUpgrades((s) => s.hotend);
  const plateZColumn = usePlateUpgrades((s) => s.zColumn);
  const toggleUpgrade = usePlateUpgrades((s) => s.toggleUpgrade);

  const ordinal = plates.findIndex((p) => p.id === activeId) + 1;
  const activePlate = plates.find((p) => p.id === activeId) ?? plates[0];

  const onFit = () => window.dispatchEvent(new CustomEvent(FIT_PLATE_EVENT));
  const onTop = () => {
    window.dispatchEvent(
      new CustomEvent(VIEW_PRESET_EVENT, { detail: { preset: "top" as const } }),
    );
  };

  const activeObjects = objects.filter((object) => (object.plateId ?? "plate-1") === activeId);
  const upgrades = {
    pei: platePei,
    quadrants: plateQuadrants,
    hotend: plateHotend,
    zColumn: plateZColumn,
  } as const;

  return (
    <div
      className="plate-rail"
      data-testid="plate-rail"
      role="toolbar"
      aria-label={t("plate.actions.aria")}
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
        {PLATE_UPGRADE_KEYS.map((key) => {
          const labelKey =
            key === "pei"
              ? "plate.upgrade.pei.aria"
              : key === "quadrants"
                ? "plate.upgrade.quadrants.aria"
                : key === "hotend"
                  ? "plate.upgrade.hotend.aria"
                  : "plate.upgrade.zColumn.aria";
          return (
            <button
              key={key}
              type="button"
              className={`toolbar-btn toolbar-toggle${upgrades[key] ? " is-active" : ""}`}
              aria-pressed={upgrades[key]}
              aria-label={t(labelKey)}
              title={t(labelKey)}
              data-testid={`plate-upgrade-${key}`}
              onClick={() => toggleUpgrade(key)}
            >
              <Icon name={key === "hotend" ? "printer" : "settings"} size={16} />
            </button>
          );
        })}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="toolbar-btn plate-info-trigger"
            aria-label={t("plate.info.aria")}
            title={t("plate.info.title")}
            data-testid="plate-info-trigger"
          >
            <span aria-hidden="true">i</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="plate-info-popover"
          data-testid="plate-info-popover"
        >
          <strong>{activePlate?.name ?? t("plate.info.unknown")}</strong>
          <dl>
            <div>
              <dt>{t("plate.info.profile")}</dt>
              <dd>{profile.displayName || t("plate.info.unknown")}</dd>
            </div>
            <div>
              <dt>{t("plate.info.source")}</dt>
              <dd>
                {profile.provenance === "operator-declared"
                  ? t("settings.source.operator")
                  : t("plate.info.source.unknown")}
              </dd>
            </div>
            <div>
              <dt>{t("plate.info.volume")}</dt>
              <dd>
                {volume && volume.widthMm > 0 && volume.depthMm > 0 && volume.heightMm > 0
                  ? t("plate.specifications", {
                      w: String(volume.widthMm),
                      d: String(volume.depthMm),
                      h: String(volume.heightMm),
                    })
                  : t("plate.info.unknown")}
              </dd>
            </div>
            <div>
              <dt>{t("plate.info.occupancy")}</dt>
              <dd>{t("plate.info.objectCount", { n: String(activeObjects.length) })}</dd>
            </div>
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  );
}
