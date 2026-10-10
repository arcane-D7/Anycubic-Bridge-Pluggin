# Sprint 9.17 — Four-Page Workspace, History & Typed Device Transports

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sprint Name**       | Home, Prepare, Preview and Workbench with truthful local history and device state                                                                                                          |
| **Sprint Goal**       | Deliver coherent page responsibilities, local-first history and typed, capability-gated device transports without confusing profiles with connected hardware.                              |
| **Duration Estimate** | ~4 weeks                                                                                                                                                                                   |
| **Priority**          | P1                                                                                                                                                                                         |
| **Sprint Type**       | Feature + Integration                                                                                                                                                                      |
| **Primary Owner**     | apps/editor workspace and device providers                                                                                                                                                 |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-11/AUD-13; sections 7, 14, 19                                                           |
| **Depends On**        | Sprint 9.16                                                                                                                                                                                |
| **Status**            | 🔄 In progress — S9.17-001–002 complete; S9.17-003 partially implemented; S9.17-004 NAV-05 + Workbench Live frontend slices in progress (camera adapter + Tauri backend transport pending) |

> **📌 Gate-evidence reconciliation — 2026-10-10.** Gate numbers cited below (2026-10-09: 803 unit / 3 E2E; later slices: 838 unit / e2e×4; auth 27; broker 82) are **dated records of their runs, not current**. Verified today (two `pnpm run check` EXIT 0 runs covering the S9.17/S9.18 committed tree, plus a final run that reached licenses): **unit 879 / integration 11 / 5 E2E suites / smoke 115 tools / licenses 59 / sanitizer 0**. The E2E set today is cad-ui, editor-reload, editor-home, editor-chat-scope, broker-provider-status.

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Make Home the local workspace/history entry, Prepare the persistent authoring surface, Preview an honest artifact consumer, and Workbench the sole owner of live device operations. Device providers must distinguish declared profiles, stale snapshots, transport acceptance and observed effects. Hardware smoke tests require separate explicit permission and are not part of this sprint's automatic gate.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Use controlled transport stubs for command-path integration. Do not issue real heat, motion, feed, drying, upload or print commands.

## Tickets

### S9.17-001 — Local Home, recovery and separated histories

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.17-001                                                              |
| **Title**            | Build Home around local projects, recovery and truthful recent history |
| **Priority**         | P1                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | L                                                                      |
| **Source Finding**   | NAV-01; HIS-01–HIS-04; AUD-15                                          |
| **Status**           | ✅ Done — implementation and full health gate verified (2026-10-08)    |

#### Context

Projects, slice jobs and physical print history have distinct owners, identifiers and artifact availability. Home must remain useful without cloud login and must not invent missing history or reprint readiness.

#### Acceptance Criteria

- [x] **NAV-01:** Home opens/creates/recovers local projects without cloud authentication; controlled Home E2E verifies selected-project recovery and failed-recovery preservation.
- [x] **HIS-01:** Project and slice-job histories remain distinct; slice-job rows identify local origin. Physical print history is a separate cloud-owned, explicitly unavailable section.
- [x] **HIS-02:** Missing artifacts are reported as missing; recovery removes unavailable geometry and reports diagnostics without fabricating geometry.
- [x] **HIS-03:** Reprint intent invokes backend preflight, which validates artifact digest/provenance, source revision, destination profile/mode/tool binding and qualification; it records an intent only and never uploads or prints. Controlled E2E covers proposed/blocked replies and zero print-side effects. The runtime destination provider is explicitly unavailable, so no real printer qualification or hardware validation is claimed.
- [x] **HIS-04:** Local project and slice history remains independent of cloud print history; history read failure is shown explicitly.
- [x] Focused checks passed: Home unit 8/8, Home E2E (including reprint proposed/blocked paths and zero print-side effects), project-store Rust 14/14, Tauri slice-history test 1/1, TypeScript typecheck.
- [x] Full `pnpm run check` and sanitizer dry-run passed; see S9.17-001 Implementation Notes for recorded results.

#### Implementation Notes

