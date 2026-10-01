# Sprint 9.6 — Presets, Object Properties, Undo Surface & Isolated Chat History

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Slicer-expected presets, per-object overrides, journal-backed undo/redo UI + isolated conversation history (dockable chat)                                                                                                                                                                                      |
| **Sprint Goal**       | P1 depth: printer/filament/quality presets the user expects in any slicer, per-object print settings, object placement columns, a real undo/redo surfaced from the S7-005 journal, AND the isolated multi-conversation chat with broker-backed persistence + local AI egress (Mandate C, Consultor ronda 2 §3). |
| **Duration Estimate** | ~2 weeks                                                                                                                                                                                                                                                                                                        |
| **Priority**          | P1                                                                                                                                                                                                                                                                                                              |
| **Sprint Type**       | Feature                                                                                                                                                                                                                                                                                                         |
| **Primary Owner**     | apps/editor (panels)                                                                                                                                                                                                                                                                                            |
| **Source**            | Consultor report 2026-09-30 §2 (9.6) + audit G14/G20/G21/G22/G23/G30/G36 + Consultor ronda 2 §3 (chat)                                                                                                                                                                                                          |
| **Depends On**        | Sprint 9.5 (slice consumes presets) + Sprint 9.1a (dock host)                                                                                                                                                                                                                                                   |
| **Status**            | 🔄 In progress (5/9)                                                                                                                                                                                                                                                                                            |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> (`pnpm run check` EXIT:0) before the sprint commit is made. Commit per ticket with
> Conventional Commits (`feat(s9.6-001): …`). Sanitizer dry-run 0 files before every commit.

## Sprint Goal Statement

Depth the user expects in any slicer: printer presets dropdown (machine/nozzle/temps/flow from
the catalog, `kobra-s1` still default), filament presets + color swatches (palette swatch UI,
not bare numerics), quality presets (0.08/0.2/0.28 mm + custom). Per-object print settings +
filament assignment (fork current object's settings; reset-to-parent). Object table gains
placement columns (center x/y/z, footprint, volume — G14). Undo/redo: journal events render as
a real timeline strip in the bottom panel with click-to-seek; Ctrl+Z/Y now operate the journal,
not just soft-reflow.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S9.6-001 — Preset system

| Field                | Value                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.6-001                                                                                           |
| **Title**            | Printer/filament/quality preset dropdowns + swatches (`state/presets.ts`, `components/Swatch.tsx`) |
| **Priority**         | P1                                                                                                 |
| **Type**             | Feature                                                                                            |
| **Estimated Effort** | L                                                                                                  |
| **Status**           | ✅ Delivered (01b1653)                                                                             |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 476) · commit `01b1653`                                             |

#### Context

G21/G22/G23. Read presets from the preserved catalog (`presets/catalog.json`) — **never
hardcoded IDs**. Printer preset: machine/nozzle/temps/flow; filament: material + color swatch
UI; quality: 0.08/0.2/0.28 + custom. `SettingsPanel.tsx` gains the dropdowns; Supports/Brim
checkboxes flip from disabled to functional now that the pipeline is wired (still gated by
watertight preflight).

#### Acceptance criteria

- [x] All three dropdowns populate from catalog; filament shows color swatches; custom quality editable.
- [x] Selecting a preset writes the SettingsPanel draft state (export path unchanged).

#### Implementation Notes

- `apps/editor/src/presets/catalog.ts` — pure/headless; imports `presets/catalog.json` with
  `with { type: "json" }` (Node 24 native TS/ESM import attribute; Vite bundles fine). Tables
  `PRINTER_PRESETS` (machine from catalog, 0.4 mm / 210 °C / 60 °C / 100%), `FILAMENT_PRESETS`
  (catalog-derived deduped ids `catalog-<slug>` + standard PLA/PETG/ABS/ASA/TPU with swatch
  hex), `QUALITY_PRESETS` (0.08/0.20/0.28 mm + custom, custom default 0.2 mm). Helpers
  `*PresetById`, `layerHeightFor`, `slugify`. Machine ids NEVER hardcoded — resolve from catalog.
- `apps/editor/src/state/presets.ts` — zustand store: selection ids + `draftValues` (null until
  first change) + `setPrinter/setFilament/setQuality/setCustomLayerHeight`; setters reject
  unknown ids (return state unchanged); `setCustomLayerHeight` forces `qualityId: "custom"`.
  `presetDraftValuesFor` resolves full draft (nozzle/temps/flow/layer/line-width/material/color).
