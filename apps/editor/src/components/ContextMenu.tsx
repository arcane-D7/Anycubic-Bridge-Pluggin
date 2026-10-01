import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { useContextMenuStore } from "../state/context-menu";
import type { ContextMenuItem, ContextMenuState } from "./context-menu-core";

export type { ContextMenuItem, ContextMenuState };

/**
 * S9.8-001 shared glass context menu — the ONE menu for every surface
 * (object tree rows, viewport background, plate tabs, timeline journal
 * chips). Mounted ONCE in App; each surface opens it through the store:
 *
 *   const { open } = useContextMenuStore();
 *   open(openContextMenuAt(e, buildObjectMenuItems(ctx, handlers)));
 *
 * Keyboard: ArrowUp/Down/Home/End move focus, Enter/Space activate, Escape
 * closes, Tab closes (trap released). Click-outside closes. Focus starts on
 * the first enabled item. Rendered via a fixed-position portal so it never
 * needs a mounted trigger and survives any parent scroll/transform.
 */

export function ContextMenu() {
  const state = useContextMenuStore((s) => s.state);
  const close = useContextMenuStore((s) => s.close);
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset the keyboard cursor whenever the menu (re)opens.
  const items = state?.items ?? [];
  useEffect(() => {
    if (state) setFocusIndex(0);
  }, [state]);

  useLayoutEffect(() => {
    if (!state || !listRef.current) return;
    const els = [...listRef.current.querySelectorAll<HTMLElement>("[data-menu-index]")];
    const first = els.find((el) => !el.hasAttribute("aria-disabled")) ?? els[0];
    first?.focus();
  }, [state]);

  if (!state) return null;

  const enabled = items
    .map((it, i) => ({ it, i }))
    .filter((x) => !x.it.disabled && x.it.id !== "—");

  const move = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const cur = enabled.findIndex((x) => x.i === focusIndex);
    const next = enabled[(cur + dir + enabled.length) % enabled.length];
    if (next) {
      setFocusIndex(next.i);
      listRef.current?.querySelector<HTMLElement>(`[data-menu-index="${next.i}"]`)?.focus();
    }
  };

  const activate = (i: number) => {
    const item = items[i];
    if (!item || item.disabled || item.id === "—") return;
    close();
    item.onSelect?.();
  };

  return createPortal(
    <div
      className="context-menu-backdrop"
      data-testid="context-menu-backdrop"
      onClick={close}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        ref={listRef}
        role="menu"
        aria-label="Context menu"
        data-testid="context-menu"
        className="context-menu"
        style={{ left: state.x, top: state.y }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Home") {
            e.preventDefault();
            if (enabled[0]) {
              setFocusIndex(enabled[0].i);
              listRef.current
                ?.querySelector<HTMLElement>(`[data-menu-index="${enabled[0]!.i}"]`)
                ?.focus();
            }
          } else if (e.key === "End") {
            e.preventDefault();
            const last = enabled[enabled.length - 1];
            if (last) {
              setFocusIndex(last.i);
              listRef.current?.querySelector<HTMLElement>(`[data-menu-index="${last.i}"]`)?.focus();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Tab") {
            e.preventDefault();
            close();
          }
        }}
      >
        {items.map((item, i) =>
          item.id === "—" ? (
            <div key={`sep-${i}`} className="context-menu-separator" role="separator" />
          ) : (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-menu-index={i}
              data-testid={`context-item-${item.id}`}
              data-danger={item.danger ? "true" : undefined}
              className="context-menu-item"
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              title={item.disabled ? item.label : undefined}
              onClick={(e) => {
                e.stopPropagation();
                activate(i);
              }}
              onMouseEnter={() => {
                if (!item.disabled) {
                  setFocusIndex(i);
                  listRef.current?.querySelector<HTMLElement>(`[data-menu-index="${i}"]`)?.focus();
                }
              }}
            >
              {item.icon ? (
                <Icon name={item.icon} size={14} />
              ) : (
                <span className="context-menu-icon-spacer" />
              )}
              <span>{item.label}</span>
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