- `home.ts` defines typed reprint-intent requests/replies and a pure proposal guard; Home calls the Tauri preflight command, not a printer command.
- Tauri delegates validation and intent persistence to `project-store`. The current destination adapter returns unavailable; controlled provider fixtures validate backend decisions without hardware access.
- Home E2E verifies proposed and blocked intent responses and asserts there are no upload/send/start/control/print calls. This is controlled UI/backend-contract evidence, not printer validation; no native Preview artifact or hardware outcome is claimed.
- Validation: Home unit 8/8; project-store 14/14; Tauri slice-history 1/1; Home E2E passed; TypeScript typecheck passed. Full-gate and sanitizer evidence is recorded in the task closeout.

### S9.17-002 — Persistent Prepare and empty Preview navigation

| Field                | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.17-002                                                                       |
| **Title**            | Preserve project authority across pages and provide a valid empty Preview state |
| **Priority**         | P1                                                                              |
| **Type**             | Feature                                                                         |
| **Estimated Effort** | M                                                                               |
| **Source Finding**   | NAV-02–NAV-03; audit section 7                                                  |
| **Status**           | ✅ Done — implementation and full health gate verified (2026-10-09)             |

#### Context

Page changes must not reconstruct the scene or silently cancel a job. Preview is a real destination even before an artifact exists and must direct the user to a valid slice action.

#### Acceptance Criteria

- [x] **NAV-02:** Prepare navigation preserves scene, selection and authoritative revision; controlled E2E confirms camera position/target continuity within 1e-5.
- [x] **NAV-03:** Preview opens without an artifact and displays an honest empty state with an actionable path back to Prepare.
- [x] Navigation during active jobs preserves or explicitly resolves job continuity; navigation does not silently cancel jobs.
- [x] Run full gate and sanitizer dry-run successfully after concurrent cloud-source edits settle.

#### Implementation Notes

- Prepare navigation retains the mounted authoring surface and job state; controlled reload E2E verifies camera position and target continuity with tolerance 1e-5.
- Preview provides an honest empty state and a navigation path to Prepare; no automatic slice is triggered.
- A pending controlled slice request survives navigation; its request identity stays unchanged, cancellation is not invoked, and completion on Home does not steal the active page.
- Full gate passed 2026-10-09: 803 unit tests, 11 integration tests, Rust checks/tests, 3 E2E flows, smoke 115 tools, 59 license entries, architecture check, sanitizer dry-run 0 files/0 groups.
- Validation used controlled Tauri/provider fixtures and browser E2E. This does not qualify native desktop Preview output or physical hardware.
- Screenshot captures were produced during focused checks, but visual interpretation remains unverified because the mandated vision model is unavailable. DOM hit-testing and camera assertions are distinct from screenshot review.

### S9.17-003 — Workbench typed device transports and state reconciliation

| Field                | Value                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| **Ticket ID**        | S9.17-003                                                                     |
| **Title**            | Route device operations through typed providers and reconcile command effects |
| **Priority**         | P0                                                                            |
| **Type**             | Feature + Safety                                                              |
| **Estimated Effort** | XL                                                                            |
| **Source Finding**   | AUD-11; DEV-01–DEV-07, DEV-10–DEV-11                                          |
| **Status**           | 🔄 In progress — partial implementation; acceptance criteria remain open      |

#### Context

Cloud discovery/read does not prove write transport support. Every writer must declare provider capability and revalidate target/freshness at execution, separating accepted from observed and preventing blind retries after ambiguity.

#### Acceptance Criteria

- [ ] **DEV-01–DEV-03:** Device identity is distinct from declared profile; typed commands revalidate capability, limits, target and current state.
- [ ] **DEV-04–DEV-07:** Device changes invalidate approvals; accepted/observed/refused/timeout/indeterminate differ; no blind retry; slot/box mapping is correct.
- [ ] **DEV-10:** Upload, queue/start/stop have separate typed effects and authorization.
- [ ] **DEV-11:** Automated tests use controlled transports; physical tests are opt-in only after explicit permission and redacted evidence plan.
- [ ] Unsupported writes return unavailable; they never fall back to the demo provider silently.
- [ ] Run focused transport/policy tests, full gate and sanitizer dry-run successfully; no real hardware commands.
- [ ] Run focused transport/policy tests, full gate and sanitizer dry-run successfully; no real hardware commands.

#### Implementation Notes