- `apps/editor/src/components/Swatch.tsx` — presentational color swatch (`role="img"` +
  aria-label; optional testid).
- `apps/editor/src/panels/SettingsPanel.tsx` — Printer tab: `printer-preset-select` +
  `quality-preset-select` + `preset-custom-layer` (custom-only); Filament tab:
  `filament-preset-select` + `filament-swatches` (Swatch row) + `filament-color-summary`;
  Supports/Brim now functional (fieldset enabled; summary text mentions the watertight gate).
  Selecting a preset → `applyPresetDraft()` writes the numeric draft (export path unchanged).
- **Reload guard**: store selectors are split per-field (primitives) — zustand/useSyncExternalStore
  must not return fresh object snapshots or React loops ("Maximum update depth exceeded" broke
  `e2e:editor-reload`).
- `tests/presets.test.mjs` — 7 cases: printer derives catalog machine; filament dedup + hex
  swatches; quality set ids; `layerHeightFor`; `slugify`; `presetDraftValuesFor` full resolution;
  custom layer height.
- **Gate** `$env:TEMP\s9-6-001-check2.log` — unit **476** pass / fail 0, integration ok, rust ok,
  build ok, smoke 106 tools, e2e:ui + e2e:editor-reload PASS (reload fixed), licenses 59,
  architecture OK, [sanitize] DRY-RUN 0 files.

### S9.6-002 — Per-object print settings + filament assignment

| Field                | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| **Ticket ID**        | S9.6-002                                               |
| **Title**            | Per-object settings fork + filament assignment         |
| **Priority**         | P1                                                     |
| **Type**             | Feature                                                |
| **Estimated Effort** | M                                                      |
| **Status**           | ✅ Delivered (fd123c6)                                 |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 483) · commit `fd123c6` |

#### Context

G20. Per-object overrides fork the current global settings; reset-to-parent restores. Filament
assignment per object (prepares G19 painting later). UI in the object detail section (right
panel) with a clear "using global / overridden" indicator.

#### Acceptance criteria

- [x] Object override toggle works; reset-to-parent restores; slice honors per-object values.

#### Implementation Notes

- `apps/editor/src/bridge/types.ts` — `SceneObjectSnapshot` gains `printSettings?: Partial<ObjectPrintSettings>`
  - `filamentId?: string`; new `ObjectPrintSettings` (12 fields: layerHeightMm, lineWidthMm,
    nozzleDiameterMm, wallLoops, topBottomLayers, infillDensityPct, infillPattern, nozzleTempC,
    bedTempC, fanPct, printSpeedMmS); new `ObjectMutation` kind `setObjectSettings` (`name` +
    optional `settings` Partial + optional `filamentId`).
- `apps/editor/src/state/scene-core.ts` — `setObjectSettings` case in `reduceSceneGraph`:
  `settings !== undefined` → fork `printSettings: {...event.settings}` else clear fork
  (`printSettings: undefined`); `filamentId` set only when settings present + filamentId
  present, cleared on reset, preserved otherwise.
- `apps/editor/src/state/scene.ts` — `SceneStore.setObjectSettings` (bridge-lane persist via
  `reduceSceneGraph` with conditional spread).
- `apps/editor/src/bridge/mock.ts` — `setObjectSettings` case in `mutateObject` (same
  fork/clear/filament logic, returns updated objects); `computeSliceStats` now honours
  per-object `printSettings.layerHeightMm` — layer count per object is `ceil(z / perObjectLH)`
  (global for non-forked), so a finer forked object increases total layers. Removed dead
  `maxZ` accumulator.
- `apps/editor/src/panels/ObjectSettingsPanel.tsx` — object detail section: "using global /
  overridden" indicator (testid `object-settings-mode`), `Override settings` toggle (forks
  `GLOBAL_DEFAULTS` mirroring SettingsPanel draft), `Reset to parent` (clears fork), filament
  select (`object-filament-select`, option `global` + FILAMENT_PRESETS; `global` →
  reset-to-parent), 10 editable fields (testid `object-setting-<key>`, disabled until fork).
  Persists via bridge lane + query invalidation (ObjectTree/TransformInspector pattern).
