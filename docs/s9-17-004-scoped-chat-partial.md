# S9.17-004 — NAV-05 Frontend Slice (PARTIAL / BEGIN)

> **Status: PARTIAL — begin, not complete.** This document records ONLY the
> NAV-05 frontend scope of S9.17-004 (project-scoped chat conversation
> context). NAV-04 (Live camera in Workbench), DEV-08 (on-demand camera with
> permission/source state), DEV-09 (unknown-job representation), and the
> end-to-end AI09 provider-context tool/backend isolation are **NOT** done.

---

## 1. What is implemented (frontend, verified)

Project-scoped chat conversations in the editor shell:

- **Schema**: `Conversation.projectId: string | null`. Legacy/unscoped
  conversations persist as `null` and are **never** auto-injected into a
  project (backward-compatible; existing conversations are not deleted).
- **Store state**: `currentProjectId`, `activeByProject` (per-scope last
  active conversation), `lastUsedProjectId`.
- **Scope keys (NAV-05 security fix)**: global scope is the raw literal
  `WORKSPACE_SCOPE_KEY = "workspace"`; every project scope is namespaced as
  `"project:" + encodeURIComponent(projectId)` (`PROJECT_SCOPE_PREFIX`), so
  the mapping is **injective**: a project literally id "workspace" produces
  `"project:workspace"` and can never merge into the global scope. The empty
  string `""` is a REAL project id → key `"project:"` (lossless round-trip;
  not folded into workspace). `projectIdFromScopeKey` decodes exactly
  (malformed/foreign keys → `null`, fail-closed).
- **Prototype-safety (NAV-05 security fix)**: every conversation lookup on
  user/foreign ids uses `Object.hasOwn` (never `in`), and all persisted map
  materialization (`LocalFallback.readBucket`, hydrate, `conversationsForScope`
  accumulation) uses `Object.create(null)` records with direct own-key
  assignment — hostile ids such as `__proto__`, `constructor`, `toString`,
  unicode/slash ids stay inert own properties and can never pollute
  `Object.prototype` or attach foreign state to a scope. Old `activeByProject`
  entries are NOT trusted as an id authority: hydration derives per-scope
  last-active from `conversation.projectId` (the new authority pattern);
  legacy unscoped (null) conversations stay global and are preserved.
- **Switching** (`enterProjectScope`): restores the scope's last-active
  conversation (validating `convo.projectId` matches, stale entries guarded);
  if none, creates a fresh conversation with a bounded id sequence. Same-scope
  - match is a strict no-op (returns the same state reference). Switching
    never deletes or rewrites legacy conversations. `switchConversation` never
    changes scope.
- **Persistence**: legacy key `anycubic:chat-store:v1` + per-project buckets
  `anycubic:chat-store:project:<id>`. Hydration merges legacy with all project
  buckets (no AllHistories drop), picks per-scope newest
  (updatedAt → createdAt → id), computes `nextSeq`, and never overwrites the
  current active scope on late async boot. Debounced writer 500 ms +
  `flushChatPersistenceNow` on unload. Backward migration verified: a
  pre-seeded v1 legacy map survives, new puts route to v1, no stray bucket.
- **UI**: `ChatPanel` shows a localized scope label
  (`chat.scope.project` → "Project: {name}" / "Projeto: {name}",
  `chat.scope.workspace` → "Workspace" / "Espaço de trabalho") plus
  `data-project-scope`; thread keyed `${scope}:${conversationId}`;
  `ConversationList` and the dock quick-switcher list **only** the current
  scope. Page-tab switches (Home ↔ Prepare ↔ Preview ↔ Workbench) never create
  conversations nor clear messages/camera/jobs.
- **Finish/abort race**: `ChatThread` captures `conversationIdRef` +
  `scopeAtMountRef` at mount. Unmount aborts the in-flight stream via a
  captured `stopRef` (never re-reads the unstable `chat` object identity, which
  previously killed legitimate mid-stream replies). `onFinish` writes ONLY to
  the ORIGINAL conversation (if it still exists) and never appends to a
  mismatched new scope — if the scope changed mid-stream, the finished turn is
  persisted to its original conversation (no AI-context leak) and the old
  stream runs to completion under cancel semantics.
- **Bridge**: create-handle snapshot exposes `projectId` and a readonly
  `bridgeSnapshot` (`{id, projectId, workspaceScope}`).

## 2. Tests & gate (actuals)

