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
import { isViewportReadOnly } from "../state/shortcuts-core";
export { isViewportReadOnly } from "../state/shortcuts-core";
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
  previewLayerSegmentsAt,
  previewPlaybackStep,
  previewAttributeSummary,
  visiblePlaybackSegments,
  type PreviewAttribute,
  type PreviewPathFilters,
} from "./preview-model";
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
  readonly workspaceMode?: "prepare" | "preview";
}

export function Viewport({
  scene,
  preview,
  buildVolume,
  workspaceMode = "prepare",
}: ViewportProps) {
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
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [accumulated, setAccumulated] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [colorMode, setColorMode] = useState<
    | "function"
    | "material"
    | "speed"
    | "flow"
    | "beadWidth"
    | "lineWidth"
    | "layerHeight"
    | "temperature"
  >("function");
  const [pathFilters, setPathFilters] = useState<PreviewPathFilters>({});
  const [playing, setPlaying] = useState(false);

  // S9.11-001 view mode: live requires a reachable printer, otherwise the
  // effective mode falls back to slicer and a one-line banner shows why.
  const viewMode = useViewMode((s) => s.mode);
  const selectedPrinter = usePrinters((s) => s.printers.find((p) => p.id === s.selectedId));
  const liveReachable = selectedPrinter?.reachable === true;
  const effectiveMode = effectiveViewMode(viewMode === "live" ? "slicer" : viewMode, liveReachable);
  const isPreviewMode = isViewportReadOnly(workspaceMode);

  const layerCount = preview?.layerCount ?? 0;
  useEffect(() => {
    setLayerIndex(0);
    setSegmentIndex(0);
    setPlaying(false);
  }, [preview]);
  const clampedLayer = layerCount > 0 ? Math.min(layerIndex, layerCount - 1) : 0;
  const currentLayerSegments = preview ? previewLayerSegmentsAt(preview, clampedLayer) : [];
  const clampedSegment =
    currentLayerSegments.length > 0 ? Math.min(segmentIndex, currentLayerSegments.length - 1) : 0;
  const playbackPaths = preview
    ? visiblePlaybackSegments(
        preview,
        {
          layerPosition: clampedLayer,
          segmentPosition: clampedSegment,
          accumulated,
        },
        pathFilters,
      )
    : [];

  useEffect(() => {
    if (!playing || !preview) return;
    const segment = currentLayerSegments[clampedSegment];
    const delay = Math.max(16, 100 / playbackSpeed);
    const timer = window.setTimeout(() => {
      if (!segment) {
        setPlaying(false);
        return;
      }
      const next = previewPlaybackStep(preview, clampedLayer, clampedSegment, 1);
      const samePosition =
        next.layerPosition === clampedLayer && next.segmentPosition === clampedSegment;
      if (samePosition) setPlaying(false);
      else {
        setLayerIndex(next.layerPosition);
        setSegmentIndex(next.segmentPosition);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, preview, clampedLayer, clampedSegment, currentLayerSegments.length, playbackSpeed]);

  const updatePathFilter = (key: string, checked: boolean) =>
    setPathFilters((current) => ({ ...current, [key]: checked }));

  const attributeForMode: Record<typeof colorMode, PreviewAttribute | null> = {
    function: null,
    material: null,
    speed: "speed",
    flow: "flow",
    beadWidth: "beadWidth",
    lineWidth: "lineWidth",
    layerHeight: "layerHeight",
    temperature: "temperature",
  };
  const attributeSummary =
    preview && attributeForMode[colorMode]
      ? previewAttributeSummary(playbackPaths, attributeForMode[colorMode]!)
      : null;
  const materialIds =
    colorMode === "material"
      ? [
          ...new Set(
            playbackPaths.map((path) => path.materialId).filter((id): id is string => id !== null),
          ),
        ]
      : [];

  const stepPlayback = (delta: -1 | 1) => {
    if (!preview) return;
    const next = previewPlaybackStep(preview, clampedLayer, clampedSegment, delta);
    setLayerIndex(next.layerPosition);
    setSegmentIndex(next.segmentPosition);
  };

  return (
    <ViewportFrame bridge={scene} readOnly={isPreviewMode}>
      <Toolbar scene={scene} mode={workspaceMode} preview={preview} />
      {/* P1-5 — plate identity + quick actions (fit/top/grid). */}
      {!isPreviewMode ? (
        <PlateRail volume={volume} profile={operatorProfile} objects={objects} />
      ) : null}
      <RendererGuard scene={scene} />
      <Canvas
        camera={{ position: [180, 260, 320], fov: 40, near: 0.1, far: 10000 }}
        dpr={[1, 2]}
        gl={{ preserveDrawingBuffer: true }}
      >
        <color attach="background" args={[viewportBg]} />
        {!isPreviewMode && !preview ? (
          <ObjectContextMenuPicker objects={visibleObjects} onOpen={openObjectMenu} />
        ) : null}
        <ambientLight intensity={0.55} />
        <directionalLight position={[80, 160, 120]} intensity={1} />
        <directionalLight position={[-100, 60, -60]} intensity={0.35} color="#9fb4ff" />
        {volume ? <BuildPlate volume={volume} /> : null}
        {/* S9.11-003 — live overlay (toolhead ≤4 Hz, nozzle color, spray, layer bar). */}
        {!isPreviewMode && effectiveMode === "live" ? (
          <LiveOverlay volume={volume ?? null} />
        ) : null}
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
            paths={playbackPaths}
            colorMode={colorMode}
            currentSegment={
              currentLayerSegments[clampedSegment] &&
              pathFilters[currentLayerSegments[clampedSegment]!.kind] !== false
                ? currentLayerSegments[clampedSegment]!
                : null
            }
          />
        ) : !isPreviewMode ? (
          visibleObjects.map((o) => (
            <SceneObjectModel key={o.name} info={o} onObjectContextMenu={openObjectMenu} />
          ))
        ) : null}
        {/* S9.8-002 — in-canvas label projector (writes NDC to the bus). */}
        {!isPreviewMode && !preview ? <LabelProjector objects={visibleObjects} /> : null}
        {!isPreviewMode && !preview && scene ? (
          <TransformGizmo bridge={scene} selectedName={selectedName} />
        ) : null}
        {/* S9.8-003 — measure probe collector + world markers (in-canvas). */}
        {!isPreviewMode && !preview ? <MeasureTool objects={visibleObjects} /> : null}
        {!isPreviewMode && !preview ? <FrameSelectedCamera /> : null}
        <ViewportCamera />
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
      {!isPreviewMode ? <ViewCube /> : null}{" "}
      {/* S9.7-003 — repair trigger + popover (top-left of the frame — the zone
          freed by the old corner chip removal; never overlaps the toolbar or
          plate rail). */}
      {!isPreviewMode && !preview ? <NonWatertightBadges bridge={scene} /> : null}{" "}
      {/* S9.8-002 — chip overlay outside the Canvas (no three re-renders). */}
      {!isPreviewMode && !preview ? <ObjectLabels objects={visibleObjects} /> : null}{" "}
      {/* S9.8-003 — measure readout overlay (mono, bottom-left) outside the canvas. */}
      {!isPreviewMode && !preview ? <MeasureReadout /> : null}{" "}
      {/* S9.13 — snap readout overlay (axis/value/step chip) outside the canvas.
          DOM must never mount inside the R3F tree (crash fix). */}
      {!isPreviewMode && !preview ? <SnapReadout volume={volume} /> : null}{" "}
      {preview ? (
        <div
          className="viewport-preview-controls"
          data-testid="preview-controls"
          data-visible-segment-ids={playbackPaths
            .map((path) => path.segmentId)
            .filter(Boolean)
            .join(",")}
        >
          {" "}
          <span className="preview-mode" data-testid="preview-mode-label">
            {t("viewport.preview.mode", { mode: preview.mode })}
          </span>
          {preview.jobId ? (
            <span className="preview-artifact" data-testid="preview-artifact">
              {t("viewport.preview.artifact", {
                job: preview.jobId,
                revision: String(preview.sourceRevision ?? "unavailable"),
              })}
            </span>
          ) : null}
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
            className="preview-layer-slider"
            min={0}
            max={Math.max(0, layerCount - 1)}
            step={1}
            value={clampedLayer}
            disabled={layerCount <= 1}
            onChange={(e) => {
              setLayerIndex(Number(e.currentTarget.value));
              setSegmentIndex(0);
            }}
          />
          <label htmlFor="preview-segment-slider">
            {t("viewport.preview.segmentOf", {
              n: String(currentLayerSegments.length ? clampedSegment + 1 : 0),
              total: String(currentLayerSegments.length),
            })}
          </label>
          <input
            id="preview-segment-slider"
            data-testid="preview-segment-slider"
            data-current-segment-id={currentLayerSegments[clampedSegment]?.segmentId ?? ""}
            type="range"
            min={0}
            max={Math.max(0, currentLayerSegments.length - 1)}
            step={1}
            value={clampedSegment}
            disabled={currentLayerSegments.length <= 1}
            onChange={(e) => setSegmentIndex(Number(e.currentTarget.value))}
          />
          <button
            type="button"
            data-testid="preview-step-back"
            aria-label={t("viewport.preview.previousSegment")}
            onClick={() => stepPlayback(-1)}
          >
            ◀
          </button>
          <button
            type="button"
            data-testid="preview-play-toggle"
            aria-pressed={playing}
            onClick={() => {
              if (!playing && preview) {
                const current = currentLayerSegments[clampedSegment];
                const last = preview.orderedSegments.at(-1);
                if (current && current === last) {
                  const first = preview.orderedSegments[0];
                  const position = first ? preview.playbackPositions.get(first) : null;
                  if (position) {
                    setLayerIndex(position.layerPosition);
                    setSegmentIndex(position.segmentPosition);
                  }
                }
              }
              setPlaying((value) => !value);
            }}
          >
            {playing ? t("viewport.preview.pause") : t("viewport.preview.play")}
          </button>
          <button
            type="button"
            data-testid="preview-step-forward"
            aria-label={t("viewport.preview.nextSegment")}
            onClick={() => stepPlayback(1)}
          >
            ▶
          </button>
          <label htmlFor="preview-play-speed">{t("viewport.preview.speed")}</label>
          <select
            id="preview-play-speed"
            data-testid="preview-play-speed"
            value={playbackSpeed}
            onChange={(e) => setPlaybackSpeed(Number(e.currentTarget.value))}
          >
            {[0.5, 1, 2, 4].map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              data-testid="preview-accumulated-toggle"
              checked={accumulated}
              onChange={(e) => setAccumulated(e.currentTarget.checked)}
            />
            {t("viewport.preview.accumulated")}
          </label>
          <label htmlFor="preview-color-mode">{t("viewport.preview.colorBy")}</label>
          <select
            id="preview-color-mode"
            data-testid="preview-color-mode"
            value={colorMode}
            onChange={(e) => setColorMode(e.currentTarget.value as typeof colorMode)}
          >
            <option value="function">{t("viewport.preview.function")}</option>
            <option
              value="material"
              disabled={!playbackPaths.some((path) => path.materialId !== null)}
            >
              {t("viewport.preview.material")}
            </option>
            <option value="speed" disabled={!playbackPaths.some((path) => path.speedMmS !== null)}>
              {t("viewport.preview.commandedSpeed")}
            </option>
            <option value="flow" disabled={!playbackPaths.some((path) => path.flowMm3S !== null)}>
              {t("viewport.preview.flow")}
            </option>
            <option
              value="beadWidth"
              disabled={!playbackPaths.some((path) => path.beadAreaMm2 !== null)}
            >
              {t("viewport.preview.beadWidth")}
            </option>
            <option
              value="lineWidth"
              disabled={!playbackPaths.some((path) => path.lineWidthMm !== null)}
            >
              {t("viewport.preview.lineWidth")}
            </option>
            <option
              value="layerHeight"
              disabled={!playbackPaths.some((path) => path.layerHeightMm !== null)}
            >
              {t("viewport.preview.layerHeight")}
            </option>
            <option
              value="temperature"
              disabled={!playbackPaths.some((path) => path.nozzleTemperatureC !== null)}
            >
              {t("viewport.preview.temperature")}
            </option>
          </select>
          {(
            [
              ["WALL", "viewport.preview.wall"],
              ["OUTER_WALL", "viewport.preview.outerWall"],
              ["INNER_WALL", "viewport.preview.innerWall"],
              ["INFILL", "viewport.preview.infill"],
              ["SOLID_INFILL", "viewport.preview.solidInfill"],
              ["SUPPORT", "viewport.preview.support"],
              ["SUPPORT_INTERFACE", "viewport.preview.supportInterface"],
              ["BRIDGE", "viewport.preview.bridge"],
              ["GAP_INFILL", "viewport.preview.gapInfill"],
              ["BRIM", "viewport.preview.brim"],
              ["SKIRT", "viewport.preview.skirt"],
              ["TRAVEL", "viewport.preview.travel"],
              ["RETRACTION", "viewport.preview.retraction"],
              ["SEAM", "viewport.preview.seam"],
              ["PRIME", "viewport.preview.prime"],
              ["PURGE", "viewport.preview.purge"],
              ["TOOL_CHANGE", "viewport.preview.toolChange"],
            ] as const
          ).map(([key, labelKey]) => (
            <label key={key}>
              <input
                type="checkbox"
                data-testid={`preview-filter-${key.toLowerCase()}`}
                checked={pathFilters[key] !== false}
                onChange={(e) => updatePathFilter(key, e.currentTarget.checked)}
              />
              {t(labelKey)}
            </label>
          ))}
          <span className="preview-legend" data-testid="preview-attribute-legend">
            {colorMode === "function"
              ? t("viewport.preview.legendFunction")
              : colorMode === "material"
                ? materialIds.length > 0
                  ? t("viewport.preview.legendMaterial", { value: materialIds.join(", ") })
                  : t("viewport.preview.attributeUnavailable")
                : attributeSummary
                  ? t(
                      colorMode === "speed"
                        ? "viewport.preview.legendSpeed"
                        : colorMode === "flow"
                          ? "viewport.preview.legendFlow"
                          : colorMode === "beadWidth"
                            ? "viewport.preview.legendBeadWidth"
                            : colorMode === "lineWidth"
                              ? "viewport.preview.legendWidth"
                              : colorMode === "layerHeight"
                                ? "viewport.preview.legendHeight"
                                : "viewport.preview.legendTemperature",
                      {
                        value:
                          attributeSummary.min === attributeSummary.max
                            ? attributeSummary.min.toFixed(2)
                            : `${attributeSummary.min.toFixed(2)}–${attributeSummary.max.toFixed(2)} ${attributeSummary.unit}`,
                      },
                    )
                  : t("viewport.preview.attributeUnavailable")}
            {attributeSummary ? (
              <span
                className="preview-legend-distribution"
                data-testid="preview-attribute-distribution"
              >
                {attributeSummary.histogram.map((count, index) => (
                  <span
                    key={index}
                    title={`${count}`}
                    style={{ height: `${Math.max(2, count * 2)}px` }}
                  />
                ))}
              </span>
            ) : null}
          </span>
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
  const objectsRef = useRef(objects);
  const onOpenRef = useRef(onOpen);
  objectsRef.current = objects;
  onOpenRef.current = onOpen;

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
      const currentObjects = objectsRef.current;
      const objectNames = new Set(currentObjects.map((object) => object.name));
      for (const hit of raycaster.intersectObjects(scene.children, true)) {
        let owner: THREE.Object3D | null = hit.object;
        while (owner && !objectNames.has(owner.name)) owner = owner.parent;
        if (!owner) continue;
        const target = currentObjects.find((object) => object.name === owner?.name);
        if (!target) continue;
        event.preventDefault();
        event.stopImmediatePropagation();
        onOpenRef.current("canvas", target, { clientX: event.clientX, clientY: event.clientY });
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
  }, [camera, gl, pointer, raycaster, scene]);

  return null;
}

function PreviewScene({
  model,
  layerIndex,
  paths,
  colorMode,
  currentSegment,
}: {
  readonly model: PreviewModel;
  readonly layerIndex: number;
  readonly paths: typeof model.orderedSegments;
  readonly colorMode:
    | "function"
    | "material"
    | "speed"
    | "flow"
    | "beadWidth"
    | "lineWidth"
    | "layerHeight"
    | "temperature";
  readonly currentSegment: (typeof model.orderedSegments)[number] | null;
}) {
  const fit = useMemo(() => previewFit(model), [model]);
  return (
    <>
      <group position={[-fit.center[0], -fit.center[1], -fit.center[2]]}>
        <LayerPreview
          layerIndex={layerIndex}
          paths={paths}
          colorMode={colorMode}
          currentSegment={currentSegment}
        />
      </group>
    </>
  );
}

function FitCamera({ radius }: { readonly radius: number }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((state) => state.size);
  const didInitialFit = useRef(false);
  const fitPlate = useCallback(
    (event?: Event) => {
      const perspective = camera as THREE.PerspectiveCamera;
      const target = (
        event as
          CustomEvent<{ center?: readonly [number, number, number]; radius?: number }> | undefined
      )?.detail;
      const center = target?.center ? new THREE.Vector3(...target.center) : new THREE.Vector3();
      const fitRadius = target?.radius ?? radius;
      const distance = fitDistanceForRadius(fitRadius, perspective.fov, size.width, size.height);
      const direction = camera.position.clone().sub(center);
      if (direction.lengthSq() < 1e-8) direction.set(0.36, 0.62, 0.7);
      direction.normalize();
      camera.position.copy(center).add(direction.multiplyScalar(distance));
      camera.lookAt(center);
      camera.updateProjectionMatrix();
    },
    [camera, radius, size.width, size.height],
  );
  useEffect(() => {
    if (!didInitialFit.current) {
      fitPlate();
      didInitialFit.current = true;
    }
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
  readOnly = false,
  children,
}: {
  readonly bridge: BridgeHandle | undefined;
  readonly readOnly?: boolean;
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
    if (readOnly) {
      e.preventDefault();
      return;
    }
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
    if (readOnly) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file || !classifyFile(file.name)) return;
    e.preventDefault();
    depth.current += 1;
    setDragActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (readOnly) return;
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
    if (readOnly) return;
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
      {!readOnly ? <ModalInteraction bridge={bridge} /> : null}
      {!readOnly ? (
        <input
          ref={fileInputRef}
          type="file"
          accept=".stl,.3mf"
          data-testid="viewport-import-input"
          className="visually-hidden"
          onChange={onImportFile}
        />
      ) : null}
      {/* 2026-10-06 layout fix (Consultor): canvas-local dock root — the ONLY
          anchor for floating panels + collapsed pills, so dock chrome is
          frame-relative (never window-anchored over the header/footer). */}
      <div
        id="viewport-dock-root"
        className="viewport-dock-root"
        data-testid="viewport-dock-root"
      />
      {!readOnly && dragActive ? (
        <div className="viewport-drop-hint" data-testid="viewport-drop-hint" role="status">
          {t("viewport.dropHint")}
        </div>
      ) : null}
    </section>
  );
}
