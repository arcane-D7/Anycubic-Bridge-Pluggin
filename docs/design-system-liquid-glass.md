# Design System — "Liquid Glass × Engineering HUD"

**Source:** Consultor report 2026-09-30 (validated audit + design spec)
**Status:** Approved spec for Sprint 9.1 implementation
**Applies to:** `apps/editor` (Tauri 2 + React 19 + R3F + zustand)

---

## 1. Design Philosophy

**One ruling principle: the 3D viewport is the hero; glass is the substrate, not the decoration.**

1. **Liquid glass discipline** — translucency + blur are _functional devices_: they tier
   information (panel → floating tool → dialog) and let the plate geometry glow through
   panels. Every surface follows the same recipe — **frosted fill + 1px hairline + top
   specular highlight + soft drop shadow** — so the eye reads the system's material in one
   glance.
2. **Engineering temper** — engineering comes from: (a) **micro-labels** — 10–11px,
   uppercase, `+0.04em` tracking, mono numerals; (b) **precision** — hairline 1px borders,
   4px snap grid, `tabular-nums` everywhere numeric; (c) **toolpath motifs** — 1px accent
   hairline under the active tool, crosshair/dot-grid viewport backdrop, chamfered (not
   purely rounded) corners on accents; (d) **HUD layering** — viewport chrome (toolbar, view
   cube, readouts) floats _above_ the canvas with the highest glass clarity so geometry stays
   readable.
3. **Anti eye-candy rules** — saturation ≤ 60% across accent/semantic colors; blur never
   exceeds 24px in dense UI; no gradients larger than a 2-stop range; no glow on body text;
   glass tint stays within ±4 chroma points of the theme neutrals; floating elements always
   have ≥1px hairline border so they don't "melt" into each other.
4. **Density is a feature** — CAD means dense, operable controls: rows 28–34px, buttons ≥24px
   hit area, numeric inputs 36px tall, tight 4px grid spacing. Small text is _legal_ (10px
   mono readouts) because it is always supplementary to the plate view.

## 2. Naming Convention & Backward Compatibility

Token namespace flat kebab-case under `:root`, grouped by purpose prefix, **keeping the
existing core names alive as aliases** so no current class breaks:

```
--bg-*        surfaces/backgrounds           (aliases: --bg, --bg-panel, --bg-raised)
--glass-*     glass layers (fill/alpha/blur)
--border-*    hairline colors
--text-*      text hierarchy                 (aliases: --text, --text-dim)
--accent-*    brand + selection states       (alias: --accent)
--brand-*     brand-locked values
--sema-*      semantic states
--ctrl-*      controls (sliders/inputs/toggles)
--overlay-*   overlay/scrim colors
--shadow-*    elevations
--blur-*      blur levels
--r-*         radii, --sp-* spacing, --t-* type scale
```

**Migration alias block (must ship in 9.1 so zero regressions):**

```css
:root {
  --bg: var(--bg-base);
  --bg-panel: var(--bg-raised-1);
  --bg-raised: var(--bg-raised-2);
  --border: var(--border-default);
  --text: var(--text-primary);
  --text-dim: var(--text-secondary);
  --accent: var(--accent-primary);
  --danger: var(--sema-error);
}
```

## 3. Token Sets

### 3.1 Shared / theme-independent (`tokens.css`, `:root`)

```css
/* ---------- Type ---------- */
--font-ui: "Inter", "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: "JetBrains Mono", "Cascadia Mono", ui-monospace, Consolas, monospace;
--t-xs: 10px;
--t-sm: 11px;
--t-md: 12px;
--t-base: 13px;
--t-lg: 14px;
--t-xl: 16px;
--t-2xl: 18px;
--t-mono-sm: 11px;
--t-mono-md: 12px;
--t-mono-lg: 14px;
--track-wide: 0.04em;
--track-num: -0.01em;

/* ---------- Shape ---------- */
--r-none: 0;
--r-sm: 4px;
--r-md: 6px;
--r-lg: 10px;
--r-pill: 999px;
--r-chamfer-sm: 4px;
--r-chamfer-lg: 14px;

/* ---------- Spacing (4px grid) ---------- */
--sp-1: 4px;
--sp-2: 8px;
--sp-3: 12px;
--sp-4: 16px;
--sp-5: 20px;
--sp-6: 24px;
--sp-8: 32px;
--sp-10: 40px;

/* ---------- Blur levels ---------- */
--blur-1: 16px; /* side panels, header, footer     */
--blur-2: 24px; /* floating toolbar, view cube     */
--blur-3: 32px; /* dialogs, toasts                 */

/* ---------- Elevation ---------- */
--shadow-1: 0 1px 2px rgb(0 0 0 / 0.05), 0 4px 12px rgb(0 0 0 / 0.06);
--shadow-2: 0 2px 4px rgb(0 0 0 / 0.06), 0 12px 28px rgb(0 0 0 / 0.1);
--shadow-3: 0 4px 8px rgb(0 0 0 / 0.08), 0 24px 48px rgb(0 0 0 / 0.16);
--shadow-inset-hi: inset 0 1px 0 rgb(255 255 255 / 0.55);
--shadow-inset-io: inset 0 0 0 1px rgb(255 255 255 / 0.08), inset 0 1px 0 rgb(255 255 255 / 0.35);

/* ---------- Timing ---------- */
--dur-fast: 120ms;
--dur-med: 200ms;
--dur-slow: 320ms;
--ease-out: cubic-bezier(0.22, 1, 0.36, 1);
```

