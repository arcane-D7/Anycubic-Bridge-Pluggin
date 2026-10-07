import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { BridgeHandle } from "../bridge/mock";
import type { BuildVolume, SceneObjectSnapshot } from "../bridge/types";
import { useImportCommit } from "../bridge/import-actions";
import { classifyFile } from "../bridge/import-core";
import { useScene } from "../state/scene";
import { FIT_PLATE_EVENT, fitDistanceForRadius } from "../state/camera-core";
import { usePlates } from "../state/plates";
import { objectsOnPlate } from "../state/plates-core";
import { useUi } from "../state/ui";
import { useI18n } from "../state/i18n";
import { usePrinters } from "../state/printers";
import { effectiveViewMode, useViewMode } from "../state/view-mode";
import { useOperatorProfile } from "../profile/useOperatorProfile";
import { openContextMenuAt } from "../components/context-menu-core";
import { useContextMenuStore } from "../state/context-menu";
import type { ContextMenuItem } from "../components/context-menu-core";
import { useObjectContextMenu } from "../hooks/use-object-context-menu";
import { BuildPlate } from "./BuildPlate";
import { ContextLossGuard } from "./ContextLossGuard";
import { FrameSelectedCamera } from "./FrameSelectedCamera";
import { LayerPreview, previewFit } from "./LayerPreview";
import { ObjectLabels, LabelProjector } from "./Labels";
import { MeasureReadout } from "./MeasureReadout";
import { MeasureTool } from "./MeasureTool";
import { ModalInteraction } from "./ModalInteraction";
import { NonWatertightBadges } from "./NonWatertightBadges";
import { PlateRail } from "./PlateRail";
import { RendererGuard } from "./RendererGuard";
import { SceneObjectModel } from "./SceneObjectModel";
import { SnapReadout } from "./SnapController";
import { Toolbar } from "./Toolbar";
import { TransformGizmo } from "./TransformGizmo";
import { ViewCube } from "./ViewCube";
import { ViewportCamera } from "./ViewportCamera";
import { LiveOverlay } from "./LiveOverlay";
import type { PreviewModel } from "./preview-model";
import {
  beginRightGesture,
  cancelRightGesture,
  consumeRightGestureMenu,
  moveRightGesture,
  type RightGesture,
} from "./context-gesture-core";

interface ViewportProps {
  readonly scene: BridgeHandle | undefined;
  readonly preview: PreviewModel | null;
  readonly buildVolume?: BuildVolume;
}

