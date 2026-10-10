# Sprint 9.18 — Operational AI Tool Loop, Authenticated Approval & Parity

## Sprint Metadata

| Field                 | Value                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint Name**       | Shared operation registry, real chat tool loop and backend approval authority                                                                       |
| **Sprint Goal**       | Let chat discover and execute the same authorized domain actions as UI while preserving backend-enforced consent, structured results and isolation. |
| **Duration Estimate** | ~4 weeks                                                                                                                                            |
| **Priority**          | P0                                                                                                                                                  |
| **Sprint Type**       | Feature + Security                                                                                                                                  |
| **Primary Owner**     | Broker chat, operation registry and editor transcript                                                                                               |
| **Source**            | [Editor workspace CAD/AI audit](../../docs/audit/editor-workspace-cad-ai-audit-2026-10-07.md), AUD-09/AUD-10/AUD-12; sections 6, 15, 19             |
| **Depends On**        | Sprint 9.17                                                                                                                                         |
| **Status**            | 🔄 In progress (partial) — S9.18-001 transport complete, S9.18-003 backend authority partial, S9.18-002 not started; see dated status block below   |

> **📌 Current status — 2026-10-10 (supersedes the ⏳ Planned header).** This sprint is **PARTIAL, not complete**:
>
> - **S9.18-001** — provider transport, real bounded egress and `/provider/status` lane are **complete and committed** (`87090d6`); the operation registry / discovery (AI-03, AI-04) is **pending** (S9.18-002).
> - **S9.18-003** — backend approval authority, verified sessions (auth-service schema v2; broker approvals v5→v6 with snapshot+project binding and capability caps) are **partial and committed** (`359afe1`); AI-05/AI-06 remain open — no UI login, no external verified-session establishment, no real resolver gateway; every write route stays typed unavailable.
> - **S9.18-002** (shared tool loop) — **not started**.
> - **Provider state today**: the default is the **offline Demo lane** (`GET /provider/status` → `demo`). With `ANYCUBIC_MODEL_URL` set, the broker performs REAL bounded egress (`configured`); **invalid/external/credentialed env values resolve to `""` → the same offline Demo lane** (fail-closed, the webview never reaches an external host). Any earlier phrasing implying the current provider URL is "invalid" is superseded by this statement.
> - **Ports**: the broker CORS dev origin `127.0.0.1:1420` and broker port `18181` are **preflighted with SKIP-if-busy**; E2E/captures use **dynamic ports regardless** — there is no "fixed 1420" claim.
> - **Gate evidence (2026-10-10)**: two full `pnpm run check` runs **EXIT 0** (10:18, 10:46) covered the committed tree (commits `87090d6`, `359afe1`, `e9998bb`, `6249860`, 11:00–11:03). A final post-commit run passed **unit 879 / integration 11 / Rust / build 255608 B / smoke 115 tools / all 5 E2E suites / licenses 59** and was **interrupted at check-architecture/sanitize (no exit)**. Counts recorded in the Implementation Notes below (803/838 unit, e2e×3/e2e×4, broker 53/63, auth 19/24/27) are **dated records of their slices, not current**; today: unit **879**, broker **85**, auth **27** (+14 config slice), editor Tauri **28** (19 `device_control`), smoke **115**, licenses **59**, sanitizer 0/0.

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **100% of tickets must pass their acceptance criteria and the full health gate before the sprint is accepted.** Commit each ticket separately only after focused validation, full `pnpm run check`, and `node scripts/sanitize-repo.mjs --dry-run` all pass.

## Sprint Goal Statement

Replace echo/mock success paths with configured-provider status, contextual operation discovery and a bounded typed tool loop. UI and AI dispatch through the same domain handlers and policy; a trusted backend issues one-use approvals bound to the exact target, arguments, revision and artifact. Physical writers remain unavailable unless both provider capability and authenticated approval exist; test the boundary with stubs only.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

Run focused broker/policy/transcript tests before the full gate. Never expose provider secrets to the webview or execute raw model-generated code.

## Tickets

### S9.18-001 — Safe provider bootstrap and operation discovery

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| **Ticket ID**        | S9.18-001                                                                        |
| **Title**            | Bootstrap configured chat lane and discover capability-filtered typed operations |
| **Priority**         | P0                                                                               |
| **Type**             | Feature + Security                                                               |
| **Estimated Effort** | L                                                                                |
| **Source Finding**   | AUD-09/AUD-10; AI-01, AI-03–AI-04                                                |
| **Status**           | 🔄 In progress                                                                   |

#### Context

The configured broker endpoint must be reachable through a public-safe bootstrap without shipping credentials to the webview. The model needs discovery/description and availability reasons, while backend execution still revalidates current policy and capabilities.

#### Acceptance Criteria

- [x] **AI-01:** Real provider bootstrap works with no secret in frontend bundles, runtime config or logs; missing/invalid endpoint reports unavailable, not fake model output.
- [ ] **AI-03:** Every public action has a versioned schema, discovery entry, policy and handler mapping or an explicit documented exclusion.
- [ ] **AI-04:** Backend rejects invalid, unavailable and revoked operations even if the client previously discovered them.
- [ ] Provider failure, unknown operation, invalid arguments and cancellation produce structured results.
- [ ] Run focused broker/config/registry tests, full gate and sanitizer dry-run successfully.

#### Implementation Notes — S9.18-001 (provider bootstrap transport — REAL, not mock)

