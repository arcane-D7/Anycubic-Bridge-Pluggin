# S9.8-001 — Context menus everywhere (2026-10-02, implementation in progress)

## AC rápidas (G35)

- **Uma** componente de menu (`ContextMenu`) para TODAS as superfícies: object tree rows,
  viewport background, plate tabs, timeline journal chips.
- Keyboard operable: ArrowUp/Down/Home/End/Esc/Enter/Space/Tab.
- Fecha em click-outside/Esc/Tab.

## Design

- `components/context-menu-core.ts` — puro (testável headless): `openContextMenuAt(pointer,
items, viewport?)` clampa x/y; `journalMenuItems`; tipos `ContextMenuItem`/`ContextMenuState`;
  constantes (margin 8, estWidth 220, estHeight 32/item).
- `components/context-menu-items.ts` — `buildObjectMenuItems(ctx, handlers)` (duplicate/rename/
  toggle-visible/place-on-plate/[repair-replace|repair-copy se !watertight]/delete danger) e
  `buildPlateMenuItems(moveTargets, handlers)` (dup/rename/move-<id> com header "Move objects to…").
- `state/context-menu.ts` — zustand store global `{state, open, close}` (headless, testável).
- `components/ContextMenu.tsx` — portal fixed + backdrop; role=menu; foco 1º item enabled;
  navegação teclado; `data-testid="context-menu"` / `context-item-<id>`.
- Montado UMA vez em `App.tsx`. ObjectTree/PlateTabs/Timeline/Viewport abrem via store.

## Notas de wiring

- ObjectTree: right-click na row E botão `obj-more` abrem o mesmo menu (openRowMenu).
- PlateTabs: right-click no tab abre (click no tab continua a ser switchTo; dbl-click rename inline).
- Timeline: right-click num chip `journal-rev-<n>` abre seek/reset.
- Viewport: right-click no background (fora de buttons/inputs/toolbar/plate-tabs/preview-
  controls) abre arrange/measure/import; meshes de objetos fazem stopPropagation no contextmenu.

## Licoes do round 1 do gate

- `state/context-menu.ts` importava `./context-menu-core` (caminho errado) → `../components/...`.
- `onSelect` de `ContextMenuItem` tem de ser **opcional** (headers/separadores) e o activate usa
  `item.onSelect?.()`.
- Tests `.mjs` NÃO têm TS — `as number[]` quebra parse do Node.