| Artifact                                                                                                                                                                | Result                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Unit — `chat-project-scope.test.mjs` (incl. NAV-05 adversarial: collision, hostile/empty/unicode ids, prototype refusal, delete isolation, hydrate "workspace" project) | 20/20 PASS             |
| Unit — `chat-persistence.test.mjs` (incl. NAV-05: raw-JSON hostile `__proto__` non-pollution, hostile-id round-trip buckets)                                            | 13/13 PASS             |
| Unit — `chat-conversations.test.mjs` (unchanged)                                                                                                                        | 15/15 PASS             |
| Unit total (full suite)                                                                                                                                                 | **845 pass / 0 fail**  |
| Integration                                                                                                                                                             | 11/11 PASS             |
| Rust (all crates + editor shell)                                                                                                                                        | PASS                   |
| Build (`scripts/build.mjs`)                                                                                                                                             | OK → `dist/server.mjs` |
| MCP smoke                                                                                                                                                               | 115 tools              |
| E2E ×4 (incl. `editor-chat-scope.e2e.mjs`)                                                                                                                              | PASS                   |
| Licenses                                                                                                                                                                | 59 OK                  |
| Architecture + sanitizer dry-run                                                                                                                                        | OK / 0 files           |
| `pnpm run check` standalone                                                                                                                                             | **exit 0**             |

E2E coverage map (`tests/e2e/editor-chat-scope.e2e.mjs`, real editor +
synthetic Tauri): continue A → labeled scope + scope-a message; page tabs
don't clear; recover B → fresh scope (no A leak) + scope-b message; back to A
→ original A transcript restored, B absent; persisted entries carry explicit
`projectId`; no scope's history dropped; reload (reopen) restores A only
(0 browser errors beyond tolerated favicon 404). **NAV-05 additions**: after
reload the global scope label reads "Workspace" with `data-project-scope`
`"workspace"`; the final collision leg (project id "workspace", display name
"Synthetic Workspace Project") asserts the label reads "Project: Synthetic
Workspace Project" — distinct from "Workspace" — with `data-project-scope`
`"project:workspace"`, empty transcript (no cross-scope leak).

## 3. UI evidence

`local-scripts/capture-s19-017-004-ui.mjs` →
`poc-output/ui-check-s19-017-004/` and, for the NAV-05 fix,
`local-scripts/capture-s19-017-004b-scopekey-ui.mjs` →
`poc-output/ui-check-s19-017-004b/` (both gitignored, never commit):

- 16/16 fresh matrix views (Home/Prepare/Preview/Workbench × desktop 1440×900 /
  mobile 390×844 × light/dark) re-captured for the NAV-05 build, each
  inspected with the image viewer.
- 3 NAV-05 scope-key collision proofs (light desktop, real provider +
  synthetic Tauri incl. a project id "workspace"):
  `proof-global-workspace-scope.png` (global label "Workspace",
  `data-project-scope="workspace"`), `proof-project-a-namespaced-key.png`
  (label "Project: Synthetic Project A", `data-project-scope`
  `"project:home-project-a"`),
  `proof-project-workspace-collision-resolved.png` (label "Project: Synthetic
  Workspace Project", `data-project-scope="project:workspace"` — visually and
  via DOM assert distinct from the global scope).
- Zero page errors / console errors; the only failed request is the dev
  favicon 404 (tolerated, reported separately). Captures also previously
  covered 3 A/B chat-scope transcript proofs.
- Visual: no defects found; the demo-mode Workbench view is intentionally
  sparse (no printer armed — expected with `?provider=demo`).

## 4. Known open items (NEXT)

- **NAV-04 / DEV-08**: Live camera preview in Workbench + on-demand camera with
  permission/source state — absent (untouched).
- **DEV-09**: unknown-job 3D representation / artifact freshness — not done.
- **AI09 provider context**: frontend metadata is attached
  (`metadata.projectScope = scopeKeyFor(scopeAtMount)`), and the frontend-side
  isolation is tested; the full provider-tool / backend isolation path is NOT
  yet verified end-to-end.
- **Backend**: Tauri `chat_store` lane is still flat-by-id; files carry
  `projectId` in JSON but the backend bucket-split is a reported TODO
  (scoped listing currently served by the frontend layer).
- No commits/pushes were made (working tree intentionally left dirty).

## 5. Files touched (this slice)

```
apps/editor/src/state/chat-conversations-core.ts   (schema + scope API)
apps/editor/src/state/chat-persistence.ts          (buckets + migration)
apps/editor/src/state/chat-conversations.ts        (store fields/hydrate/enter)
apps/editor/src/state/project-scope.ts             (useProjectScope, name guard)
apps/editor/src/state/i18n-core.ts                 (chat.scope.* keys)
apps/editor/src/panels/ChatPanel.tsx               (scope label + thread key)
apps/editor/src/panels/ConversationList.tsx        (scope filter)
apps/editor/src/panels/ChatThread.tsx              (scope-hold + abort/finish guard)
apps/editor/src/components/dock/ConversationQuickSwitcher.tsx (scope filter)
apps/editor/src/App.tsx                            (activateProject scope entry)
apps/editor/src/bridge/mock.ts, real-project-bridge.ts (projectId/bridgeSnapshot)
tests/chat-project-scope.test.mjs, tests/chat-persistence.test.mjs
tests/e2e/editor-chat-scope.e2e.mjs
local-scripts/capture-s19-017-004-ui.mjs
local-scripts/capture-s19-017-004b-scopekey-ui.mjs (NAV-05 fresh matrix + collision proofs)
```
