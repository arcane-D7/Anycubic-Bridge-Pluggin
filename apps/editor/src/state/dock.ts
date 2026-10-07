import { create } from "zustand";

/**
 * Dock state (S9.1a-002) — panel mode + rect + z per PanelId, persisted to
 * localStorage (`anycubic:dock-state:v2`). Machine-agnostic: no repo literals.
 *
 * Reference frame (2026-10-06 layout fix, Consultor): `PanelRect` is a fraction
 * of the CANVAS (`#viewport-frame`), NOT the window. The old v1 rects were
 * window-anchored — floating panels drifted across the left sidebar when the
 * window resize or sidebar toggle changed the canvas origin. v2 stores
 * canvas-relative rects; `loadPersisted` migrates v1 rects by translating
 * window fractions into canvas fractions and clamps them to the canvas band.
 */

export type PanelMode = "docked" | "floating" | "collapsed";

export interface PanelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type PanelId = "chat" | "device" | "transform";

export interface PanelState {
  readonly mode: PanelMode;
  /** Canvas-relative rect (fraction of the viewport frame, 0..1). */
  readonly rect: PanelRect;
  readonly z: number;
}

/** v1 storage: window-relative fractions + v2:layout marker. */
interface PersistedV2 {
  readonly version: 2;
  readonly panels: Record<PanelId, PanelState>;
}

export const DOCK_STORAGE_KEY = "anycubic:dock-state:v2";
const LEGACY_STORAGE_KEY = "anycubic:dock-state:v1";

/** Canvas-frame fallback when the element isn't mounted yet (e.g. SSR/tests).
 *  Returns the full viewport size so mig flash is a no-op. */
function canvasFrameSize(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: 0, h: 0 };
  const el = document.querySelector<HTMLElement>("#viewport-frame");
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 ? { w: r.width, h: r.height } : { w: 0, h: 0 };
}

/**
 * Default canvas-relative rect: 0.36×0.5 of the canvas, CENTERED on the
 * canvas. The model is the "main panel" users expect — not glued to the
 * window edge (v1) nor to the top-left (old floating panels).
 */
const DEFAULT_RECT: PanelRect = { x: 0.32, y: 0.25, w: 0.36, h: 0.5 };

/** Canvas inner inset (~12px on a typical 1000px-wide frame): keeps panels
 *  fully inside the frame; collapses gracefully when the panel is wide. */
const INSET = 0.012;

export function clampRect(rect: PanelRect): PanelRect {
  const w = Math.min(0.9, Math.max(0.2, rect.w));
  const h = Math.min(0.9, Math.max(0.3, rect.h));
  // Panel must lie entirely inside [INSET, 1-INSET] of the canvas; when the
  // panel is too wide the inset shrinks (never a negative/empty interval).
  const minX = Math.min(INSET, Math.max(0, 1 - w - INSET));
  const maxX = Math.max(minX, 1 - w - INSET);
  const minY = Math.min(INSET, Math.max(0, 1 - h - INSET));
  const maxY = Math.max(minY, 1 - h - INSET);
  const x = Math.min(Math.max(rect.x, minX), maxX);
  const y = Math.min(Math.max(rect.y, minY), maxY);
  return { x, y, w, h };
}

/** Translate a legacy v1 window-relative rect into canvas-relative fractions. */
export function migrateV1Rect(winRect: PanelRect): PanelRect {
  const { w: cw, h: ch } = canvasFrameSize();
  if (cw <= 0 || ch <= 0) return DEFAULT_RECT;
  // v1 x was window fraction; canvas starts at the window's left-panel width
  // (~ (330px / innerW)). The navbar + sidebar are roughly the left panel.
  const leftPanelRatio = 330 / window.innerWidth;
  const x = (winRect.x - leftPanelRatio) / (1 - leftPanelRatio);
  const y = winRect.y;
  return clampRect({ x, y, w: winRect.w, h: winRect.h });
}

