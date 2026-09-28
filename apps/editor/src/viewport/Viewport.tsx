import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { BridgeHandle } from "../bridge/mock";
import { BuildPlate } from "./BuildPlate";
import { SceneObjectModel } from "./SceneObjectModel";

/**
 * R0 viewport — a VIEW of the scene, never an authority. Renders the
 * profile-driven build plate (machine profile) + any scene objects from the
 * mock bridge. R1 replaces the mock with the real bridge client; the viewport
 * stays a pure view.
 */

interface ViewportProps {
  readonly scene: BridgeHandle | undefined;
}

export function Viewport({ scene }: ViewportProps) {
  const volume = scene?.buildVolume;
  const objects = scene?.objects ?? [];

  return (
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
  );
}