- Partial controlled-provider work covers typed capability declarations, frozen payload approval with execution-time revalidation (including a 60-second freshness bound), capability revocation, synthetic failure with zero transport calls, and accepted-versus-observed state reconciliation. Matching snapshots do not overwrite newer state; fields without a newer observation retain their prior values. One-use approval, deterministic post-dispatch failure without retry, concurrent busy protection, and strict cloud-login input allowlisting/redaction were exercised with controlled fixtures. These checks are partial evidence, not completion of DEV-01–DEV-11.
- The default writer remains unavailable: no production device-writer authority is implemented. DevicePanel does not import or invoke mock control seams. Upload and typed queue/start/stop routes remain unimplemented; transport approval and broader criterion coverage are still required. No hardware commands were issued.
- Verification baseline: the full `pnpm run check` completed successfully on 2026-10-09. Its recorded aggregate was 803 unit tests, 11 integration tests, Rust checks/tests, 3 E2E flows, smoke 115 tools, 59 license entries, architecture check, and sanitizer dry-run with 0 findings. This is a repository gate result, not evidence that every S9.17-003 acceptance criterion passed.
- Existing screenshots were captured as artifacts only; visual interpretation was not performed because the mandated vision model was unavailable.

#### Implementation Notes (DEV-10 slice — 2026-10-1x, backend-internal only)

- **auth-service**: added `Scope::DeviceUpload` ("device_upload") and `Scope::PrintJob` ("print_job") as writer session capabilities; read scopes (LocalProject/CloudSynced) still never grant writers. `create_session` accepts granted DeviceUpload/PrintJob and refuses CloudSynced. Tests: 24 → **27**.
- **broker**: new `action_registry.rs` maps each action to its required scope (upload → DeviceUpload; job.queue/job.start/job.stop → PrintJob; 9 control actions → DeviceControl; unknown → none). `approval::issue_for_session` renamed to **`issue_for_session_scoped`** — it privately derives the required scope from the action (never caller-supplied) and denies sessions without it. `dispatch_for_session` derives scope from the registry instead of a hard-coded DeviceControl.
- **broker**: new **`job_dispatch.rs`** (~330 lines + 15 tests): closed typed intents (Upload/Queue/Start/Stop, all `deny_unknown_fields`), CAS artifact SHA-256 + opaque file refs (no URLs/FS paths), bounded sizes, `ProviderSnapshot` (non-serde, 60 s freshness), preview-only start blocked ALWAYS with 0 transport, stop requires matching observed job id, no auto-chaining (upload ack never queues; queue ack never starts), `JobAction::ALL` allowlist, transport availability checked BEFORE consume, single consume+dispatch (Timeout/Indeterminate consumed once, never retried), `JobReceipt.observed` always `None` (never invented). Tests: broker 63 → **82**.
- **Verified**: auth-service 27/27; broker 82/82; full `pnpm run check` green (803 unit incl. one transient flaky retried to pass, 11 integration, Rust all crates, build, smoke 115, e2e×3, licenses, architecture) and sanitizer dry-run 0 files.
- **UI regression (real browser, real pointer+keyboard)**: 16/16 screenshot combos captured and each inspected: 4 pages (Home/Prepare/Preview/Workbench) × desktop 1280×800 + mobile 390×844 × light+dark → `poc-output/ui-check-s19-017-dev10/`. Zero page errors/console errors across all four pages. Flagged for next slice: `PrintJobDialog` + demo `sendJob` lane claim "Job sent — task \<mock-task-N\>" with no real transport (timer-faked stages, mock task id) — sentinel/simulated sender must never be presented as a real send.
- DEV-10 backend-internal slice only: no Tauri/MCP writer wiring, no auth UI, no real transport; ticket stays 🔄 in progress (DEV-01–09/11 and adapter remain open).

### S9.17-004 — Workbench Live and shared page conversation context

