# S9.18-001 — Public-safe operation discovery catalog (PARTIAL)

> **Status: PARTIAL — AI03/AI04, not complete.**
> This slice delivers **discovery only** for the 13 already-known writer
> actions: a versioned, public-safe catalog (`GET /operations` +
> `GET /operations/{id}`) built on top of the **existing** action allowlists
> and typed parsers. **Discovery is NOT permission** — the default backend
> wires no session, no writer transport and no snapshot resolver, so every
> known writer entry reports `available:false` with a precise stable reason.
> Nothing in this slice activates physical writers or adds a general
> execution endpoint. Per the scope contract this slice stays PARTIAL until
> actual inventory/shared-handler parity is proven (see §6).

---

## 1. Scope (what this slice is)

Anchors (single-owner mapping + typed validators, no parallel unsafe
validators):

- `crates/broker/src/action_registry.rs` — the 13 known writer IDs with their
  single-scope mapping and the new discovery catalog (schema, effect class,
  approval policy, honest handler mapping, availability gate).
- `crates/broker/src/dispatch.rs` / `job_dispatch.rs` — typed payload
  validators (`DevicePayload::parse`, `UploadIntent`/`QueueIntent`/
  `StartIntent`/`StopIntent` serde shapes) are the **authoritative**
  enforcement. The catalog's `inputSchema` fields are a hand-maintained
  DOCUMENTATION contract that shares the dispatch constants (see §4) — it is
  NOT parser-derived and therefore cannot be "drift-proof"; dedicated tests
  re-parse schema-approved examples with the authoritative parsers so the
  contract stays honest when either side changes.
- `crates/broker/src/lib.rs` — public re-exports of the catalog types.
- `crates/broker-server/src/lib.rs` — `AppState.capabilities`
  (`broker::BackendCapabilityState`), `operations_handler` +
  `operation_handler`, routes `/operations` and `/operations/{operation_id}`,
  strict origin guard, static structured unknown error, bounded output.

Catalog contract (wire, `schemaVersion: 1`):

| Field                | Type    | Notes                                                                                                                                                           |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string  | one of the 13 known writer IDs (single owner)                                                                                                                   |
| `schemaVersion`      | number  | catalog schema version (1)                                                                                                                                      |
| `effect`             | string  | thermal \| state \| upload \| job                                                                                                                               |
| `requiredScope`      | string  | backend-owned scope: device_control \| device_upload \| print_job                                                                                               |
| `approvalPolicy`     | string  | `one_use_approval` for every writer                                                                                                                             |
| `handler`            | string  | dispatch_device_control \| dispatch_job                                                                                                                         |
| `inputSchema`        | object  | CLOSED (`additionalProperties:false`) JSON schema; hand-maintained DOCUMENTATION contract sharing the dispatch constants — the typed parsers stay authoritative |
| `available`          | boolean | false by default (backend wires nothing)                                                                                                                        |
| `availabilityReason` | string  | stable machine reason, see §3                                                                                                                                   |

## 2. What is implemented and verified

**13 known writer entries** (single scope mapping unchanged, ordered):

1. `nozzle` → `device_control`, effect `thermal`
2. `bed` → `device_control`, effect `thermal`
3. `part_fan` → `device_control`, effect `thermal`
4. `speed` → `device_control`, effect `state`
5. `light_set_enabled` → `device_control`, effect `state`
6. `light_brightness` → `device_control`, effect `state`
7. `ace_dry` → `device_control`, effect `thermal` (dryer heater target + duration)
8. `ace_auto_feed` → `device_control`, effect `state`
9. `ace_bind_slot` → `device_control`, effect `state`
10. `upload` → `device_upload`, effect `upload`
11. `job.queue` → `print_job`, effect `job`
12. `job.start` → `print_job`, effect `job`
13. `job.stop` → `print_job`, effect `job`

**HTTP surface** (broker-server, loopback only):

- `GET /operations` → 200 with `{schemaVersion: 1, operations: [...]}`.
- `GET /operations/{operation_id}` → 200 single entry, or 404 with a STATIC
  body `{error: "operation-not-found"}` (NO `id` field — the caller-
  controllable id is bounded `[a-z0-9._-]`, ≤ 64 bytes, before the registry
  lookup and is never echoed; oversized/off-charset ids answer the exact
  same immutable body).
- Strict origin guard (`origin_allowed`) — any origin outside the dev
  (`http://127.0.0.1:1420`) / prod (`tauri://localhost`) allowlist or the env
  `ANYCUBIC_BROKER_ALLOWED_ORIGIN` set is refused with 403 `Origin not
allowed` before any body is produced.
- Bounded output: the full catalog body stays well under the 256 KiB request
  limit (asserted < 256 KiB in tests).
- No secrets, provider URLs, account paths or token material ever appear in
  the catalog (asserted on the wire, see §5).

**Availability gate** (`availability(id, handler, scope, state)`) uses
backend-owned trusted state, never query JSON:

1. revoked → `revoked` (DISCOVERY-only advisory — dispatch gates enforce
   their own approval-level revocation; this descriptor never authenticates)
2. handler transport not wired → `backend-not-wired`
3. the entry's `requiredScope` is NOT in `state.granted_scopes` (an absent
   session and a missing scope both map to the single stable reason) →
   `no-session`
4. every device-control handler AND `job.start` / `job.stop` additionally
   require a trusted snapshot resolver → `no-trusted-snapshot` when absent
   (upload/queue need none)

Default `BackendCapabilityState::default()` grants no scopes and wires
nothing ⇒ all 13 entries report `available:false` with
`availabilityReason: "backend-not-wired"`. Tests inject backend state
(granted scope sets / wired transports / resolver / revoked list) and prove
the flip is honest and per-action, and that unknown/invalid/unavailable/
revoked states fail before any effect.

## 3. Availability reasons (stable machine vocabulary)

| Reason                | Meaning                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `backend-not-wired`   | the handler's transport is not wired in this backend                                                                              |
| `no-session`          | the entry's required scope is not in the backend's granted scopes (absent session and missing scope share this one stable reason) |
| `no-trusted-snapshot` | device-control actions and job start/stop need a trusted printer snapshot resolver (absent)                                       |
| `revoked`             | the action id is explicitly revoked in backend state (DISCOVERY-only advisory — not an authentication grant)                      |
| `""` (empty)          | the action is genuinely available (only reachable with injected state in tests, never in the default backend)                     |

## 4. Reuse, not parallel validators

`inputSchema` for each device-control entry is generated from the SAME window
constants the dispatch layer enforces (`NOZZLE_MAX_C`, `BED_MAX_C`,
`FAN_MAX_PCT`, `BRIGHTNESS_MAX_PCT`, `ACE_BOX_MAX`, `ACE_SLOT_MAX`,
`DRYER_TARGET_MAX_C`, `DRYER_DURATION_MAX_MIN`, `MAX_UPLOAD_BYTES`,
`MAX_MATERIAL_SLOTS`). The opaque-ref / CAS rules share the `is_opaque_ref` /
`is_cas_digest` restrictions (`job_dispatch.rs`): the ref pattern is
`^[^\s/:\\\u0000]+$` — NUL is denied EXPLICITLY because ECMA `\s` does not
cover U+0000 — and the description states the byte caveat: `maxLength` counts
characters while the typed parser bounds encoded BYTES to
`MAX_IDENTIFIER_LEN` (256), so e.g. 256 two-byte characters pass the schema
shape but are refused by the parser. Revision fields (`profile_rev`,
`project_revision`) expose the exact serde `u64` ceiling (`maximum:
18446744073709551615`).

The schemas are a **documentation contract, not a parallel validator**:
`DevicePayload::parse` and the serde intents stay authoritative. Tests keep
the contract honest on BOTH sides: (a) schema-approved example payloads are
re-parsed with the authoritative parsers (and must succeed), and (b) every
schema-documented required field is dropped / an unknown extra field is added
and the authoritative parser must refuse — so a schema/parser disagreement
fails the suite, in either direction. No writable channel is opened by the
catalog; the broker crate already owns the writer mapping — this slice only
publishes it.

## 5. Evidence

Full gate (single run, `pnpm run check`): **exit 0**

| Artifact                                                                                                                                                                                                                                              | Result                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Rust unit — `crates/broker` (incl. `action_registry` catalog tests)                                                                                                                                                                                   | 97 PASS                |
| Rust test — `broker-server/tests/operations_test.rs` (10 cases: 200 list, 403, entry, static structured 404 no-echo + oversized/off-charset, injected availability flips, no-session, scoped matrix, snapshot gate, bounded body, no route shadowing) | 10/10 PASS             |
| Rust test — `broker-server/tests/loopback_test.rs` (unchanged)                                                                                                                                                                                        | 7 PASS                 |
| Rust test — `broker-server/tests/provider_egress_test.rs` (unchanged)                                                                                                                                                                                 | 17 PASS                |
| JS unit — full suite                                                                                                                                                                                                                                  | 879 PASS               |
| Integration                                                                                                                                                                                                                                           | 11 PASS                |
| Build                                                                                                                                                                                                                                                 | OK → `dist/server.mjs` |
| MCP smoke                                                                                                                                                                                                                                             | 115 tools              |
| E2E — `tests/e2e/broker-operations.e2e.mjs` (real binary, browser on valid origin)                                                                                                                                                                    | PASS                   |
| E2E — remaining suites (cad-ui, editor reload/home/chat-scope, broker-provider-status)                                                                                                                                                                | PASS                   |
| Licenses / architecture / sanitize dry-run                                                                                                                                                                                                            | 59 OK / OK / 0 files   |
| `pnpm run check` standalone                                                                                                                                                                                                                           | **exit 0**             |

