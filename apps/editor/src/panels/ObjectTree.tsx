import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import type { SceneObjectSnapshot } from "../bridge/types";
import { Icon } from "../components/icons";
import { centerOnPlateTransform } from "../state/arrange-core";
import { comparePlacement, placementMetrics, type PlacementSortKey } from "../state/object-metrics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";

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

/** S9.6-003: compact numeric cell (mono, tabular). Absolute mm values get a
 * unit-less compact form (trailing zeros trimmed). */
function fmtMm(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const rounded = Math.round(v * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** S9.6-003: footprint cell — `w × d` as compact mm. */
function fmtFootprint(o: SceneObjectSnapshot): string {
  const m = placementMetrics(o);
  if (!m.footprint) return "—";
  return `${fmtMm(m.footprint.w)} × ${fmtMm(m.footprint.d)}`;
}

/** S9.6-003: volume cell — compact cm³-ish (mm³ → 1 decimal when ≥1000). */
function fmtVolume(o: SceneObjectSnapshot): string {
  const v = placementMetrics(o).volumeMm3;
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(1)} cm³`;
  return `${fmtMm(v)} mm³`;
}

/** Visual column set (S9.6-003). Stable order, headers double as sort buttons. */
const PLACEMENT_COLUMNS: ReadonlyArray<{ key: PlacementSortKey; label: string; title: string }> = [
  { key: "x", label: "X", title: "Center X (mm)" },
  { key: "y", label: "Y", title: "Center Y (mm)" },
  { key: "z", label: "Z", title: "Center Z (mm)" },
  { key: "footprint", label: "Ftp", title: "Footprint (w × d)" },
  { key: "volume", label: "Vol", title: "Volume" },
];

export function ObjectTree({ scene, onOpenImport }: ObjectTreeProps) {
  const queryClient = useQueryClient();
  const objects = useScene((s) => s.objects);
  const selectedNames = useScene((s) => s.selectedNames);
  const anchorName = useScene((s) => s.anchorName);
  const toggleSelect = useScene((s) => s.toggleSelect);
  const select = useScene((s) => s.select);
  const remove = useScene((s) => s.remove);
  const rename = useScene((s) => s.rename);
  const pushToast = useUi((s) => s.pushToast);
  const duplicate = useScene((s) => s.duplicate);
  const toggleVisible = useScene((s) => s.toggleVisible);
  const toggleLock = useScene((s) => s.toggleLock);
  const setTransform = useScene((s) => s.setTransform);

  // S9.6-003 — column sort state (header click toggles asc/desc per key).
  const [sortKey, setSortKey] = useState<PlacementSortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);

  /** Header click: same key toggles direction, new key defaults ascending. */
  const onSortHeader = (key: PlacementSortKey) => {
    if (key === sortKey) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  /** The ordered object list for render — selection ops act on the underlying
   * names, so sorting the render list is safe. */
  const sortedObjects = useMemo(() => {
    if (sortKey === "name") {
      const list = [...objects];
      return sortAsc
        ? list.sort((a, b) => a.name.localeCompare(b.name))
        : list.sort((a, b) => b.name.localeCompare(a.name));
    }
    const list = [...objects];
    list.sort((a, b) =>
      sortAsc ? comparePlacement(a, b, sortKey) : -comparePlacement(a, b, sortKey),
    );
    return list;
  }, [objects, sortKey, sortAsc]);

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

  /** S9.7-003 (G46): "Auto-repair" — watertight closure via the bridge repair
   * lane. `mode` = "replace" (in place) | "copy" (replace-as-copy). Toast on
   * success/failure; snapshot rehydrates the store after the lane commit. */
  const onRepair = async (o: SceneObjectSnapshot, mode: "replace" | "copy") => {
    if (!scene) return;
    try {
      const res = await scene.repair({ name: o.name, mode });
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
      if (!res.ok) {
        pushToast({ kind: "error", title: "Auto-repair", message: res.error });
        return;
      }
      const target = res.object !== o.name ? ` as "${res.object}"` : "";
      pushToast({
        kind: "success",
        title: "Auto-repair",
        message: `${o.name} is watertight${target}.`,
      });
    } catch (err) {
      console.warn("[object-tree] repair failed", err);
      pushToast({ kind: "error", title: "Auto-repair", message: "Bridge error during repair." });
    }
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
      <header className="object-tree-header" aria-label="Object columns">
        <button
          type="button"
          className={`column-sort${sortKey === "name" ? " active" : ""}`}
          data-testid="column-sort-name"
          title="Sort by name"
          onClick={() => onSortHeader("name")}
        >
          Name
          {sortKey === "name" ? (
            <svg className="sort-arrow" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
              <path d={sortAsc ? "M4 1 L7 6 H1 Z" : "M4 7 L1 2 H7 Z"} fill="currentColor" />
            </svg>
          ) : null}
        </button>
        {PLACEMENT_COLUMNS.map((col) => (
          <button
            key={col.key}
            type="button"
            className={`column-sort${sortKey === col.key ? " active" : ""}`}
            data-testid={`column-sort-${col.key}`}
            title={col.title}
            onClick={() => onSortHeader(col.key)}
          >
            {col.label}
            {sortKey === col.key ? (
              <svg className="sort-arrow" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <path d={sortAsc ? "M4 1 L7 6 H1 Z" : "M4 7 L1 2 H7 Z"} fill="currentColor" />
              </svg>
            ) : null}
          </button>
        ))}
      </header>
      <ul className="object-list">
        {sortedObjects.map((o) => {
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
                <span
                  className="object-name"
                  title={o.provenance ? `${o.name} — ${o.provenance}` : o.name}
                >
                  {o.name}
                  {/* S9.7-003 (G46) — non-watertight badge becomes the repair
                      entry point (AC-1: repair action available from the tree
                      row). One click = Auto-repair (replace in place); the
                      context menu offers replace-as-copy. */}
                  {!o.watertight ? (
                    <button
                      type="button"
                      className="obj-repair-badge"
                      title="Non-watertight — click to Auto-repair"
                      aria-label={`Auto-repair ${o.name}`}
                      data-testid={`repair-${CSS.escape(o.name)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRepair(o, "replace");
                      }}
                    >
                      <Icon name="wrench" size={12} />
                      repair
                    </button>
                  ) : null}
                </span>
              )}
              <span className="object-meta" aria-label="Mesh stats">
                {metaOf(o)}
              </span>
              <span className="object-placement" aria-label="Placement metrics">
                <span
                  className="obj-cell"
                  title="Center X (mm)"
                >{`${fmtMm(placementMetrics(o).center[0])}`}</span>
                <span
                  className="obj-cell"
                  title="Center Y (mm)"
                >{`${fmtMm(placementMetrics(o).center[1])}`}</span>
                <span
                  className="obj-cell"
                  title="Center Z (mm)"
                >{`${fmtMm(placementMetrics(o).center[2])}`}</span>
                <span className="obj-cell" title="Footprint (w × d)">
                  {fmtFootprint(o)}
                </span>
                <span className="obj-cell" title="Volume">
                  {fmtVolume(o)}
                </span>
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
                  {/* S9.7-003 (G46) — Auto-repair choices for non-watertight
                      objects (AC-1: replace / replace-as-copy). */}
                  {!o.watertight ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={(e: Event) => {
                          e.preventDefault();
                          void onRepair(o, "replace");
                        }}
                      >
                        <Icon name="wrench" size={14} /> Auto-repair (replace)
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={(e: Event) => {
                          e.preventDefault();
                          void onRepair(o, "copy");
                        }}
                      >
                        <Icon name="duplicate" size={14} /> Auto-repair (copy)
                      </DropdownMenuItem>
                    </>
                  ) : null}
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