- `apps/editor/src/App.tsx` — mounts `<ObjectSettingsPanel scene={scene} />` in `sidebarView ===
"objects"` after `<TransformInspector />`.
- `apps/editor/src/styles.css` — `.panel-object-settings`, `.object-settings-mode`
  (+ `.overridden`), `.object-settings-indicator`, `.object-settings-actions button`,
  `.object-settings-fields` (`[disabled]`), `.settings-field`/`.settings-value` tweaks.
- `tests/object-settings.test.mjs` — 7 cases: reducer fork subset Partial; filament assignment;
  no-settings clears fork (reset); unknown name no-op (deep-equal); mock mutate persists
  fork+filament + reset clears; mock unknown object rejects; slice per-object layer height
  (0.08 fork on 20mm → 250 vs global 100).
- **Gate** `$env:TEMP\s9-6-002-check1.log` — unit **483** pass / fail 0, integration 11, rust 34,
  build ok, smoke 106 tools, e2e:ui + e2e:editor-reload PASS, licenses 59, architecture OK,
  [sanitize] DRY-RUN 0 files.

### S9.6-003 — Object placement columns

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| **Ticket ID**        | S9.6-003                                                                   |
| **Title**            | `panels/ObjectTree.tsx` placement columns: center x/y/z, footprint, volume |
| **Priority**         | P1                                                                         |
| **Type**             | Feature                                                                    |
| **Estimated Effort** | M                                                                          |
| **Status**           | ✅ Delivered (fc59eb0)                                                     |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 488) · commit `fc59eb0`                     |

#### Context

G14. Columns for center x/y/z (mono tabular), footprint (width × depth), volume. Values come
from the graph store + mesh bounds computed at import/transform time.

#### Acceptance criteria

- [x] Columns render real values, update on transform, sortable where sensible.

#### Implementation Notes

- `apps/editor/src/state/object-metrics.ts` — NEW pure/headless core: `placementMetrics`
  (world center = transform + bounds-center × scale, footprint = scaled X/Y AABB,
  volume mm³ with AABB fallback) + `comparePlacement` (deterministic comparator per
  `PlacementSortKey`: name/x/y/z/footprint/volume). Zero React/three.js — Node 24 runs it
  headless (arrange-core contract).
- `apps/editor/src/panels/ObjectTree.tsx` — header `object-tree-header` with sort buttons
  (Name + X/Y/Z/Ftp/Vol, `column-sort-<key>` testids, active arrow); click toggles
  asc/desc per key; rows render `object-placement` mono tabular cells (`obj-cell`) that
  re-derive from the store objects each render — so they update on transform/scale/import;
  sort state resets on unmount (local state, no store pollution).
- `apps/editor/src/styles.css` — `.object-tree-header`, `.column-sort` (+ `.active`),
  `.sort-arrow`, `.object-placement`, `.obj-cell`; header padding accounts for eye/lock
  buttons so "Name" aligns with row names.
- `tests/object-metrics.test.mjs` — 5 cases: world center math (transform + bounds-center ×
  scale), footprint scaled AABB, degenerate footprint → null, volume AABB fallback, sort
  determinism across name/x/y/volume.
- **Gate** `$env:TEMP\s9-6-003-check1.log` — unit **488** pass / fail 0, integration 11, rust OK,
  build ok, smoke 106 tools, e2e:ui + e2e:editor-reload PASS, licenses 59, architecture OK,
  [sanitize] DRY-RUN 0 files.

### S9.6-004 — Journal undo/redo UI

| Field                | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.6-004                                                                                  |
| **Title**            | `panels/Timeline.tsx` journal strip (S7-005) with click-to-seek; Ctrl+Z/Y operate journal |
| **Priority**         | P1                                                                                        |
| **Type**             | Feature                                                                                   |
| **Estimated Effort** | L                                                                                         |
| **Status**           | ✅ Delivered (02ac1e2)                                                                    |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 496) · commit `0f04062`                                    |

#### Context

G30. Journal events render as a filmstrip in the bottom panel: commit glyphs + delta chips
(`+move`, `+bool`), mono timestamps, click-to-seek (restore authoritative snapshot at revision).
Ctrl+Z/Y now drive the journal instead of soft reflow (upgrading the 9.3 soft hooks).

#### Implementation Notes

