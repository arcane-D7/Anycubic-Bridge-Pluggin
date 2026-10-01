import type { IconName } from "../components/icons";

/**
 * S9.8-001 shared context menu — the ONE menu component used by every surface
 * (object tree, viewport, plate tabs, timeline) so the G35 completion AC
 * ("all four surfaces open the same menu component") holds by construction.
 *
 * Pure/headless core — testable under `node --test` without React. The React
 * component (`ContextMenu` below) renders the state produced here.
 */

/** A single context-menu item. `separatorBefore` draws a divider above it. */
export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly separatorBefore?: boolean;
  /** Omitted only for headers/static rows — disabled items never fire. */
  readonly onSelect?: () => void;
}

/** Fully-resolved menu state: fixed viewport coordinates + item list. */
export interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
}

/** Menu sizing constants for the clamp (matches the CSS + viewport margins). */
export const CONTEXT_MENU_MARGIN = 8;
export const CONTEXT_MENU_EST_WIDTH = 220;
export const CONTEXT_MENU_EST_HEIGHT = 32; // per item, conservative (row + gap)

/** Pointer position source — structurally duck-typed so core stays headless. */
export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
}

/** Open the menu at a pointer event, clamped to the window viewport. */
export function openContextMenuAt(
  e: PointerLike,
  items: readonly ContextMenuItem[],
  viewport?: { readonly width: number; readonly height: number },
): ContextMenuState {
  const vw = viewport?.width ?? 0;
  const vh = viewport?.height ?? 0;
  const estH = items.length * CONTEXT_MENU_EST_HEIGHT + CONTEXT_MENU_MARGIN;
  const maxX = Math.max(CONTEXT_MENU_MARGIN, vw - CONTEXT_MENU_EST_WIDTH - CONTEXT_MENU_MARGIN);
  const maxY = Math.max(CONTEXT_MENU_MARGIN, vh - estH - CONTEXT_MENU_MARGIN);
  return {
    x: Math.min(Math.max(CONTEXT_MENU_MARGIN, e.clientX), maxX),
    y: Math.min(Math.max(CONTEXT_MENU_MARGIN, e.clientY), maxY),
    items,
  };
}

/** Interface for the journal/timeline menu. */
export interface JournalMenuInput {
  readonly revision: number;
  readonly atHead: boolean;
  readonly onSeek: (rev: number) => void;
  readonly onReset: () => void;
}

/** Timeline/journal items: seek to revision + reset to journal head. */
export function journalMenuItems({
  revision,
  atHead,
  onSeek,
  onReset,
}: JournalMenuInput): readonly ContextMenuItem[] {
  return [
    {
      id: `seek-${revision}`,
      label: `Seek to revision ${revision}`,
      icon: "undo",
      disabled: atHead,
      onSelect: () => onSeek(revision),
    },
    {
      id: "journal-reset",
      label: "Reset to journal head",
      icon: "redo",
      disabled: atHead,
      onSelect: onReset,
    },
  ];
}
