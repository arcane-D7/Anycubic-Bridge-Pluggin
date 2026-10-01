import { useMemo } from "react";
import { SHORTCUT_HELP } from "../state/shortcuts";

/**
 * S9.3-003 AC-2 — accessible shortcut summary.
 *
 * Renders the full key map as a structured list (kbd chips + labels +
 * groups). `role="list"` + labelled sections make it consumable by screen
 * readers; the trigger button aria-expands the panel (the toolbar already
 * exposes tooltips via the registry `label` field — this is the complete
 * summary surface).
 */

function chip(mods: readonly string[], keys: readonly string[]): string {
  const parts = [...mods, ...keys];
  return parts.join("+");
}

export function ShortcutHelp() {
  const groups = useMemo(
    () => [
      {
        title: "Transform",
        items: SHORTCUT_HELP.filter((s) =>
          ["grab-move", "grab-rotate", "grab-scale", "constrain", "confirm", "cancel"].includes(
            s.id,
          ),
        ),
      },
      {
        title: "Tools",
        items: SHORTCUT_HELP.filter((s) => s.id === "tool-switch"),
      },
      {
        title: "Scene",
        items: SHORTCUT_HELP.filter((s) => s.id === "frame"),
      },
      {
        title: "Edit",
        items: SHORTCUT_HELP.filter((s) => ["duplicate", "delete", "undo", "redo"].includes(s.id)),
      },
    ],
    [],
  );

  return (
    <section className="shortcut-help" aria-label="Keyboard shortcuts" data-testid="shortcut-help">
      <header className="shortcut-help-title">Keyboard shortcuts</header>
      <div className="shortcut-help-groups" role="list">
        {groups.map((g) => (
          <div key={g.title} className="shortcut-help-group" role="listitem">
            <h4 className="shortcut-help-group-title">{g.title}</h4>
            <ul>
              {g.items.map((s) => (
                <li key={s.id} className="shortcut-help-row">
                  <span className="shortcut-help-label">{s.label}</span>
                  <kbd className="shortcut-help-keys">{chip(s.ctrl ? ["Ctrl"] : [], s.keys)}</kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
