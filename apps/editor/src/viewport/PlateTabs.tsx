import { useRef, useState } from "react";
import type { BridgeHandle } from "../bridge/mock";
import type { SceneObjectSnapshot } from "../bridge/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { usePlates, type PlateDescriptor } from "../state/plates";
import { objectsOnPlate } from "../state/plates-core";
import { useQueryClient } from "@tanstack/react-query";

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
function chipTitle(plate: PlateDescriptor): string {
  return `${plate.name}${plate.dirty ? " · unsaved" : ""}`;
}

export function PlateTabs({ scene, objects }: PlateTabsProps) {
  const queryClient = useQueryClient();
  const { plates, activeId, add, switchTo, duplicate, rename } = usePlates();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  return (
    <div className="plate-tabs" data-testid="plate-tabs" role="tablist" aria-label="Plates">
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
          <DropdownMenu key={plate.id}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-selected={plate.id === activeId}
                data-testid={`plate-tab-${plate.id}`}
                className={`plate-tab${plate.id === activeId ? " is-active" : ""}`}
                title={chipTitle(plate)}
                onClick={() => switchTo(plate.id)}
                onDoubleClick={() => {
                  setEditingId(plate.id);
                  setDraft(plate.name);
                }}
              >
                <span>{plate.name}</span>
                {plate.dirty ? (
                  <span
                    className="plate-tab-dot"
                    data-testid={`plate-dot-${plate.id}`}
                    aria-label="Unsaved changes"
                  />
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" data-testid={`plate-menu-${plate.id}`}>
              <DropdownMenuItem
                data-testid={`plate-dup-${plate.id}`}
                onSelect={() => duplicate(plate.id)}
              >
                Duplicate plate
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`plate-rename-menu-${plate.id}`}
                onSelect={() => {
                  setEditingId(plate.id);
                  setDraft(plate.name);
                }}
              >
                Rename…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <span className="plate-menu-caption">Move objects to…</span>
              {plates
                .filter((other) => other.id !== plate.id)
                .map((other) => (
                  <DropdownMenuItem
                    key={other.id}
                    data-testid={`plate-move-${plate.id}-${other.id}`}
                    disabled={!objectsOnPlate(objects, plate.id).length}
                    onSelect={() =>
                      objectsOnPlate(objects, plate.id).forEach((o) =>
                        commitMoveTo(o.name, other.id),
                      )
                    }
                  >
                    {other.name}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      )}
      <button
        type="button"
        className="plate-tab plate-tab-add"
        data-testid="plate-add"
        aria-label="Add plate"
        title="Add plate"
        onClick={() => add()}
      >
        +
      </button>
    </div>
  );
}