### 3.2 Light theme (`themes.css`)

```css
:root,
:root[data-theme="light"] {
  --bg-base: #e9ebe8; /* app backdrop            */
  --bg-raised-1: #f2f4f1; /* panels (opaque fallback)*/
  --bg-raised-2: #e2e5e1; /* raised controls         */
  --bg-sunken: #dde0dc; /* inputs wells, footer    */
  --bg-dialog: #f6f7f5; /* modal base              */

  --glass-fill-1: rgb(240 243 239 / 0.72); /* side panels / header    */
  --glass-fill-2: rgb(246 248 245 / 0.85); /* floating toolbar        */
  --glass-fill-3: rgb(250 251 249 / 0.92); /* dialogs / toasts        */
  --glass-stroke: rgb(255 255 255 / 0.55); /* glass hairline (white)  */
  --glass-spec: rgb(255 255 255 / 0.8); /* top-edge highlight      */

  --border-default: rgb(25 31 28 / 0.12);
  --border-strong: rgb(25 31 28 / 0.2);
  --border-focus: #4f9cf7;

  --text-primary: #191f1c; /* ≈15.9:1 on panels — AA+ */
  --text-secondary: #555e59; /* ≈6.4:1 on panels  — AA  */
  --text-tertiary: #6b746f;
  --text-disabled: rgb(25 31 28 / 0.38);
  --text-on-accent: #ffffff;

  --brand: #247348;
  --accent-primary: #247348;
  --accent-strong: #1d5e3c;
  --accent-soft: rgb(36 115 72 / 0.1);
  --accent-ring: rgb(36 115 72 / 0.28);

  --sema-success: #2a7a50;
  --sema-success-soft: rgb(42 122 80 / 0.1);
  --sema-warning: #9a6b16;
  --sema-warning-soft: rgb(176 116 24 / 0.12);
  --sema-error: #c23b2e;
  --sema-error-soft: rgb(194 59 46 / 0.1);
  --sema-info: #2f6bb5;
  --sema-info-soft: rgb(47 107 181 / 0.1);

  --sel-bg: rgb(36 115 72 / 0.12);
  --sel-hover: rgb(25 31 28 / 0.05);
  --sel-active: rgb(36 115 72 / 0.16);
  --sel-outline-3d: #4f9cf7;
  --sel-outline-glow: rgb(79 156 247 / 0.45);

  --ctrl-bg: rgb(255 255 255 / 0.55);
  --ctrl-bg-hover: rgb(255 255 255 / 0.85);
  --ctrl-well: rgb(25 31 28 / 0.045);
  --ctrl-border: rgb(25 31 28 / 0.16);
  --track-fill: #247348;
  --track-empty: rgb(25 31 28 / 0.1);

  --overlay-scrim: rgb(21 26 23 / 0.32);
  --viewport-bg: #d9ddd8; /* replaces hard-coded #d5d9d6 */
  --viewport-grid: rgb(25 31 28 / 0.08);
  --viewport-grid-strong: rgb(25 31 28 / 0.16);
}
```

### 3.3 Dark theme (`themes.css`)

