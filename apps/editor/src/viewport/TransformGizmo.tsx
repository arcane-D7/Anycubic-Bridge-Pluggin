import { TransformControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type * as THREE from "three";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from "react";
import type { BridgeHandle } from "../bridge/mock";
import type { SceneObjectSnapshot } from "../bridge/types";
import { useViewport } from "../state/viewport";
import { useUi, type ToolMode } from "../state/ui";
import { SnapReadout, useSnap } from "./SnapController";
import { constrainToAxis } from "./transform-core";

/**
 * S9.3-001 — real drei <TransformControls> gizmo on the selected object.
 *
 * Mode maps from the active toolbar tool (select hides the gizmo; move/
 * rotate/scale drive it). The target object is the SceneObjectModel's root
 * <group name={name}>, resolved from the R3F scene graph — the gizmo drags
 * the OBJECT (never the geometry buffers; renderer mutation invariant kept).
 *
 * Gesture lifecycle:
 * - onObjectChange (mid-drag): provisional — persist the draft transform
 *   through the bridge `setTransform` mutation lane (the mock applies it
 *   immediately; the authoritative snapshot refetch happens at the end).
 * - onMouseUp (drag end): commit through the S7-004 contract via
 *   `runFlow(bridge, "gizmo")` (begin→update→commit, validates revision) then
 *   invalidate the bridge query so the authoritative snapshot rehydrates.
 * - Esc cancels the flow (viewport store rollback), and the provisional
 *   setTransform is rebased onto the pre-drag value (rollback capture).
 *
 * AC-4 pointer isolation: while the pointer is over a floating panel the
 * gizmo is `enabled=false` (it must not steal events under the chat panel).
 * Panel rects are collected from `.floating-panel-host` elements.
 */

function modeToGizmoMode(tool: ToolMode): "translate" | "rotate" | "scale" | null {
  if (tool === "select") return null;
  if (tool === "measure") return null; // gizmo-less measure probe (G42)
  if (tool === "move") return "translate";
  return tool;
}

function collectPanelRects(): { x: number; y: number; width: number; height: number }[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll<HTMLElement>(".floating-panel-host")].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

interface TransformGizmoProps {
  readonly bridge?: BridgeHandle;
  readonly selectedName: string | null;
}

export function TransformGizmo({ bridge, selectedName }: TransformGizmoProps) {
  const tool = useUi((s) => s.tool);
  const revision = useViewport((s) => s.revision);
  const sessionStatus = useViewport((s) => s.sessionStatus);
  // S9.7-002 — effective snap step from the toolbar store; the gizmo snaps
  // the draft BEFORE persisting and shows the target in the readout.
  const { snapTransform, readout } = useSnap(bridge?.buildVolume);
  const runFlow = useViewport((s) => s.runFlow);
  const cancel = useViewport((s) => s.cancel);
  const sceneGraph = useThree((s) => s.scene);
  const controlsRef = useRef<ElementRef<typeof TransformControls> | null>(null);
  // Pre-drag transform for rollback (Esc).
  const beginTransform = useRef<SceneObjectSnapshot["transform"] | null>(null);
  // AC-4: true while the pointer sits over a floating panel (gizmo disabled).
  const [overPanel, setOverPanel] = useState(false);

  // Listen for pointer moves: recompute panel blocking on every move across
  // the delta threshold — cheap and accurate for AC-4 (never steals events
  // from a floating panel over the viewport).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (sessionStatus === "active") return; // mid-drag owns the pointer
      const blocked = isPointerOverPanel(e.clientX, e.clientY);
      setOverPanel((prev) => (prev === blocked ? prev : blocked));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [sessionStatus]);

  // Find the target object in the current snapshot.
  const target = useMemo(
    () =>
      selectedName
        ? (sceneGraph.getObjectByName(selectedName) as THREE.Object3D | undefined)
        : undefined,
    [selectedName, sceneGraph],
  );

  const mode = modeToGizmoMode(tool);

  // Mode change ends any active flow (clean lifecycle).
  useEffect(() => {
    if (sessionStatus === "active") {
      cancel(revision);
    }
  }, [mode, sessionStatus, cancel, revision]);

  // AC-3: axis colors follow the design system. three-stdlib 2.36.1 ships no
  // public `setColors()` API and each axis material is shared inside the
  // gizmo, so we recolor materials AFTER mount by walking the gizmo children
  // (mesh `name` contains X/Y/Z). Shared material per axis — recoloring X
  // recolors every X part, which is exactly the desired axis semantics.
  const AXIS_COLORS: Record<string, string> = {
    X: "#e0523f",
    Y: "#2f9e63",
    Z: "#3f7fd4",
  };
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const gizmo =
      (controls as unknown as { gizmo?: THREE.Object3D }).gizmo ??
      (controls.children[0] as THREE.Object3D | undefined);
    if (!gizmo) return;
    const touched = new Set<THREE.Material>();
    gizmo.traverse((child: THREE.Object3D) => {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      const mat = mesh.material;
      if (!mat || Array.isArray(mat) || touched.has(mat)) return;
      const name = (child.name ?? "").toUpperCase();
      const axis = name.includes("X")
        ? "X"
        : name.includes("Y")
          ? "Y"
          : name.includes("Z")
            ? "Z"
            : null;
      if (!axis) return;
      (mat as THREE.MeshBasicMaterial).color?.set(AXIS_COLORS[axis]!);
      touched.add(mat);
    });
  }, [mode, target]);

  // Q/W/E/R tool switching moved to the central shortcut layer (S9.3-003,
  // hooks/useShortcuts.ts) — one keydown listener owns the whole map and
  // guards against text inputs; the gizmo just reacts to `useUi.tool`.
  const handleObjectChange = useCallback(() => {
    const obj = target;
    if (!obj || !selectedName || !bridge) return;
    // Capture the pre-drag transform once (rollback point).
    if (beginTransform.current === null) {
      beginTransform.current = {
        x: obj.position.x,
        y: obj.position.y,
        z: obj.position.z,
        rx: obj.rotation.x * (180 / Math.PI),
        ry: obj.rotation.y * (180 / Math.PI),
        rz: obj.rotation.z * (180 / Math.PI),
        sx: obj.scale.x,
        sy: obj.scale.y,
        sz: obj.scale.z,
      };
    }
    // Provisional persist through the mutation lane (mock applies it).
    // S9.3-003: an active keyboard grab with an axis lock constrains the
    // draft (move → slide plane, rotate → locked axis only, scale → unit
    // on other axes). The gizmo drag produces a free draft; the lock is
    // applied here so the persisted value honors X/Y/Z. `kind` for the
    // constraint = the grab gesture (fallback to the gizmo mode).
    const grab = useUi.getState().grab;
    const constraintKind =
      grab?.kind ?? (tool === "move" ? "move" : tool === "rotate" ? "rotate" : "scale");
    const draft = constrainToAxis(
      {
        x: obj.position.x,
        y: obj.position.y,
        z: obj.position.z,
        rx: obj.rotation.x * (180 / Math.PI),
        ry: obj.rotation.y * (180 / Math.PI),
        rz: obj.rotation.z * (180 / Math.PI),
        sx: obj.scale.x,
        sy: obj.scale.y,
        sz: obj.scale.z,
      },
      grab?.axis ?? null,
      constraintKind as "move" | "rotate" | "scale",
    );
    // S9.7-002 AC-1: grid/vertex snaps apply during gizmo drags — the draft
    // is snapped here so the persisted value honors the configurable step.
    const snapped = snapTransform(draft, constraintKind as "move" | "rotate" | "scale");
    void bridge.mutateObject({
      kind: "setTransform",
      name: selectedName,
      transform: snapped,
    });
  }, [selectedName, bridge, target, tool, snapTransform]);

  const handleMouseUp = useCallback(() => {
    if (!bridge) return;
    // Commit gesture through the S7-004 contract (begin→update→commit).
    void runFlow(bridge, "gizmo");
    beginTransform.current = null;
  }, [bridge, runFlow]);

  // Esc cancels an active modal session (viewport core rolls back to begin
  // revision). Also restore the pre-drag transform via the mutation lane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sessionStatus === "active") {
        if (bridge && selectedName && beginTransform.current) {
          void bridge.mutateObject({
            kind: "setTransform",
            name: selectedName,
            transform: beginTransform.current,
          });
        }
        cancel(revision);
        beginTransform.current = null;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionStatus, cancel, revision, bridge, selectedName]);

  if (!target || !mode) return null;

  return (
    <>
      <TransformControls
        ref={controlsRef}
        object={target}
        mode={mode}
        enabled={!overPanel}
        onObjectChange={handleObjectChange}
        onMouseUp={handleMouseUp}
        translationSnap={null}
        rotationSnap={null}
        scaleSnap={null}
      />
      {/* S9.7-002 AC-1 — snap target readout + guide while dragging. */}
      <SnapReadout readout={readout} volume={bridge?.buildVolume} />
    </>
  );
}

function isPointerOverPanel(x: number, y: number): boolean {
  if (typeof document === "undefined") return false;
  const rects = collectPanelRects();
  return rects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
}