Slice delivered: the configured egress lane is now REAL. When `ANYCUBIC_MODEL_URL` is set, `broker-server` performs an actual `POST {url}{endpoint}` chat/completions call and streams the reply back over the UI-protocol SSE; when unset/disabled it is an explicit offline Demo echo. **NOT complete**: the S9.18 operation registry (AI-03/AI-04: versioned action schemas, discovery entries, policy + handler mapping) is pending next (S9.18-002); there is no auth UI or tool-backend isolation verification yet.

- `crates/broker-server/Cargo.toml` — `reqwest 0.12` (`default-features=false`, `features=["json","rustls-tls"]`) + `url 2`; both MIT/Apache-2.0.
- `crates/broker-server/src/lib.rs` — real provider egress:
  - `EgressConfig` (env `ANYCUBIC_MODEL_URL`/`ANYCUBIC_MODEL_API_KEY`/`ANYCUBIC_MODEL_ENDPOINT`/`ANYCUBIC_MODEL`/timeout via `ANYCUBIC_MODEL_TIMEOUT_SECS`) with a **manual `Debug` impl that redacts the API key** (`[REDACTED]`/`none`; proven by `debug_redacts_api_key`).
  - URL policy: https required for remote hosts; http only for loopback (127.0.0.1 / localhost / ::1 / [::1]); userinfo/query/fragment rejected (`validate_model_url`). Endpoint: relative-path-only (`validate_endpoint`). reqwest `redirect::Policy::none()` (auth headers are never forwarded); connect timeout 10s, request timeout clamped 1–60s.
  - Budgets: ≤64 input messages, ≤256 KiB request body, ≤4 MiB response; semaphore (1 permit) bounds in-flight egress; cancellation drops the reqwest future.
  - `ProviderError` (11 variants) → stable `reason()` codes; errors are SSE `error` chunk + `finishReason:"error"` + `[DONE]`; `sse_error_body` never leaks upstream bodies.
  - Tool calls in the upstream reply → `unsupported-tools` error (the shared tool loop is S9.18-002 next).
  - `GET /provider/status` → `{mode: demo|configured|unavailable, configured: bool, reason: stable}` — "configured" means valid egress env, NEVER reachability; the status probe never contacts the provider.
- `crates/broker-server/tests/provider_egress_test.rs` (new, 14 tests) — fake local provider over a real TCP listener: real streamed reply (exactly 1 provider call), bearer header, `FAKE_MODEL`, non-streaming upstream, demo echo when disabled, Debug redaction proof, URL/endpoint validation matrices, status matrix, missing-content → malformed-response, tool-calls → unsupported-tools, 400 → upstream-status (no body leak), redirect not followed, timeout, invalid-endpoint unavailable with zero calls, too-many-messages budget error.
- `crates/broker-server/tests/loopback_test.rs` — 7 tests kept green (State-based direct calls).
- Frontend: `apps/editor/src/bridge/chat-transport.ts` gains loopback+http(s) validation (`isBrokerBaseUrl`, `brokerLaneConfiguredFrom`, `brokerChatUrlFrom`, `brokerProviderStatusUrlFrom`); invalid/external/credentialed values resolve to `""` → the chrome stays on the offline Demo lane (never reaches an external host from the webview). `apps/editor/vite.config.ts` envPrefix exposes exactly `ANYCUBIC_BROKER_URL` (never `ANYCUBIC_MODEL_*` secrets). `ChatThread.tsx` reads `GET /provider/status` once (AbortSignal.timeout 4000 ms) and shows the honest banner: configure/unavailable/demo via i18n keys `chat.source.configured/unavailable` (EN+PT) + `data-provider-mode` for e2e.
- Tests: `tests/chat-transport.test.mjs` (7) — invalid matrix (external host, LAN IP, ws:, file:, userinfo, query, fragment), status-URL derivation, "configured but invalid → offline" semantics. E2E `tests/e2e/broker-provider-status.e2e.mjs` (3 legs, real broker binary + real fake provider on an ephemeral port): demo lane (no env), configured (provider called exactly 1× with the key/model, fixed provider text rendered, banner Configured), unavailable (invalid non-loopback URL → banner unavailable + chat error alert, provider calls 0). Editor e2e served from the broker CORS dev origin 127.0.0.1:1420; broker-port preflight → SKIP exit 0 if busy.
- Gate: `pnpm run check` EXIT 0 (format/lint/typecheck/unit/integration/rust/build/smoke-115/e2e×5/licenses-59/architecture/sanitize-dry-run 0 files). Screenshots: 16 canonical + 4 chat-banner variants + 3 TestLocalGateway evidence in `poc-output/ui-check-s9-18-001/` (configured/unavailable/demo banners, all viewed; re-captured 2026-10-10 11:21 from the committed tree).
- Next: S9.18-002 shared handler tool loop (tool calls currently `unsupported-tools`) and the operation registry (AI-03/AI-04).

### S9.18-002 — Shared handler tool loop and durable structured transcript

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| **Ticket ID**        | S9.18-002                                                              |
| **Title**            | Execute UI-parity tools and persist structured progress/results safely |
| **Priority**         | P0                                                                     |
| **Type**             | Feature                                                                |
| **Estimated Effort** | XL                                                                     |
| **Source Finding**   | AUD-09; AI-02, AI-07–AI-10                                             |
| **Status**           | ⏳ Planned                                                             |