```css
:root[data-theme="dark"] {
  --bg-base: #10130f;
  --bg-raised-1: #171b17;
  --bg-raised-2: #1d221d;
  --bg-sunken: #0c0f0c;
  --bg-dialog: #1a1f1a;

  --glass-fill-1: rgb(24 29 24 / 0.66);
  --glass-fill-2: rgb(30 36 30 / 0.8);
  --glass-fill-3: rgb(34 40 34 / 0.9);
  --glass-stroke: rgb(255 255 255 / 0.08); /* dark = white @ 8%      */
  --glass-spec: rgb(255 255 255 / 0.1);

  --border-default: rgb(255 255 255 / 0.09);
  --border-strong: rgb(255 255 255 / 0.18);
  --border-focus: #6aaef7;

  --text-primary: #e7ece7; /* ≈15:1 on panels — AA+  */
  --text-secondary: #a3ada5; /* ≈7.5:1 on panels — AA  */
  --text-tertiary: #8b958d;
  --text-disabled: rgb(231 236 231 / 0.36);
  --text-on-accent: #ffffff;

  --brand: #3fa06b; /* lifted brand for dark  */
  --accent-primary: #3fa06b;
  --accent-strong: #4cb57c;
  --accent-soft: rgb(63 160 107 / 0.16);
  --accent-ring: rgb(63 160 107 / 0.45);

  --sema-success: #4cb57c;
  --sema-success-soft: rgb(76 181 124 / 0.14);
  --sema-warning: #e2a63d;
  --sema-warning-soft: rgb(226 166 61 / 0.14);
  --sema-error: #e2634f;
  --sema-error-soft: rgb(226 99 79 / 0.14);
  --sema-info: #7fb0e8;
  --sema-info-soft: rgb(127 176 232 / 0.14);

  --sel-bg: rgb(63 160 107 / 0.16);
  --sel-hover: rgb(255 255 255 / 0.05);
  --sel-active: rgb(63 160 107 / 0.22);
  --sel-outline-3d: #6aaef7;
  --sel-outline-glow: rgb(106 174 247 / 0.55);

  --ctrl-bg: rgb(255 255 255 / 0.05);
  --ctrl-bg-hover: rgb(255 255 255 / 0.1);
  --ctrl-well: rgb(0 0 0 / 0.28);
  --ctrl-border: rgb(255 255 255 / 0.14);
  --track-fill: #3fa06b;
  --track-empty: rgb(255 255 255 / 0.1);

  --overlay-scrim: rgb(0 0 0 / 0.55);
  --viewport-bg: #151a15;
  --viewport-grid: rgb(255 255 255 / 0.06);
  --viewport-grid-strong: rgb(255 255 255 / 0.12);
}
```

**3D gizmo axis colors** (drawn on theme, not assets):

| Axis          | Light                                  | Dark      |
| ------------- | -------------------------------------- | --------- |
| X             | `#e0523f`                              | `#f2725f` |
| Y             | `#2f9e63`                              | `#4cb57c` |
| Z             | `#3f7fd4`                              | `#6aaef7` |
| White handles | `#f5f7f5` w/ `--glass-stroke` hairline | same      |

## 4. Glass Panel Patterns

The **recipe** that makes the system feel like one material:

```css
.glass-surface {
  background: var(--glass-fill-1);
  backdrop-filter: blur(var(--blur-1)) saturate(1.15);
  -webkit-backdrop-filter: blur(var(--blur-1)) saturate(1.15);
  border: 1px solid var(--glass-stroke);
  box-shadow: var(--shadow-inset-hi);
}
@media (prefers-reduced-transparency: reduce) {
  .glass-surface {
    backdrop-filter: none;
    background: var(--bg-raised-1);
  }
}
```

Where glass is **not** applied: the viewport itself (solid `--viewport-bg` — blur behind the
canvas is unbudgeted GPU cost), inputs inside panels (use `--ctrl-well`, frosted but flat),
and any surface under the cursor that needs a crisp hover (`--ctrl-bg-hover`).

