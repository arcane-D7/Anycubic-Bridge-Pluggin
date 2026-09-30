import { create } from "zustand";

/**
 * Dock state (S9.1a-002) — panel mode + rect + z per PanelId, persisted to
 * localStorage (`anycubic:dock-state:v1`). Machine-agnostic: no repo literals,
 * values are viewport-relative so they clamp on any window size.
 */

export type PanelMode = "docked" | "floating" | "collapsed";

export interface PanelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type PanelId = "chat";

export interface PanelState {
  readonly mode: PanelMode;
  /** Viewport-relative rect (fraction of viewport for portability). */
  readonly rect: PanelRect;
  readonly z: number;
}

const STORAGE_KEY = "anycubic:dock-state:v1";

/** Default viewport-relative rect: 0.42×0.5 viewport, starting right-center. */
const DEFAULT_RECT: PanelRect = { x: 0.5, y: 0.22, w: 0.34, h: 0.5 };

export function clampRect(rect: PanelRect): PanelRect {
  const x = Math.min(0.9, Math.max(0, rect.x));
  const y = Math.min(0.8, Math.max(0, rect.y));
  const w = Math.min(0.9, Math.max(0.2, rect.w));
  const h = Math.min(0.9, Math.max(0.2, rect.h));
  return { x, y, w, h };
}

interface DockState {
  readonly panels: Record<PanelId, PanelState>;
  readonly activePanel: PanelId | null;
  readonly nextZ: number;
  readonly setPanelMode: (id: PanelId, mode: PanelMode) => void;
  readonly setPanelRect: (id: PanelId, rect: PanelRect) => void;
  readonly focusPanel: (id: PanelId) => void;
  readonly resetPanel: (id: PanelId) => void;
}

const initialPanels: Record<PanelId, PanelState> = {
  chat: { mode: "docked", rect: DEFAULT_RECT, z: 1 },
};

function loadPersisted(): Record<PanelId, PanelState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialPanels;
    const parsed = JSON.parse(raw) as Record<PanelId, PanelState>;
    const out: Record<PanelId, PanelState> = { chat: initialPanels.chat };
    const p = parsed.chat;
    if (p && (p.mode === "docked" || p.mode === "floating" || p.mode === "collapsed")) {
      out.chat = {
        mode: p.mode,
        rect: clampRect(p.rect ?? DEFAULT_RECT),
        z: typeof p.z === "number" ? p.z : 1,
      };
    }
    return out;
  } catch {
    return initialPanels;
  }
}

function persist(panels: Record<PanelId, PanelState>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(panels));
  } catch {
    /* storage unavailable — state still lives in memory */
  }
}

export const useDock = create<DockState>()((set, get) => ({
  panels: typeof window === "undefined" ? initialPanels : loadPersisted(),
  activePanel: null,
  nextZ: 2,

  setPanelMode: (id, mode) => {
    const panels = { ...get().panels };
    panels[id] = { ...panels[id], mode };
    persist(panels);
    set({ panels });
  },

  setPanelRect: (id, rect) => {
    const panels = { ...get().panels };
    panels[id] = { ...panels[id], rect: clampRect(rect) };
    set({ panels });
  },

  focusPanel: (id) => {
    const nextZ = get().nextZ + 1;
    const panels = { ...get().panels };
    panels[id] = { ...panels[id], z: nextZ };
    set({ panels, activePanel: id, nextZ });
  },

  resetPanel: (id) => {
    const panels = { ...get().panels };
    panels[id] = { mode: "docked", rect: DEFAULT_RECT, z: get().nextZ };
    persist(panels);
    set({ panels, activePanel: id });
  },
}));