#### Context

Echo responses and text-only rendering cannot prove tool execution. Connect typed tool calls to the same domain handler as the UI and render/persist invocation IDs, progress, approval states, outputs and failures without replaying mutations on reconnect.

#### Acceptance Criteria

- [ ] **AI-02:** A reversible navigation/selection tool invokes the same handler as UI and has the same observable result.
- [ ] **AI-07:** Transcript persists tool IDs, progress, result, denial and error as structured parts.
- [ ] **AI-08:** UI-originated mutations refresh agent context and tool-originated mutations update UI snapshots/journal.
- [ ] **AI-09:** Switching conversation/project cannot expose prior context or approval references.
- [ ] **AI-10:** Retry, reconnect and cancellation do not duplicate mutating or physical effects; reconciliation is explicit.
- [ ] Tool step/time/budget limits and typed errors prevent unbounded execution; raw shell/Blender is not exposed.
- [ ] Run focused tool-loop/isolation/idempotency tests, full gate and sanitizer dry-run successfully.

### S9.18-003 — Backend-authenticated payload-bound approval

| Field                | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Ticket ID**        | S9.18-003                                                               |
| **Title**            | Require opaque, expiring, one-use backend approval for protected writes |
| **Priority**         | P0                                                                      |
| **Type**             | Security                                                                |
| **Estimated Effort** | L                                                                       |
| **Source Finding**   | AUD-12; AI-05–AI-06                                                     |
| **Status**           | 🔄 In progress                                                          |

#### Context

Textual `confirm` arguments do not prove human consent. Approval must come from an authenticated backend principal and bind the exact action/target/args digest plus relevant project revision or artifact, expiring and consuming before dispatch.

#### Acceptance Criteria

- [ ] **AI-05:** Protected write with `confirm` but no authenticated backend approval is rejected before transport invocation.
- [ ] **AI-06:** Approval binds payload, target, revision/artifact and principal; expiry, replay, revocation and one-use consumption are enforced.
- [ ] Changing device, material, artifact or relevant revision invalidates pending approval.
- [ ] Approval UI explains concrete effect; logs redact bearer material and secrets.
- [ ] Integration tests prove zero transport calls on all rejection paths; no physical hardware command is run.
- [ ] Run focused security tests, full gate and sanitizer dry-run successfully.

#### Implementation Notes

Broker approval-authority slice landed in this sprint (informs S9.17-003 DEV-04/DEV-07; no UI wiring, external issuance intentionally unavailable):

- `crates/broker/src/approval.rs` (new): `ApprovalAuthority` (issue/consume/revoke/pending_tokens) over the workspace DB. Identity is typed from `auth_service::Principal` — anonymous issuance is refused (`MissingPrincipal`); the broker never holds credentials or BYOK keys.
- Token = 32 bytes OS RNG (`getrandom`, hex 64 chars); only the SHA-256 hash is persisted. Payload binding = SHA-256 of the canonicalized (recursively key-sorted, compact) args JSON, re-derived at consume (frozen-payload revalidation).
- `consume` revalidates the frozen envelope (payload digest, target, principal, optional session/revision/artifact/material), expiry, revocation and one-use state, then applies a conditional `UPDATE … WHERE consumed_ms IS NULL` inside a `BEGIN IMMEDIATE` transaction — the atomic one-winner gate. All denials precede any transport dispatch; the module contains no transport code.
- Broker schema v5 (`db.rs`): `approvals` table + principal index; `SCHEMA_VERSION` 4 → 5 with `apply_v5`.
- 13 focused tests (broker suite now 28): anonymous refusal, exact-envelope one-use, wrong payload/target/revision/session/material/artifact, expiry bounds, revocation, unknown token, TTL bounds, distinct tokens, 16-thread concurrent replay grants exactly once.
- Also hardened `executeControl` revalidation in `apps/editor/src/state/printer-control-core.ts` (working-tree test gap): the live `snapshotCapturedAt` must equal the authorized request's — a capture changed after authorization is refused before dispatch instead of being dispatched.

Remaining (not done here): MCP/Tauri exposure of issuance, real session API binding, approval UI, transport-level integration tests, end-to-end wiring.

#### Implementation Notes — S9.18-003 follow-up: `dispatch.rs` hardening (security correction)

Small bounded correction to `crates/broker/src/dispatch.rs` (plus a `lib.rs` re-export line; `approval.rs` untouched). Fixes the gap that `S9.17`/`S9.18` gates crossed: the pre-fix gate validated only `serde_json::to_vec(&req.payload).len() <= MAX_PAYLOAD_BYTES`, so an **out-of-range payload (`{"nozzle": 500}`) was GRANTED (Ack, 1 transport call)** and `consume` dropped all four bindings as `None`; `Ack` doc misclaimed a dispatched end-state.