| Element                                                  | Fill               | Blur       | Border                                         | Shadow                                                           |
| -------------------------------------------------------- | ------------------ | ---------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| Header / side panels / footer                            | `--glass-fill-1`   | `--blur-1` | `--glass-stroke`                               | `--shadow-inset-hi` + `--shadow-1`                               |
| Floating viewport toolbar, view cube, coordinate readout | `--glass-fill-2`   | `--blur-2` | `--glass-stroke` + 1px `--border-strong` inner | `--shadow-2` + `--shadow-inset-hi`                               |
| Dialogs / toasts / pickers                               | `--glass-fill-3`   | `--blur-3` | `--glass-stroke`                               | `--shadow-3` over `--overlay-scrim`                              |
| Buttons (secondary)                                      | `--ctrl-bg`        | `--blur-1` | `--ctrl-border`                                | hover → `--ctrl-bg-hover` + 1px `--accent-ring`                  |
| Buttons (primary/slice)                                  | `--accent-primary` | none       | none                                           | `--shadow-2`, hover → `--accent-strong`                          |
| Numeric inputs                                           | `--ctrl-well`      | none       | `--ctrl-border`                                | focus: 2px ring `--accent-ring` + `--border-focus`               |
| Chips / badges                                           | `--glass-fill-2`   | `--blur-1` | `--glass-stroke`                               | `--shadow-1`, 24px radius                                        |
| Toggle / slider track                                    | `--track-empty`    | none       | none                                           | fill `--track-fill`; thumb 12px `--text-on-accent` with 2px ring |

**Overlay discipline:** dialogs render over `--overlay-scrim` and never wider than
`min(520px, 92vw)`; toasts top-right, stacked, `--shadow-3`, 1px `--glass-stroke`, status LED
dot using semantic colors.

## 5. Typography

```css
body {
  font-family: var(--font-ui);
  font-size: var(--t-base);
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: 0;
}
```

| Role                                                  | Font               | Size    | Weight  | Style                                |
| ----------------------------------------------------- | ------------------ | ------- | ------- | ------------------------------------ |
| UI body / controls                                    | Inter              | 13px    | 400/500 | —                                    |
| Panel titles (uppercase micro-label)                  | Inter              | 11px    | 650     | `uppercase`, `+0.04em`               |
| Numeric readouts (coords, stats, transform, timeline) | JetBrains Mono     | 12px    | 500     | `font-variant-numeric: tabular-nums` |
| HUD readouts (bottom-left viewport)                   | JetBrains Mono     | 11px    | 500     | `tabular-nums`, secondary            |
| Inspector labels (X/Y/Z)                              | Inter              | 11px    | 500     | dim                                  |
| Dialog titles                                         | Inter              | 16px    | 650     | `-0.01em` tracking                   |
| Status bar                                            | Inter 12 / Mono 11 | 400/500 | —       | secondary, LEDs for status           |

Numbers _always_ mono+tabular in: transform inspector, object tree meta, slice stats,
timeline, status bar, budget bars.

## 6. Component-Level Specs

**Viewport HUD (top-center floating, `--glass-fill-2`)**

- Tool row: Select(Q) / Move(W) / Rotate(E) / Scale(R) | divider | Snap, Grid, Measure |
  divider | Arrange, Fit(F), View presets (iso/top/front/right). Active tool = accent text
  - 2px accent underline. 28px buttons, 2px gaps. Tooltips (110ms).
- View cube: bottom-right, 3×3 grid of faces/corners/edges from DOM (isometric "home"
  center), 84px glass tile, face hover = `--sel-bg`, click = damped camera tween.
- Coordinate readout: bottom-left mono `X 128.00  Y 84.50  Z 0.00`; temp value flashes
  while gizmo dragging.
- Selection outline: 2px `--sel-outline-3d` + 6px `--sel-outline-glow` halos; hidden while
  transient transform in progress. Non-watertight: `#b36a5e` tint + dashed edge overlay.

**Object tree rows (left panel)** — 32px rows: visibility eye (mono glyph 16px), lock, name
(13px, ellipsis), meta right-aligned mono 11px (`2.4k tri · 1.8k vtx`). States: hover
`--sel-hover`; selected `--sel-bg` + 2px left accent rail; context menu (right-click)
duplicates/rename/hide/delete. Footer: Add-Object (import), Duplicate, Delete, Arrange — 30px.

**Settings groups (right panel)** — collapsible `<details>` (matches `.settings-group`):
12px semibold titles, `--ctrl-well` fields, 36px numeric rows, mono values, focus ring
`--border-focus`. Disabled fields (pipeline not wired) at `--text-disabled` + inline "soon"
chip — honest, not dead.

**Timeline (bottom)** — filmstrip of journal events (S7-005): commit glyphs + delta chips
(`+move`, `+bool`), mono timestamps, click-to-seek; slicing mode selector kept. Background
`--glass-fill-1`, height `--bottom-panel-size` preserved.

**Chat / approval cards** — transcript bubbles `--glass-fill-2`; approval card states:
pending = warning border + LED, approved = accent border/icon, rejected = error + 0.7 opacity.
Token budget bar: `--track-empty/fill`, over → `--sema-error`.

