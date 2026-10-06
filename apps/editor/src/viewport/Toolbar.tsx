import { FRAME_SELECTED_EVENT } from "../state/shortcuts-core";
import { useToolbar, type ViewPreset } from "../state/toolbar";
import { useUi, type ToolMode } from "../state/ui";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";
import { Icon, type IconName } from "../components/icons";
import { shortcutFor, shortcutLabel } from "../state/shortcuts";
import { usePlates } from "../state/plates";
import { objectsOnPlate } from "../state/plates-core";
import { useScene } from "../state/scene";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import { usePrinters } from "../state/printers";
import { useViewMode, effectiveViewMode, VIEW_MODES } from "../state/view-mode";

/**
 * S9.4-001 floating viewport toolbar (AC-1/AC-2).
 *
 * Glass fill-2 / blur-2 row floating top-center OVER the canvas (mounted inside
 * `.viewport-frame`, sibling of the R3F canvas so it never blocks 3D input
 * except where it visually sits). Hosts:
 * - tool modes Select/Move/Rotate/Scale → `useUi.setTool` (the S9.3-001 gizmo
 *   reacts; the S9.3-003 shortcut layer Q/W/E/R also drives this store).
 * - snap + grid toggles → `useToolbar` STATE ONLY in 9.4 (real snapping
 *   behavior lands 9.7); the `grid` flag also toggles BuildPlate grid lines.
 * - Arrange → S9.4-004: runs the bridge auto-arrange lane (cad-arrange shelf
 *   packing) over the ACTIVE plate's objects; re-commits their transforms and
 *   surfaces placements / overflow warnings as a toast.
 * - Fit view → F shortcut equivalent (FRAME_SELECTED_EVENT).
 * - View presets iso/top/front/right + numpad (S9.4-002 camera tween listener).
 *
 * Tooltips carry the matching shortcut labels (110ms via CSS transition delay;
 * `shorcutFor`/`shortcutLabel` from the shared registry so menus/toolbar/help
 * stay in sync).
 */

/** Custom DOM event the camera listener (S9.4-002 ViewCube/Viewport) watches. */
export const VIEW_PRESET_EVENT = "anycubic:viewport-preset";

const TOOLS: readonly {
  readonly mode: ToolMode;
  readonly icon: IconName;
  readonly labelKey: MsgKey;
}[] = [
  { mode: "select", icon: "snap", labelKey: "toolbar.tool.select" },
  { mode: "move", icon: "move", labelKey: "toolbar.tool.move" },
  { mode: "rotate", icon: "rotate", labelKey: "toolbar.tool.rotate" },
  { mode: "scale", icon: "scale", labelKey: "toolbar.tool.scale" },
  { mode: "measure", icon: "measure", labelKey: "toolbar.tool.measure" },
];

const PRESETS: readonly {
  readonly preset: ViewPreset;
  readonly labelKey: MsgKey;
  readonly key: string;
}[] = [
  { preset: "iso", labelKey: "toolbar.preset.isometric", key: "1" },
  { preset: "top", labelKey: "toolbar.preset.top", key: "2" },
  { preset: "front", labelKey: "toolbar.preset.front", key: "3" },
  { preset: "right", labelKey: "toolbar.preset.right", key: "4" },
];

interface ToolbarProps {
  readonly scene: BridgeHandle | undefined;
}