- **Typed closed payloads** — `DevicePayload` enum (9 variants) parsed by `DevicePayload::parse(action, &Value)` via `serde_json::from_value` with `#[serde(deny_unknown_fields)]` structs and `validate()` range checks: `nozzle` ≤320 °C, `bed` ≤120 °C, `part_fan` ≤100 % on the closed target `Part`, `print_speed_mode` ∈ {1,2,3}, light `{on}`/`{on,brightness≤100}` boolean-strict, `ace_dry` (box≤9, target≤80 °C, duration≤1440 min, remain=0), `ace_auto_feed` (box≤9), `ace_bind_slot` (box≤9, slot≤9, manual material metadata only — never forges RFID; `edit_status` rejected by `deny_unknown_fields`). Shape/range/type failures → `PayloadError` → `DispatchError::InvalidPayload` **before** any bindings/`consume` call.
- **Domain windows** are `pub(crate)` consts (`NOZZLE_MAX_C` … `DRYER_DURATION_MAX_MIN`); no clamping — out-of-bounds is refused (proven by `thermal_windows_reject_out_of_bounds_without_clamping` edge tests).
- **Binding pass-through** — `DeviceControlRequest` gains `context: RequestContext { session_ref, revision, artifact, material }`; `DispatchGate::dispatch` consumes with **all four** `req.context.*` values (previously always `None`). `bindings_are_passed_through_to_consume` proves match → grant, any single mismatch → `ContextChanged`, 0 calls, pending kept.
- **Dispatch order** (1) allowlist → (2) target non-empty, ≤`MAX_IDENTIFIER_LEN`, no whitespace (`InvalidTarget`) → (3) byte bound → (4) typed parse → (5) transport availability → (6) `consume` → (7) `transport.dispatch(&typed)`. Post-consumption failures split: `TransportTimeout` (new) vs `IndeterminateOutcome`, no retry.
- **Honest docs** — `TransportOutcome::Ack` = "acknowledgment of acceptance only — no physical effect or end-state claim"; module doc claims typed validation + binding pass-through.
- `DeviceControlAction` (9 snake_case names); legacy coarse names (`fan_speed`/`light`/`ace`) are rejected. Digest stability: parse is read-only on the original `Value`, so `issue`==`consume` normalization is preserved.
- **Evidence**: 14 new adversarial tests (all assert `transport.calls()==0` + pending kept): nozzle 500 refused, null/string/missing/unknown fields refused, window edges, fan unknown-target/out-of-range, speed triplet only, boolean-strict light, ace windows/shapes, manual-bind metadata, bindings pass-through matrix, opaque legacy shapes refused. Broker suite **53 passed, 0 warnings**; full crates workspace `cargo test` green; full `pnpm run check` **EXIT=0** (format/lint/typecheck/unit/integration/check:rust/build→115 tools/smoke/e2e:ui 3 PASS/licenses/architecture); `sanitize-repo --dry-run` 0 files, 0 groups.
- **UI verification** (no hardware): 4 pages (Home, Prepare, Preview read-only, Workbench) walked with real pointer + keyboard on the local vite dev server — **zero** page errors/console errors/request failures; screenshots desktop+mobile × light+dark inspected (`poc-output/ui-check-s19/*.png`, 16 files). Notes: Workbench shows "No printer selected", camera default off, bindings/approval UI and chat textarea not wired — no complete-flow claim.
- **Auth note**: `Principal` remains the known trusted internal API — **not yet AuthApi-verified** (planned Sprint 10 R4). No commits/push in this correction.

#### Implementation Notes — S9.18-003 follow-up: backend-authenticated sessions (S9.17-003/S9.18-003 slice)

**Status: in progress** — the backend authority + verified-session repository landed and is gate-green, but the whole ticket criterion (UI-originated authenticated writes with approval UI) is NOT complete: no Tauri/UI writer endpoint in this slice, external session establishment deliberately unavailable. No commits/push in this slice.

**auth-service crate — local trusted session repository (backend-internal only, not login magic)**

- `crates/auth-service/src/db.rs`: `AUTH_SCHEMA_VERSION` **1 → 2**; `apply_v2` adds `device_sessions.expires_ms INTEGER NOT NULL DEFAULT 0` and `device_sessions.scope TEXT NOT NULL DEFAULT ''` — every pre-v2 row has `expires_ms=0` and is **invalid at resolve** (`Expired`). `AuthDb` now owns an injectable per-instance clock (`AuthClock`, `open_in_memory_with_clock`); `PRAGMA foreign_keys = ON` enables `ON DELETE CASCADE` for `users → sessions/scopes/sync_state`.
- **Fail-closed scope parsing (security fix)**: the old `scope_from_name` had `_ => LocalProject` (unknown → silently granted). Now `Scope::from_name` is an **exhaustive allowlist returning `Option`** (`local_project`/`cloud_synced`/`device_control`; anything else → `None`) and `scopes_for` **skips** unknown rows; the stdio `grant` op refuses unknown scope names. `Scope::name()` is the single source of truth for storage strings.
- New `crates/auth-service/src/api.rs` `Scope::DeviceControl` — the only **session capability** (`is_session_capability()`); `LocalProject` stays a read scope and **never grants writer access**.
- New `crates/auth-service/src/sessions.rs`: `SessionError` (12 structured variants, token-free), `SessionToken` (raw + sha256 hash, **Debug redacted** `<redacted>`), `VerifiedSession` (**private fields**; the only constructor is crate-internal `from_parts` reachable solely via `AuthDb::resolve_session` — unforgeable outside the crate; accessors `user_id()/session_hash()/scope()/is_expired_at()/has_scope()/principal()`).
- `AuthDb::create_session(user_id, scope, ttl_ms)` requires an **existing user**, an **allowed session capability**, TTL ≤ 24 h; token = 32 B OS RNG (`getrandom` 0.2) → hex 64 chars; **only SHA-256 hash persisted**. `resolve_session` re-validates live: token known → not revoked → not expired (`expires_ms ≤ 0` ⇐ v1) → scope name allowlisted → user still present → scope still granted → `ScopeRescinded`/`UserRemoved` otherwise. `revoke_session(hash)`, `AuthDb::revoke_scope`, `AuthDb::remove_user` (cascade) added. No new external crates (getrandom 0.2 / sha2 0.10 / hex 0.4 already in the lockfile via broker).

