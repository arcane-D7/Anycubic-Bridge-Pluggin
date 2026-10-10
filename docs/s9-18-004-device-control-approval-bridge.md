# S9.18-004 — Typed device-control approval bridge (backend capability, production-blocked surface)

Scope: a typed Tauri command surface for remote device control — public-safe
availability, typed preflight draft, a protected approve command that is
**unreachable in production today**, and a dispatch seam proven by controlled
Rust tests. The editor UI stays read-only and shows an honest
"backend auth unavailable" status. No commits, no pushes.

---

## 1. What this slice adds

### 1.1 Backend (Rust, `apps/editor/src-tauri`)

New module `device_control.rs` (~720 lines) + `auth-service` path dependency +
4 registered `#[tauri::command]` handlers:

| Command                       | Public-safe? | What it does                                                                              |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `device_control_availability` | Yes          | Booleans + fixed reasons only (never a user id, never a session bearer).                  |
| `device_control_preflight`    | Yes          | Typed draft of the would-be effect; executes nothing.                                     |
| `device_control_approve`      | **No**       | Mints a scoped approval token — requires a real backend session + trusted device context. |
| `device_control_dispatch`     | **No**       | One consume + one transport call through the broker's `DispatchGate`.                     |

`DeviceAuthorityState` (managed in `lib.rs`) holds:

- `workspace: Mutex<Result<DbHandle, String>>` — the broker's production DB
  (per-command open, same pattern as the existing editor commands).
- `resolver: Box<dyn DeviceResolver + Send + Sync>` — the **only** source of
  device/project identity. Constructed as `UnavailableDeviceResolver`.
- `transport: Box<dyn ControlTransport + Send + Sync>` — the **only** execution
  path. Constructed as `UnavailableTransport`.

The session repository is deliberately **not** held in managed state:
`AuthDb` owns a boxed `!Send` clock, and Tauri `State<T>` requires `T: Send`.
So each protected command opens `<APPDATA>\AnycubicBridge\auth.db` per call
(via `open_auth_store()`), which also gives **live re-verification** of the
session on every call and avoids any shared-handle ordering hazard.

### 1.2 approve/dispatch semantics (deny by default)

- `approve(state, session_token, request)`:
  1. `resolve_context(now)` gate — resolver absent or snapshot stale ⇒ typed
     `unavailable`, **before** any issue attempt.
  2. `request.target == ctx.device_id` — a caller-supplied target that doesn't
     match the trusted device is rejected (`invalid`).
  3. Broker validation: closed `DeviceControlAction` set, target bounds
     (non-empty, ≤ 256 bytes, no whitespace), payload ≤ 4096 bytes +
     `DevicePayload::parse`.
  4. `ApprovalAuthority::issue_for_session_scoped` — re-resolves the session
     (user exists, scope granted, not expired/revoked) and binds the session's
     real principal.
  - `#[serde(deny_unknown_fields)]` rejects `confirm`, `principal`, `user_id`
    — a caller cannot assert identity or self-confirm.
- `dispatch(...)`: same gates, then `DispatchGate::new(authority, transport,
&DeviceControlAction::ALL)` + `dispatch_for_session` — transport
  `available()` is checked **before** consume; exactly one consume; exactly
  one transport call.
- The raw approval token exists only in memory (a `Debug`-masked field) and is
  returned **only** when a real resolver present + real session present —
  production never reaches that point.

### 1.3 Frontend (`apps/editor/src`)

- `bridge/device-control.ts` — typed mirrors of the backend contract,
  `fetchDeviceControlAvailability()` (optional local-Tauri, defaults to a
  `BLOCKED_DEVICE_CONTROL` descriptor), `previewDeviceControlEffect(input)` (typed
  draft; returns typed `unavailable` when the backend has no resolver).
  Deliberately **no approve/dispatch callers are exported** — issuance stays
  unwired until a production resolver exists (S10).
- `state/device-availability-core.ts` — `canWrite` stays `false` by
  construction; new `backendControlBootstrapUsable()` +
  `fetchBackendDeviceControlStatus()` (lazy relative import).
- `panels/DevicePanel.tsx` — new `BackendControlStatus` row under the origin
  banner. States: `checking` / `auth-unavailable` / `no-resolver` /
  `ready-read-only`. It is a **status only**: `writer=disabled` is rendered
  unconditionally and no "writer ready" affordance exists.

## 2. Why production is explicitly blocked (the honest surface)

1. **Empty auth store** — there is no login UI, no login endpoint, and no
   auto-grant. `auth.db` has zero users, so `create_session` can never
   succeed on a fresh install; `device_control_availability` returns
   `session.established = false`. Since the review-fix pass, `established` is
   **never inferred from user rows** — a store that merely contains users is
   `session-unverified`, never `established` (identity configured ≠ session
   authenticated; the public route has no session argument and this build has
   no trusted current-session provider).
