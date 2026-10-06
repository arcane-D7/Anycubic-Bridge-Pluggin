import type { ContextMenuItem } from "./context-menu-core";

/**
 * S9.8-001 — pure builders for the shared context menu. Each surface maps its
 * actions to `ContextMenuItem[]` here so the layering (menu core → items →
 * component) stays headless-testable and every surface shares the same
 * component + item grammar.
 */

/** Actions the object-tree row menu can dispatch. */
export interface ObjectMenuHandlers {
  readonly onDuplicate: () => void;
  readonly onRename: () => void;
  readonly onToggleVisible: () => void;
  readonly onPlaceOnPlate: () => void;
  readonly onRepair: (mode: "replace" | "copy") => void;
  readonly onRemove: () => void;
  /** P1-7 — optional "More info" item opens the row's info popover. */
  readonly onMoreInfo?: () => void;
}

/** Context for buildObjectMenuItems. */
export interface ObjectMenuContext {
  readonly name: string;
  readonly visible: boolean;
  readonly watertight: boolean;
}

/** Row menu: duplicate/rename/hide/place-on-plate (+repair if not watertight
 * — the S9.7-003 repair lane only makes sense for non-watertight shells)/
 * delete. */
export function buildObjectMenuItems(
  ctx: ObjectMenuContext,
  handlers: ObjectMenuHandlers,
): readonly ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: "duplicate",
      label: "Duplicate",
      icon: "duplicate",
      onSelect: handlers.onDuplicate,
    },
    {
      id: "rename",
      label: "Rename",
      icon: "fit",
      onSelect: handlers.onRename,
    },
  ];
  // P1-7 — "More info" right-click entry (opens the same metrics popover as
  // the row (i) button).
  if (handlers.onMoreInfo) {
    items.push({
      id: "more-info",
      label: "More info",
      icon: "eye",
      onSelect: handlers.onMoreInfo,
    });
  }
  items.push(
    {
      id: "toggle-visible",
      label: ctx.visible ? "Hide" : "Show",
      icon: "eye",
      onSelect: handlers.onToggleVisible,
    },
    {
      id: "place-on-plate",
      label: "Place on plate",
      icon: "arrange",
      onSelect: handlers.onPlaceOnPlate,
    },
  );
  if (!ctx.watertight) {
    items.push(
      {
        id: "repair-replace",
        label: "Auto-repair (replace)",
        icon: "wrench",
        separatorBefore: true,
        onSelect: () => handlers.onRepair("replace"),
      },
      {
        id: "repair-copy",
        label: "Auto-repair (copy)",
        icon: "duplicate",
        onSelect: () => handlers.onRepair("copy"),
      },
    );
  }
  items.push({
    id: "delete",
    label: "Delete",
    icon: "trash",
    danger: true,
    separatorBefore: true,
    onSelect: handlers.onRemove,
  });
  void ctx.name;
  return items;
}

/** Actions the plate-tab menu can dispatch. */
export interface PlateMenuHandlers {
  readonly onDuplicate: () => void;
  readonly onRename: () => void;
  readonly onMoveTo: (targetPlateId: string) => void;
}

/**
 * Plate menu: duplicate / rename… / move objects to <target>. The move
 * targets are dynamic, so callers build this per plate.
 */
export function buildPlateMenuItems(
  moveTargets: readonly {
    readonly id: string;
    readonly name: string;
    readonly disabled: boolean;
  }[],
  handlers: PlateMenuHandlers,
): readonly ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: "plate-dup",
      label: "Duplicate plate",
      icon: "duplicate",
      onSelect: handlers.onDuplicate,
    },
    {
      id: "plate-rename",
      label: "Rename…",
      icon: "fit",
      onSelect: handlers.onRename,
    },
  ];
  if (moveTargets.length > 0) {
    items.push({
      id: "plate-move-header",
      label: "Move objects to…",
      icon: "arrange",
      separatorBefore: true,
      disabled: true,
    });
    for (const t of moveTargets) {
      items.push({
        id: `plate-move-${t.id}`,
        label: t.name,
        disabled: t.disabled,
        onSelect: () => handlers.onMoveTo(t.id),
      });
    }
  }
  return items;
}