**broker crate — secure external gates (no principal+session from JSON)**

- `crates/broker/src/approval.rs`: `issue` is now **`pub(crate)`** (same-crate tests unaffected); new `ApprovalError::SessionDenied(&'static str)`; new `ScopedIssueRequest` (no caller principal/session_ref — resolved internally); **`ApprovalAuthority::issue_for_session(&AuthDb, session_token, &ScopedIssueRequest)`** resolves the session NOW, requires `DeviceControl`, then binds `session.principal()` + non-secret `session.session_hash()` into the approval.
- `crates/broker/src/dispatch.rs`: `dispatch` is now **`pub(crate)`** (internal seam, `Anonymous → SessionDenied("unauthenticated")`); new `DispatchError::SessionDenied(&'static str)`; the pipeline moved to `dispatch_internal(token, req, principal, session_ref)` — principal/session come from the seam caller, **never `req.principal`/`req.context.session_ref`**; new **`DispatchGate::dispatch_for_session(&AuthDb, session_token, token, req)`** re-resolves the session **before consume** (revoked/expired/removed/rescinded ⇔ zero transport, approval stays pending) and binds consume to the verified session's hash. A replaced session (revoke + re-create) yields a different hash → `ContextChanged("session")`; changed revision → `ContextChanged("revision")`.
- New `crates/broker/src/resolve.rs` — the single `SessionError → static reason` mapping shared by both gates (token-free errors).

**Migration/denial evidence (counts are the real test results)**

- auth-service: **19 tests** (5 pre-existing + 14 new: existing-user requirement, read-scope refusal, TTL bounds, happy path + fields, malformed/unknown tokens, revoked, expired via clock, user-removed (cascade→UnknownToken, FK-off→UserRemoved), scope rescinded, **v1 row `expires_ms=0` → Expired**, **unknown scope row never granted**, `Debug` redaction, raw token never in DB + revoke-by-hash).
- broker: **63 tests** (53 pre-existing + 10 new: issue_for_session round-trip/binding; denial matrix mapping to static reasons; authenticated session ⇒ **exactly 1** transport call; forged principal w/o session ⇒ **0**; revoked-after-approval ⇒ **0**; expired ⇒ **0**; user removed ⇒ **0**; scope rescinded ⇒ **0**; revision mismatch ⇒ **0**; replaced session hash mismatch ⇒ **0** — all with `transport.calls() == 0` and the approval kept pending).
- Full crates workspace `cargo test` green; `cargo check --workspace` 0 warnings; full `pnpm run check` **EXIT 0** (format/lint/typecheck/unit/integration/check:rust/build→dist 255608 B/smoke 115 tools/e2e:ui PASS/licenses 59/architecture); `sanitize-repo --dry-run` **0 files, 0 groups**.
- UI regression (no hardware, local vite dev server `127.0.0.1:1437`, stopped after): Home/Prepare/Preview/Workbench walked with real pointer clicks + physical keyboard (Tab/arrows/digits/Enter), desktop 1280×800 + mobile 390×844 × light/dark; **zero page errors / zero console errors / zero failed requests** (only the dev-server `/favicon.ico` 404 on desktop-light — vite boilerplate, not app code); read-only surface preserved everywhere — exactly one "No printer selected" marker per page, `deviceAvailability.canWrite === false` by construction (`device-availability-core.ts` is a pure constant DP). 16 screenshots captured and inspected, `poc-output/ui-check-s19-003/*.png` (gitignored).
- **Explicit non-claims**: no Tauri/UI writer endpoint added; `main.rs` stdio gains **no** session ops (external session establishment remains a backend-only API, Sprint 10 — partial, not complete); `upsert_user` stays internal (not a UI login wire); no user login exists; approval UI not wired; bridge/cloud not exposed; no commits/push.

#### Implementation Notes — S9.18-003 follow-up: `create_session` grant + clock enforcement (correction)

Correction to the two slices above: they claimed `create_session` requires an explicitly granted scoped capability, but the implemented path only checked user-exists + `is_session_capability()` — it **never queried the `scopes` grant**, so any existing user could mint a `device_control` session without `DeviceControl` being granted. `now + ttl_ms` was also a raw add (overflow-unchecked) and neither path validated the clock.