2. **Resolver is `None`** — this slice ships the command surface, not a device
   snapshot producer. Without a resolver, `resolve_context` is typed
   `unavailable` (fixeds reasons `resolver-unavailable` / `stale-snapshot`),
   so `approve` and `dispatch` return typed `unavailable` **before** any
   issue/consume can happen.
3. **Transport is `UnavailableTransport`** — even a hypothetical valid
   approval cannot execute: `available()` is `false` and the gate refuses
   before consume.

Net effect: on production, every route is typed `unavailable`; the only
paths that mint/execute are Rust tests with injected stub resolver +
counting transport. Cloud telemetry (the existing read-only cloud lane)
deliberately does **not** grant writer status.

## 3. Tests (Rust, `device_control.rs`)

`cargo test` in `apps/editor/src-tauri`: **25 passed, 0 failed**
(15 device_control + 10 slice_job). The device_control tests prove:

- approve with no auth store user ⇒ `session/unauthenticated`, **0** dispatch calls;
- approve→dispatch with stub resolver + counting transport ⇒ exactly **1** transport call;
- token replay ⇒ `already-consumed`, **0** further calls;
- resolver absent ⇒ every route typed `unavailable` before issue/consume;
- stale snapshot (age > 60 s) ⇒ `unavailable`, blocked;
- revoked scope ⇒ session denial, **0** transport;
- `confirm` / `principal` fields ⇒ rejected by `deny_unknown_fields`;
- availability never leaks secret key names (booleans + reasons only);
- user rows **without** a verified session ⇒ `established=false
(session-unverified)` and writer stays off even with resolver+transport
  present; empty store ⇒ `login-required`;
- furnished revision/artifact/material mismatch at approve ⇒ `invalid`
  (`revision-mismatch` / `artifact-mismatch` / `material-mismatch`) before
  issue, **0** transport;
- furnished mismatch at dispatch ⇒ refused before consume and the approval is
  preserved (still one-use afterwards);
- trusted revision changing between approve and dispatch ⇒ broker
  `context-changed` BEFORE transport, approval stays pending (restoring the
  original revision still consumes it exactly once);
- preflight refuses a `claimed_project_id` that differs from the trusted
  context (`project-mismatch`).

## 3b. Review-fix pass (2026-10-10) — trust truthfulness

1. **Session truthfulness** — `session_state` never returns `established=true`
   from `db.users()`: public availability has no session argument, and this
   build has no trusted current-session provider. Empty store ⇒
   `login-required`; users exist ⇒ `session-unverified`; DB error ⇒
   `auth-unavailable`. `established=true` is unreachable until a backend
   current-session source exists (S10). Writer stays `false` by construction.
2. **Strict TS normalization (all references)** — the raw Tauri replies are
   normalized from `unknown`: `normalizeDeviceAvailability` requires ALL THREE
   sections (session/capability/writer) to be well-shaped (boolean flag +
   `reason` string|null) or the descriptor is BLOCKED — a malformed
   `capability`/`writer` can no longer pass a partial structural guard.
   `normalizeDevicePreflight` validates `status`/`reason`/`action`/`target`
   and maps the backend's snake_case keys (`snapshot_captured_at_ms`,
   `claimed_project_id`) to the camelCase TS contract on every reference
   (`snapshotCapturedAtMs`, `claimedProjectId`); unknown keys (e.g. an echoed
   secret) are discarded; a malformed reply is typed
   `unavailable("malformed-reply")`. The `invoke` seam is injectable for
   tests (`DeviceInvoke`). New `tests/device-control.test.mjs` (8 unit tests,
   Node type-stripping).
3. **Trusted project-revision binding** — `DeviceContext` now carries
   authoritative `revision`/`artifact`/`material` (resolver-observed,
   optional). `approve` and `dispatch` derive bindings SOLELY from the trusted
   context: a caller may furnish a claim only when it equals the trusted
   value; a furnished difference is refused BEFORE issue/consume and a claim
   can never clear a binding. A changed trusted revision between approve and
   dispatch surfaces as broker `context-changed` before transport (approval
   preserved). Preflight refuses a mismatched `claimed_project_id` claim.

## 4. Health gate (all EXIT 0)

`pnpm run check` green: format, lint, typecheck, unit **810/810**,
integration, `check:rust` (no warnings), build (`dist/server.mjs`
~255.6 KB), smoke **115 tools**, e2e ×3 PASS (cad-ui, editor-reload,
editor-home), licenses **59 deps**, architecture, and
`node scripts/sanitize-repo.mjs --dry-run` → **0 files touched**.

