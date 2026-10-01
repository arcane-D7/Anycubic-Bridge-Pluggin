import { FRAME_SELECTED_EVENT } from "../state/shortcuts-core";
import { useToolbar, type ViewPreset } from "../state/toolbar";
import { useUi, type ToolMode } from "../state/ui";
import { Icon, type IconName } from "../components/icons";
import { shortcutFor, shortcutLabel } from "../state/shortcuts";
import { usePlates } from "../state/plates";
import { objectsOnPlate } from "../state/plates-core";
import { useScene } from "../state/scene";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";

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
  readonly label: string;
}[] = [
  { mode: "select", icon: "snap", label: "Select" },
  { mode: "move", icon: "move", label: "Move" },
  { mode: "rotate", icon: "rotate", label: "Rotate" },
  { mode: "scale", icon: "scale", label: "Scale" },
];

const PRESETS: readonly {
  readonly preset: ViewPreset;
  readonly label: string;
  readonly key: string;
}[] = [
  { preset: "iso", label: "Isometric", key: "1" },
  { preset: "top", label: "Top", key: "2" },
  { preset: "front", label: "Front", key: "3" },
  { preset: "right", label: "Right", key: "4" },
];

interface ToolbarProps {
  readonly scene: BridgeHandle | undefined;
}

export function Toolbar({ scene }: ToolbarProps) {
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
      pushToast({ kind: "warning", title: "Arrange", message: "Bridge unavailable." });
      return;
    }
    const targets = objectsOnPlate(allObjects, activePlateId);
    if (targets.length === 0) {
      pushToast({
        kind: "info",
        title: "Arrange",
        message: "Nothing on the active plate to arrange.",
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
        pushToast({ kind: "error", title: "Arrange", message: res.error });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      const overflow = res.warnings.filter((w) => /does not fit|exceeds plate/.test(w));
      if (overflow.length > 0) {
        pushToast({
          kind: "warning",
          title: "Arrange — overflow",
          message: `${overflow.length} object${overflow.length === 1 ? "" : "s"} exceed the plate (${overflow[0]!.split(" — ")[0] ?? ""}).`,
        });
      } else {
        pushToast({
          kind: "success",
          title: "Arrange",
          message: `Re-committed ${res.placed.length} object${res.placed.length === 1 ? "" : "s"} onto the active plate.`,
        });
      }
    } catch (err) {
      console.warn("[toolbar] arrange failed", err);
      pushToast({ kind: "error", title: "Arrange", message: "Arrange failed — see console." });
    }
  }, [scene, allObjects, activePlateId, pushToast, queryClient]);

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
      aria-label="Viewport tools"
    >
      <div className="toolbar-group" role="group" aria-label="Transform tools">
        {TOOLS.map(({ mode, icon, label }) => (
          <button
            type="button"
            key={mode}
            className={`toolbar-btn${tool === mode ? " is-active" : ""}`}
            aria-pressed={tool === mode}
            aria-label={label}
            title={`${label} (${toolTip(`tool.${mode}`) ?? ""})`}
            data-testid={`tool-${mode}`}
            onClick={() => setTool(mode)}
          >
            <Icon name={icon} size={18} />
            <span className="toolbar-btn-label">{label}</span>
          </button>
        ))}
      </div>

      <div className="toolbar-group" role="group" aria-label="View toggles">
        <button
          type="button"
          className={`toolbar-btn toolbar-toggle${snap ? " is-active" : ""}`}
          aria-pressed={snap}
          aria-label="Snap"
          title={`Snap (${toolTip("snap.toggle") ?? ""})`}
          data-testid="toggle-snap"
          onClick={() => toggleFlag("snap")}
        >
          <Icon name="snap" size={18} />
        </button>
        <button
          type="button"
          className={`toolbar-btn toolbar-toggle${grid ? " is-active" : ""}`}
          aria-pressed={grid}
          aria-label="Grid"
          title={`Grid (${toolTip("grid.toggle") ?? ""})`}
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
          aria-label="Labels"
          title="Object labels (hover / always-on)"
          data-testid="toggle-labels"
          onClick={() => toggleObjectLabelsAlwaysOn()}
        >
          <Icon name="eye" size={18} />
        </button>
        {/* S9.7-002 AC-2 — snap step configurable from the toolbar: discrete
            number input, clamped 1..100 mm. Determinism guaranteed by the
            pure `snapValue` rounding used everywhere. */}
        <label className="toolbar-snap-step" title="Snap step (mm)">
          <span className="visually-hidden">Snap step mm</span>
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            data-testid="snap-step-input"
            value={snapStep}
            disabled={!snap}
            aria-label="Snap step (mm)"
            onChange={(e) => setSnapStep(Number(e.currentTarget.value))}
          />
          <span className="snap-step-unit">mm</span>
        </label>
      </div>

      <div className="toolbar-group" role="group" aria-label="Scene actions">
        <button
          type="button"
          className="toolbar-btn"
          aria-label="Arrange"
          title="Auto-arrange"
          data-testid="toolbar-arrange"
          onClick={onArrange}
        >
          <Icon name="arrange" size={18} />
        </button>
        <button
          type="button"
          className="toolbar-btn"
          aria-label="Fit view"
          title={`Fit view (${toolTip("view.fit") ?? ""})`}
          data-testid="toolbar-fit"
          onClick={onFit}
        >
          <Icon name="fit" size={18} />
        </button>
      </div>

      <div className="toolbar-group toolbar-view-presets" role="group" aria-label="View presets">
        {PRESETS.map(({ preset, label, key }) => (
          <button
            type="button"
            key={preset}
            className="toolbar-btn"
            aria-label={`View ${label}`}
            title={`${label} (${key})`}
            data-testid={`view-${preset}`}
            onClick={() => dispatchPreset(preset)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