- `crates/auth-service/src/sessions.rs` `create_session`, now in order: TTL bounds → session capability → **positive clock** (`InvalidClock` for zero/pre-Epoch) → **overflow-safe expiry via `now.checked_add(ttl_ms)`** (`InvalidClock` on overflow) → **user exists** (`UnknownUser`) → **scope actually GRANTED as a `scopes` row** (`ScopeRescinded` — same fail-closed denial `resolve_session` reports at use time; refused before RNG) → RNG → **atomic single-statement `INSERT … SELECT … WHERE EXISTS(user) AND EXISTS(grant)`** so a concurrent revoke on an external file can never mint a row without a live grant (0 rows ⇒ re-query for `UnknownUser`/`ScopeRescinded`; nothing persisted).
- `resolve_session`: clock sanity now runs **before any grant lookup** — non-positive clock (`now ≤ 0`) or wallclock rolled back before creation (`now < created_ms`) ⇒ `InvalidClock`; expiry stays per-row monotonic (a recovered clock can never rewind an expiry, mirroring the approval `consume` behavior).
- Stable error surface: reused exactly `ScopeRescinded`/`InvalidClock` — **no new `SessionError` variants** (broker `resolve.rs` mapping untouched). No login endpoints; no autogrant — granting stays only via `upsert_user` + `grant_scope`.
- Counts: auth-service **24 tests** (19 + 5 new: no-grant ⇒ `ScopeRescinded` + **0 rows minted** via private-conn `COUNT(*)`; clock must be positive; expiry overflow refused; resolve rollback denied before grants then recovers; resolve zero/pre-Epoch clock invalid). Broker **63 tests** — the `issue_for_session_denials_map_to_static_token_free_reasons` case-6 required a re-grant after case-5 rescinds, i.e. the new contract refuses minting on a rescinded grant. `cargo check` 0 warnings; full `pnpm run check` **EXIT 0**; sanitize DRY-RUN 0/0.
- UI (no hardware, private vite, stopped after): **keyboard navigation VERIFIED with a fresh clean context**. Root cause of the previously retracted claim was the probe itself: it clicked `home-demo-prepare` first (moving focus into the Home main section before tabbing) and relied on the locale-specific selector `nav[aria-label="Workspace view"]`. The new falsifier probe (`poc-output/ui-check-s19-003/keyboard-clean-probe.mjs`, gitignored) opens `?provider=demo` with empty localStorage and **zero pointer interaction**; it measured: `document.activeElement === BODY` at boot (no autofocus), locale en-US → rendered nav aria-label "Workspace view", `.app-brand` span NOT focusable, no dock pills, and the nav buttons are the **first 4 focusables in the document** (`tabindex 0`, visible, not inside `[hidden]`). Natural Tab #1 → **Home**, #2 → **Prepare**, #3 → **Preview**, #4 → **Workbench**; Shift+Tab reverses Preview → Prepare (stays in nav); **Enter on Workbench switches `data-workspace-view="workbench"`** and flips aria-pressed; Esc with nothing open is a no-op (no new page errors). Committed as the front "keyboard-only workspace nav" scenario in `tests/e2e/editor-reload.e2e.mjs` (asserts the full sequence; exact 17-event keydown trace logged as `e2e:editor-reload keyboard seq: [...]`). Non-modal overlays: bell Escape closes the popover **and returns focus to the bell trigger** (`aria-expanded=false`, `activeElement===toast-bell`); floating chat Escape collapses to the dock pill and focus exits the panel (lands on BODY — not the trigger; the next Tab reaches nav Home ⇒ **no focus trap**; the BODY fallback is disclosed, not overclaimed). Focus-ring PNGs inspected (`poc-output/ui-check-s19-003/kb-*.png`, 11 files: desktop/mobile × light/dark nav Home+Prepare + toast popover): nav 282×33 px at header y=8, ring inside button bounds, no occlusion; zero page/console errors (only dev favicon 404). **No product change was needed — the refactored UI's Workspace nav is keyboard-reachable from natural document focus.**
- Remaining (accurate): **no user login exists** — session establishment stays backend-only (Sprint 10 partial); `main.rs` stdio has no session ops. No commits/push in this correction.

#### Implementation Notes — 2026-10-09: chat Escape focus-return (S9.18-003 UI polish)

**Correction to the note above**: it claimed floating-chat Escape lands on BODY. That is now fixed: Escape from the floating chat panel returns focus to the **opener** — the global header chat toggle `.header-chat-toggle` when opened from the header (or the sidebar detach action), and the same always-visible header toggle as the fallback when the opener is hidden by the nav change (pill unmounts on open, so the pill cannot be restored to). The previous BODY landing was real and measured (probe + e2e showed `activeElement === BODY`), which is why it was disclosed honestly; it is now superseded.

**Why no Radix `Dialog.Trigger` was needed** — `FloatingPanelHost` renders `DialogPrimitive.Content` with `open` controlled by the zustand dock store (`setPanelMode`), so no `Dialog.Trigger` is mounted: `context.triggerRef.current` is `null`, and Radix's non-modal `DialogContentNonModal` close path (`onCloseAutoFocus`) always `preventDefault()`s and only refocuses via `triggerRef` (or `document.body` otherwise). The chosen fix instead captures the actual opener **before** Radix autofocus moves focus: `onOpenAutoFocus` fires synchronously as part of Radix's FocusScope `AUTOFOCUS_ON_MOUNT` dispatch, at which point `document.activeElement` is still the element the pointer was on — capture it into `openerRef`. On close, `onCloseAutoFocus` runs `preventDefault()` and restores `openerRef.current` if it is still a valid restorable focus target (`isRestorableFocusTarget`: connected, not `document.body`, has `getClientRects().length > 0`, not a disabled button/input), else falls back to `.header-chat-toggle`. Gated by `kind === "chat"` so device/transform panels keep Radix's default behavior.