| Field                | Value                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ticket ID**        | S9.17-004                                                                                                                                                                                                          |
| **Title**            | Host Live in Workbench and preserve correctly scoped chat context                                                                                                                                                  |
| **Priority**         | P1                                                                                                                                                                                                                 |
| **Type**             | Feature                                                                                                                                                                                                            |
| **Estimated Effort** | L                                                                                                                                                                                                                  |
| **Source Finding**   | NAV-04–NAV-05; DEV-08–DEV-09                                                                                                                                                                                       |
| **Status**           | 🔄 In progress — NAV-05 frontend scope implemented & verified; NAV-04/DEV-08/DEV-09 Workbench Live frontend slice implemented & verified (camera adapter, printer bound state, Tauri transport end-to-end pending) |

#### Implementation Notes (NAV-05 frontend slice — project-scoped chat context, FRONTEND ONLY)

- **Scope model** (`apps/editor/src/state/chat-conversations-core.ts`): `Conversation` gains `projectId: string | null` (legacy/unscoped = `null`, never auto-injected into existing conversations). Store gains `currentProjectId`, `activeByProject` (per-scope last-active) and `lastUsedProjectId`. **NAV-05 security fix (applied)**: global scope is the raw literal `WORKSPACE_SCOPE_KEY = "workspace"`; project scopes are namespaced `"project:" + encodeURIComponent(projectId)` (injective — a project id "workspace" can never collide with the global scope; empty string `""` is a REAL project-scope key → `"project:"`); `projectIdFromScopeKey` round-trips losslessly (malformed → null, fail-closed); all conversation lookups use `Object.hasOwn` and persisted maps materialize as `Object.create(null)` records so hostile ids (`__proto__`, `constructor`, `toString`, unicode/slashes) stay inert; hydration derives per-scope last-active from `conversation.projectId`, never from old map keys.
- **Switching**: `enterProjectScope(state, projectId)` restores `activeByProject[scopeKeyFor(projectId)]` (validating `convo.projectId === normalized`, stale entries guarded) else creates a fresh conversation (`createConversation` 4th param `projectId`), bounded `nextSeq`, never touches legacy conversations. Same-scope+match is a strict no-op (returns the SAME state ref). `switchConversation` never changes scope.
- **Persistence** (`chat-persistence.ts`): key `anycubic:chat-store:v1` (legacy) + `anycubic:chat-store:project:<id>` buckets; v1 legacy map merges with project buckets (backward compatible — nothing is dropped); `chatBucketKeyFor` routes by `projectId == null`. Browser `LocalFallback` is injectable-storage; Tauri path is the flat `chat_store_put/get/list` lane (files carry `projectId` in JSON — **backend bucket-split is a reported TODO**). Debounced writer (500 ms) + `flushChatPersistenceNow` on unload. Hydrate is async-boot-safe: it never overwrites the current active scope.
- **Store/UI**: hydrate merge keeps `currentProjectId`; `useProjectScope` exposes `{projectId, name, setScope}`; `currentScopeName` returns the project name ONLY when `state.projectId === chatScopeProjectId` (stale-guard). `ChatPanel` renders the localized scope label (`chat.scope.project` → "Project: {name}" / "Projeto: {name}"; `chat.scope.workspace`) with `data-project-scope`; thread keyed `${scope}:${conversationId}`; `ConversationList` + quick-switcher list ONLY the current scope. `App.activateProject` calls `enterProjectScope` + `setScope` (sync, not scene-effect). Bridge handles expose `projectId` + readonly `bridgeSnapshot` ({id, projectId, workspaceScope}).
- **Abort/finish race**: `ChatThread` captures `conversationIdRef` + `scopeAtMountRef` (store read at mount). Abort-on-unmount uses a `stopRef` pattern (`chat.stop` captured once — `[chat]` dep was unstable mid-stream and killed legit replies). `onFinish` guards: skip abort/error; write ONLY to the ORIGINAL conversation (`conversationIdRef`) if it still exists — switching scope mid-stream persists the finished turn to its original scope and never appends to the new scope (no AI-context leak).
- **Tests**: `tests/chat-project-scope.test.mjs` (16: scope keys incl. `""`, enter/restore/no-op ref-equality, stale guard, deletions, hydrate per-scope normalization) and `tests/chat-persistence.test.mjs` (10: buckets, migration, merge-no-drop, unavailability, delete bucket-drop) — all green; `tests/chat-conversations.test.mjs` 15 unchanged.
- **E2E `editor-chat-scope.e2e.mjs`** (real editor + synthetic Tauri): continue A → chat "Project: Synthetic Project A" + scope-a message; page-tab switches never create/clear; recover B → scope B fresh (no A leak) + scope-b message; back to A → original transcript restored, B absent; persisted entries carry explicit `projectId`; NO scope's history dropped (no AllHistories drop); reload (reopen via localStorage-backed fake lane) re-hydrates A without B. PASS.
- **Gate (standalone)**: `pnpm run check` exit 0 — 838 unit, 11 integration, Rust all crates, build, smoke 115 tools, e2e ×4 (cad-ui, editor-reload, editor-home, editor-chat-scope), 59 licenses, architecture check, sanitizer dry-run 0 files.
- **UI regression**: `local-scripts/capture-s19-017-004-ui.mjs` → `poc-output/ui-check-s19-017-004/`: 16/16 combos (4 pages × desktop 1440×900 / mobile 390×844 × light/dark) captured and each inspected; 3 chat proofs (A transcript scoped, B isolated, A restored). Zero page errors (favicon 404 only). No visual defects found beyond the expected sparse demo-mode Workbench (no printer armed).