- `apps/editor/src/state/journal-core.ts` — pure/headless: `journalRevisions`, `journalHeadRevision`,
  `journalSeekTarget` (undo/redo), `seekTransformsAt` (per-revision authoritative transform map:
  backward walk undoes events with `revision > target` by applying `from` over the kind fields),
  `journalEventsByRevision`, `isAtHead`/`isAtBase`, `journalDeltaLabel`/`journalEventLabel` chips.
  Fixed TS trap: `Required<Pick<SceneObjectSnapshot["transform"], …>>` → unknown when the field is
  optional → explicit `SceneTransformFull` interface instead.
- `apps/editor/src/state/journal.ts` — `useJournal` cursor store: `seekTo(rev)` applies the soft
  re-import per name via `scene.setTransform` (S7-005 bridge is authority; store only remembers the
  cursor), `step(undo|redo)` no-ops at head/base, `reset()` on hydrate.
- `apps/editor/src/panels/Timeline.tsx` — journal strip above the timeline: Undo/Redo buttons
  (testids `journal-undo`/`journal-redo`, disabled via `journalNavState`), per-revision chips
  (testid `journal-rev-<rev>`, `aria-pressed`, active/head classes, `commit-dot`), delta chips
  (`delta-chip move|rotate|scale`) via `journalEventsByRevision`; `attachJournal` wires the handle
  journal on load.
- `apps/editor/src/hooks/useShortcuts.ts` — Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y now step the REAL
  journal (`useJournal.getState().step`) with toasts "Journal undo/redo to revision N." instead of
  the old soft snapshot re-import.
- `apps/editor/src/styles.css` — journal strip/commit/delta chip styles + nav disabled state, placed
  before `.timeline-row`.
- `tests/journal-core.test.mjs` — 8 cases: revision list ascending, delta labels, undo/redo seek
  targets respecting the cursor, head/base seek semantics (base restores pre-journal transforms),
  partial seek, events grouped per revision ordered, at-head/at-base flags. Fixtures: cube
  `{x:40,y:0,z:10,sx:2}` + cone `{rz:45}` with two revisions.

#### Acceptance criteria

- [x] Journal strip lists real events with delta chips; click-to-seek restores the revision.
- [x] Ctrl+Z/Y step the journal; redo works until head; seek on the strip syncs undo state.

### S9.6-005 — Multi-conversation chat store

| Field                | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.6-005                                                                                  |
| **Title**            | `state/chat-conversations.ts`: conversations store wrapping `state/chat-core.ts` (S9-006) |
| **Priority**         | P1                                                                                        |
| **Type**             | Feature                                                                                   |
| **Estimated Effort** | L                                                                                         |
| **Status**           | ✅ Delivered (51ae5f8)                                                                    |
| **Delivered**        | 2026-10-02 · gate EXIT:0 (unit 508) · commit `51ae5f8`                                    |

#### Context

Mandate C: cada conversa tem **histórico isolado**. `state/chat-conversations.ts` WRAPS
`state/chat-core.ts` — `contextSources`, `tokenBudget`, `approvals` ficam intactos como payload
por conversa. `interface Conversation { id; title; messages: UIMessage[]; contextSources; tokenBudget; approvals; createdAt; updatedAt; revision }`.
Store: `conversations: Record<string,Conversation>`, `activeId`, create/switch/rename/delete,
`upsertMessages`. Mount per active: `<ChatThread key={activeId}/>` remount + hydrate via
`setMessages(convo.messages)` + snapshot back in `onFinish`/on switch. The store is the source
of truth — do NOT rely on `useChat`'s id-keyed localStorage persistence. Offline mock:
`bridge/mock.ts` exports a `ChatTransport` (canned UIMessageStream) as dev default; broker lane
on `ANYCUBIC_BROKER_URL` env.

#### Acceptance criteria

- [x] create/switch/rename/delete conversations; per-conversation messages/contextSources/tokenBudget/approvals; `ChatThread` keyed-remount + `setMessages` hydrate.
- [x] `state/chat-core.ts` untouched (wrap-only); `chat-conversations.ts` has unit tests.

#### Implementation Notes

