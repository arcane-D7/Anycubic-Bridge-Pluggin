# Sprint 9.1 — Design System Foundation + Shell Refresh

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Liquid-glass design system em **Tailwind CSS v4 + shadcn/ui** (tokens + light/dark themes), glass shell refresh, toast + shortcut scaffolding                                                                         |
| **Sprint Goal**       | Ship the design system as real Tailwind v4 tokens + shadcn components so the shell immediately reads as a slicer-grade app; stand up toast + status-bar + theme-toggle primitives that every later 9.x sprint reuses. |
| **Duration Estimate** | ~1 week                                                                                                                                                                                                               |
| **Priority**          | P0                                                                                                                                                                                                                    |
| **Sprint Type**       | Feature                                                                                                                                                                                                               |
| **Primary Owner**     | apps/editor (UI)                                                                                                                                                                                                      |
| **Source**            | Consultor report 2026-09-30 §3 (design system spec) + ronda 2 (Tailwind v4 + shadcn + AI SDK) + `docs/ui-gap-audit-2026-09-30.md` G39/G40                                                                             |
| **Depends On**        | Sprint 9 (R3)                                                                                                                                                                                                         |
| **Status**            | ✅ Delivered (2026-10-01, commits 3b7c2e0 → 85b72e3)                                                                                                                                                                  |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.1-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

**User Mandate A (2026-09-30): implementar tudo em Tailwind CSS @latest + lib de componentes
com visual forte E SDK de AI chat completo (shadcn/ui + AI Elements/Vercel AI SDK).**

Design tokens land first because everything else in 9.2–9.8 consumes them. The current
shell is a single hard-coded light theme (`:root --bg:#e5e7e6, --accent:#247348`) with
`.settings-*`, `.panel-*`, `.object-*` classes; `.viewport-frame` hard-codes `#d5d9d6`.
This sprint ports the token spec into **Tailwind v4** (`@import "tailwindcss"` +
`@theme`/`@theme inline` + `@custom-variant dark` + `@layer base/components`), adds
`data-theme` light/dark with `prefers-color-scheme` at boot and localStorage persistence,
initializes **shadcn/ui** (`pnpm dlx shadcn@latest init -t vite`) with our token values,
refreshes the shell (header/panels/footer) with frosted glass, and ships the toast bus +
status bar + theme toggle primitives. **Zero functional regression**: legacy class names
resolve through alias tokens (`--bg → --bg-base`, `--accent → --accent-primary`, …).

**Order is critical (Consultor):** run `shadcn init` FIRST (it rewrites the CSS head), THEN
overlay the spec tokens — never the reverse. The editor is a standalone **Vite 8.3.1 + React
19.3** project (not Next.js) — `@tailwindcss/vite` plugin is the documented path; Tauri
renders whatever Vite builds.

**License gate:** tailwindcss/@tailwindcss/vite (MIT), shadcn/ui (MIT), Radix (MIT), `ai`/
`@ai-sdk/react` (Apache-2.0), motion (MIT), cva (Apache-2.0), clsx/tailwind-merge (MIT) all
pass the repo's Apache/MIT-only rule. **EXCLUDED: lucide-react (ISC)** — ship a custom
`components/icons.tsx` inline-SVG set instead (also fits the mono toolpath-glyph aesthetic).

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.1-001 — Tailwind v4 token layers + shadcn init

| Field                | Value                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.1-001                                                                                                 |
| **Title**            | Port token spec into Tailwind v4 (`@theme`/layers) + `shadcn init -t vite`; alias-compat zero-regression |
| **Priority**         | P0                                                                                                       |
| **Type**             | Refactor                                                                                                 |
| **Estimated Effort** | L                                                                                                        |
| **Status**           | ✅ Delivered (3b7c2e0)                                                                                   |

#### Context

Consultor ronda 2 §2: this is **not** deletion of the token CSS — it's embedding it into
Tailwind v4's machinery. Exact shape:

```css
@import "tailwindcss";
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
@theme { --font-mono: ...; --radius: 6px; }
@theme inline { --color-*: var(--token); --blur-glass-*: ...; }
:root { /* spec §3.2 token values VERBATIM */ }
[data-theme="dark"] { /* spec §3.3 */ }
:root { /* shadcn semantic layer: --background:var(--bg-base); … */ }
@layer base { /* ALIAS-COMPAT BLOCK: --bg, --bg-panel, --accent, --danger … */ }
@layer components { .glass-surface { … } }
```

Install (order matters — init first, then overlay tokens, never reverse):

```bash
# in apps/editor
pnpm add tailwindcss @tailwindcss/vite motion ai @ai-sdk/react
pnpm add -D @types/node
# vite.config.ts: + tailwindcss() plugin; tsconfig: @/* → ./src/*
# src/index.css: @import "tailwindcss" (replaces old head)
pnpm dlx shadcn@latest init -t vite     # cssVariables: true (default)
pnpm dlx shadcn@latest add button input select toggle slider tooltip dialog dropdown-menu popover tabs scroll-area
```

Token namespace flat kebab-case under `:root`, grouped by prefix: `--bg-*`, `--glass-*`,
`--border-*`, `--text-*`, `--accent-*`, `--brand-*`, `--sema-*`, `--ctrl-*`, `--overlay-*`,
`--shadow-*`, `--blur-*`, `--r-*`, `--sp-*`, `--t-*`. Ship a migration alias block:

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

#### Acceptance criteria

- [x] Tailwind v4 layers (shared: type, shape, spacing, blur, elevation, timing) + `[data-theme]` light/dark token sets + `.glass-surface` recipe exist in `src/index.css` (or imported layers); `@theme`/`@theme inline` maps tokens to utilities (`bg-glass-1`, `backdrop-blur-glass-2`, …).
- [x] `shadcn init -t vite` done FIRST; shadcn semantic layer (`--background:var(--bg-base)`, `--card:var(--glass-fill-1)`, …) consumes our tokens.
- [x] Legacy classes still resolve via alias block — zero visual regression in existing features (verify visually in both themes).
- [x] `.viewport-frame` background uses `--viewport-bg` token, not hard-coded `#d5d9d6`.
- [x] `pnpm run check` admits new deps: tailwindcss, @tailwindcss/vite, Radix set, ai/@ai-sdk/react, motion, cva, clsx, tailwind-merge (Apache/MIT); **lucide-react NOT added**.

### S9.1-002 — Light/Dark themes + switching strategy

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.1-002                                                                         |
| **Title**            | `data-theme` light/dark + `@custom-variant dark` + boot resolution + persistence |
| **Priority**         | P0                                                                               |
| **Type**             | Feature                                                                          |
| **Estimated Effort** | M                                                                                |
| **Status**           | ✅ Delivered (d891fe4)                                                           |

#### Context