#### Implementation Notes (Workbench Live slice — NAV-04 / DEV-08 / DEV-09, FRONTEND ONLY)

- **Pure core** (`apps/editor/src/state/workbench-live-core.ts`, dependency-free): `TelemetryOrigin` (`cloud`/`demo`/`none`), `telemetryOrigin(printerId)` keyed on the cloud id prefix, `TelemetryFreshness` (`fresh`/`stale`/`offline`/`unknown`) from `telemetryAgeMs` + 60 s/120 s thresholds, and `buildTelemetryView({printerId, capturedAt, now, printFilename, pollingStatus})` — the view never fabricates a job task id (`reportsTaskId: false`). Camera: `NO_CAMERA_PROVIDER` and `cameraProviderFor(snap)` ALWAYS return unavailable (advertisement ≠ transport — `peripherals.hasCamera`/`capabilities.camera` alone are not a provider), `cameraActivationAllowed` gates activation, `CameraPanelStatus` covers `requested`/`permission-denied`/`start-failure`/`unavailable`, and `reduceCameraRequest` turns a user request on an unavailable provider into `status: "unavailable"` with reason `no-supported-provider` (fail-closed, never silent). Artifact: `CapturedJobBinding` REQUIRES an explicit `physicalTaskId` for a bound job (native slicer job ids are NOT a binding), `resolveLiveArtifactLink` uses exact-equality checks in a fixed priority (`no-job` → `no-binding` → `job-mismatch` → `printer-mismatch` → `artifact-unavailable` → `artifact-mismatch` → `stale-source-rev` → `artifact-not-parsed`), and `observedTaskIdFromSnapshot` returns a task id only from an explicit binding (`reportsTaskId: false` otherwise — unknown job ⇒ no invented 3D).
- **Unit tests FIRST** (`tests/workbench-live-core.test.mjs`, 11/11 pass): telemetry origin/freshness/view carries no task id; camera unavailable despite capability advertisement; user request on unavailable → `unavailable` (reason `no-supported-provider`); `requested` on available provider; permission-denied / start-failure / stop transitions; artifact `no-job`/`no-binding`; exact-match binding links; `physicalTaskId ≠` native job id ⇒ `job-mismatch`; printer-mismatch, artifact-unavailable, artifact-mismatch, stale-source-rev, artifact-not-parsed.
- **Bridge** (`apps/editor/src/bridge/live-job.ts`): `fetchLiveJobView` — non-Tauri ⇒ `source: "demo"` (honest demo label, never indistinguishable from real); Tauri ⇒ read-only `live_job_binding` invoke; errors ⇒ `source: "unavailable"`; invalid payloads normalized, never thrown.
- **Panel** (`apps/editor/src/panels/WorkbenchLivePanel.tsx`, wired in `App.tsx` above `DevicePanelMonitor`): Radix tabs (Telemetry / Camera / Artifact) stay enabled for a11y; telemetry chips (origin `data-tag`, freshness `data-freshness`, `data-present="false"` task id); camera tab shows `data-source="none"` + disabled activation + reason "Camera unavailable: no supported provider."; artifact tab renders link state (`data-linked`, `data-reason`) with an `Open preview` route button ONLY when a bound artifact is fresh+parsed, plus stale-state wording for `stale-source-rev`. No `<canvas>`, `<video>` or `<img>` anywhere in the panel. `DevicePanel` camera section unchanged in honesty: the start button stays `disabled`/`aria-disabled="true"` with the same reason — no placeholder `<video>`, no fake preview.
- **i18n**: 22 new `workbench.live.*` / `workbench.telemetry.*` / `workbench.camera.*` / `workbench.artifact.*` keys, EN + PT-BR identical sets (44 entries) — `localeKeysMatch` (key-set equality) stays green.
- **E2E `tests/e2e/editor-home.e2e.mjs`** (real editor + synthetic read-only Tauri lane, own port 1437): "actual none" — camera source `none`, activation disabled + reason, three tabs enabled, telemetry empty, ZERO canvas/video/img, no write-class invoke; "known stale" — artifact `no-job` when silent, `linked → stale-source-rev` transition on the controlled fixture, `open preview` present only when linked, `bindingCalls ≥ 1` with ZERO write commands (no start/send/upload/control/print); keyboard: roving tabstop + ArrowRight focus move on a fresh roving group + click restores the active tabstop. PASS (ArrowRight guarded by a focus-settle wait — pinned Radix 1.1.21 loses the arrow handler after a mouse redirect between two tabs, on a fresh group it fires reliably; see probe notes in `local-scripts/`).
- **Gate**: pure test 11/11; e2e extended editor-home PASS; prettier clean; zero TS errors. Full `pnpm run check` + sanitizer dry-run ran standalone EXIT 0 (details below).
- **UI regression**: `local-scripts/capture-s19-017-004b-live-ui.mjs` (own port 1438) → `poc-output/ui-check-s19-017-004b/`: 16/16 combos (4 live states — telemetry empty / camera / artifact none / artifact linked fixture — × desktop 1440×900 + mobile 390×844 × light/dark) captured and each inspected via `view_image`. Every state asserts: no invented media (canvas/video/img = 0), no write-class invoke, no load error. Zero page errors; only the tolerated favicon 404. Camera availability reads "Actual camera source: none"; the linked positive is a controlled fixture (`physical-task-100` + `bracket-ir-42` rev 5), never a claim of connected hardware.
- **Scope of THIS slice**: FRONTEND ONLY. No true camera is connected (no provider/adapter, no transport to anycubic-camera), no real printer bound state is exercised (fixture-driven), DEV-09 freshness is proven purely (binding rev vs artifact rev vs 60 s window) in local time, and the Tauri backend transport + AI09 provider-context isolation remain open. No hardware/cloud/paid calls; no commits/pushes (working tree left dirty per instructions).

