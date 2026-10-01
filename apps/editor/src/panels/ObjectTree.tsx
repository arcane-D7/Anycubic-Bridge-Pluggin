import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import type { SceneObjectSnapshot } from "../bridge/types";
import { Icon } from "../components/icons";
import { centerOnPlateTransform } from "../state/arrange-core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useScene } from "../state/scene";

/**
 * Left panel — object tree (S9.2-004 full rework).
 *
 * Rows ≤32px with visibility eye + lock + ellipsis name + right-aligned mono
 * meta (`tri · vtx`). Inline rename on double-click; hover `--sel-hover`;
 * selected `--sel-bg` + 2px left accent rail; right-click context menu
 * (duplicate/rename/hide/delete); footer Add (import → S9.2-005)/Duplicate/
 * Delete/Arrange buttons.
 *
 * The object list is the AUTHORITATIVE scene store graph (hydrated in App
 * from the bridge snapshot). Every mutation walks the store CRUD lane and is
 * persisted to the bridge via `scene.mutateObject` (the provider handles the
 * real IPC in production — here it is the in-process mock).
 */

interface ObjectTreeProps {
  readonly scene: BridgeHandle | undefined;
  /** S9.2-005: footer Add opens the import dialog (entry point #1). */
  readonly onOpenImport: () => void;
}

function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Unquote the meta to the frozen convention: `2.4k tri · 1.8k vtx`. */
function metaOf(o: SceneObjectSnapshot): string {
  return `${fmtCount(o.triangles)} tri · ${fmtCount(o.vertices)} vtx`;
}

