# S9.8-005 implementation notes — Full PT/EN i18n coverage (G38)

Complete PT/EN internationalization: every user-facing UI string in the
editor now flows through a single i18n store backed by a pure translation
table. No hardcoded UI strings remain in source. The language toggle switches
live (localStorage-persisted); the default locale follows the system locale.

## Design

- `state/i18n-core.ts` (pure, headless): `Locale = "en" | "pt-BR"`,
  `SUPPORTED_LOCALES`, `LOCALE_KEY`, `defaultLocale()` (reads
  `navigator.language`, pt-prefix → pt-BR, fallback en; Node-safe),
  `type MsgKey` (union of ~480 keys), `EN` / `PT_BR` tables with
  full parity (enforced by `localeKeysMatch`), `interpolate(template,
params?)` (unknown tokens stay visible — all tokens must be passed),
  `pluralTail` / `pluralObjects`.
- `state/i18n.ts` (zustand): `useI18n` with a stable `t(key, params?)`
  reference; `setLocale` persists to localStorage and hot-swaps both
  locale + `t`; boot reads the stored raw value.
- Components consume `const t = useI18n((s) => s.t)` and translate at the
  UI layer. Pure cores that are test-contracted stay untranslated (their
  labels are contracts, e.g. `context-menu-items.ts` `label === "Show"`).

## Files

| File                                                               | Purpose                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `state/i18n-core.ts`                                               | Pure translation table + locale resolution (new)                                                          |
| `state/i18n.ts`                                                    | zustand i18n store: stable `t`, live toggle, persistence (new)                                            |
| `tests/i18n.test.mjs`                                              | 9 headless tests: default locale, keys parity EN↔PT, interpolation, plural helpers, spot-checks (new)     |
| `App.tsx`                                                          | Header, IR panel, plate heading, divider, sidebar, viewport aria                                          |
| `components/status-bar.tsx`                                        | Objects/units/volume/coords/plate dims/revision/dirty                                                     |
| `components/Toolbar.tsx`                                           | Group arias + tool titles                                                                                 |
| `components/PrinterPicker.tsx`                                     | Operator fallback + volume                                                                                |
| `components/theme-toggle.tsx`                                      | Light/Dark/System options                                                                                 |
| `components/SliceButton.tsx`                                       | Slice / cancel                                                                                            |
| `components/SliceProgress.tsx`                                     | Stage labels + progress                                                                                   |
| `components/shortcut-help.tsx`                                     | Keyboard shortcut help (groups + items)                                                                   |
| `components/toast-viewport.tsx`                                    | Toast dismiss aria                                                                                        |
| `components/dirty-chip.tsx`                                        | Unsaved/saved chip, save/restore labels + toasts                                                          |
| `components/ContextMenu.tsx`                                       | Context menu aria                                                                                         |
| `components/dock/*`                                                | dock-panel, FloatingPanelHost, ConversationQuickSwitcher                                                  |
| `dialogs/PrintJobDialog.tsx`                                       | Send-approval dialog: stages, token, payload-changed, reject/approve/dismiss, sent/failure toasts         |
| `panels/SettingsPanel.tsx`                                         | Tabs, printer, language toggle (`settings-language`), filament/process/export settings + supports summary |
| `panels/Timeline.tsx`                                              | Journal strip, undo/redo, slicing header, nonplanar hints                                                 |
| `panels/BooleanToolPanel.tsx`                                      | Union/Subtract/Intersect op labels, preview, committed                                                    |
| `panels/TransformInspector.tsx`                                    | Position/rotation/scale rows, absolute/relative, copy/reset                                               |
| `panels/ObjectSettingsPanel.tsx`                                   | Field labels, mode overridden/global, filament                                                            |
| `panels/ObjectTree.tsx`                                            | Row actions (rename/duplicate/delete/toggle), new-object menu                                             |
| `panels/ChatPanel.tsx` / `ChatThread.tsx` / `ConversationList.tsx` | Chat UI, thread, conversation list + quick switch                                                         |
| `panels/ImportDialog.tsx`                                          | Import dialog                                                                                             |
| `panels/SliceStatsPanel.tsx`                                       | Slice stats                                                                                               |
| `viewport/Viewport.tsx`                                            | Preview controls, context menu, drop hint                                                                 |
| `viewport/Labels.tsx`                                              | Object labels (watertight/repair/locked notes)                                                            |
| `viewport/PlateTabs.tsx`                                           | Plate tabs, unsaved dot, add                                                                              |
| `viewport/NonWatertightBadges.tsx`                                 | Repair badges                                                                                             |
| `viewport/ViewCube.tsx`                                            | View cube cells + aria                                                                                    |
| `viewport/MeasureReadout.tsx`                                      | Distance/radius/angle kinds + prompts                                                                     |
| `viewport/Toolbar.tsx`                                             | Tool names + arrange/fit                                                                                  |
| `viewport/SnapController.tsx`                                      | Snap readout step                                                                                         |
| `viewport/ModalInteraction.tsx`                                    | Numeric entry aria                                                                                        |

## New keys added this ticket

`send.dismiss`, `app.toast.dismissAria`, `modal.transformValueAria`,
`snap.step`, `dirty.unsaved/saved/tooltip/save.*/restore.*/toast.*`,
`measure.kind.radius/angle`, `viewport.repairLabel`, `shortcut.group.*`.

## Key contracts preserved

- `tests/boolean-tool.test.mjs` — `booleanOpLabel("add") === "Union"`
- `tests/shortcuts.test.mjs` — `grabLabel("move") === "move"`
- `tests/labels.test.mjs` — `chipLabel("Marble","watertight") === "Marble · watertight"`
- `tests/printjob-core.test.mjs` — stage labels "prepare"/"planar-core"/"IR"/"postprocess"/"preview"
- `tests/statusbar-core.test.mjs` — `unsavedCount`
- `tests/context-menu.test.mjs` — `context-menu-core.ts` + `context-menu-items.ts` fully
  untouched (labels are contract, incl. `label === "Show"`); only the shell
  `ContextMenu.tsx` aria migrated.
- All `data-testid` contracts + e2e selectors unchanged.

## Gate evidence

- unit: 577 (baseline) + 9 (i18n) = **586 pass / 0 fail**
- integration 11 · smoke 106 tools · licenses 59 · sanitize DRY-RUN 0
- `pnpm run check` EXIT:0