**Plate tabs** — floating chips above bottom edge: `Plate 1` active = accent-soft fill +
accent text; + Add; rename via context menu; unsaved indicator = 3px dot.

**Status bar (bottom, 28px)** — left: object count, plate size, units; center: zoom-fit +
grid state; right: revision, dirty chip (`● 3 unsaved`), theme toggle, connection LED.

## 7. Dark/Light Switching Strategy

1. `data-theme` lives on `<html>`: `light | dark | system`.
2. Boot: `localStorage['anycubic-theme']`; missing → `system` → resolve via
   `matchMedia('(prefers-color-scheme: dark)')`; applied pre-paint in `index.html` inline
   script (no flash).
3. CSS: theme values in `:root[data-theme="light"]` / `[data-theme="dark"]`; **no**
   media-query duplication; `@media (prefers-reduced-transparency: reduce)` drops blur.
4. Toggle cycles light↔dark (system as a sub-choice). Live-swap needs no re-render: tokens
   drive every color via `var()`.
5. 3D canvas colors (`--viewport-bg`, grid, gizmo axes) read via CSS var → `THREE.Color` on
   theme change (cheap imperative update in `RendererGuard`).

## 8. Contrast & Legibility Rules (WCAG-ish AA)

- Body/UI text ≥11px uses `--text-primary`/`--text-secondary` — both AA even over
  `--glass-fill-1` (worst-case ≈5.2:1 light, 6.4:1 dark).
- 10px micro-labels are UI-context (non-essential) → `--text-tertiary` acceptable (≈3.1:1).
- Text never sits directly on an un-blurred photo-like surface; glass keeps ≥66% opacity fill.
- Semantic colors paired with `-soft` washes — never rely on hue alone (add icon/LED shape).
- Focus: `:focus-visible` = 2px `--border-focus` ring + offset on every control; viewport
  canvas keeps a `--accent-ring` outline when keyboard-focused.

## 9. Delivery Notes

- Implement in Sprint 9.1: `tokens.css` + `themes.css` + `components.css`, `data-theme`
  switching, glass shell, UI primitives, toasts/status bar/theme toggle, shortcut registry
  scaffold.
- Fonts: Inter + JetBrains Mono via system fallbacks (no bundled web fonts required; if
  needed, self-hosted subset under Apache/MIT-compatible license only).
- All colors above are original mixes derived from the existing green accent `#247348` —
  no proprietary assets.

---

## 10. Tailwind v4 Delivery Mapping (Addendum — 2026-09-30, Consultor ronda 2)

Sprint 9.1 implements this spec **in Tailwind CSS v4 + shadcn/ui**. Migration is _embedding_,
not deletion — the raw `var()` token layer stays the single source of truth, and Tailwind
consumes it:

- `src/index.css`:
  - `@import "tailwindcss";`
  - `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` — utility
    `dark:` binds to our `data-theme` attribute (NO media-query duplication).
  - `@theme { --font-mono: …; --radius: 6px; … }` — static theme values.
  - `@theme inline { --color-*: var(--token); --blur-glass-*: var(--blur-*); … }` —
    exposes tokens as utilities (`bg-glass-1`, `backdrop-blur-glass-1`, `text-primary`, …).
  - `:root { … }` / `[data-theme="dark"] { … }` — the spec's light (§3.3) and dark token
    values **verbatim**, unchanged.
- shadcn semantic layer consumes our tokens (`--background:var(--bg-base); --card:var(--glass-fill-1);
--primary:var(--accent-primary); --border:var(--border-default); --ring:var(--accent-ring)`).
- `@layer base` keeps an alias-compat block (`--bg:var(--bg-base); --bg-panel:…; --border:…;
--text:…; --accent:…; --danger:…`) so legacy classes resolve with zero visual regression
  in both themes.
- `@layer components` defines `.glass-surface` (frosted fill + hairline + specular) and the
  filled/floating viewport toolbar recipes.
- **ORDER CRITICAL**: run `shadcn init` FIRST (it rewrites the CSS head), then overlay the
  token/`.glass-surface` layers — never the reverse.
- Canvas theming stays imperative (`THREE.Color` in `RendererGuard`) — untouched by Tailwind.
- Icons: **lucide-react excluded (ISC)**; custom `components/icons.tsx` inline-SVG set keeps
  the Apache/MIT-only gate green.