export function Toolbar({ scene }: ToolbarProps) {
  const t = useI18n((s) => s.t);
  const tool = useUi((s) => s.tool);
  const setTool = useUi((s) => s.setTool);
  const snap = useToolbar((s) => s.snap);
  const grid = useToolbar((s) => s.grid);
  const snapStep = useToolbar((s) => s.snapStep);
  const setSnapStep = useToolbar((s) => s.setSnapStep);
  const toggleFlag = useToolbar((s) => s.toggleFlag);
  const objectLabelsAlwaysOn = useUi((s) => s.objectLabelsAlwaysOn);
  const toggleObjectLabelsAlwaysOn = useUi((s) => s.toggleObjectLabelsAlwaysOn);
  const queryClient = useQueryClient();
  const pushToast = useUi((s) => s.pushToast);

  // S9.11-001 view mode: requested mode persisted per-context; live falls
  // back to slicer when the selected printer isn't reachable. Reachability
  // is tri-state (null = probing) — treat only `true` as reachable.
  const viewMode = useViewMode((s) => s.mode);
  const setViewMode = useViewMode((s) => s.setMode);
  const selectedPrinter = usePrinters((s) => s.printers.find((p) => p.id === s.selectedId));
  const liveReachable = selectedPrinter?.reachable === true;
  const effectiveMode = effectiveViewMode(viewMode, liveReachable);

  // S9.4-004 arrange target = the ACTIVE plate's objects (same filter as the
  // viewport render so the layout you see is the layout that arranges).
  const allObjects = useScene((s) => s.objects);
  const activePlateId = usePlates((s) => s.activeId);
  const dispatchPreset = (preset: ViewPreset) => {
    window.dispatchEvent(
      new CustomEvent<{ preset: ViewPreset }>(VIEW_PRESET_EVENT, { detail: { preset } }),
    );
  };

  const onArrange = useCallback(async () => {
    if (!scene) {
      pushToast({
        kind: "warning",
        title: t("toolbar.arrange.title"),
        message: t("toolbar.arrange.bridgeUnavailable"),
      });
      return;
    }
    const targets = objectsOnPlate(allObjects, activePlateId);
    if (targets.length === 0) {
      pushToast({
        kind: "info",
        title: t("toolbar.arrange.title"),
        message: t("toolbar.arrange.noObjects"),
      });
      return;
    }
    try {
      // Layout over the plate footprint from the machine profile contract —
      // never a hardcoded 220×220 (same rule as BuildPlate).
      const volume = scene.buildVolume;
      const res = await scene.arrange({
        plateW: volume?.widthMm,
        plateD: volume?.depthMm,
        gap: 2,
        center: true,
      });
      if (!res.ok) {
        pushToast({ kind: "error", title: t("toolbar.arrange.title"), message: res.error });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      const overflow = res.warnings.filter((w) => /does not fit|exceeds plate/.test(w));
      if (overflow.length > 0) {
        pushToast({
          kind: "warning",
          title: t("toolbar.arrange.overflowTitle"),
          message: t("toolbar.arrange.overflowMsg", {
            n: String(overflow.length),
            s: overflow.length === 1 ? "" : "s",
            first: overflow[0]?.split(" — ")[0] ?? "",
          }),
        });
      } else {
        pushToast({
          kind: "success",
          title: t("toolbar.arrange.title"),
          message: t("toolbar.arrange.successMsg", {
            n: String(res.placed.length),
            s: res.placed.length === 1 ? "" : "s",
          }),
        });
      }
    } catch (err) {
      console.warn("[toolbar] arrange failed", err);
      pushToast({
        kind: "error",
        title: t("toolbar.arrange.title"),
        message: t("toolbar.arrange.failed"),
      });
    }
  }, [scene, allObjects, activePlateId, pushToast, queryClient, t]);

  const onFit = () => {
    window.dispatchEvent(new CustomEvent(FRAME_SELECTED_EVENT));
  };

  const toolTip = (id: string) => {
    const entry = shortcutFor(id);
    return entry ? shortcutLabel(entry) : undefined;
  };

  return (
    <div
      className="viewport-toolbar"
      data-testid="viewport-toolbar"
      role="toolbar"
      aria-label={t("toolbar.aria")}
    >
      <div className="toolbar-group" role="group" aria-label={t("toolbar.group.transform.aria")}>
        {TOOLS.map(({ mode, icon, labelKey }) => {
          const label = t(labelKey);
          return (
            <button
              type="button"
              key={mode}
              className={`toolbar-btn${tool === mode ? " is-active" : ""}`}
              aria-pressed={tool === mode}
              aria-label={label}
              title={t("toolbar.tool.title", {
                label,
                shortcut: toolTip(mode === "measure" ? "measure.toggle" : `tool.${mode}`) ?? "",
              })}
              data-testid={`tool-${mode}`}
              onClick={() =>
                mode === "measure"
                  ? setTool(tool === "measure" ? "select" : "measure")
                  : setTool(mode)
              }
            >
              <Icon name={icon} size={18} />
              <span className="toolbar-btn-label">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="toolbar-group" role="group" aria-label={t("toolbar.group.view.aria")}>
        <button
          type="button"
          className={`toolbar-btn toolbar-toggle${snap ? " is-active" : ""}`}
          aria-pressed={snap}
          aria-label={t("toolbar.toggle.snap.aria")}
          title={t("toolbar.toggle.snap.title", { shortcut: toolTip("snap.toggle") ?? "" })}
          data-testid="toggle-snap"
          onClick={() => toggleFlag("snap")}
        >
          <Icon name="snap" size={18} />
        </button>
        <button
          type="button"
          className={`toolbar-btn toolbar-toggle${grid ? " is-active" : ""}`}
          aria-pressed={grid}
          aria-label={t("toolbar.toggle.grid.aria")}
          title={t("toolbar.toggle.grid.title", { shortcut: toolTip("grid.toggle") ?? "" })}
          data-testid="toggle-grid"
          onClick={() => toggleFlag("grid")}
        >
          <Icon name="grid" size={18} />
        </button>
        {/* S9.8-002 — object label chips always-on toggle (hover shows a
            chip per object; this forces them all visible). */}
        <button
          type="button"
          className={`toolbar-btn toolbar-toggle${objectLabelsAlwaysOn ? " is-active" : ""}`}
          aria-pressed={objectLabelsAlwaysOn}
          aria-label={t("toolbar.toggle.labels.aria")}
          title={t("toolbar.toggle.labels.title")}
          data-testid="toggle-labels"
          onClick={() => toggleObjectLabelsAlwaysOn()}
        >
          <Icon name="eye" size={18} />
        </button>
        {/* S9.7-002 AC-2 — snap step configurable from the toolbar: discrete
            number input, clamped 1..100 mm. Determinism guaranteed by the
            pure `snapValue` rounding used everywhere. */}
        <label className="toolbar-snap-step" title={t("toolbar.snapStep.title")}>
          <span className="visually-hidden">{t("toolbar.snapStep.srText")}</span>
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            data-testid="snap-step-input"
            value={snapStep}
            disabled={!snap}
            aria-label={t("toolbar.snapStep.aria")}
            onChange={(e) => setSnapStep(Number(e.currentTarget.value))}
          />
          <span className="snap-step-unit">mm</span>
        </label>
      </div>

      {/* S9.11-001 — view mode seg (mesh | slicer | live). Live requires a
          reachable printer; when it isn't, the seg still shows the request
          but the effective mode falls back to slicer (+ toolbar hint). */}
      <div className="toolbar-group" role="group" aria-label={t("toolbar.viewmode.aria")}>
        {VIEW_MODES.map((mode) => {
          const label = t(`toolbar.viewmode.${mode}`);
          const active = effectiveMode === mode;
          return (
            <button
              type="button"
              key={mode}
              className={`toolbar-btn${active ? " is-active" : ""}`}
              aria-pressed={active}
              aria-label={label}
              title={
                mode === "live"
                  ? t("toolbar.viewmode.live") +
                    (liveReachable ? "" : ` — ${t("toolbar.viewmode.fallback")}`)
                  : label
              }
              data-testid={`view-mode-${mode}`}
              onClick={() => setViewMode(mode)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="toolbar-group" role="group" aria-label={t("toolbar.group.scene.aria")}>
        <button
          type="button"
          className="toolbar-btn"
          aria-label={t("toolbar.arrange.aria")}
          title={t("toolbar.arrange.titleAttr")}
          data-testid="toolbar-arrange"
          onClick={onArrange}
        >
          <Icon name="arrange" size={18} />
        </button>
        <button
          type="button"
          className="toolbar-btn"
          aria-label={t("toolbar.fit.aria")}
          title={t("toolbar.fit.title", { shortcut: toolTip("view.fit") ?? "" })}
          data-testid="toolbar-fit"
          onClick={onFit}
        >
          <Icon name="fit" size={18} />
        </button>
      </div>

      <div
        className="toolbar-group toolbar-view-presets"
        role="group"
        aria-label={t("toolbar.presets.aria")}
      >
        {PRESETS.map(({ preset, labelKey, key }) => {
          const label = t(labelKey);
          return (
            <button
              type="button"
              key={preset}
              className="toolbar-btn"
              aria-label={t("toolbar.preset.aria", { label })}
              title={t("toolbar.preset.title", { label, key })}
              data-testid={`view-${preset}`}
              onClick={() => dispatchPreset(preset)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