**Change scope** — implementation only in `apps/editor/src/components/dock/FloatingPanelHost.tsx` (`FloatingPanelHost` + module doc); `dock-panel.tsx`/`App.tsx` unchanged (capture is automatic via `activeElement`; no trigger ref threading). Test additions in `tests/e2e/editor-reload.e2e.mjs`: `settleChatOpenerFocus` evidence helper + assertions for (1) header-open → Escape → focus on `.header-chat-toggle`, not inside the chat DOM, Home not hidden; (2) pill-open → Escape → no trap + header fallback; (3) a loop over Prepare/Preview/Workbench pages — every page: Escape closes, pill returns, focus on the header toggle, no page errors/5xx. Also `poc-output/focus-restore-probe.mjs` (gitignored, kept as evidence).

**Real gate/evidence counts (all from actual runs, not asserted from memory)**:

- Full `pnpm run check` **EXIT 0** (chain: format → lint → typecheck → test:unit **pass 803** → test:integration **pass 11** → check:rust → build → dist/server.mjs **255608 B** → smoke **115 tools** → e2e:ui **PASS** (cad-ui objects=4 + editor-reload PASS + editor-home PASS) → check:licenses **59 deps** → check:architecture OK → `sanitize-repo.mjs --dry-run` **0 files, 0 groups** (also run standalone: 0/0, usr=<USER_HOME>)).
- Focus-restore e2e scenario: the full 17-event keydown trace including the new Escape→"Open chat" events is logged as `e2e:editor-reload keyboard seq: [...]`; the focused run passes standalone and in the gate chain.
- Visual evidence `poc-output/ui-check-s19-018-focus/` (gitignored): **16 files** — 8 PNG (`desktop|mobile` × `light|dark` × `chat-escape` full-page + `header-zoom` 2× crop) + 4 `ring-probe.json` + 4 `header-scroll` PNG. Inspected with vision: in all four combos the panel closes, the dock pill returns, nav buttons are not occluded, and the focus ring is visible on `.header-chat-toggle` — 2px solid `var(--border-focus)` outline per the global `button:focus-visible` rule (light `rgb(36,115,72)`, dark `rgb(63,160,107)`), `activeElement === .header-chat-toggle`, `:focus-visible === true`, panel count 0, pill count 1. Only error in capture: dev-server `/favicon.ico` 404 (vite boilerplate, not app code).

**Explicit non-claims** — keyboard coverage beyond what was probed is NOT claimed: Enter/Tab/Escape flows were exercised only for the scenarios listed (nav Tab/Shift+Tab/Enter, bell popover Escape, chat header/pill Escape); other keyboard behaviors in the chat panel itself are out of scope for this slice. Device/transform panels were untouched and keep Radix default focus behavior. No commits/push; ticket **S9.18-003 status stays 🔄 In progress** — this slice is UI polish on the floating chat focus path, not the full backend-authenticated approval criterion.

#### Implementation Notes — S9.18-003 follow-up: snapshot + project binding and capability caps (S9.18-003 continuation slice)

**Status: in progress** — schema v6 + closure enforcement landed gate-green (broker 85, auth-service 27, editor Tauri 28/19 device-control) and the Workbench widget proves the honest blocked state; the ticket criterion (UI-originated authenticated writes with approval UI) is still NOT complete: no external verified-session establishment and no real resolver gateway exist — those are the explicit "remaining" for the next slice. No commits/push.

**Broker schema v6 (`crates/broker/src/db.rs`)** — `SCHEMA_VERSION` 5 → **6**; `apply_v6` runs two idempotent `ALTER TABLE approvals ADD COLUMN` statements (`device_snapshot_ms INTEGER`, `project_id TEXT`) plus `PRAGMA user_version = 6`; the `migrate()` arm is `if current < 6 { self.apply_v6()?; }`. Migration-test assertions updated 5 → 6. The two new columns are dedicated, nullable, and NOT overloaded onto `revision`/`artifact` string columns.

**Broker closure enforcement (`crates/broker/src/approval.rs`)** — all request structs carry the new fields: `IssueRequest`/`ScopedIssueRequest` (`device_snapshot_ms: Option<i64>`, `project_id: Option<&str>`), `ConsumeContext` +2, `ApprovalRow` get(10)/get(11) with the remainder shifted (issued 12, expires 13, consumed 14, revoked 15); the `INSERT` is now 16 columns with `(…, NULL, 0)` for consumed/revoked. **`issue_for_session_scoped`** now refuses (before RNG) `DeviceControl`-scope issuance when `device_snapshot_ms` is not `Some(ms>0)` or `project_id` is `None` (`InvalidRequest`). **`consume`** revalidates the envelope in the locked order (principal → action → target → payload_digest → session → revision → artifact → material → **snapshot** → **project**): `row.device_snapshot_ms != ctx.device_snapshot_ms` → `ContextChanged("snapshot")`; `row.project_id.as_deref() != ctx.project_id` → `ContextChanged("project")` — both BEFORE the conditional one-winner `UPDATE`; any mismatch leaves the approval pending at zero transport calls.

**Backward-compat denial, by design** — legacy pending v5 rows keep NULL `device_snapshot_ms`/`project_id`; strict Option-equality means a trusted `Some` context vs a NULL row → `ContextChanged` (denied, approval preserved). Old generic job-dispatch (`job_dispatch.rs`) calls keep `None`/`None` (noWriter lanes by design, `device_snapshot_ms: None, project_id: None` in its `ConsumeContext`) — the exact `legacy_null_columns_never_authorize_trusted_writes` regression proves the split. `dispatch.rs` `RequestContext` gains the two owned fields; its session tests build contexts via the new `req_session()` helper (or explicit `Some(BASE)`/`Some("project-1")`).