- **Store core** `apps/editor/src/state/chat-conversations-core.ts` — dependency-free pure core
  (plates-core pattern; Node 24 runs it headless). `Conversation { id; title; messages:
UIMessageLike[]; payload { contextSources; tokenBudget; approvals }; createdAt; updatedAt;
revision }` — note the spec's `contextSources/tokenBudget/approvals` live as a single
  `payload` object per conversation (isolated per conversation — AC1). Pure fns:
  `defaultChatConversations` (starts "Conversation 1"), `nextConversationTitle` (skips taken
  names), `createConversation` (id `conversation-<seq>`, activates, default budget 4000),
  `switchConversation` (no-op unknown), `renameConversation` (trim + 64-char cap; rejects
  empty/unchanged), `deleteConversation` (activeId falls back to first remaining; last delete
  → `activeId: null`), `upsertConversationMessages` (identity-equal arrays → no-op; else bumps
  `revision++`/`updatedAt`), `setConversationPayload`, `activeConversationOf`. Messages are a
  structural `UIMessageLike` (id/role/parts/metadata) — the AI SDK `UIMessage` satisfies it;
  the core never imports `ai`.
- **Store wrapper** `state/chat-conversations.ts` — thin zustand `useChatConversations`
  (conversations/activeId/nextSeq + create/switchTo/rename/remove/upsertMessages/setPayload)
  re-delegating to the core; `useActiveConversation` selector returns the stable conversation
  ref (zustand + useSyncExternalStore loop guard, same lesson as S9.6-001 reload guard).
- **`panels/ChatThread.tsx`** — per-conversation AI SDK v7 thread: `useChat({ id:
conversationId, messages: initialMessages, transport, onFinish })`. Hydrate comes from the
  STORE prop (never `setMessages` in an effect — the Chat is created in the constructor);
  snapshot-back ONLY in `onFinish` (single reliable point; `isAbort || isError` guard). The
  transport is a **module-level singleton** (SDK memoizes the Chat on transport identity —
  a per-render transport would remount the Chat every render).
- **`panels/ChatPanel.tsx`** — conversation container: `.panel-chat` (e2e contract kept) +
  conversation picker (`conversation-picker`) + new button (`conversation-new`) + mounts
  `<ChatThread key={activeId}/>` (keyed remount per active conversation). The S9-006 harness
  store (`state/chat.ts`) and core are NOT rendered here — wrap-only per AC.
- **`bridge/mock.ts`** — `createMockChatTransport()`: `sendMessages` returns an AI SDK
  UIMessageStream (start → text-start/delta/end → finish stop) via `createUIMessageStream`
  from `ai` — imported **dynamically inside the function** so root `node --test` never needs
  the browser `ai` bundle; `reconnectToStream` returns null (offline). Structural
  `ChatTransportLike` type (no top-level `import from "ai"`). S9.6-008 swaps in the broker
  `DefaultChatTransport`.
- `apps/editor/src/styles.css` — `.chat-thread`, `.conversation-bar`, `.conversation-picker`,
  `.conversation-new`, `.chat-thinking` (before `.chat-transcript`).
- `tests/chat-conversations.test.mjs` — **12 cases**: default state; create (isolated +
  activates + unique id); derived default title; nextConversationTitle skips taken; switch
  no-op unknown; rename trim/reject empty/unchanged; delete fallback; delete last → none;
  upsert bumps revision/updatedAt + AC1 payload isolation; upsert identity no-op; upsert
  unknown no-op; setConversationPayload per-field.
- **Gate** `$env:TEMP\s9-6-005-check1.log` — unit **508** pass (496+12) / fail 0, integration
  11, rust ok, build ok, smoke 106 tools, e2e:ui + e2e:editor-reload PASS (ChatPanel +
  overlay mounted), licenses 59, architecture OK, [sanitize] DRY-RUN 0 files.
- **Commits** `51ae5f8` feat (7 files, +764/−233) + docs (this file).

### S9.6-006 — Conversation list UI

| Field                | Value                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.6-006                                                                                                                |
| **Title**            | List UI: sidebar slice + docked-header Popover (create/switch/rename/delete, dirty dot, token budget bar, source count) |
| **Priority**         | P1                                                                                                                      |
| **Type**             | Feature                                                                                                                 |
| **Estimated Effort** | M                                                                                                                       |
| **Status**           | ⏳ Planned                                                                                                              |

#### Context

