import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import type { SceneObjectSnapshot } from "../bridge/types";
import { Icon } from "../components/icons";
import { centerOnPlateTransform } from "../state/arrange-core";
import { comparePlacement, placementMetrics, type PlacementSortKey } from "../state/object-metrics";
import { openContextMenuAt } from "../components/context-menu-core";
import { buildObjectMenuItems } from "../components/context-menu-items";
import { useContextMenuStore } from "../state/context-menu";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";

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
const PLACEMENT_COLUMNS: ReadonlyArray<{
  key: PlacementSortKey;
  labelKey: MsgKey;
  titleKey: MsgKey;
}> = [
  { key: "x", labelKey: "objectTree.col.centerX", titleKey: "objectTree.col.centerX" },
  { key: "y", labelKey: "objectTree.col.centerY", titleKey: "objectTree.col.centerY" },
  { key: "z", labelKey: "objectTree.col.centerZ", titleKey: "objectTree.col.centerZ" },
  {
    key: "footprint",
    labelKey: "objectTree.col.footprintShort",
    titleKey: "objectTree.col.footprint",
  },
  { key: "volume", labelKey: "objectTree.col.volumeShort", titleKey: "objectTree.col.volume" },
];

export function ObjectTree({ scene, onOpenImport }: ObjectTreeProps) {
  const t = useI18n((s) => s.t);
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  // S9.8-001 — shared context menu (single store; one menu for all surfaces).
  const openMenu = useContextMenuStore((s) => s.open);

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
    openRowMenu(o, e);
  };

  /** Shared: object row "more" button and right-click both open the same
   * shared ContextMenu (S9.8-001) anchored at the pointer. */
  const openRowMenu = (
    o: SceneObjectSnapshot,
    e: { readonly clientX: number; readonly clientY: number },
  ) => {
    select(o.name, o.watertight);
    openMenu(
      openContextMenuAt(
        e,
        buildObjectMenuItems(
          { name: o.name, visible: o.visible, watertight: o.watertight },
          {
            onDuplicate: () => onDuplicate(o),
            onRename: () => {
              setEditing(o.name);
              setDraft(o.name);
            },
            onToggleVisible: () => onToggleVisible(o),
            onPlaceOnPlate: () => onPlaceOnPlate(o),
            onRepair: (mode) => void onRepair(o, mode),
            onRemove: () => onRemove(o),
          },
        ),
      ),
    );
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
      const target =
        res.object !== o.name ? t("objectTree.toast.repair.asCopy", { object: res.object }) : "";
      pushToast({
        kind: "success",
        title: t("objectTree.toast.repair.title"),
        message: t("objectTree.toast.repair.watertight", { name: o.name, target }),
      });
    } catch (err) {
      console.warn("[object-tree] repair failed", err);
      pushToast({
        kind: "error",
        title: t("objectTree.toast.repair.title"),
        message: t("objectTree.toast.repair.bridgeError"),
      });
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
    <section className="panel-object-tree" aria-label={t("objectTree.label")}>
      <header className="panel-title">{t("objectTree.title")}</header>
      {objects.length === 0 && !scene ? (
        <p className="panel-hint">{t("objectTree.loading")}</p>
      ) : null}
      {objects.length === 0 && scene ? <p className="panel-hint">{t("objectTree.empty")}</p> : null}
      <header className="object-tree-header" aria-label={t("objectTree.columns.aria")}>
        <button
          type="button"
          className={`column-sort${sortKey === "name" ? " active" : ""}`}
          data-testid="column-sort-name"
          title={t("objectTree.sortName.title")}
          onClick={() => onSortHeader("name")}
        >
          {t("objectTree.sortName")}
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
            title={t(col.titleKey)}
            onClick={() => onSortHeader(col.key)}
          >
            {t(col.labelKey)}
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
                title={o.visible ? t("objectTree.hide") : t("objectTree.show")}
                aria-label={o.visible ? t("objectTree.hideObj") : t("objectTree.showObj")}
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
                title={o.locked ? t("objectTree.unlock") : t("objectTree.lock")}
                aria-label={o.locked ? t("objectTree.unlockObj") : t("objectTree.lockObj")}
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
                  aria-label={t("objectTree.rename.aria")}
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
                  title={
                    o.provenance
                      ? t("objectTree.provenance", { name: o.name, provenance: o.provenance })
                      : o.name
                  }
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
                      title={t("objectTree.repair.title")}
                      aria-label={t("objectTree.repair.label", { name: o.name })}
                      data-testid={`repair-${CSS.escape(o.name)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRepair(o, "replace");
                      }}
                    >
                      <Icon name="wrench" size={12} />
                      {t("objectTree.repair")}
                    </button>
                  ) : null}
                </span>
              )}
              <span className="object-meta" aria-label={t("objectTree.mesh.aria")}>
                {metaOf(o)}
              </span>
              <span className="object-placement" aria-label={t("objectTree.placement.aria")}>
                <span
                  className="obj-cell"
                  title={t("objectTree.col.centerX")}
                >{`${fmtMm(placementMetrics(o).center[0])}`}</span>
                <span
                  className="obj-cell"
                  title={t("objectTree.col.centerY")}
                >{`${fmtMm(placementMetrics(o).center[1])}`}</span>
                <span
                  className="obj-cell"
                  title={t("objectTree.col.centerZ")}
                >{`${fmtMm(placementMetrics(o).center[2])}`}</span>
                <span className="obj-cell" title={t("objectTree.col.footprint")}>
                  {fmtFootprint(o)}
                </span>
                <span className="obj-cell" title={t("objectTree.col.volume")}>
                  {fmtVolume(o)}
                </span>
              </span>
              <button
                type="button"
                className="obj-action obj-more"
                title={t("objectTree.menu.title")}
                aria-label={t("objectTree.menu.aria", { name: o.name })}
                data-testid={`obj-more-${o.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openRowMenu(o, e);
                }}
              >
                <Icon name="chevron-down" size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <footer className="object-footer">
        <button
          type="button"
          className="obj-footer-btn"
          title={t("objectTree.add.title")}
          data-testid="object-add"
          disabled={!scene}
          onClick={onOpenImport}
        >
          <Icon name="plus" size={14} /> {t("objectTree.add")}
        </button>
        <button
          type="button"
          className="obj-footer-btn"
          title={t("objectTree.duplicate.title")}
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
          title={t("objectTree.delete.title")}
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
          title={t("objectTree.arrange.title")}
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
