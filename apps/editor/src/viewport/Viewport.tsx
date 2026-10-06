import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import type { BridgeHandle } from "../bridge/mock";
import type { BuildVolume } from "../bridge/types";
import { useImportCommit } from "../bridge/import-actions";
import { classifyFile } from "../bridge/import-core";
import { useScene } from "../state/scene";
import { usePlates } from "../state/plates";
import { objectsOnPlate } from "../state/plates-core";
import { useUi } from "../state/ui";
import { useI18n } from "../state/i18n";
import { usePrinters } from "../state/printers";
import { effectiveViewMode, useViewMode } from "../state/view-mode";
import { openContextMenuAt } from "../components/context-menu-core";
import { useContextMenuStore } from "../state/context-menu";
import type { ContextMenuItem } from "../components/context-menu-core";
import { BuildPlate } from "./BuildPlate";
import { ContextLossGuard } from "./ContextLossGuard";
import { FrameSelectedCamera } from "./FrameSelectedCamera";
import { LayerPreview, previewFit } from "./LayerPreview";
import { ObjectLabels, LabelProjector } from "./Labels";
import { MeasureReadout } from "./MeasureReadout";
import { MeasureTool } from "./MeasureTool";
import { ModalInteraction } from "./ModalInteraction";
import { NonWatertightBadges } from "./NonWatertightBadges";
import { RendererGuard } from "./RendererGuard";
import { SceneObjectModel } from "./SceneObjectModel";
import { Toolbar } from "./Toolbar";
import { TransformGizmo } from "./TransformGizmo";
import { ViewCube } from "./ViewCube";
import { ViewportCamera } from "./ViewportCamera";
import type { PreviewModel } from "./preview-model";

interface ViewportProps {
  readonly scene: BridgeHandle | undefined;
  readonly preview: PreviewModel | null;
  readonly buildVolume?: BuildVolume;
}