E2E proof points (`broker-operations.e2e.mjs`, no SKIP, ephemeral ports,
CORS pinned to the actual vite origin, real `cargo build -p broker-server`):

- valid-origin browser fetch → 200, `schemaVersion:1`, exactly 13 entries,
  every one `available:false` / `backend-not-wired`, closed schemas, and no
  forbidden substrings (`://`, `Users`, `AppData`, `api_key`, `Bearer`,
  `token`, `access_token`) anywhere in the body;
- `GET /operations/nozzle` → 200 (scope `device_control`, effect `thermal`,
  `inputSchema.properties.nozzle.maximum === 320`);
- `GET /operations/does-not-exist` → 404 with the STATIC body
  `{error:"operation-not-found"}` (no `id` key — plus an oversized-id case
  that must return the identical immutable body), read from the browser;
- `origin: http://evil.example` at the HTTP layer → 403 `Origin not allowed`
  (the strict guard; the browser CORS sandbox masks it as a network error, so
  it is asserted against the same binary);
- valid-origin request gets `access-control-allow-origin` echoed strictly to
  THIS run's origin (no wildcard).

**UI regression** (`local-scripts/capture-s9-18-001-ui.mjs`, outputs gitignored
in `poc-output/ui-check-s9-18-001/`, never committed): 20/20 matrix views
(Home/Prepare/Preview/Workbench + Home-chat × desktop 1440×900 / mobile
390×844 × light/dark) re-captured for this build and inspected with the image
viewer, plus the 3 Phase-B testlocal views (configured local broker,
unavailable provider banner, offline demo transport). Result: zero page
errors, zero console errors beyond the tolerated dev favicon 404s; visual
defects none. This slice changes no UI code — the capture exists to prove the
editor still renders cleanly with the new broker crate in the tree.

## 6. NOT in this slice (honest exclusions)

- **No execution endpoint**: no general `POST /operations`-style executor was
  added; the catalog is read-only discovery. Physical writers stay
  dormant — the default backend grants no scopes, wires no transport and has
  no trusted snapshot, and every entry reports it.
- **No UI/navigation/geometry actions**: the catalog covers the 13 known
  writers' actions only. Other public UI surface (Home/Prepare/Preview/
  Workbench navigation, camera, preview geometry, chat scope, object-tree
  interactions and any other UI-only action) is **explicitly not part of the
  writer inventory** — those are frontend/editor concerns that have no
  backend writer entry and no amount of discovery; they remain owned by the
  editor slices (S9.17-003/004, editor-reload/home e2e) and are excluded from
  this catalog with rationale: this slice is registry/discovery for already
  known write-side actions only.
- **AI03/AI04 parity**: the writer-side catalog is complete for the 13 known
  actions, but actual shared-handler parity with every piece of inventory
  (including camera/preview/geometry consumers) is **NOT proven**, so
  S9.18-001 stays PARTIAL until a full inventory cross-check lands.
- **Auth**: no login flow, no session establishment, no token minting.
  `no-session` / `backend-not-wired` are the truthful default answers.
- **Account/cloud**: nothing here touches the cloud account, printer
  discovery, cloud files or any provider network. The catalog is purely local
  metadata derived from the broker crate's existing registry.

## 7. Files touched

**Fix commit** (this one — narrow corrections on review of `1b8c24c`):

- `crates/broker/src/action_registry.rs` — explicit per-id effect
  classification (thermal vs state), scope-granted `BackendCapabilityState`
  (`authenticated_session` removed), snapshot gate extended to every
  device-control entry, honest schema-contract wording (NUL-denying
  opaque-ref pattern, byte-limit caveat, exact `u64` revision ceilings),
  matrix + schema↔parser tests.
- `crates/broker/src/lib.rs` — `pub use auth_service::Scope;` re-export
  (single shared scope type).
- `crates/broker-server/src/lib.rs` — `OperationNotFound` is static (no `id`
  echo), `MAX_OPERATION_ID_LEN`/`is_plausible_operation_id` bound the id
  BEFORE the registry lookup, capability doc comments reflect granted
  scopes.
- `crates/broker-server/tests/operations_test.rs` — scoped state, static
  no-echo 404 (+ oversized/off-charset), device-control snapshot pinning,
  scoped backend matrix (10 tests).
- `tests/e2e/broker-operations.e2e.mjs` — no-echo assertions + oversized-id
  case.
- This doc — honest contract wording and real evidence numbers.

**Original slice** (`1b8c24c`) also introduced the catalog in
`action_registry.rs`, the re-exports, the `AppState.capabilities` + handler
routes in `broker-server/src/lib.rs`, `operations_test.rs`, the
`broker-operations.e2e.mjs` suite, the `package.json` e2e:ui chain entry and
this doc.

Pre-existing formatting drift in untouched files (`approval.rs`,
`provider_egress_test.rs`) is NOT modified by this slice and not part of this
commit.
