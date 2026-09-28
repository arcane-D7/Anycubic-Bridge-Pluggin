import type { BridgeHandle } from "../bridge/mock";
import { useScene } from "../state/scene";

/**
 * Left panel — object tree (R0 shell). Lists the scene objects returned by the
 * bridge with their mesh stats and the selection marker. R2+ adds layers,
 * modifiers and print-setting presets per §7.2.
 */

interface ObjectTreeProps {
  readonly scene: BridgeHandle | undefined;
}

export function ObjectTree({ scene }: ObjectTreeProps) {
  const selected = useScene((s) => s.selected);
  const objects = scene?.objects ?? [];

  return (
    <section className="panel-object-tree" aria-label="Object tree">
      <header className="panel-title">Objects</header>
      {scene ? (
        <ul className="object-list">
          {objects.map((o) => {
            const isSel = selected?.name === o.name;
            return (
              <li
                key={o.name}
                className={isSel ? "object-item selected" : "object-item"}
                onClick={() => useScene.getState().select(o.name, o.watertight)}
                aria-selected={isSel}
              >
                <span className="object-name">{o.name}</span>
                <span className="object-meta">
                  {o.triangles} tri · {o.vertices} vtx
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="panel-hint">Loading scene…</p>
      )}
      {!scene && <p className="panel-hint">No scene.</p>}
    </section>
  );
}