export function Viewport({ scene, preview, buildVolume }: ViewportProps) {
  const t = useI18n((s) => s.t);
  const volume = buildVolume ?? scene?.buildVolume;
  const sceneObjects = scene?.objects ?? [];
  // S9.4-003 per-plate filter: only the ACTIVE plate's objects render. The
  // scene store carries authoritative plateId membership (hydrated from the
  // snapshot); objects rendered use the store objects so plateId is applied.
  const storeObjects = useScene((s) => s.objects);
  const activePlateId = usePlates((s) => s.activeId);
  const objects = useMemo(
    () => (storeObjects.length > 0 ? storeObjects : sceneObjects),
    [storeObjects, sceneObjects],
  );
  const visibleObjects = objectsOnPlate(objects, activePlateId);
  const selectedName = useScene((s) => s.selected?.name ?? null);

  // Live theme-aware canvas backdrop (S9.1-002): read the --viewport-bg CSS
  // token imperatively and re-resolve when data-theme changes — no re-render
  // of the R3F tree, just a THREE.Color swap.
  const [viewportBg, setViewportBg] = useState<string>(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--viewport-bg").trim(),
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () =>
      setViewportBg(getComputedStyle(root).getPropertyValue("--viewport-bg").trim() || "#d9ddd8");
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  const [layerIndex, setLayerIndex] = useState(0);
  const [showWalls, setShowWalls] = useState(true);
  const [showInfill, setShowInfill] = useState(true);

  // S9.11-001 view mode: live requires a reachable printer, otherwise the
  // effective mode falls back to slicer and a one-line banner shows why.
  const viewMode = useViewMode((s) => s.mode);
  const selectedPrinter = usePrinters((s) => s.printers.find((p) => p.id === s.selectedId));
  const liveReachable = selectedPrinter?.reachable === true;
  const effectiveMode = effectiveViewMode(viewMode, liveReachable);
  const modeFallbackActive = viewMode === "live" && effectiveMode !== "live";

  const layerCount = preview?.layerCount ?? 0;
  useEffect(() => {
    setLayerIndex(0);
  }, [preview]);
  const clampedLayer = layerCount > 0 ? Math.min(layerIndex, layerCount - 1) : 0;

  return (
    <ViewportFrame bridge={scene}>
      <Toolbar scene={scene} />
      {modeFallbackActive ? (
        <div className="viewport-live-banner" data-testid="viewport-live-banner" role="status">
          {t("viewport.live.banner")}
        </div>
      ) : null}
      <RendererGuard scene={scene} />
      <Canvas
        camera={{ position: [180, 260, 320], fov: 40, near: 0.1, far: 10000 }}
        dpr={[1, 2]}
        gl={{ preserveDrawingBuffer: true }}
      >
        <color attach="background" args={[viewportBg]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[80, 160, 120]} intensity={1} />
        <directionalLight position={[-100, 60, -60]} intensity={0.35} color="#9fb4ff" />
        {volume ? <BuildPlate volume={volume} /> : null}
        <FitCamera
          radius={Math.max(
            volume ? Math.hypot(volume.widthMm, volume.depthMm) / 2 : 160,
            preview ? previewFit(preview).radius : 0,
          )}
        />
        {preview ? (
          <PreviewScene
            model={preview}
            layerIndex={clampedLayer}
            showWalls={showWalls}
            showInfill={showInfill}
          />
        ) : (
          visibleObjects.map((o) => <SceneObjectModel key={o.name} info={o} />)
        )}
        {/* S9.8-002 — in-canvas label projector (writes NDC to the bus). */}
        {!preview ? <LabelProjector objects={visibleObjects} /> : null}
        {!preview && scene ? <TransformGizmo bridge={scene} selectedName={selectedName} /> : null}
        {/* S9.8-003 — measure probe collector + world markers (in-canvas). */}
        {!preview ? <MeasureTool objects={visibleObjects} /> : null}
        {!preview ? <FrameSelectedCamera /> : null}
        {!preview ? <ViewportCamera /> : null}
        {/* S9.8-006 — GL context-loss recovery (inside Canvas via useThree). */}
        <ContextLossGuard />
        <OrbitControls makeDefault enableDamping />
      </Canvas>
      {!preview ? <ViewCube /> : null} {!preview ? <NonWatertightBadges bridge={scene} /> : null}{" "}
      {/* S9.8-002 — chip overlay outside the Canvas (no three re-renders). */}
      {!preview ? <ObjectLabels objects={visibleObjects} /> : null}{" "}
      {/* S9.8-003 — measure readout overlay (mono, bottom-left) outside the canvas. */}
      {!preview ? <MeasureReadout /> : null}{" "}
      {preview ? (
        <div className="viewport-preview-controls" data-testid="preview-controls">
          {" "}
          <span className="preview-mode" data-testid="preview-mode-label">
            {t("viewport.preview.mode", { mode: preview.mode })}
          </span>
          <label htmlFor="preview-layer-slider">
            {t("viewport.preview.layerOf", {
              n: String(layerCount > 0 ? clampedLayer + 1 : 0),
              total: String(layerCount),
            })}
          </label>
          <input
            id="preview-layer-slider"
            data-testid="preview-layer-slider"
            type="range"
            min={0}
            max={Math.max(0, layerCount - 1)}
            step={1}
            value={clampedLayer}
            disabled={layerCount <= 1}
            onChange={(e) => setLayerIndex(Number(e.currentTarget.value))}
          />
          <label>
            <input
              type="checkbox"
              data-testid="preview-walls-toggle"
              checked={showWalls}
              onChange={(e) => setShowWalls(e.currentTarget.checked)}
            />
            Walls
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="preview-infill-toggle"
              checked={showInfill}
              onChange={(e) => setShowInfill(e.currentTarget.checked)}
            />
            Infill
          </label>
        </div>
      ) : null}
    </ViewportFrame>
  );
}

function PreviewScene({
  model,
  layerIndex,
  showWalls,
  showInfill,
}: {
  readonly model: PreviewModel;
  readonly layerIndex: number;
  readonly showWalls: boolean;
  readonly showInfill: boolean;
}) {
  const fit = useMemo(() => previewFit(model), [model]);
  return (
    <>
      <group position={[-fit.center[0], 0, -fit.center[2]]}>
        <LayerPreview
          model={model}
          layerIndex={layerIndex}
          showWalls={showWalls}
          showInfill={showInfill}
        />
      </group>
    </>
  );
}

function FitCamera({ radius }: { readonly radius: number }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((state) => state.size);
  useEffect(() => {
    const fovRad = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
    const aspect = Math.max(0.2, size.width / Math.max(1, size.height));
    const limitingAngle = Math.min(fovRad / 2, Math.atan(Math.tan(fovRad / 2) * aspect));
    const dist = Math.max(120, (radius / Math.sin(limitingAngle)) * 1.12);
    camera.position.set(dist * 0.36, dist * 0.62, dist * 0.7);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, radius, size.width, size.height]);
  return null;
}

/**
 * Viewport frame: the renderer surface + the UI-owned modal interaction strip.
 * The interaction strip sits OVER the viewport (bottom edge) so gizmo/numeric
 * flows are usable without leaving the canvas. The live bridge handle is the
 * contract subject — the interaction strip subscribes to commit events (AC-1)
 * and issues begin→update→commit|cancel against it (AC-2).
 *
 * S9.2-005: the frame is also a drag-drop import surface (entry point #2).
 * Dragging an .stl/.3mf onto the viewport imports it through the same
 * `useImportCommit` path as the dialog (entry point #1).
 */
function ViewportFrame({
  bridge,
  children,
}: {
  readonly bridge: BridgeHandle | undefined;
  readonly children: React.ReactNode;
}) {
  const t = useI18n((s) => s.t);
  const { commitFile } = useImportCommit(bridge);
  const openMenu = useContextMenuStore((s) => s.open);
  const pushToast = useUi((s) => s.pushToast);
  const [dragActive, setDragActive] = useState(false);
  const depth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // S9.8-001 — right-click on the viewport BACKGROUND opens the shared
  // context menu. Object meshes call `nativeEvent.stopPropagation()` on their
  // own context menu (SceneObjectModel), so this only fires for the empty
  // canvas area; toolbar/tabs/preview controls stop propagation themselves.
  const onFrameContextMenu = (e: React.MouseEvent) => {
    const targetEl = e.target as HTMLElement;
    if (
      targetEl.closest(
        "button, input, select, [data-testid='viewport-toolbar'], [data-testid='plate-tabs'], .viewport-preview-controls",
      )
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        id: "arrange",
        label: t("viewport.menu.arrange"),
        icon: "arrange",
        onSelect: () => {
          pushToast({
            kind: "info",
            title: t("viewport.toast.arrange.title"),
            message: t("viewport.toast.arrange.message"),
          });
        },
      },
      {
        id: "measure",
        label: t("viewport.menu.measure"),
        icon: "measure",
        onSelect: () => {
          pushToast({
            kind: "info",
            title: t("viewport.toast.measure.title"),
            message: t("viewport.toast.measure.message"),
          });
        },
      },
      {
        id: "import",
        label: t("viewport.menu.import"),
        icon: "plus",
        separatorBefore: true,
        onSelect: () => fileInputRef.current?.click(),
      },
    ];
    openMenu(openContextMenuAt(e, items));
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (file) void commitFile(file, { center: true, orientFlat: true });
  };

  const onDragEnter = (e: React.DragEvent) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file || !classifyFile(file.name)) return;
    e.preventDefault();
    depth.current += 1;
    setDragActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file || !classifyFile(file.name)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (_e: React.DragEvent) => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    const file = e.dataTransfer?.files?.[0];
    e.preventDefault();
    depth.current = 0;
    setDragActive(false);
    if (!file) return;
    if (!classifyFile(file.name)) {
      return; // non-importable — leave the drag alone
    }
    void commitFile(file, { center: true, orientFlat: true });
  };

  return (
    <section
      className={`viewport-frame${dragActive ? " import-dragging" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={onFrameContextMenu}
      data-testid="viewport-frame"
    >
      {children}
      <ModalInteraction bridge={bridge} />
      <input
        ref={fileInputRef}
        type="file"
        accept=".stl,.3mf"
        data-testid="viewport-import-input"
        className="visually-hidden"
        onChange={onImportFile}
      />
      {dragActive ? (
        <div className="viewport-drop-hint" data-testid="viewport-drop-hint" role="status">
          {t("viewport.dropHint")}
        </div>
      ) : null}
    </section>
  );
}