UI verification (fresh `poc-output/ui-check-s19-018/`, dev server
`127.0.0.1:1437`, own stop): **16 matrix screenshots**
(home/prepare/preview/workbench × light/dark × desktop/mobile) + 1 device-panel
evidence shot, all captured 2026-10-10 02:21 and individually inspected.
Zero page errors; the only failed request is the dev favicon 404 (reported
separately). Live DOM proof on the Workbench view with an armed profile
machine: `device-backend-status` rendered `data-state="auth-unavailable"`,
`data-writer="false"`, widget text `writer=disabled`, and **no**
writer-ready banner anywhere in the panel. Keyboard pass: Tab reaches the nav
cluster (Home/Prepare/Preview/Workbench) then the picker + device-panel
toggle; Enter on the demo prepare card mounts the workspace; Escape is a safe
no-op.

## 5. Non-claims (report standards)

- No user login exists anywhere in this slice; `auth.db` is empty by design.
- No approve/dispatch callers are exported from the frontend bridge.
- Cloud telemetry grants no writer; `canWrite` is `false` by construction.
- No commits/pushes; no new tasks; no nested agents.

## 6. Future S10 authorized-flow note

- Add a production `DeviceResolver` (real device snapshot producer) and a
  human login entry (vendoring an access token via an authenticated flow —
  meeting `ANYCUBIC_ACCESS_CODE`/`ANYCUBIC_CLOUD_TOKEN` style env vars per
  AGENTS.md) — then `availability` flips `session`/`capability`, and
  `approve`+`dispatch` become reachable **only after** the frontend bridge
  exports typed callers behind that gate.
- The typed seam (requests, replies, `deny_unknown_fields`) is the contract
  those future callers must satisfy; no shape change expected.

### Deferred (explicitly out of this slice, reported as gaps)

- **Approval snapshot binding** — DONE (S9.18-003 slice):
  broker schema v6 adds a dedicated nullable `device_snapshot_ms INTEGER`
  column (plus `project_id TEXT`) to `approvals`; issue/consume structs carry
  both; `issue_for_session_scoped` refuses `DeviceControl` issuance without
  `Some(ms>0)` + `Some(project_id)`; `consume` revalidates snapshot then
  project (strict Option equality) → `ContextChanged("snapshot"/"project")`
  with zero transport calls and the approval kept pending. Legacy v5 rows
  keep NULL (deny trusted-Some writes by design). `device_control.rs`
  `approve()`/`dispatch()` bind the trusted `ctx.snapshot_captured_at_ms` +
  `ctx.project_id`.
- **Domain capability set from the trusted context** — DONE (S9.18-003 slice):
  `DeviceContext.capabilities: Option<Vec<DeviceControlAction>>`;
  `check_capability()` (`capability-unavailable` for None, `action-not-enabled`
  for an action outside the list) gates preflight/approve/dispatch; a
  capability revoked between approve and dispatch is rejected before consume
  (approval preserved); `availability` reports `capability.defined` only for
  a non-empty descriptor. TS normalizer unchanged — the descriptor is not
  exposed through `DeviceAvailabilityDescriptor`.
- **Auth DB path unification** — DONE (S9.18-004 slice). One owner:
  `crates/auth-service/src/config.rs` (`AuthDb` path resolver). Resolution
  precedence (highest first): explicit CLI `--db <path>` > `ANYCUBIC_AUTH_DB`
  > legacy `AUTH_DB` (additive compat, never removed) > platform app-data
  > default (Windows `%APPDATA%\AnycubicBridge\auth.db`, Unix
  > `$XDG_DATA_HOME`/`$HOME/.local/share` `anycubic-bridge/auth.db`; typed
  > `NoDataDir` error if none). Stable empty-path semantics: **unset** skips to
  > the next level; **explicitly set but empty** is a typed `EmptyPath` error,
  > never silently treated as unset. Relative explicit config is normalized
  > against the startup working directory (the historic `"auth.db"` ==
  > `<cwd>/auth.db` CLI convention is preserved). The Tauri writer authority
  > (`device_control.rs::open_auth_store`) reuses the same resolver and runs a
  > distinctness gate (`ensure_distinct_from`) before opening: the resolved
  > auth path must never alias `workspace.db` (lexical + best-effort canonical
  > normalization, case/separator folded on Windows paths) — refusal is a typed
  > `db` error. Resolution never opens/moves/copies a DB or creates a
  > directory; only the open path boots the parent dir. Existing user/token DB
  > contents are untouched by design; no DB file is moved.
- **Frontend writer callers / login UI** — still deliberately absent; no code
  auto-grants a writer even with a valid session.