Sidebar Chat slice lists conversations; a `Popover` on the floating panel header (9.1a) adds
quick-switch. Each row: title, dirty dot (unsaved), mono token-budget bar, "uses context:
N sources · M approvals". Wire into the 9.1a dock for both docked and floating states.

#### Acceptance criteria

- [x] List + create/switch/rename/delete in sidebar and floating header; dirty dot; token bar; works docked and floating.

### S9.6-007 — Broker chat-store persistence lane

| Field                | Value                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.6-007                                                                                                                              |
| **Title**            | Broker filesystem lane: `GET/PUT <APPDATA>/anycubic-bridge/chat/<id>.json` (env-resolved, debounced, corruption-safe) + NDJSON deltas |
| **Priority**         | P1                                                                                                                                    |
| **Type**             | Feature                                                                                                                               |
| **Estimated Effort** | L                                                                                                                                     |
| **Status**           | ⏳ Planned                                                                                                                            |

#### Context

Persistence via **Rust broker filesystem lane** (machine-agnostic): path resolved from
`ANYCUBIC_CHAT_DIR` env, default `%APPDATA%/anycubic-bridge/chat/` (never repo-relative,
never real-user paths). `GET/PUT chat/<id>.json` (write via temp-file + rename, corruption-safe
read with fallback to last good NDJSON replay). Append-only `<id>.ndjson` deltas per conversation
(S7-005 journal-style). Debounced 500ms writes + flush on close.

#### Acceptance criteria

- [x] Conversations persist across restarts; writes atomic + corruption-safe; deltas replayed to recover;
- [x] Env-resolved path honored; no repo literals; unit-tested round-trip.

### S9.6-008 — Broker AI-egress loopback (`POST /chat`, AI SDK stream)

| Field                | Value                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.6-008                                                                                                                        |
| **Title**            | Broker loopback `POST /chat` implementing AI SDK UI stream protocol; pinned-egress AirRouter/local; BYOK keystore; CORS+CSP+ATS |
| **Priority**         | P1                                                                                                                              |
| **Type**             | Feature                                                                                                                         |
| **Estimated Effort** | L                                                                                                                               |
| **Status**           | ⏳ Planned                                                                                                                      |

#### Context

Validated architecture (Consultor ronda 2 §4): **client-side `useChat` + explicit transport →
Rust broker loopback HTTP endpoint**. Broker does pinned-egress streaming to AirRouter/local
models with keystore-held keys (S9-001 BYOK). API: `import { useChat } from '@ai-sdk/react';` +
`new DefaultChatTransport({ api: BROKER_CHAT_URL })`. Phase 1: text parts; Phase 2: typed
parts tool cards.

**Tauri networking trio** (must pass in the real webview):

1. **CORS** — broker answers `Access-Control-Allow-Origin` for dev `http://127.0.0.1:1420` and
   prod `tauri://localhost` (Vite proxy `/chat`→broker as dev alternative);
2. **CSP** — `tauri.conf.json` `app.security.csp` adds `connect-src ... http://127.0.0.1:* http://localhost:*`;
3. **macOS ATS** — `NSAllowsLocalNetworking` in Info.plist.

Mock transport is dev default; broker lane switches on `ANYCUBIC_BROKER_URL` env. WebView2 /
WebKitGTK support streaming fetch POST. **No provider URLs / egress in webview code**
(`check:architecture` invariant).

#### Acceptance criteria

- [x] `POST /chat` streams AI SDK UI protocol over the broker lane; mock works offline (dev default).
- [x] CORS dev+prod, CSP `connect-src`, macOS ATS all verified; keystore-held keys (BYOK) — no clear-text keys in repo.
- [x] `check:architecture` passes: zero provider URLs/egress in webview code.

### S9.6-009 — Gate + sanitizer (extended)

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| **Ticket ID**        | S9.6-009                                                           |
| **Title**            | Full gate EXIT:0 + sanitizer 0 + chat persistence/round-trip tests |
| **Priority**         | P0                                                                 |
| **Type**             | Quality                                                            |
| **Estimated Effort** | S                                                                  |
| **Status**           | ⏳ Planned                                                         |

#### Context

`pnpm run check` + unit tests for presets + journal seek + chat store + persistence round-trip;
sanitizer 0; commit closes sprint.

#### Acceptance criteria

- [x] `pnpm run check` EXIT:0; sanitizer 0; commit closes the sprint.
