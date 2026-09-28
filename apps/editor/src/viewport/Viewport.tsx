import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { BridgeHandle } from "../bridge/mock";
import { BuildPlate } from "./BuildPlate";
import { ModalInteraction } from "./ModalInteraction";
import { RendererGuard } from "./RendererGuard";
import { SceneObjectModel } from "./SceneObjectModel";

/**
 * R0/R1 viewport — a VIEW of the live Blender scene, never an authority.
 * Renders the profile-driven build plate + scene objects from the bridge. The
 * viewport subscribes to commit events (RendererGuard) and re-renders from the
 * authoritative snapshot (S7-004); modal interactions (gizmo/numeric) issue
 * begin→update→commit|cancel through ModalInteraction. Mesh state is
 * Blender-owned; the viewport never mutates geometry.
 */

interface ViewportProps {
  readonly scene: BridgeHandle | undefined;
}

export function Viewport({ scene }: ViewportProps) {
  const volume = scene?.buildVolume;
  const objects = scene?.objects ?? [];

  return (
    <ViewportFrame bridge={scene}>
      <RendererGuard scene={scene} />
      <Canvas camera={{ position: [0, 130, 240], fov: 50, near: 0.1, far: 2000 }} dpr={[1, 2]}>
        <ambientLight intensity={0.55} />
        <directionalLight position={[80, 160, 120]} intensity={1} />
        <directionalLight position={[-100, 60, -60]} intensity={0.35} color="#9fb4ff" />
        {/* Grid + axes helpers */}
        <axesHelper args={[60]} position={[0, 0.03, 0]} />
        {volume ? <BuildPlate volume={volume} /> : null}
        {objects.map((o) => (
          <SceneObjectModel key={o.name} info={o} />
        ))}
        <OrbitControls makeDefault enableDamping />
      </Canvas>
    </ViewportFrame>
  );
}

/**
 * Viewport frame: the renderer surface + the UI-owned modal interaction strip.
 * The interaction strip sits OVER the viewport (bottom edge) so gizmo/numeric
 * flows are usable without leaving the canvas. The live bridge handle is the
 * contract subject — the interaction strip subscribes to commit events (AC-1)
 * and issues begin→update→commit|cancel against it (AC-2).
 */
function ViewportFrame({
  bridge,
  children,
}: {
  readonly bridge: BridgeHandle | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="viewport-frame">
      {children}
      <ModalInteraction bridge={bridge} />
    </section>
  );
}