#### Context

Live camera, telemetry and artifact-backed 3D job paths are different evidence types. Workbench owns Live; chat remains available across all pages without carrying another project's context or implying an exact path for an unknown job.

#### Acceptance Criteria

- [ ] **NAV-04:** Live exists in Workbench and differentiates camera, telemetry and artifact-linked 3D representation. _(partial: Live Workbench panel with distinct Telemetry/Camera/Artifact tabs implemented & verified; camera differentiates by honest "no supported provider" — NO true camera connected, no adapter/transport yet)_
- [x] **NAV-05:** Active conversation persists across all four pages with correct project context _(frontend slice verified — see implementation notes; backend bucket-split and AI09 end-to-end isolation pending)_.
- [ ] **DEV-08:** Camera is on-demand and reports permission/source state. _(partial: on-demand activation gate + source state implemented ("Actual camera source: none"); activation stays disabled with reason `no-supported-provider` — no camera provider/adapter exists, nothing ever starts)_
- [ ] **DEV-09:** Unknown job has no invented 3D representation; known artifact freshness is explicit. _(partial: unknown job renders no 3D surface (zero canvas/video/img, task id absent); freshness explicit via `stale-source-rev`/`artifact-not-parsed` reasons on a controlled fixture binding — no real printer bound state exercised)_
- [ ] Run focused page/context/provider tests, full gate and sanitizer dry-run successfully; no hardware action.

## Sprint Commit

Each ticket commit uses `feat(s9.17-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and controlled-transport tests pass; no push.