export function ObjectTree({ scene, onOpenImport }: ObjectTreeProps) {
  const queryClient = useQueryClient();
  const objects = useScene((s) => s.objects);
  const selectedNames = useScene((s) => s.selectedNames);
  const anchorName = useScene((s) => s.anchorName);
  const toggleSelect = useScene((s) => s.toggleSelect);
  const select = useScene((s) => s.select);
  const remove = useScene((s) => s.remove);
  const rename = useScene((s) => s.rename);
  const duplicate = useScene((s) => s.duplicate);
  const toggleVisible = useScene((s) => s.toggleVisible);
  const toggleLock = useScene((s) => s.toggleLock);
  const setTransform = useScene((s) => s.setTransform);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Object whose context menu is open (right-click row). */
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  /** Persist a graph-op to the bridge; failures surface as a toast-less row
   * drop (the store already reverted uncertain ops; the mock cannot fail
   * except on unknown names, which the store guards). After persistence the
   * snapshot query is invalidated so the authoritative re-fetch re-hydrates
   * the store (App) and the viewport/tree stay consistent — mutations are
   * never twin-edited locally. */
  const persist = useCallback(
    async (mutation: Parameters<BridgeHandle["mutateObject"]>[0]): Promise<void> => {
      if (!scene) return;
      try {
        const res = await scene.mutateObject(mutation);
        if (!res.ok) {
          console.warn(`[object-tree] mutate rejected: ${res.error}`);
        }
      } catch (err) {
        console.warn("[object-tree] mutate failed", err);
      }
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
    },
    [scene, queryClient],
  );

  const onRowClick = (o: SceneObjectSnapshot, e: React.MouseEvent) => {
    if (e.shiftKey) {
      toggleSelect(o.name, o.watertight);
    } else {
      select(o.name, o.watertight);
    }
  };

  const onRowContextMenu = (o: SceneObjectSnapshot, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    select(o.name, o.watertight);
    setOpenMenu(o.name);
  };

  const commitRename = (o: SceneObjectSnapshot) => {
    const from = o.name;
    const to = draft.trim();
    setEditing(null);
    if (!to || to === from) return;
    if (rename(from, to)) {
      void persist({ kind: "rename", from, to });
    }
  };

  const onDuplicate = (o: SceneObjectSnapshot) => {
    if (duplicate(o.name) !== null) {
      void persist({ kind: "duplicate", name: o.name });
    }
  };

  const onRemove = (o: SceneObjectSnapshot) => {
    const steps = remove(o.name);
    if (steps) void persist({ kind: "remove", name: o.name });
  };

  const onToggleVisible = (o: SceneObjectSnapshot) => {
    toggleVisible(o.name);
    void persist({ kind: "toggleVisible", name: o.name });
  };

  const onToggleLock = (o: SceneObjectSnapshot) => {
    toggleLock(o.name);
    void persist({ kind: "toggleLock", name: o.name });
  };

  /** S9.4-004 per-object "place on plate": centers X/Y + drops minZ to 0. */
  const onPlaceOnPlate = (o: SceneObjectSnapshot) => {
    const t = centerOnPlateTransform(o);
    setTransform(o.name, t);
    void persist({ kind: "setTransform", name: o.name, transform: t });
  };

  /** S9.4-004 auto-arrange (same lane as the toolbar Arrange). */
  const onAutoArrange = async () => {
    if (!scene) return;
    const res = await scene.arrange({
      plateW: scene.buildVolume?.widthMm,
      plateD: scene.buildVolume?.depthMm,
      gap: 2,
      center: true,
    });
    if (!res.ok) {
      console.warn("[object-tree] arrange rejected:", res.error);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
  };

  const hasSelection = selectedNames.length > 0;
  const anchor = anchorName ? objects.find((x) => x.name === anchorName) : undefined;

  return (
    <section className="panel-object-tree" aria-label="Object tree">
      <header className="panel-title">Objects</header>
      {objects.length === 0 && !scene ? <p className="panel-hint">Loading scene…</p> : null}
      {objects.length === 0 && scene ? <p className="panel-hint">No objects.</p> : null}
      <ul className="object-list">
        {objects.map((o) => {
          const isSel = selectedNames.includes(o.name);
          const isAnchor = anchorName === o.name;
          const classes = [
            "object-item",
            isSel ? "selected" : "",
            isAnchor && !isSel ? "anchor" : "",
            o.visible ? "" : "hidden-obj",
            o.locked ? "locked" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li
              key={o.name}
              data-name={o.name}
              className={classes}
              aria-selected={isSel}
              onClick={(e) => onRowClick(o, e)}
              onContextMenu={(e) => onRowContextMenu(o, e)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(o.name);
                setDraft(o.name);
              }}
            >
              <button
                type="button"
                className="obj-action obj-eye"
                title={o.visible ? "Hide" : "Show"}
                aria-label={o.visible ? "Hide object" : "Show object"}
                aria-pressed={o.visible}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleVisible(o);
                }}
              >
                <Icon name="eye" size={14} />
              </button>
              <button
                type="button"
                className="obj-action obj-lock"
                title={o.locked ? "Unlock" : "Lock"}
                aria-label={o.locked ? "Unlock object" : "Lock object"}
                aria-pressed={o.locked}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleLock(o);
                }}
              >
                <Icon name="lock" size={14} />
              </button>
              {editing === o.name ? (
                <input
                  ref={inputRef}
                  className="obj-rename"
                  value={draft}
                  aria-label="Rename object"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(o);
                    else if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => commitRename(o)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="object-name" title={o.name}>
                  {o.name}
                </span>
              )}
              <span className="object-meta" aria-label="Mesh stats">
                {metaOf(o)}
              </span>
              <DropdownMenu
                open={openMenu === o.name}
                onOpenChange={(open) => setOpenMenu(open ? o.name : null)}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="obj-action obj-more"
                    title="Object menu"
                    aria-label={`Actions for ${o.name}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon name="chevron-down" size={12} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  <DropdownMenuItem
                    onSelect={(e: Event) => {
                      e.preventDefault();
                      onDuplicate(o);
                    }}
                  >
                    <Icon name="duplicate" size={14} /> Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(e: Event) => {
                      e.preventDefault();
                      setEditing(o.name);
                      setDraft(o.name);
                    }}
                  >
                    <Icon name="fit" size={14} /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(e: Event) => {
                      e.preventDefault();
                      onToggleVisible(o);
                    }}
                  >
                    <Icon name="eye" size={14} /> {o.visible ? "Hide" : "Show"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(e: Event) => {
                      e.preventDefault();
                      onPlaceOnPlate(o);
                    }}
                  >
                    <Icon name="fit" size={14} /> Place on plate
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    onSelect={(e: Event) => {
                      e.preventDefault();
                      onRemove(o);
                    }}
                  >
                    <Icon name="trash" size={14} /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
      <footer className="object-footer">
        <button
          type="button"
          className="obj-footer-btn"
          title="Add object (import)"
          data-testid="object-add"
          disabled={!scene}
          onClick={onOpenImport}
        >
          <Icon name="plus" size={14} /> Add
        </button>
        <button
          type="button"
          className="obj-footer-btn"
          title="Duplicate selected"
          data-testid="object-duplicate"
          disabled={!hasSelection || !scene}
          onClick={() => {
            if (anchor) onDuplicate(anchor);
          }}
        >
          <Icon name="duplicate" size={14} />
        </button>
        <button
          type="button"
          className="obj-footer-btn"
          title="Delete selected"
          data-testid="object-delete"
          disabled={!hasSelection || !scene}
          onClick={() => {
            if (anchor) onRemove(anchor);
          }}
        >
          <Icon name="trash" size={14} />
        </button>
        <button
          type="button"
          className="obj-footer-btn"
          title="Arrange"
          data-testid="object-arrange"
          disabled={!scene}
          onClick={() => void onAutoArrange()}
        >
          <Icon name="arrange" size={14} />
        </button>
      </footer>
    </section>
  );
}