/**
 * Load persisted panels, migrating v1 window-anchored rects to v2
 * canvas-anchored (and if a previous resize already stored a valid v2, keep
 * it but clamp to the current frame).
 */
function loadPersisted(): Record<PanelId, PanelState> {
  const initial = { ...initialPanels };
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    let parsed: PersistedV2 | null = null;
    if (raw) {
      const obj = JSON.parse(raw) as Partial<PersistedV2>;
      if (obj && obj.version === 2 && obj.panels) parsed = { version: 2, panels: obj.panels };
    }
    // No v2 yet — try the legacy v1 key.
    if (!parsed) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const legacyPanels = JSON.parse(legacy) as Record<PanelId, PanelState>;
        const migrated: Record<PanelId, PanelState> = { ...initial };
        for (const id of ["chat", "device", "transform"] as const) {
          const p = legacyPanels[id];
          if (!p) continue;
          migrated[id] = {
            mode:
              p.mode === "floating" || p.mode === "collapsed" || p.mode === "docked"
                ? p.mode
                : "collapsed",
            rect: migrateV1Rect(p.rect ?? DEFAULT_RECT),
            z: typeof p.z === "number" ? p.z : 1,
          };
        }
        // Persist the migrated rects under the v2 key and drop the legacy key.
        persist(migrated);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
    }
    if (parsed) {
      const out: Record<PanelId, PanelState> = { ...initial };
      for (const id of ["chat", "device", "transform"] as const) {
        const p = parsed.panels[id];
        if (!p) continue;
        out[id] = {
          mode:
            p.mode === "floating" || p.mode === "collapsed" || p.mode === "docked"
              ? p.mode
              : "collapsed",
          rect: clampRect(p.rect ?? DEFAULT_RECT),
          z: typeof p.z === "number" ? p.z : 1,
        };
      }
      return out;
    }
    return initial;
  } catch {
    return initial;
  }
}

function persist(panels: Record<PanelId, PanelState>) {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ version: 2, panels }));
  } catch {
    /* storage unavailable — state still lives in memory */
  }
}

interface DockState {
  readonly panels: Record<PanelId, PanelState>;
  readonly activePanel: PanelId | null;
  readonly nextZ: number;
  /** Device panel focus target set by status-bar chips (S9.9-006):
   *  tab + optional section id; DevicePanel settles/scrolls on mount. */
  readonly deviceFocus: { readonly tab: "monitor" | "filament"; readonly section?: string } | null;
  readonly setPanelMode: (id: PanelId, mode: PanelMode) => void;
  readonly setPanelRect: (id: PanelId, rect: PanelRect) => void;
  readonly focusPanel: (id: PanelId) => void;
  readonly focusDevicePanel: (tab: "monitor" | "filament", section?: string) => void;
  readonly resetPanel: (id: PanelId) => void;
}

const initialPanels: Record<PanelId, PanelState> = {
  // Default rect: canvas-centered (x=(1−w)/2 → 0.32 with w=0.36).
  chat: { mode: "docked", rect: DEFAULT_RECT, z: 1 },
  device: { mode: "collapsed", rect: DEFAULT_RECT, z: 1 },
  // Transform inspector is narrower by design.
  transform: { mode: "collapsed", rect: { x: 0.62, y: 0.2, w: 0.28, h: 0.46 }, z: 1 },
};

export const useDock = create<DockState>()((set, get) => ({
  panels: typeof window === "undefined" ? initialPanels : loadPersisted(),
  activePanel: null,
  nextZ: 2,
  deviceFocus: null,

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

  focusDevicePanel: (tab, section) => {
    const nextZ = get().nextZ + 1;
    const panels = { ...get().panels };
    panels.device = { ...panels.device, mode: "floating", z: nextZ };
    set({ panels, activePanel: "device", nextZ, deviceFocus: { tab, section } });
    persist(panels);
  },

  resetPanel: (id) => {
    const panels = { ...get().panels };
    panels[id] = { mode: "docked", rect: DEFAULT_RECT, z: get().nextZ };
    persist(panels);
    set({ panels, activePanel: id });
  },
}));