Tokens per `docs/design-system-liquid-glass.md` §3.3 (light: cool warm-neutral greys with
green undertone matching current; dark: `#10130f` base family, lifted brand `#3fa06b`);
values live in `:root[data-theme="light"]` / `[data-theme="dark"]` **under the raw `var()`
token layer** (so imperative canvas reads in RendererGuard are unaffected — spec §3.7.5).
Tailwind's utility dark path binds via `@custom-variant dark (&:where([data-theme=dark],
[data-theme=dark] *))` — **no media-query duplication** (Consultor ronda 2 §2).
Switch strategy per §3.7: `data-theme` on `<html>`, `localStorage['anycubic-theme']`, fallback
`system` → `matchMedia('(prefers-color-scheme: dark)')`, applied pre-paint in `index.html`
inline script to avoid flash. `@media (prefers-reduced-transparency: reduce)` drops blur.
3D canvas colors read via CSS var → `THREE.Color` on theme change (cheap imperative update in
`RendererGuard`) — unchanged by the Tailwind migration. shadcn dark components use the same
`[data-theme=dark]` via the custom variant (Radix primitives don't care).

#### Acceptance criteria

- [x] Both themes render via `data-theme` attr; toggle persists; `prefers-color-scheme` respected at boot.
- [x] `dark:` utilities resolve against `[data-theme=dark]` (custom variant); raw `var()` layer untouched.
- [x] Live theme swap needs no re-render (all colors via `var()`); canvas bg + grid follow theme (imperative `THREE.Color`).

### S9.1-003 — Glass shell refresh (header, side panels, footer, viewport chrome)

| Field                | Value                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.1-003                                                                                                       |
| **Title**            | Apply glass-surface recipe (`.glass-surface` + `bg-glass-N`/`backdrop-blur-glass-N` utilities) to shell chrome |
| **Priority**         | P0                                                                                                             |
| **Type**             | Feature                                                                                                        |
| **Estimated Effort** | M                                                                                                              |
| **Status**           | ✅ Delivered (95fefa5)                                                                                         |

#### Context

`.glass-surface` recipe: frosted fill `--glass-fill-N`, `backdrop-filter: blur(var(--blur-N))
saturate(1.15)` (+ `-webkit-` prefix), 1px `--glass-stroke` hairline, `--shadow-inset-hi`
specular top edge (per spec §3.4). Header/side panels/footer = fill-1/blur-1; floating
viewport toolbar/view cube = fill-2/blur-2; dialogs/toasts = fill-3/blur-3 over scrim.
New code can use the generated utilities (`bg-glass-1` + `backdrop-blur-glass-1`), legacy
classes keep the `.glass-surface` component-layer equivalent. **The viewport itself stays
solid** (`--viewport-bg` — blur behind canvas is unbudgeted GPU cost).

#### Acceptance criteria

- [x] Header, left panel, bottom timeline use frosted glass; viewport keeps solid bg.
- [x] Hairline borders + specular highlight read as one material across elements.
- [x] Text on glass AA in both themes (spec §3.8).

### S9.1-004 — shadcn UI primitives + custom icons

| Field                | Value                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.1-004                                                                                                                                                                      |
| **Title**            | shadcn components (button/input/select/toggle/slider/tooltip/dialog/dropdown-menu/popover/tabs/scroll-area) restyled by our tokens + `components/icons.tsx` (no lucide-react) |
| **Priority**         | P1                                                                                                                                                                            |
| **Type**             | Feature                                                                                                                                                                       |
| **Estimated Effort** | L                                                                                                                                                                             |
| **Status**           | ✅ Delivered (2b83689)                                                                                                                                                        |

#### Context

Consultor ronda 2 §1: `pnpm dlx shadcn@latest add button input select toggle slider tooltip
dialog dropdown-menu popover tabs scroll-area` (Radix primitives, MIT, React-19-compatible).
Primitives per spec §3.4/§3.5: buttons ≥24px hit area (28px standard), numeric inputs 36px tall
mono `tabular-nums`, toggles with `--track-*`, focus-visible 2px `--border-focus` ring, active
tool = accent text + 2px accent underline (toolpath motif). Primary (slice) = solid
`--accent-primary` + `--shadow-2`; secondary = `--ctrl-bg` frosted.
**Icons: NO lucide-react (ISC)** — hand-rolled inline-SVG `components/icons.tsx` (mono
toolpath-glyph aesthetic fits the spec better; keeps the Apache/MIT-only gate green).

#### Acceptance criteria

- [x] shadcn primitives installed and restyled with our tokens; both themes; keyboard-accessible (focus-visible, aria-pressed on toggles).
- [x] Density: rows 28–34px, numeric inputs 36px, 4px spacing grid respected.
- [x] Icons render from `components/icons.tsx`; no `lucide-react` in package.json.

### S9.1-005 — Toast system + status bar + theme toggle scaffolding

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.1-005                                                           |
| **Title**            | Toast bus, status bar (objects/units/volume/revision), ThemeToggle |
| **Priority**         | P1                                                                 |
| **Type**             | Feature                                                            |
| **Estimated Effort** | M                                                                  |
| **Status**           | ✅ Delivered (85b72e3)                                             |

#### Context

`state/ui.ts` gains `toasts` + `theme` slices. Toasts top-right, stacked, fill-3/blur-3,
semantic LED dot, auto-dismiss (shadcn `sonner`-style or our own; keep Apache/MIT).
Status bar (28px, bottom): object count, units, build volume, revision; theme toggle cycles
light↔dark with `system` as a sub-choice (shadcn `dropdown-menu` with light/dark/system).
Shortcut scaffolding registry (`state/shortcuts.ts`) is stubbed here (real shortcuts land in 9.3).

#### Acceptance criteria

- [x] Toast bus emits ≥1 demo toast with semantic colors; status bar shows the four fields.
- [x] Theme toggle works end-to-end (persists, no flash, no re-render).
- [x] Shortcut registry file scaffolds key binding map without wiring (9.3 consumer).

### S9.1-006 — Health gate + sanitizer

| Field                | Value                                                   |
| -------------------- | ------------------------------------------------------- |
| **Ticket ID**        | S9.1-006                                                |
| **Title**            | Full gate EXIT:0 + sanitizer 0 + new-deps license check |
| **Priority**         | P0                                                      |
| **Type**             | Quality                                                 |
| **Estimated Effort** | S                                                       |
| **Status**           | ✅ Delivered (2026-10-01)                               |

#### Context

Run `pnpm run check` (format/lint/typecheck/unit/integration/rust/build/smoke/e2e/licenses/architecture)

- `node scripts/sanitize-repo.mjs --dry-run` (0 files). Fix any regressions introduced by the
  Tailwind/shadcn migration before the sprint commit. `check:licenses` must admit the new stack
  (tailwindcss, @tailwindcss/vite, Radix, ai/@ai-sdk/react, motion, cva, clsx, tailwind-merge).

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer dry-run 0; commit closes the sprint.

## Execution Summary (2026-10-01)

**Result: ✅ Sprint delivered — all 6 tickets, `pnpm run check` EXIT:0 per commit, sanitizer dry-run 0 on every commit.**

| Commit  | Ticket   | What landed                                                                                                                                                                                                                                                                                                                                                    |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3b7c2e0 | S9.1-001 | Tailwind v4 token layers (`@import "tailwindcss"` + `@theme`/`@theme inline` + `@custom-variant dark`); **manual shadcn scaffold** (CLI is interactive-killed in this monorepo) — `components.json` + `src/lib/utils.ts` + 13 Radix UI components hand-written, `iconLibrary: none` (no lucide-react, ISC excluded); alias-compat block; `--viewport-bg` token |
| d891fe4 | S9.1-002 | `data-theme` light/dark + system boot resolution (pre-paint inline script, no flash) + `localStorage['anycubic-theme']`; `theme-toggle.tsx` (dropdown: Light/Dark/System); canvas bg + grid follow theme via CSS var + MutationObserver                                                                                                                        |
| 95fefa5 | S9.1-003 | Liquid-glass shell: `.app-header`/`.panel-left`/`.panel-right`/`.app-footer` frosted (fill-1/blur-1), `.viewport-preview-controls` fill-2/blur-2; removed legacy `:root` in styles.css (tokens single source in index.css)                                                                                                                                     |
| 2b83689 | S9.1-004 | `components/icons.tsx` inline-SVG set (19 icons, no lucide); density layer (28px buttons, 36px numeric inputs, mono tabular-nums)                                                                                                                                                                                                                              |
| 85b72e3 | S9.1-005 | Toast bus (`ui.ts` toasts slice) + `toast-viewport.tsx` (fill-3/blur-3, semantic LED, auto-dismiss, aria-live) + `status-bar.tsx` (objects/units/volume/revision) + `shortcuts.ts` registry stub + boot demo toast                                                                                                                                             |
| gate    | S9.1-006 | `pnpm run check` EXIT:0 (format/lint/typecheck/unit 295/integration/rust/5+35/build/smoke 106 tools/e2e:ui 4 objects/licenses 59 OK/architecture); sanitizer dry-run 0                                                                                                                                                                                         |

**Notes:**

- shadcn init CLI (Nova/Lucide preset prompt) is interactive and killed by the terminal harness — manual scaffold is the deterministic path here. Keep `iconLibrary: "none"`.
- `styles.css` legacy `:root` block removed so it cannot override the new token layer (import order: `index.css` first, then `styles.css`).
- Viewport canvas bg reads `--viewport-bg` at runtime with a `MutationObserver` on `data-theme` — theme swap needs no re-render.
- License gate green: 59 direct deps, all Apache/MIT or allowlisted (knip ISC dev-only, node-forge/replicad legacy). `motion@13.4.6` (MIT) admitted for 9.1a dock.
