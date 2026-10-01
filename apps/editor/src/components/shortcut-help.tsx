import { useMemo } from "react";
import { SHORTCUT_HELP } from "../state/shortcuts";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";

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

/** id → i18n key for the visualised label (keys stay tech-neutral). */
const ID_TO_KEY: Readonly<Record<string, MsgKey>> = {
  "grab-move": "shortcut.object.grabMove",
  "grab-rotate": "shortcut.object.grabRotate",
  "grab-scale": "shortcut.object.grabScale",
  constrain: "shortcut.object.constrainAxis",
  confirm: "shortcut.object.grabConfirm",
  cancel: "shortcut.object.grabCancel",
  frame: "shortcut.help.frame",
  duplicate: "shortcut.object.duplicate",
  delete: "shortcut.object.delete",
  undo: "shortcut.edit.undo",
  redo: "shortcut.edit.redo",
  "tool-switch": "shortcut.help.toolSwitch",
};

export function ShortcutHelp() {
  const t = useI18n((s) => s.t);
  const groups = useMemo(
    () => [
      {
        title: t("shortcut.group.transform"),
        items: SHORTCUT_HELP.filter((s) =>
          ["grab-move", "grab-rotate", "grab-scale", "constrain", "confirm", "cancel"].includes(
            s.id,
          ),
        ),
      },
      {
        title: t("shortcut.group.tools"),
        items: SHORTCUT_HELP.filter((s) => s.id === "tool-switch"),
      },
      {
        title: t("shortcut.group.scene"),
        items: SHORTCUT_HELP.filter((s) => s.id === "frame"),
      },
      {
        title: t("shortcut.group.edit"),
        items: SHORTCUT_HELP.filter((s) => ["duplicate", "delete", "undo", "redo"].includes(s.id)),
      },
    ],
    [t],
  );

  return (
    <section
      className="shortcut-help"
      aria-label={t("app.shortcutHelp.aria")}
      data-testid="shortcut-help"
    >
      <header className="shortcut-help-title">{t("app.shortcutHelp.title")}</header>
      <div className="shortcut-help-groups" role="list">
        {groups.map((g) => (
          <div key={g.title} className="shortcut-help-group" role="listitem">
            <h4 className="shortcut-help-group-title">{g.title}</h4>
            <ul>
              {g.items.map((s) => (
                <li key={s.id} className="shortcut-help-row">
                  <span className="shortcut-help-label">
                    {t(ID_TO_KEY[s.id] ?? "shortcut.help.frame")}
                  </span>
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