**Staged broker regressions (3, all GREEN)** — `project_swap_same_revision_is_denied` (legacy approve with None/None, consume with a different project → `ContextChanged("project")`, 0 calls, pending kept); `snapshot_new_fresh_denies_stale_payload_same_context` (approve with T, consume with T′ → `ContextChanged("snapshot")`); `legacy_null_columns_never_authorize_trusted_writes` (None/None approve, trusted-Some consume denied; None/None consume grants).

**Tauri `device_control.rs` (~1750 → ~2050 lines, 19 device_control tests)** — `DeviceContext` gains `capabilities: Option<Vec<DeviceControlAction>>` (trusted backend descriptor only, `Serialize`); `check_capability()` (`None` → `unavailable("capability-unavailable")`, `Some(list)` without the action → `unavailable("action-not-enabled")`) is wired into **all three write paths**: preflight (after `resolve_context`, typed unavailable draft, never an issue row), approve (step 2b, BEFORE issue), dispatch (re-checked BEFORE `gate.dispatch_for_session` consume — a capability revoked between approve and dispatch is rejected at 0 transport calls and the approval stays pending). `approve()` binds `device_snapshot_ms: Some(ctx.snapshot_captured_at_ms)` and `project_id: Some(ctx.project_id.as_str())` into `ScopedIssueRequest`; `dispatch()` binds the fresh `Some(ctx.snapshot_captured_at_ms)` / `Some(ctx.project_id.clone())` into `RequestContext` (a resolver re-read since approve → snapshot T′ → broker `ContextChanged("snapshot")`, approval preserved). `availability()` now reports `capability.defined` only when the descriptor is `Some` non-empty (else `capability-unavailable`), so the Workbench rows honestly reflect "no capability descriptor → no writer". The `changed_trusted_revision` test now restores the ORIGINAL context clone (fresh context would mint a new snapshot and trip `ContextChanged("snapshot")` instead of proving the ack-on-restore). New Tauri regressions (3, GREEN): `capabilities_none_keep_preflight_and_approve_typed_unavailable_no_row`, `action_outside_capability_list_is_typed_unavailable_before_issue`, `capability_revoked_between_approve_and_dispatch_rejects_before_consume`.

**Real gate/evidence counts (from actual runs)** — full `pnpm run check` **EXIT 0** (format/lint/typecheck/unit/integration/check:rust tests green/build → `dist/server.mjs` 255608 B/smoke **115 tools**/e2e:ui PASS 3 suites/licenses 59/architecture OK/`sanitize-repo.mjs --dry-run` **0 files, 0 groups**); `cargo test -p broker -p auth-service`: broker **85 passed**, auth-service **27 passed**; editor Tauri `cargo test`: **28 passed** (lib), of which **19 are `device_control`**; `cargo check` 0 warnings. UI capture `poc-output/ui-check-s19-018c/` (gitignored): 16-matrix PNGs (home/prepare/preview/workbench × desktop/mobile × light/dark) + armed Workbench evidence `device-panel-evidence-armed-workbench-light-desktop.png`, all 17 inspected with vision — **zero page errors / zero console errors / zero failed requests** (only dev `/favicon.ico` 404); the workbench widget renders `data-writer="false"`, `writer=disabled`, `auth-unavailable`, no "writer ready" affordance; keyboard Tab/Enter/Escape probe passes (nav Home/Prepare/Preview/Workbench first focusables, Escape safe).

**Explicit non-claims / remaining** — no external verified-session establishment (backend-only API, Sprint 10 partial) and no real device resolver gateway; the demo/none resolver keeps every write route typed unavailable; TS `device-control.ts` + `tests/device-control.test.mjs` unchanged (capability descriptor not exposed to the UI descriptor); no commits/push.

#### Implementation Notes — S9.18-003 follow-up: auth DB path unification (single config owner)

**Status: in progress (slice, no commit)** — the CLI and the Tauri writer
authority now share one resolver (`crates/auth-service/src/config.rs`),
closing the gap where `device_control.rs::auth_db_path()` resolved
`%APPDATA%\\AnycubicBridge\\auth.db` directly while `auth-service` defaulted
to `AUTH_DB`/project-relative `auth.db`. Contract: explicit CLI `--db` >
`ANYCUBIC_AUTH_DB` > legacy `AUTH_DB` > platform app-data default (Windows
`AnycubicBridge\\auth.db`, Unix `anycubic-bridge/auth.db`); **unset** skips,
**set-but-empty** is a typed `EmptyPath` error; relative explicit config
normalizes against the startup cwd; the Tauri open path refuses an auth path
that aliases `workspace.db` (typed `db` error). Resolution never touches the
DB file or creates directories; existing user/token contents are never
moved/read. Test counts from actual runs: auth-service **41 passed** (27
pre-slice + 14 new config), editor Tauri **30 passed** (28 pre-slice + 2 new
device_control), `cargo check` clean on both workspaces (check-rust exit 0).
The ticket criterion (UI-originated authenticated writes with approval UI)
remains NOT complete — still no verified-session establishment or real
resolver gateway; the observed "2026-10-12" label on the prior slice heading
was replaced with an undated S9.18-003 label (machine date 2026-10-10).

## Sprint Commit

Each ticket commit uses `feat(s9.18-00x): <imperative summary>` (or suitable Conventional Commits type) only after focused validation, both health commands and policy tests pass; no push.
