import { useRef, useState } from "react";
import type { BridgeHandle } from "../bridge/mock";
import type { SceneObjectSnapshot } from "../bridge/types";
import { usePlates, type PlateDescriptor } from "../state/plates";
import { objectsOnPlate } from "../state/plates-core";
import { useQueryClient } from "@tanstack/react-query";
import { openContextMenuAt } from "../components/context-menu-core";
import { buildPlateMenuItems } from "../components/context-menu-items";
import { useContextMenuStore } from "../state/context-menu";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";

/** i18n `t` shape used by chipTitle (structural — avoids a hook in a helper). */
type T = (key: MsgKey, params?: Readonly<Record<string, string>>) => string;

/**
 * S9.4-003 plate tabs (G12) — floating chips above the bottom edge of the
 * viewport frame:
 *
 * - active chip = accent-soft fill + accent text
 * - "+" add chip
 * - rename via context menu; duplicate via context menu
 * - unsaved indicator = 3px dot (plate.dirty)
 * - per-plate object filter lives in the store; the viewport renders only the
 *   active plate's objects (`objectsOnPlate` shipped with the plate props).
 *
 * Cross-plate moves: the context menu is the AC-2 route here (drag-drop across
 * tabs lands S9.7 with real snapping). Each plate row's menu offers Move to
 * other plate → persistent via bridge mutateObject (kind: setPlate) patterns
 * mirroring the ObjectTree persist lane.
 */

interface PlateTabsProps {
  readonly scene?: BridgeHandle;
  readonly objects: readonly SceneObjectSnapshot[];
}

/** Chip title text with a visible keyboard shortcut affordance. */
function chipTitle(plate: PlateDescriptor, t: T): string {
  return plate.dirty ? t("plateTabs.unsaved", { name: plate.name }) : plate.name;
}

export function PlateTabs({ scene, objects }: PlateTabsProps) {
  const t = useI18n((s) => s.t);
  const queryClient = useQueryClient();
  const { plates, activeId, add, switchTo, duplicate, rename } = usePlates();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // S9.8-001 — shared context menu (single store; one menu for all surfaces).
  const openMenu = useContextMenuStore((s) => s.open);

  const persistMutation = async (mutation: Parameters<BridgeHandle["mutateObject"]>[0]) => {
    if (!scene) return;
    try {
      const res = await scene.mutateObject(mutation);
      if (!res.ok) console.warn(`[plate-tabs] mutate rejected: ${res.error}`);
    } catch (err) {
      console.warn("[plate-tabs] mutate failed", err);
    }
    await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
  };

  const commitRename = (id: string) => {
    const label = draft.trim();
    setEditingId(null);
    if (!label) return;
    rename(id, label);
  };

  const commitMoveTo = (name: string, targetPlate: string) => {
    if (name && targetPlate !== activeId) {
      void persistMutation({ kind: "setPlate", name, plateId: targetPlate });
    }
  };

  /** S9.8-001: right-click (or the header menu trigger) on a tab opens the
   * shared ContextMenu with duplicate/rename/move-here items. */
  const openPlateMenu = (
    plateId: string,
    e: { readonly clientX: number; readonly clientY: number },
  ) => {
    const plate = plates.find((p) => p.id === plateId);
    if (!plate) return;
    const moveTargets = plates
      .filter((other) => other.id !== plate.id)
      .map((other) => ({
        id: other.id,
        name: other.name,
        disabled: objectsOnPlate(objects, plate.id).length === 0,
      }));
    openMenu(
      openContextMenuAt(
        e,
        buildPlateMenuItems(moveTargets, {
          onDuplicate: () => duplicate(plate.id),
          onRename: () => {
            setEditingId(plate.id);
            setDraft(plate.name);
          },
          onMoveTo: (targetId) =>
            objectsOnPlate(objects, plate.id).forEach((o) => commitMoveTo(o.name, targetId)),
        }),
      ),
    );
  };

  return (
    <div
      className="plate-tabs"
      data-testid="plate-tabs"
      role="tablist"
      aria-label={t("plateTabs.aria")}
    >
      {plates.map((plate) =>
        editingId === plate.id ? (
          <input
            key={plate.id}
            ref={inputRef}
            className="plate-tabs-rename"
            data-testid={`plate-rename-${plate.id}`}
            defaultValue={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => commitRename(plate.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(plate.id);
              if (e.key === "Escape") setEditingId(null);
            }}
          />
        ) : (
          <button
            key={plate.id}
            type="button"
            role="tab"
            aria-selected={plate.id === activeId}
            data-testid={`plate-tab-${plate.id}`}
            className={`plate-tab${plate.id === activeId ? " is-active" : ""}`}
            title={chipTitle(plate, t)}
            onClick={() => switchTo(plate.id)}
            onDoubleClick={() => {
              setEditingId(plate.id);
              setDraft(plate.name);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openPlateMenu(plate.id, e);
            }}
          >
            <span>{plate.name}</span>
            {plate.dirty ? (
              <span
                className="plate-tab-dot"
                data-testid={`plate-dot-${plate.id}`}
                aria-label={t("plateTabs.unsavedDot")}
              />
            ) : null}
          </button>
        ),
      )}
      <button
        type="button"
        className="plate-tab plate-tab-add"
        data-testid="plate-add"
        aria-label={t("plateTabs.add.aria")}
        title={t("plateTabs.add.title")}
        onClick={() => add()}
      >
        +
      </button>
    </div>
  );
}