export function Viewport({ scene, preview, buildVolume }: ViewportProps) {
  const t = useI18n((s) => s.t);
  const openObjectMenu = useObjectContextMenu(scene);
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
  const [operatorProfile] = useOperatorProfile();

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
      {/* P1-5 — plate identity + quick actions (fit/top/grid). */}
      {!preview ? <PlateRail volume={volume} profile={operatorProfile} objects={objects} /> : null}
      <RendererGuard scene={scene} />
      <Canvas
        camera={{ position: [180, 260, 320], fov: 40, near: 0.1, far: 10000 }}
        dpr={[1, 2]}
        gl={{ preserveDrawingBuffer: true }}
      >
        <color attach="background" args={[viewportBg]} />
        {!preview ? (
          <ObjectContextMenuPicker objects={visibleObjects} onOpen={openObjectMenu} />
        ) : null}
        <ambientLight intensity={0.55} />
        <directionalLight position={[80, 160, 120]} intensity={1} />
        <directionalLight position={[-100, 60, -60]} intensity={0.35} color="#9fb4ff" />
        {volume ? <BuildPlate volume={volume} /> : null}
        {/* S9.11-003 — live overlay (toolhead ≤4 Hz, nozzle color, spray, layer bar). */}
        {effectiveMode === "live" ? <LiveOverlay volume={volume ?? null} /> : null}
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
          visibleObjects.map((o) => (
            <SceneObjectModel key={o.name} info={o} onObjectContextMenu={openObjectMenu} />
          ))
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
        {/* S9.9-010 — navigation like Orca/Anycubic Slicer: LEFT drag = orbit,
            MIDDLE drag = PAN (not dolly), RIGHT drag = pan. Middle-button
            dolly was the default OrbitControls mapping; users dragging with
            the scroll button expected view panning and got zoom. */}
        <OrbitControls
          makeDefault
          enableDamping
          mouseButtons={{
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.PAN,
          }}
        />
      </Canvas>
      {!preview ? <ViewCube /> : null}{" "}
      {/* S9.7-003 — repair trigger + popover (top-left of the frame — the zone
          freed by the old corner chip removal; never overlaps the toolbar or
          plate rail). */}
      {!preview ? <NonWatertightBadges bridge={scene} /> : null}{" "}
      {/* S9.8-002 — chip overlay outside the Canvas (no three re-renders). */}
      {!preview ? <ObjectLabels objects={visibleObjects} /> : null}{" "}
      {/* S9.8-003 — measure readout overlay (mono, bottom-left) outside the canvas. */}
      {!preview ? <MeasureReadout /> : null}{" "}
      {/* S9.13 — snap readout overlay (axis/value/step chip) outside the canvas.
          DOM must never mount inside the R3F tree (crash fix). */}
      {!preview ? <SnapReadout volume={volume} /> : null}{" "}
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

function ObjectContextMenuPicker({
  objects,
  onOpen,
}: {
  readonly objects: readonly SceneObjectSnapshot[];
  readonly onOpen: ReturnType<typeof useObjectContextMenu>;
}) {
  const { camera, gl, scene } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const pointer = useMemo(() => new THREE.Vector2(), []);
  const rightGesture = useRef<RightGesture | null>(null);

  useEffect(() => {
    const canvas = gl.domElement;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        rightGesture.current = beginRightGesture(event.pointerId, event.clientX, event.clientY);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      rightGesture.current = moveRightGesture(
        rightGesture.current,
        event.pointerId,
        event.clientX,
        event.clientY,
      );
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (rightGesture.current?.pointerId === event.pointerId) {
        rightGesture.current = cancelRightGesture(rightGesture.current);
      }
    };
    const onLostPointerCapture = (event: PointerEvent) => {
      if (rightGesture.current?.pointerId === event.pointerId) {
        rightGesture.current = cancelRightGesture(rightGesture.current);
      }
    };
    const onContextMenu = (event: MouseEvent) => {
      if (event.button === 2) {
        const decision = consumeRightGestureMenu(rightGesture.current);
        rightGesture.current = decision.next;
        if (!decision.openMenu) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const objectNames = new Set(objects.map((object) => object.name));
      for (const hit of raycaster.intersectObjects(scene.children, true)) {
        let owner: THREE.Object3D | null = hit.object;
        while (owner && !objectNames.has(owner.name)) owner = owner.parent;
        if (!owner) continue;
        const target = objects.find((object) => object.name === owner?.name);
        if (!target) continue;
        event.preventDefault();
        event.stopImmediatePropagation();
        onOpen("canvas", target, { clientX: event.clientX, clientY: event.clientY });
        return;
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("pointermove", onPointerMove, true);
    canvas.addEventListener("pointercancel", onPointerCancel, true);
    canvas.addEventListener("lostpointercapture", onLostPointerCapture, true);
    canvas.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointermove", onPointerMove, true);
      canvas.removeEventListener("pointercancel", onPointerCancel, true);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture, true);
      canvas.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [camera, gl, objects, onOpen, pointer, raycaster, scene]);

  return null;
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
  const fitPlate = useCallback(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = fitDistanceForRadius(radius, perspective.fov, size.width, size.height);
    const direction = new THREE.Vector3(0.36, 0.62, 0.7).normalize();
    camera.position.copy(direction.multiplyScalar(distance));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, radius, size.width, size.height]);
  useEffect(() => {
    fitPlate();
    window.addEventListener(FIT_PLATE_EVENT, fitPlate);
    return () => window.removeEventListener(FIT_PLATE_EVENT, fitPlate);
  }, [fitPlate]);
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
  const queryClient = useQueryClient();
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
          if (!bridge?.arrange) {
            pushToast({
              kind: "warning",
              title: t("viewport.toast.arrange.title"),
              message: t("toolbar.arrange.bridgeUnavailable"),
            });
            return;
          }
          const allObjects = useScene.getState().objects;
          const targets = objectsOnPlate(allObjects, usePlates.getState().activeId);
          if (targets.length === 0) {
            pushToast({
              kind: "info",
              title: t("viewport.toast.arrange.title"),
              message: t("toolbar.arrange.noObjects"),
            });
            return;
          }
          if (targets.length !== allObjects.length) {
            pushToast({
              kind: "warning",
              title: t("viewport.toast.arrange.title"),
              message: t("viewport.toast.arrange.scopeUnavailable"),
            });
            return;
          }
          void bridge
            .arrange({
              plateW: bridge.buildVolume?.widthMm,
              plateD: bridge.buildVolume?.depthMm,
              gap: 2,
              center: true,
            })
            .then(async (result) => {
              if (!result.ok) {
                pushToast({
                  kind: "error",
                  title: t("viewport.toast.arrange.title"),
                  message: result.error,
                });
                return;
              }
              await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
              pushToast({
                kind: "success",
                title: t("viewport.toast.arrange.title"),
                message: t("toolbar.arrange.successMsg", {
                  n: String(result.placed.length),
                  s: result.placed.length === 1 ? "" : "s",
                }),
              });
            })
            .catch(() =>
              pushToast({
                kind: "error",
                title: t("viewport.toast.arrange.title"),
                message: t("toolbar.arrange.failed"),
              }),
            );
        },
      },
      {
        id: "measure",
        label: t("viewport.menu.measure"),
        icon: "measure",
        onSelect: () => {
          useUi.getState().setTool("measure");
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
      tabIndex={0}
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
      {/* 2026-10-06 layout fix (Consultor): canvas-local dock root — the ONLY
          anchor for floating panels + collapsed pills, so dock chrome is
          frame-relative (never window-anchored over the header/footer). */}
      <div
        id="viewport-dock-root"
        className="viewport-dock-root"
        data-testid="viewport-dock-root"
      />
      {dragActive ? (
        <div className="viewport-drop-hint" data-testid="viewport-drop-hint" role="status">
          {t("viewport.dropHint")}
        </div>
      ) : null}
    </section>
  );
}
