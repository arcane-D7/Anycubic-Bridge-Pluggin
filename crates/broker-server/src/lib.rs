//! S9.6-008 / S9.18-001 — Broker AI-egress loopback server (library, testable).
//!
//! Implements the AI SDK v7 "UI message stream" HTTP protocol on the broker
//! lane so the editor webview can chat with a local/pinned model through
//! `DefaultChatTransport({ api })`:
//!
//! - `POST /chat` — body `{id, messages, trigger, messageId}`; answers an SSE
//!   stream of `UIMessageChunk` lines (`data:`), terminated by `data: [DONE]`.
//! - `GET /chat/{id}/stream` — reconnect probe; answers `204 No Content` when
//!   no stream is currently active for that chat (Phase 1). The v7
//!   `HttpChatTransport` treats 204 as "no active stream" and resolves `null`.
//! - `GET /health` — liveness probe used by the UI integration e2e.
//! - `GET /provider/status` — public-safe status: `{mode: "demo" |
//!   "configured" | "unavailable", configured: bool, reason: stable}`.
//!   "configured" means the egress env is VALID only — it never proves
//!   provider reachability (the UI labels it "Configured", not "Model
//!   connected").
//!
//! Egress posture (check:architecture invariant): the server never embeds a
//! provider URL. The pinned-egress endpoint is read ONLY from `ANYCUBIC_*`
//! environment variables (see [`config_from_env`]) and is always contacted
//! from this Rust process — the webview's only network lane to a model is
//! this loopback. API keys are held in the broker keystore (BYOK, S9-001);
//! this crate never logs or serializes them.
//!
//! S9.18-001 — REAL provider transport (not mock):
//! - when egress is configured, `POST /chat` ACTUALLY calls the pinned chat
//!   completions endpoint (`stream: false`, single buffered completion) and
//!   streams the reply back through the UI protocol — honest timing, no fake
//!   token animation;
//! - when egress is disabled the server answers an EXPLICIT local demo echo
//!   that flags `provider mode: demo` in the stream metadata — a data-provider
//!   mode signal, never a fake AI success;
//! - when egress is enabled but the config is invalid, the provider times
//!   out, is refused, answers non-2xx, or returns malformed output, the reply
//!   is an SSE `error` chunk with a FIXED public reason — there is NO offline
//!   echo fallback (AI-01: "missing/invalid endpoint reports unavailable, not
//!   fake model output");
//! - tool_calls in the provider reply are reported as "unsupported-tools"
//!   (the tool loop is the NEXT slice — S9.18-002);
//! - budgets: ≤[`MAX_INPUT_MESSAGES`] messages, ≤[`MAX_REQUEST_BODY`]
//!   outbound body, ≤[`MAX_RESPONSE_BODY`] inbound body, timeout clamped to
//!   1–60s, and at most one in-flight provider call (semaphore).
//!
//! Provider URL safety: the base URL is pinned — https for remote hosts, http
//! ONLY for loopback (`127.0.0.1`/`localhost`/`::1`); URLs with userinfo,
//! query or fragment are rejected; the endpoint is a relative path only
//! (never an absolute URL, `//` authority, `/` alone, `..` segments,
//! `?`/`#`); reqwest follows NO redirects and the bearer key is sent to the
//! pinned URL only — never forwarded (redirects disabled ⇒ a 3xx is surfaced
//! as a fixed upstream error, not followed).
//!
//! Cancellation: dropping the handler future (client disconnect) drops the
//! reqwest future — the in-flight request is aborted by tokio task
//! cancellation; the semaphore permit is released. No explicit token future
//! is needed this slice (the tool loop slice will add one).
//!
//! CORS: origins are reflected against an allow-list via `CorsLayer` (dev
//! `http://127.0.0.1:1420`, prod `tauri://localhost`) — never `*` on the SSE
//! lane; preflight (`OPTIONS`) is answered by the layer with the same policy.
//! The `POST /chat` handler additionally refuses unknown origins with 403.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Response as AxumResponse, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

pub const LOOPBACK_ADDR: &str = "127.0.0.1:18181";
pub const UI_STREAM_HEADER: &str = "x-vercel-ai-ui-message-stream";
pub const ALLOWED_ORIGIN_DEV: &str = "http://127.0.0.1:1420";
pub const ALLOWED_ORIGIN_PROD: &str = "tauri://localhost";

/// Default pinned endpoint (relative path) for the chat completions gateway.
pub const DEFAULT_ENDPOINT: &str = "/v1/chat/completions";
/// Default model id when `ANYCUBIC_MODEL` is not set.
pub const DEFAULT_MODEL: &str = "default";
/// S9.18-001 budgets: at most 64 input messages …
pub const MAX_INPUT_MESSAGES: usize = 64;
/// … a 256 KiB outbound request body …
pub const MAX_REQUEST_BODY: usize = 256 * 1024;
/// … and a 4 MiB inbound provider body.
pub const MAX_RESPONSE_BODY: usize = 4 * 1024 * 1024;
/// Hard cap for the provider timeout (client-configured 1–60s).
pub const MAX_EGRESS_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// S9.18-002 — tool-loop bounds (fail closed, both sides)
// ---------------------------------------------------------------------------

/// Max tool-result pairs (assistant `tool_calls` + `role:"tool"` result)
/// serialized from ONE client request. Each continuation re-sends the whole
/// transcript, so this bounds the ROUND count a misbehaving client can push
/// to the provider per request — round 1 carries 0 pairs, round N carries
/// N-1, so a value of 4 caps client-driven rounds at 5.
pub const MAX_TOOL_RESULT_PAIRS: usize = 4;
/// Max provider tool calls honored per response (navigate + select in
/// parallel is the ceiling; anything more is refused whole-response).
pub const MAX_TOOL_CALLS_PER_RESPONSE: usize = 2;
/// Max serialized args bytes per provider tool call (the webview renders and
/// the registry consumes this JSON — a hostile payload cannot exceed it).
pub const MAX_TOOL_ARGS_BYTES: usize = 8 * 1024;
/// Max length of a provider tool call id (used as the registry callId). The
/// registry only requires non-empty; the broker bounds it to keep the wire
/// bounded and the charset printable.
pub const MAX_TOOL_CALL_ID_LEN: usize = 128;
/// Max bytes of the per-message `uiContext` line injected upstream (AI-08:
/// UI-originated mutations refresh agent context — bounded snippet only).
pub const MAX_UICONTEXT_BYTES: usize = 512;

/// The ONLY provider tool names this broker will ever declare upstream or
/// honor in a reply — safe provider-compatible names (`[A-Za-z0-9_-]`)
/// mapped by the webview to the registered frontend operations. Any other
/// name (client-invented, backend writer ids like `nozzle`/`job.start`, …)
/// is a structured `unsupported-tools` denial with ZERO effects — never
/// forwarded as authority.
pub const TOOL_NAMES: [&str; 2] = ["workspace_navigate", "scene_select"];

// ---------------------------------------------------------------------------
// Wire types (mirror of the AI SDK v7 `SendMessages` payload)
// ---------------------------------------------------------------------------

/// Body of `POST /chat` (camelCase, same as the AI SDK transport sends).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub id: String,
    #[serde(default)]
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
}

/// One SSE `data:` line — an AI SDK `UIMessageChunk`.
///
/// S9.18-001: the SDK v7 schema (verified against the installed `ai@7`
/// bundle) adds `error` chunks `{type:"error", errorText}` and
/// `message-metadata` chunks `{type:"message-metadata", messageMetadata}` —
/// both optional here so unchanged chunks keep their exact wire shape.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiMessageChunk {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
}

impl UiMessageChunk {
    pub fn start(message_id: &str) -> Self {
        Self {
            kind: "start".into(),
            message_id: Some(message_id.into()),
            id: None,
            delta: None,
            finish_reason: None,
            error_text: None,
            message_metadata: None,
            tool_call_id: None,
            tool_name: None,
            input: None,
        }
    }

    pub fn text_start(id: &str) -> Self {
        Self {
            kind: "text-start".into(),
            message_id: None,
            id: Some(id.into()),
            delta: None,
            finish_reason: None,
            error_text: None,
            message_metadata: None,
            tool_call_id: None,
            tool_name: None,
            input: None,
        }
    }

    pub fn text_delta(id: &str, delta: &str) -> Self {
        Self {
            kind: "text-delta".into(),
            message_id: None,
            id: Some(id.into()),
            delta: Some(delta.into()),
            finish_reason: None,
            error_text: None,
            message_metadata: None,
            tool_call_id: None,
            tool_name: None,
            input: None,
        }
    }

    pub fn text_end(id: &str) -> Self {
        Self {
            kind: "text-end".into(),
            message_id: None,
            id: Some(id.into()),
            delta: None,
            finish_reason: None,
            error_text: None,
            message_metadata: None,
            tool_call_id: None,
            tool_name: None,
            input: None,
        }
    }

    pub fn finish(finish_reason: &str) -> Self {
        Self {
            kind: "finish".into(),
            message_id: None,
            id: None,
            delta: None,
            finish_reason: Some(finish_reason.into()),
            error_text: None,
            message_metadata: None,
            tool_call_id: None,
            tool_name: None,
            input: None,
        }
    }

    /// `{type:"error", errorText}` — surfaces as `chat.error` in the UI.
    pub fn error_text(error_text: &str) -> Self {
        Self {
            kind: "error".into(),
            message_id: None,
            id: None,
            delta: None,
            finish_reason: None,
            error_text: Some(error_text.into()),
            message_metadata: None,
            tool_call_id: None,
            tool_name: None,
            input: None,
        }
    }

    /// `{type:"message-metadata", messageMetadata}` — e.g. provider-mode
    /// signaling for the demo lane (data-provider signal, never fake AI).
    pub fn message_metadata(metadata: serde_json::Value) -> Self {
        Self {
            kind: "message-metadata".into(),
            message_id: None,
            id: None,
            delta: None,
            finish_reason: None,
            error_text: None,
            message_metadata: Some(metadata),
            tool_call_id: None,
            tool_name: None,
            input: None,
        }
    }

    /// `{type:"tool-input-start", toolCallId, toolName}` header for a tool
    /// invocation — mirrors the AI SDK v7 chunk shape, `providerExecuted`
    /// ABSENT so the webview's `onToolCall` owns the execution.
    pub fn tool_input_start(tool_call_id: &str, tool_name: &str) -> Self {
        Self {
            kind: "tool-input-start".into(),
            message_id: None,
            id: None,
            delta: None,
            finish_reason: None,
            error_text: None,
            message_metadata: None,
            tool_call_id: Some(tool_call_id.into()),
            tool_name: Some(tool_name.into()),
            input: None,
        }
    }

    /// `{type:"tool-input-available", toolCallId, toolName, input}` — the
    /// arguments object the webview will execute (NO `providerExecuted`).
    pub fn tool_input_available(tool_call_id: &str, tool_name: &str, input: serde_json::Value) -> Self {
        Self {
            kind: "tool-input-available".into(),
            message_id: None,
            id: None,
            delta: None,
            finish_reason: None,
            error_text: None,
            message_metadata: None,
            tool_call_id: Some(tool_call_id.into()),
            tool_name: Some(tool_name.into()),
            input: Some(input),
        }
    }
}

// ---------------------------------------------------------------------------
// Environment-only egress config
// ---------------------------------------------------------------------------

/// Pinned-egress configuration, read from `ANYCUBIC_*` env vars only.
///
/// - `ANYCUBIC_MODEL_URL` — the talking endpoint we stream FROM (e.g. a local
///   Ollama/OpenAI-compatible gateway URL). NEVER a repo literal. Must be an
///   HTTPS URL, or HTTP ONLY for loopback hosts (`127.0.0.1`/`localhost`/`::1`);
///   no userinfo/query/fragment allowed (pinned base only).
/// - `ANYCUBIC_MODEL_API_KEY` — BYOK key (broker keystore-backed); absent →
///   bearer header omitted. Held in this process only; redacted in `Debug`.
/// - `ANYCUBIC_MODEL_ENDPOINT` — RELATIVE path of the pinned gateway
///   (default `/v1/chat/completions`). Absolute URLs, `//` authorities,
///   `/` alone, `?`/`#` and `..` segments are rejected.
/// - `ANYCUBIC_MODEL` — optional provider model id; default `"default"`.
///
/// When no env is set the server answers a deterministic local echo stream
/// (offline dev default) — the webview needs no provider URL ever.
#[derive(Clone)]
pub struct EgressConfig {
    pub model_url: Option<String>,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub timeout: Duration,
    pub enabled: bool,
    pub model: Option<String>,
    /// EXTRA CORS origins (dev/test only): `http://127.0.0.1:<port>` exact —
    /// validated by [`validate_allowed_origin`], never expanded to a
    /// wildcard. The static dev/prod origins stay hardcoded.
    pub allowed_origins: Vec<String>,
}

impl Default for EgressConfig {
    fn default() -> Self {
        Self {
            model_url: None,
            api_key: None,
            endpoint: None,
            timeout: Duration::from_secs(60),
            enabled: false,
            model: None,
            allowed_origins: Vec::new(),
        }
    }
}

/// S9.18-001: `Debug` must NEVER leak the api_key (secrets stay in the broker
/// keystore; any `{:?}` log of the config only shows key PRESENCE).
impl std::fmt::Debug for EgressConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EgressConfig")
            .field("model_url", &self.model_url)
            .field(
                "api_key",
                &self
                    .api_key
                    .as_ref()
                    .map(|_| "[REDACTED]")
                    .unwrap_or("none"),
            )
            .field("endpoint", &self.endpoint)
            .field("timeout", &self.timeout)
            .field("enabled", &self.enabled)
            .field("model", &self.model)
            .field("allowed_origins", &self.allowed_origins)
            .finish()
    }
}

/// Resolve pinned-egress from the environment (agnostic — no literals).
pub fn config_from_env() -> EgressConfig {
    let model_url = std::env::var("ANYCUBIC_MODEL_URL").ok();
    let api_key = std::env::var("ANYCUBIC_MODEL_API_KEY").ok();
    let endpoint = std::env::var("ANYCUBIC_MODEL_ENDPOINT")
        .ok()
        .filter(|s| !s.is_empty());
    let model = std::env::var("ANYCUBIC_MODEL")
        .ok()
        .filter(|s| !s.is_empty());
    let allowed_origins = std::env::var("ANYCUBIC_BROKER_ALLOWED_ORIGIN")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty() && validate_allowed_origin(origin))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    EgressConfig {
        enabled: model_url.is_some(),
        model_url,
        api_key,
        endpoint,
        model,
        allowed_origins,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Pinned-URL validation (pure, SSRF-safe)
// ---------------------------------------------------------------------------

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]" | "0:0:0:0:0:0:0:1" | "[0:0:0:0:0:0:0:1]"
    )
}

/// Base provider URL: HTTPS for any host, HTTP accepted ONLY for loopback;
/// never with userinfo, query or fragment (pinned base only).
pub fn validate_model_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => is_loopback_host(host),
        _ => false,
    }
}

/// Endpoint: relative path ONLY — starts `/`, length > 1 (rejects `/` alone),
/// never a `//` authority, no query/fragment/whitespace, no `..` segments.
pub fn validate_endpoint(raw: &str) -> bool {
    if !raw.starts_with('/') || raw.len() <= 1 || raw.starts_with("//") {
        return false;
    }
    if raw.contains('?') || raw.contains('#') || raw.chars().any(char::is_whitespace) {
        return false;
    }
    if raw.split('/').any(|seg| seg == "..") {
        return false;
    }
    true
}

/// Extra CORS origin validation for `ANYCUBIC_BROKER_ALLOWED_ORIGIN`.
/// STRICT: `http` + loopback host `127.0.0.1` (+ any port — a dev vite picks
/// an ephemeral one), NO userinfo/query/fragment, NO wildcard. A value that
/// fails validation is DROPPED at parse time (the static dev/prod origins
/// remain; the allow-list is never broadened by a bad env value).
pub fn validate_allowed_origin(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
}

// ---------------------------------------------------------------------------
// Provider errors (fixed public reasons — never URLs / keys / bodies)
// ---------------------------------------------------------------------------

/// S9.18-001 provider outcome. `reason()` is the ONLY text that may reach
/// the UI (SSE `error` chunk) — stable codes, no secrets, no provider URLs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// Egress env absent (only reachable if `enabled` and `model_url` diverge).
    MissingModelUrl,
    /// `ANYCUBIC_MODEL_URL` fails the pinned-base rules.
    InvalidModelUrl,
    /// `ANYCUBIC_MODEL_ENDPOINT` is not a safe relative path.
    InvalidEndpoint,
    /// More than [`MAX_INPUT_MESSAGES`] text messages upstream.
    TooManyMessages,
    /// Outbound JSON body exceeds [`MAX_REQUEST_BODY`].
    RequestTooLarge,
    /// Inbound provider body exceeds [`MAX_RESPONSE_BODY`].
    ResponseTooLarge,
    /// Provider did not answer within the configured (capped) timeout.
    Timeout,
    /// Another provider call is in flight (semaphore busy) — the queue never
    /// grows unbounded; the caller FAILS FAST with this stable reason and
    /// never auto-retries.
    ProviderBusy,
    /// Provider answered non-2xx (redirects disabled ⇒ 3xx lands here too).
    UpstreamStatus(u16),
    /// Connection refused / DNS / transport failure.
    Network,
    /// Body did not match the closed chat-completions schema.
    MalformedResponse,
    /// Provider sent `tool_calls` — unsupported THIS slice (S9.18-002 next).
    UnsupportedTools,
    /// The client request serialized more tool-result pairs than
    /// [`MAX_TOOL_RESULT_PAIRS`] — a misbehaving/replayed loop must fail
    /// closed, never grow unbounded.
    ToolLoopLimit,
}

impl ProviderError {
    /// Stable public code — safe to surface verbatim in the UI.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::MissingModelUrl => "missing-model-url",
            Self::InvalidModelUrl => "invalid-model-url",
            Self::InvalidEndpoint => "invalid-endpoint",
            Self::TooManyMessages => "too-many-messages",
            Self::RequestTooLarge => "request-too-large",
            Self::ResponseTooLarge => "response-too-large",
            Self::Timeout => "timeout",
            Self::ProviderBusy => "provider-busy",
            Self::UpstreamStatus(_) => "upstream-status",
            Self::Network => "network-error",
            Self::MalformedResponse => "malformed-response",
            Self::UnsupportedTools => "unsupported-tools",
            Self::ToolLoopLimit => "tool-loop-limit",
        }
    }
}

// ---------------------------------------------------------------------------
// Provider status (public-safe)
// ---------------------------------------------------------------------------

/// `GET /provider/status` payload. `configured` only reflects VALID env —
/// it does NOT prove reachability/health (the UI labels it "Configured").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderMode {
    /// Egress disabled — the server answers the offline demo echo.
    Demo,
    /// Egress enabled AND the config is valid.
    Configured,
    /// Egress enabled but the config is invalid → SSE errors, no fake output.
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    pub mode: ProviderMode,
    pub configured: bool,
    pub reason: &'static str,
}

/// Pure status derivation (headless/testable).
pub fn provider_status_for(config: &EgressConfig) -> ProviderStatus {
    if !config.enabled {
        return ProviderStatus {
            mode: ProviderMode::Demo,
            configured: false,
            reason: "demo",
        };
    }
    let url_ok = config
        .model_url
        .as_deref()
        .map(validate_model_url)
        .unwrap_or(false);
    if !url_ok {
        return ProviderStatus {
            mode: ProviderMode::Unavailable,
            configured: false,
            reason: "invalid-model-url",
        };
    }
    let endpoint_ok = config
        .endpoint
        .as_deref()
        .map(validate_endpoint)
        .unwrap_or(true); // None → default endpoint (valid by construction)
    if !endpoint_ok {
        return ProviderStatus {
            mode: ProviderMode::Unavailable,
            configured: false,
            reason: "invalid-endpoint",
        };
    }
    ProviderStatus {
        mode: ProviderMode::Configured,
        configured: true,
        reason: "configured",
    }
}

// ---------------------------------------------------------------------------
// Provider transport (S9.18-001 — real, reqwest)
// ---------------------------------------------------------------------------

/// Router state: config + concurrency gate + the pinned HTTP client + the
/// backend-owned capability state that the discovery catalog consults.
#[derive(Clone)]
pub struct AppState {
    pub config: EgressConfig,
    /// At most one in-flight provider call at a time (owned permit).
    semaphore: Arc<Semaphore>,
    client: reqwest::Client,
    /// Backend-owned writer capabilities (granted session scopes,
    /// transport/resolver wiring + revocation). NEVER derived from request
    /// JSON — a client cannot enable a capability by querying it.
    pub capabilities: broker::BackendCapabilityState,
}

impl AppState {
    /// Build the client with redirects DISABLED (pinned base, one hop) and
    /// the configured timeout (clamped 1–60s). The bearer key is added per
    /// request to the pinned URL only; redirects are off, so it is never
    /// forwarded. Capabilities default to the honest backend-default state
    /// (no granted scopes, no wired transport, no resolver → every writer
    /// unavailable).
    pub fn from_config(config: EgressConfig) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(
                config
                    .timeout
                    .clamp(Duration::from_secs(1), MAX_EGRESS_TIMEOUT),
            )
            .build()
            .expect("reqwest client builds");
        Self {
            config,
            semaphore: Arc::new(Semaphore::new(1)),
            client,
            capabilities: broker::BackendCapabilityState::default(),
        }
    }

    /// Override the backend-owned capability state (tests inject richer or
    /// revoked states to prove the catalog never fabricates availability).
    pub fn with_capabilities(mut self, capabilities: broker::BackendCapabilityState) -> Self {
        self.capabilities = capabilities;
        self
    }
}

/// One provider tool call extracted from a completion choice (S9.18-002).
/// `arguments` is kept as a parsed JSON Value — it MUST validate as an
/// object and byte-bound serialized compact before it may reach the webview.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Full provider outcome: optional text + zero-or-more tool calls. A reply
/// with `content: None` and `tool_calls: []` is malformed (checked in
/// `call_provider`), never surfaced.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderReply {
    pub content: Option<String>,
    pub tool_calls: Vec<ProviderToolCall>,
}

/// Tools declaration sent upstream (once per request) — mirrors the CLOSED
/// frontend-operation schemas (`schemas/frontend-operations.json`,
/// `workspace.navigate` + `scene.select`) so the provider can only ever learn
/// the two safe wrapper names. Provider-safe function names (`[A-Za-z0-9_-]`)
/// are used on the wire; the webview maps them to the registry ids.
pub fn provider_tools() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "workspace_navigate",
                "description":
                    "Switch the active workspace view (home/prepare/preview/workbench). \
                     Pure view state — project scope, conversation identity and slicing \
                     state are never touched.",
                "parameters": {
                    "additionalProperties": false,
                    "required": ["view"],
                    "properties": {
                        "view": {
                            "type": "string",
                            "enum": ["home", "prepare", "preview", "workbench"],
                            "description": "Target workspace view."
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "scene_select",
                "description":
                    "Select an existing, visible object on the active plate through the \
                     shared scene store select(). Read-only preview is preserved: selection \
                     is only eligible on the prepare surface.",
                "parameters": {
                    "additionalProperties": false,
                    "required": ["name"],
                    "properties": {
                        "name": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 256,
                            "description": "Object name that must exist in the active scene, \
                             be visible and belong to the active plate."
                        }
                    }
                }
            }
        }
    ])
}

/// Map the AI SDK message array onto the closed chat-completions request.
///
/// S9.18-002: (a) the LAST message's `metadata.uiContext` string, if any, is
/// inlined bounded ([`MAX_UICONTEXT_BYTES`]) as a leading `system` line so
/// UI-originated mutations refresh agent context (AI-08); (b) each input
/// message's TEXT parts become the content, and each `role:"tool"` part
/// (already-executed tool, state output-available/output-error) is emitted as
/// an assistant `tool_calls` entry on ITS OWN assistant message PLUS the
/// immediately-following `role:"tool"` result message — the exact pair shape
/// the provider needs to continue the loop. The number of such pairs is
/// bounded ([`MAX_TOOL_RESULT_PAIRS`]); beyond it the request FAILS CLOSED
/// ([`ProviderError::ToolLoopLimit`]) instead of growing unbounded. Non-text,
/// non-tool parts (file/reasoning) are stripped — never forwarded upstream.
fn map_messages(messages: &[serde_json::Value]) -> Result<Vec<serde_json::Value>, ProviderError> {
    let mut mapped: Vec<serde_json::Value> = Vec::new();

    // (a) UI context line from the LAST message — bounded, absent if empty.
    if let Some(last) = messages.last() {
        if let Some(ctx) = last
            .get("metadata")
            .and_then(|m| m.get("uiContext"))
            .and_then(|c| c.as_str())
        {
            let ctx: String = ctx.chars().take(MAX_UICONTEXT_BYTES).collect();
            if !ctx.trim().is_empty() {
                mapped.push(serde_json::json!({
                    "role": "system",
                    "content": format!("current UI context: {ctx}")
                }));
            }
        }
    }

    let mut tool_pairs: usize = 0;
    for message in messages {
        let Some(role) = message.get("role").and_then(|r| r.as_str()) else {
            continue;
        };
        let text = message
            .get("parts")
            .and_then(|p| p.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| {
                        let is_text = part
                            .get("type")
                            .and_then(|t| t.as_str())
                            .is_some_and(|t| t == "text");
                        is_text.then(|| part.get("text").and_then(|t| t.as_str()).unwrap_or(""))
                    })
                    .collect::<String>()
            })
            .unwrap_or_default();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        mapped.push(serde_json::json!({ "role": role, "content": text }));
    }

    // (b) tool parts. In the AI SDK v7 resubmission protocol the executed
    // tools travel as `type:"tool"` PARTS on the assistant message that owns
    // them — the SDK encodes the tool name IN the part type (`tool-<name>`),
    // with `toolCallId`, `input`, and the outcome under `state` +
    // `output`/`errorText`. Reconstruct the provider pair (assistant
    // `tool_calls` + immediately-following `role:"tool"` result) from EVERY
    // message's parts, honoring ONLY the two closed names.
    for message in messages {
        let Some(parts) = message.get("parts").and_then(|p| p.as_array()) else {
            continue;
        };
        for part in parts {
            let Some(kind) = part.get("type").and_then(|t| t.as_str()) else {
                continue;
            };
            // Static tool parts are `tool-<name>`; dynamic/custom/other part
            // types carry no static tool id and are never honored.
            let Some(tool_name) = kind.strip_prefix("tool-") else {
                continue;
            };
            let Some(tool_call_id) = part.get("toolCallId").and_then(|t| t.as_str()) else {
                continue;
            };
            if tool_call_id.is_empty() || tool_call_id.len() > MAX_TOOL_CALL_ID_LEN {
                return Err(ProviderError::MalformedResponse);
            }
            if !TOOL_NAMES.contains(&tool_name) {
                return Err(ProviderError::UnsupportedTools);
            }
            let state = part.get("state").and_then(|s| s.as_str()).unwrap_or("");
            if state != "output-available" && state != "output-error" {
                continue;
            }
            let arguments = match part.get("input") {
                Some(input) => serde_json::to_value(input).unwrap_or(serde_json::json!({})),
                None => serde_json::json!({}),
            };
            let args_bytes = serde_json::to_string(&arguments)
                .map_err(|_| ProviderError::MalformedResponse)?
                .len();
            if args_bytes > MAX_TOOL_ARGS_BYTES {
                return Err(ProviderError::MalformedResponse);
            }
            tool_pairs += 1;
            if tool_pairs > MAX_TOOL_RESULT_PAIRS {
                return Err(ProviderError::ToolLoopLimit);
            }
            let result_content = if state == "output-available" {
                part.get("output").cloned().unwrap_or_else(|| {
                    serde_json::json!({ "ok": false, "error": "missing output" })
                })
            } else {
                serde_json::json!({ "error": part.get("errorText").and_then(|e| e.as_str()).unwrap_or("tool error") })
            };
            // Assistant tool_calls message + the immediately-following tool
            // result — the provider pair shape.
            mapped.push(serde_json::json!({
                "role": "assistant",
                "content": serde_json::Value::Null,
                "tool_calls": [{
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": serde_json::to_string(&arguments)
                            .map_err(|_| ProviderError::MalformedResponse)?
                    }
                }]
            }));
            mapped.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": serde_json::to_string(&result_content)
                    .map_err(|_| ProviderError::MalformedResponse)?
            }));
        }
    }

    if mapped.len() > MAX_INPUT_MESSAGES {
        return Err(ProviderError::TooManyMessages);
    }
    Ok(mapped)
}

/// Append a provider body chunk, aborting BEFORE the buffer ever crosses
/// [`MAX_RESPONSE_BODY`] (checked before `extend` — the buffer is never even
/// temporarily oversized, so a hostile chunked/unknown-length body cannot
/// force an unbounded allocation). On overflow the caller DROPS the response,
/// which aborts the connection — no more bytes are read.
pub fn append_bounded(buf: &mut Vec<u8>, chunk: &[u8]) -> Result<(), ProviderError> {
    if buf.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY {
        return Err(ProviderError::ResponseTooLarge);
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

/// Parse a closed chat-completions body into a [`ProviderReply`], validating
/// every provider tool call: id non-empty ≤ [`MAX_TOOL_CALL_ID_LEN`] with the
/// `[A-Za-z0-9_-]` charset; name ∈ [`TOOL_NAMES`] (else a structured
/// `unsupported-tools` denial — never forwarded as authority); arguments a
/// JSON object ≤ [`MAX_TOOL_ARGS_BYTES`]. More calls than
/// [`MAX_TOOL_CALLS_PER_RESPONSE`] refuses the WHOLE response; content
/// `None` + zero calls is malformed.
pub fn parse_provider_reply(
    parsed: &serde_json::Value,
) -> Result<ProviderReply, ProviderError> {
    let choice = parsed
        .pointer("/choices/0/message")
        .ok_or(ProviderError::MalformedResponse)?;
    let content = match choice.get("content") {
        Some(content) if content.is_string() => {
            Some(content.as_str().unwrap_or_default().to_string())
        }
        _ => None,
    };
    let mut tool_calls: Vec<ProviderToolCall> = Vec::new();
    if let Some(calls) = choice.get("tool_calls").and_then(|t| t.as_array()) {
        if calls.len() > MAX_TOOL_CALLS_PER_RESPONSE {
            // More tool calls than the webview can honor in one round —
            // refuse the WHOLE response, never partial execution.
            return Err(ProviderError::ToolLoopLimit);
        }
        for call in calls {
            let id = call
                .get("id")
                .and_then(|i| i.as_str())
                .filter(|id| !id.is_empty() && id.len() <= MAX_TOOL_CALL_ID_LEN)
                .filter(|id| {
                    id.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                })
                .ok_or(ProviderError::MalformedResponse)?;
            let name = call
                .pointer("/function/name")
                .and_then(|n| n.as_str())
                .ok_or(ProviderError::MalformedResponse)?;
            if !TOOL_NAMES.contains(&name) {
                // Client-invented or backend writer id — structured denial,
                // never forwarded as authority.
                return Err(ProviderError::UnsupportedTools);
            }
            let arguments: serde_json::Value = match call
                .pointer("/function/arguments")
                .and_then(|a| a.as_str())
            {
                Some(args_string) => serde_json::from_str(args_string)
                    .unwrap_or(serde_json::Value::Null),
                None => serde_json::Value::Null,
            };
            if !arguments.is_object() {
                return Err(ProviderError::MalformedResponse);
            }
            let args_bytes = serde_json::to_string(&arguments)
                .map_err(|_| ProviderError::MalformedResponse)?
                .len();
            if args_bytes > MAX_TOOL_ARGS_BYTES {
                return Err(ProviderError::MalformedResponse);
            }
            tool_calls.push(ProviderToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments,
            });
        }
    }
    // A reply that is neither text nor tool calls is malformed.
    if content.is_none() && tool_calls.is_empty() {
        return Err(ProviderError::MalformedResponse);
    }
    Ok(ProviderReply {
        content,
        tool_calls,
    })
}

/// Execute ONE provider completion (stream:false) and return the reply —
/// optional text and/or validated tool calls (S9.18-002).
///
/// Cancellation: if the handler future is dropped (client disconnect) every
/// `.await` here is dropped too — the socket is aborted and the semaphore
/// permit released. The reqwest future needs no explicit token this slice.
async fn call_provider(
    state: &AppState,
    messages: &[serde_json::Value],
) -> Result<ProviderReply, ProviderError> {
    let config = &state.config;
    let model_url = config
        .model_url
        .as_deref()
        .ok_or(ProviderError::MissingModelUrl)?;
    if !validate_model_url(model_url) {
        return Err(ProviderError::InvalidModelUrl);
    }
    let endpoint = config.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
    if !validate_endpoint(endpoint) {
        return Err(ProviderError::InvalidEndpoint);
    }

    // Pin the request URL: base (validated above) + relative path only.
    // Re-check that the final URL keeps the SAME host/scheme as the base.
    let base = model_url.trim_end_matches('/');
    let request_url = format!("{base}{endpoint}");
    let base_parsed = url::Url::parse(model_url).map_err(|_| ProviderError::InvalidModelUrl)?;
    let final_parsed = url::Url::parse(&request_url).map_err(|_| ProviderError::InvalidModelUrl)?;
    if base_parsed.scheme() != final_parsed.scheme()
        || base_parsed.host_str() != final_parsed.host_str()
    {
        return Err(ProviderError::InvalidEndpoint);
    }

    let mapped = map_messages(messages)?;
    let body = serde_json::json!({
        "model": config.model.as_deref().unwrap_or(DEFAULT_MODEL),
        "messages": mapped,
        "stream": false,
        "tools": provider_tools(),
        "tool_choice": "auto",
    });
    let body_bytes = serde_json::to_vec(&body).map_err(|_| ProviderError::MalformedResponse)?;
    if body_bytes.len() > MAX_REQUEST_BODY {
        return Err(ProviderError::RequestTooLarge);
    }

    // Bound concurrent provider calls: try (never queued). If another call is
    // in flight we fail fast with the STABLE "provider-busy" reason — the
    // waiting queue can never grow without bound, and there is NO auto-retry
    // (a retry storm on a congested gateway is a self-inflicted outage). The
    // owned permit is held across the ENTIRE response body read, so a slow
    // first request still counts as in-flight for its successors.
    let permit = match state.semaphore.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return Err(ProviderError::ProviderBusy),
    };

    let mut builder = state
        .client
        .post(&request_url)
        .header(header::CONTENT_TYPE, "application/json")
        .timeout(
            config
                .timeout
                .clamp(Duration::from_secs(1), MAX_EGRESS_TIMEOUT),
        );
    if let Some(key) = &config.api_key {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let mut response = match builder.body(body_bytes).send().await {
        Ok(response) => response,
        Err(error) if error.is_timeout() => return Err(ProviderError::Timeout),
        Err(error) if error.is_connect() || error.is_request() => {
            return Err(ProviderError::Network)
        }
        Err(_) => return Err(ProviderError::Network),
    };

    if let Some(content_length) = response.content_length() {
        if content_length > MAX_RESPONSE_BODY as u64 {
            return Err(ProviderError::ResponseTooLarge);
        }
    }
    let status = response.status();
    if !status.is_success() {
        // Redirects are disabled, so 3xx lands here too — never followed.
        return Err(ProviderError::UpstreamStatus(status.as_u16()));
    }

    // BOUNDED body read: accumulate chunk-by-chunk, aborting (dropping the
    // response → connection closed) the moment the cap is crossed. The
    // reqwest `.timeout()` set on the builder covers the WHOLE body
    // iteration too — `chunk()` returns the deadline error mid-drip, so a
    // slow-chunked body surfaces "timeout" instead of reading forever.
    let parsed: serde_json::Value;
    {
        let mut bytes: Vec<u8> = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => append_bounded(&mut bytes, &chunk)?, // Err ⇒ drop response
                Ok(None) => break,
                Err(error) if error.is_timeout() => return Err(ProviderError::Timeout),
                Err(_) => return Err(ProviderError::Network),
            }
        }
        parsed = serde_json::from_slice(&bytes).map_err(|_| ProviderError::MalformedResponse)?;
    }
    // The request is fully read and deserialized — the permit may now drop
    // (end of scope): subsequent calls can start while we post-process.
    drop(permit);

    parse_provider_reply(&parsed)
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/// Emit one SSE `data:` line carrying a chunk.
fn sse_line(chunk: &UiMessageChunk, buf: &mut String) {
    let json = serde_json::to_string(chunk).expect("chunk serializes");
    buf.push_str("data: ");
    buf.push_str(&json);
    buf.push_str("\n\n");
}

/// Deterministic local echo reply (offline dev default when no egress env).
pub fn offline_reply(messages: &[serde_json::Value]) -> String {
    let user_text = messages
        .iter()
        .filter_map(|m| {
            m.get("parts").and_then(|p| p.as_array()).and_then(|parts| {
                parts
                    .iter()
                    .find_map(|part| match part.get("type") {
                        Some(t) if t.as_str() == Some("text") => part.get("text"),
                        _ => None,
                    })
                    .and_then(|t| t.as_str())
            })
        })
        .last()
        .map(|s| s.to_owned())
        .unwrap_or_default();
    if user_text.is_empty() {
        "No text part received — broker loopback (S9.6-008) is wiring up.".to_owned()
    } else {
        format!(
            "Broker loopback echo (S9.6-008, offline dev). You said: {user_text}. \
             No live model is contacted — set ANYCUBIC_MODEL_URL to pin real egress."
        )
    }
}

/// Demo echo SSE body. S9.18-001: carries a `message-metadata` chunk flagging
/// `provider.mode = "demo"` — an explicit data-provider mode signal (the
/// status URI reports the same), never a fake AI success.
pub fn sse_body_for(messages: &[serde_json::Value], message_id: &str, text_id: &str) -> String {
    let mut buf = String::new();
    sse_line(&UiMessageChunk::start(message_id), &mut buf);
    sse_line(
        &UiMessageChunk::message_metadata(serde_json::json!({
            "provider": { "mode": "demo" }
        })),
        &mut buf,
    );
    sse_line(&UiMessageChunk::text_start(text_id), &mut buf);
    sse_line(
        &UiMessageChunk::text_delta(text_id, &offline_reply(messages)),
        &mut buf,
    );
    sse_line(&UiMessageChunk::text_end(text_id), &mut buf);
    sse_line(&UiMessageChunk::finish("stop"), &mut buf);
    buf.push_str("data: [DONE]\n\n");
    buf
}

/// Real provider reply SSE body — one buffered text delta (honest timing).
fn sse_provider_body(message_id: &str, text_id: &str, text: &str) -> String {
    let mut buf = String::new();
    sse_line(&UiMessageChunk::start(message_id), &mut buf);
    sse_line(&UiMessageChunk::text_start(text_id), &mut buf);
    sse_line(&UiMessageChunk::text_delta(text_id, text), &mut buf);
    sse_line(&UiMessageChunk::text_end(text_id), &mut buf);
    sse_line(&UiMessageChunk::finish("stop"), &mut buf);
    buf.push_str("data: [DONE]\n\n");
    buf
}

/// Tool-loop SSE body (S9.18-002): optional buffered text delta + one
/// `tool-input-start`/`tool-input-available` pair PER provider tool call,
/// then `finish "tool-calls"`. The `input` chunk carries the EXACT arguments
/// object the webview will execute — and NO `providerExecuted` flag, so the
/// webview's `onToolCall` owns execution (AI SDK v7 verifies this: the hook
/// only fires when `providerExecuted` is absent).
fn sse_tool_loop_body(message_id: &str, text_id: &str, reply: &ProviderReply) -> String {
    let mut buf = String::new();
    sse_line(&UiMessageChunk::start(message_id), &mut buf);
    if let Some(text) = reply.content.as_deref().filter(|t| !t.trim().is_empty()) {
        sse_line(&UiMessageChunk::text_start(text_id), &mut buf);
        sse_line(&UiMessageChunk::text_delta(text_id, text), &mut buf);
        sse_line(&UiMessageChunk::text_end(text_id), &mut buf);
    }
    for call in &reply.tool_calls {
        sse_line(
            &UiMessageChunk::tool_input_start(&call.id, &call.name),
            &mut buf,
        );
        sse_line(
            &UiMessageChunk::tool_input_available(&call.id, &call.name, call.arguments.clone()),
            &mut buf,
        );
    }
    sse_line(&UiMessageChunk::finish("tool-calls"), &mut buf);
    buf.push_str("data: [DONE]\n\n");
    buf
}

/// Error SSE body — FIXED reason, finish `error`, NEVER the offline echo.
fn sse_error_body(message_id: &str, reason: &str) -> String {
    let mut buf = String::new();
    sse_line(&UiMessageChunk::start(message_id), &mut buf);
    sse_line(&UiMessageChunk::error_text(reason), &mut buf);
    sse_line(&UiMessageChunk::finish("error"), &mut buf);
    buf.push_str("data: [DONE]\n\n");
    buf
}

/// Shared SSE response headers (protocol + no-buffering). CORS is added by
/// the `CorsLayer`, not manually, to avoid duplicated header values.
pub fn sse_headers() -> [(header::HeaderName, HeaderValue); 4] {
    [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream; charset=utf-8"),
        ),
        (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        (
            header::HeaderName::from_static(UI_STREAM_HEADER),
            HeaderValue::from_static("v1"),
        ),
        (
            header::HeaderName::from_static("x-accel-buffering"),
            HeaderValue::from_static("no"),
        ),
    ]
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn origin_allowed(headers: &HeaderMap, state: &AppState) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    origin == Some(ALLOWED_ORIGIN_DEV)
        || origin == Some(ALLOWED_ORIGIN_PROD)
        || state
            .config
            .allowed_origins
            .iter()
            .any(|allowed| origin == Some(allowed.as_str()))
}

/// Full configured-provider round trip: map → ONE provider call → SSE body.
/// Returns the plain text body when the reply is text-only, or the tool-loop
/// body when the provider asked for tool calls. Any error becomes a
/// fixed-reason SSE error body.
async fn stream_provider_reply(
    state: &AppState,
    messages: &[serde_json::Value],
    message_id: &str,
    text_id: &str,
) -> String {
    match call_provider(state, messages).await {
        Ok(reply) if reply.tool_calls.is_empty() => match reply.content {
            Some(text) => sse_provider_body(message_id, text_id, &text),
            // Unreachable: call_provider rejects content-less, call-less
            // replies — but an empty text is still a malformed reply.
            None => sse_error_body(message_id, ProviderError::MalformedResponse.reason()),
        },
        Ok(reply) => sse_tool_loop_body(message_id, text_id, &reply),
        Err(error) => sse_error_body(message_id, error.reason()),
    }
}

/// `POST /chat` — stream the AI SDK UI protocol for a chat request.
///
/// S9.18-001: demo echo when egress is disabled; a REAL provider relay when
/// configured; a fixed-reason SSE error when configured-but-failing — never
/// the offline echo as a fake success.
/// S9.18-002: when the provider answers with tool calls, the body carries
/// `tool-input-start`/`tool-input-available` chunks the webview executes.
pub async fn chat_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(chat): Json<ChatRequest>,
) -> AxumResponse<Body> {
    if !origin_allowed(&headers, &state) {
        return AxumResponse::builder()
            .status(StatusCode::FORBIDDEN)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from("Origin not allowed"))
            .unwrap();
    }
    let message_id = chat.message_id.clone().unwrap_or_else(|| "m-1".into());
    let body_text = match provider_status_for(&state.config) {
        ProviderStatus {
            mode: ProviderMode::Demo,
            ..
        } => sse_body_for(&chat.messages, &message_id, "text-1"),
        ProviderStatus {
            mode: ProviderMode::Unavailable,
            reason,
            ..
        } => sse_error_body(&message_id, reason),
        ProviderStatus {
            mode: ProviderMode::Configured,
            ..
        } => stream_provider_reply(&state, &chat.messages, &message_id, "text-1").await,
    };
    let mut builder = AxumResponse::builder().status(StatusCode::OK);
    for (name, value) in sse_headers() {
        builder = builder.header(name, value);
    }
    builder.body(Body::from(body_text)).unwrap()
}

/// `GET /provider/status` — public-safe provider mode (demo/configured/
/// unavailable). Never contains keys, URLs or provider bodies.
pub async fn provider_status_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(provider_status_for(&state.config))
}

// ---------------------------------------------------------------------------
// Operation catalog (S9.18-001 — registry/discovery, read-only)
// ---------------------------------------------------------------------------

/// List envelope for `GET /operations`. `schemaVersion` is the catalog wire
/// version ([`broker::OPERATION_SCHEMA_VERSION`]); the entries are the
/// registry entries with availability evaluated against the backend state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCatalogEnvelope {
    pub schema_version: u16,
    pub operations: Vec<broker::OperationEntry>,
}

/// Structured unknown-operation error (`GET /operations/{id}` 404). STATIC
/// and generic — it never echoes the caller-supplied id (which the caller
/// controls and could be oversized or sensitive), keeping the endpoint
/// public-safe. Plausible-but-unknown AND implausible ids both answer this
/// exact same body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationNotFound {
    pub error: &'static str,
}

/// Upper bound for a plausible public operation id (the 13 known ids are
/// `[a-z0-9._-]` and ≤ 21 chars; 64 leaves headroom while keeping unbounded
/// caller input out of the registry).
pub const MAX_OPERATION_ID_LEN: usize = 64;

/// Bounds the identifier path segment BEFORE any registry lookup: non-empty,
/// ≤ [`MAX_OPERATION_ID_LEN`] bytes, restricted to the stable id charset
/// (`[a-z0-9._-]`). Out-of-bound segments answer the SAME static not-found —
/// no reflection, no echo, no unbounded allocation of the caller's input.
fn is_plausible_operation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_OPERATION_ID_LEN
        && id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

fn forbidden_body() -> AxumResponse<Body> {
    AxumResponse::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("Origin not allowed"))
        .unwrap()
}

/// `GET /operations` — the public-safe discovery catalog. Strict origin
/// guard (same as `/chat`); bounded output (13 constant entries, closed
/// schemas); no secrets, provider URLs or account paths — the entries are
/// derived from the broker registry and the backend-owned capability state.
pub async fn operations_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> AxumResponse<Body> {
    if !origin_allowed(&headers, &state) {
        return forbidden_body();
    }
    let envelope = OperationCatalogEnvelope {
        schema_version: broker::OPERATION_SCHEMA_VERSION,
        operations: broker::operations(&state.capabilities),
    };
    let body = match serde_json::to_vec(&envelope) {
        Ok(body) => body,
        Err(_) => {
            return AxumResponse::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::empty())
                .unwrap();
        }
    };
    AxumResponse::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

/// `GET /operations/{id}` — one registry entry, or a structured 404 for an
/// unknown/implausible id (no fallback, no widening, NO echo of the caller's
/// id). Same strict origin guard. Availability in the entry is an ADVISORY
/// descriptor — it never authenticates anything; dispatch independently
/// enforces approval/scope, capability and revocation.
pub async fn operation_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AxumResponse<Body> {
    if !origin_allowed(&headers, &state) {
        return forbidden_body();
    }
    // The not-found body is STATIC: the caller-controllable id is never
    // echoed (and never allocated into the response).
    let not_found = || {
        serde_json::to_vec(&OperationNotFound {
            error: "operation-not-found",
        })
        .expect("not-found error serializes")
    };
    // Bound the identifier BEFORE any registry lookup: implausible ids
    // (empty/oversized/off-charset) get the same static 404 as unknown ids —
    // no reflection, no widening.
    if !is_plausible_operation_id(&id) {
        return AxumResponse::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(not_found()))
            .unwrap();
    }
    let entry = broker::operation(&id, &state.capabilities);
    let (status, body) = match entry {
        Some(entry) => (
            StatusCode::OK,
            // All fields are serializable by construction (constant registry
            // entries); a failure here is a programming error, never a
            // runtime condition.
            serde_json::to_vec(&entry).expect("operation entry serializes"),
        ),
        None => (StatusCode::NOT_FOUND, not_found()),
    };
    AxumResponse::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

/// `GET /chat/{chat_id}/stream` — reconnect probe (Phase 1: always idle).
pub async fn stream_handler(Path(chat_id): Path<String>) -> AxumResponse<Body> {
    if chat_id.is_empty() || chat_id == "." || chat_id == ".." {
        return AxumResponse::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::empty())
            .unwrap();
    }
    // No in-flight stream is tracked yet (Phase 1) → idle.
    AxumResponse::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .unwrap()
}

/// `GET /health` — liveness probe.
pub async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, "broker-server ok")
}

/// Build the router for a concrete state (tests inject their own config).
pub fn router_with_state(state: AppState) -> Router {
    // CORS allow-list: the fixed dev/prod origins PLUS any env-provided extra
    // origins (validated `http://127.0.0.1:<port>`) — NEVER a wildcard, and
    // an invalid env value is dropped at parse; the list only ever grows via
    // validated entries.
    let mut allow_origin = vec![
        ALLOWED_ORIGIN_DEV.parse::<HeaderValue>().unwrap(),
        ALLOWED_ORIGIN_PROD.parse::<HeaderValue>().unwrap(),
    ];
    allow_origin.extend(
        state
            .config
            .allowed_origins
            .iter()
            .filter_map(|origin| origin.parse::<HeaderValue>().ok()),
    );
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(allow_origin)
        // tower-http echoes the matched origin (never `*` on the SSE lane).
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .max_age(Duration::from_secs(2 * 60 * 60));
    Router::new()
        .route("/chat", axum::routing::post(chat_handler))
        .route("/health", get(health_handler))
        .route("/chat/{chat_id}/stream", get(stream_handler))
        .route("/provider/status", get(provider_status_handler))
        // S9.18-001 discovery: read-only catalog (registry + backend state),
        // strictly origin-guarded — same policy as /chat.
        .route("/operations", get(operations_handler))
        .route("/operations/{operation_id}", get(operation_handler))
        // The inbound /chat body is capped at the SAME 256 KiB budget —
        // enforced by the body-limiter BEFORE the handler runs, so an
        // oversized payload gets a generic 413 without ever touching the
        // provider (no allocation of the whole payload as a side effect).
        .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY))
        .with_state(state)
        .layer(cors)
}

/// Router over an explicit egress config (tests).
pub fn router_with(config: EgressConfig) -> Router {
    router_with_state(AppState::from_config(config))
}

/// Build the router from the environment (no server sockets; testable).
pub fn router() -> Router {
    router_with(config_from_env())
}

/// Resolve the bind address from env: `ANYCUBIC_BROKER_PORT` (numeric,
/// `0` ⇒ ephemeral — the ACTUAL bound address is printed on startup) with the
/// default [`LOOPBACK_ADDR`] port otherwise. Loopback-only by construction.
fn env_broker_addr() -> SocketAddr {
    match std::env::var("ANYCUBIC_BROKER_PORT") {
        Ok(raw) => {
            let port: u16 = raw
                .trim()
                .parse()
                .expect("ANYCUBIC_BROKER_PORT must be a numeric port (0..65535)");
            SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port)
        }
        Err(_) => LOOPBACK_ADDR.parse().expect("loopback parses"),
    }
}

/// Bind the loopback address (env-overridable port) and serve until the
/// process is killed. Prints the ACTUAL bound address — with ANYCUBIC_BROKER_PORT
/// set to 0 the OS picks a free ephemeral port, so the printed address is the
/// only authoritative one (e2e parses it from the startup log).
pub async fn run() {
    let addr = env_broker_addr();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind loopback");
    let actual = listener.local_addr().expect("bound addr");
    println!("[broker-server] listening on {actual} (loopback only)");
    axum::serve(listener, router()).await.expect("server runs");
}

/// Synchronous entry for the binary (`#[tokio::main]` wrapper inside).
pub fn run_blocking() {
    let rt = tokio::runtime::Runtime::new().expect("runtime or panic");
    rt.block_on(run());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_bounded_never_overflows_buffer() {
        let mut buf = Vec::new();
        // single chunk at the limit boundary fits
        append_bounded(&mut buf, &vec![0u8; MAX_RESPONSE_BODY]).unwrap();
        assert_eq!(buf.len(), MAX_RESPONSE_BODY);
        // crossing the limit errors AND does NOT grow the buffer
        let err = append_bounded(&mut buf, &[1u8; 8]).unwrap_err();
        assert_eq!(err, ProviderError::ResponseTooLarge);
        assert_eq!(buf.len(), MAX_RESPONSE_BODY, "buffer must stay at the cap");
        // empty chunk is a no-op success
        append_bounded(&mut buf, &[]).unwrap();
    }

    #[test]
    fn validate_allowed_origin_strict_surface() {
        assert!(validate_allowed_origin("http://127.0.0.1:1420"));
        assert!(validate_allowed_origin("http://127.0.0.1:41999"));
        // only http + 127.0.0.1, no creds/query/fragment/wildcard/other hosts
        assert!(!validate_allowed_origin("https://127.0.0.1:1420"));
        assert!(!validate_allowed_origin("http://localhost:1420"));
        assert!(!validate_allowed_origin("http://192.168.3.50:9988"));
        assert!(!validate_allowed_origin("*"));
        assert!(!validate_allowed_origin("http://127.0.0.1:1420?debug=1"));
        assert!(!validate_allowed_origin("http://user:pass@127.0.0.1:1420"));
        assert!(!validate_allowed_origin("http://127.0.0.1:1420/#frag"));
        assert!(!validate_allowed_origin("garbage"));
    }

    #[test]
    fn env_broker_addr_parses_ports() {
        // default port
        std::env::remove_var("ANYCUBIC_BROKER_PORT");
        assert_eq!(env_broker_addr(), LOOPBACK_ADDR.parse().unwrap());
        // explicit numeric port
        std::env::set_var("ANYCUBIC_BROKER_PORT", "0");
        assert_eq!(env_broker_addr().port(), 0);
        std::env::set_var("ANYCUBIC_BROKER_PORT", "41999");
        assert!(env_broker_addr().ip().is_loopback());
        assert_eq!(env_broker_addr().port(), 41999);
        std::env::remove_var("ANYCUBIC_BROKER_PORT");
    }

    // ---------------------------------------------------------------------
    // S9.18-002 — tool loop
    // ---------------------------------------------------------------------

    #[test]
    fn tool_names_are_the_only_declared_and_honored_names() {
        // allowlist accepts exactly the two closed operation wrappers
        assert!(TOOL_NAMES.contains(&"workspace_navigate"));
        assert!(TOOL_NAMES.contains(&"scene_select"));
        // backend writer ids and client-invented names are NEVER in the set
        for forged in [
            "nozzle",
            "part_fan",
            "job.start",
            "job.stop",
            "upload",
            "ace_bind_slot",
            "light_set_enabled",
            "temperature",
            "anything_else",
        ] {
            assert!(
                !TOOL_NAMES.contains(&forged),
                "{forged} must not be an honored tool name"
            );
        }
    }

    #[test]
    fn provider_tools_shape_is_closed() {
        let tools = provider_tools();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.pointer("/function/name").and_then(|n| n.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                "workspace_navigate",
                "scene_select",
            ]
        );
        // every entry has a parameters schema with additionalProperties false
        for tool in tools.as_array().unwrap() {
            let params = tool.pointer("/function/parameters").unwrap();
            assert_eq!(
                params.get("additionalProperties"),
                Some(&serde_json::Value::Bool(false))
            );
        }
    }

    fn tool_message(tool_call_id: &str, tool_name: &str, state: &str, output: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "msg-1",
            "role": "assistant",
            "parts": [{
                // AI SDK v7: the tool name is encoded IN the part type.
                "type": format!("tool-{tool_name}"),
                "toolCallId": tool_call_id,
                "state": state,
                "input": { "view": "prepare" },
                "output": serde_json::from_str::<serde_json::Value>(output).unwrap(),
            }]
        })
    }

    #[test]
    fn map_messages_emits_provider_tool_pair() {
        let messages = vec![
            serde_json::json!({
                "id": "u1",
                "role": "user",
                "parts": [{ "type": "text", "text": "go prepare" }]
            }),
            tool_message("call_abc_1", "workspace_navigate", "output-available", "{\"ok\":true,\"outcome\":{\"code\":\"changed\",\"view\":\"prepare\"}}"),
        ];
        let mapped = map_messages(&messages).unwrap();
        // [system(no uiContext → skipped), user, assistant tool_calls, tool result]
        assert_eq!(mapped.len(), 3);
        assert_eq!(mapped[0]["role"], "user");
        assert_eq!(mapped[1]["role"], "assistant");
        assert_eq!(mapped[1]["tool_calls"][0]["id"], "call_abc_1");
        assert_eq!(mapped[1]["tool_calls"][0]["function"]["name"], "workspace_navigate");
        let args: serde_json::Value =
            serde_json::from_str(mapped[1]["tool_calls"][0]["function"]["arguments"].as_str().unwrap())
                .unwrap();
        assert_eq!(args["view"], "prepare");
        assert_eq!(mapped[2]["role"], "tool");
        assert_eq!(mapped[2]["tool_call_id"], "call_abc_1");
        let result: serde_json::Value =
            serde_json::from_str(mapped[2]["content"].as_str().unwrap()).unwrap();
        assert_eq!(result["outcome"]["code"], "changed");
    }

    #[test]
    fn map_messages_ui_context_inlined_bounded_from_last_message() {
        let mut messages = vec![
            serde_json::json!({
                "id": "u1",
                "role": "user",
                "parts": [{ "type": "text", "text": "hi" }]
            }),
            serde_json::json!({
                "id": "u2",
                "role": "user",
                "parts": [{ "type": "text", "text": "hi again" }],
                "metadata": { "uiContext": "view:prepare;selected:cone" }
            }),
        ];
        let mapped = map_messages(&messages).unwrap();
        assert_eq!(mapped.len(), 3);
        assert_eq!(mapped[0]["role"], "system");
        assert_eq!(mapped[0]["content"], "current UI context: view:prepare;selected:cone");
        // bounded: an oversized context is truncated to MAX_UICONTEXT_BYTES
        messages[1]["metadata"]["uiContext"] = serde_json::json!("x".repeat(4096));
        let mapped = map_messages(&messages).unwrap();
        assert_eq!(
            mapped[0]
                .get("content")
                .and_then(|c| c.as_str())
                .map(|c| c.len()),
            Some(MAX_UICONTEXT_BYTES + "current UI context: ".len())
        );
    }

    #[test]
    fn map_messages_rejects_unknown_and_writer_tool_names() {
        for forged in ["job.start", "nozzle", "upload", "totally_fake"] {
            let messages = vec![
                serde_json::json!({
                    "id": "m",
                    "role": "assistant",
                    "parts": [{
                        "type": format!("tool-{forged}"),
                        "toolCallId": "call_1",
                        "state": "output-available",
                        "input": {},
                    }]
                })
            ];
            assert_eq!(
                map_messages(&messages).unwrap_err(),
                ProviderError::UnsupportedTools,
                "{forged} must be a structured denial"
            );
        }
    }

    #[test]
    fn map_messages_rejects_tool_pairs_beyond_limit() {
        // 5 pairs (limit is 4) → fail closed
        let mut messages = Vec::new();
        for i in 0..=MAX_TOOL_RESULT_PAIRS as usize {
            messages.push(tool_message(
                &format!("call_{i}"),
                "scene_select",
                "output-available",
                "{\"ok\":true}",
            ));
        }
        assert_eq!(
            map_messages(&messages).unwrap_err(),
            ProviderError::ToolLoopLimit
        );
    }

    #[test]
    fn map_messages_invalid_call_id_rejected() {
        let messages = vec![
            serde_json::json!({
                "id": "m",
                "role": "assistant",
                "parts": [{
                    "type": "tool-scene_select",
                    "toolCallId": "",
                    "state": "output-available",
                    "input": {},
                }]
            })
        ];
        assert_eq!(
            map_messages(&messages).unwrap_err(),
            ProviderError::MalformedResponse
        );
    }

    #[test]
    fn call_provider_parses_tool_calls_and_rejects_forged_names() {
        // Valid tool_calls reply parses into ProviderReply.
        let body = serde_json::json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_ok_1",
                        "type": "function",
                        "function": {
                            "name": "workspace_navigate",
                            "arguments": "{\"view\":\"workbench\"}"
                        }
                    }]
                }
            }]
        });
        let reply = parse_provider_reply(&body);
        assert!(reply.is_ok(), "{reply:?}");
        let reply = reply.unwrap();
        assert!(reply.content.is_none());
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "workspace_navigate");
        assert_eq!(reply.tool_calls[0].arguments["view"], "workbench");
    }

    #[test]
    fn parse_provider_reply_rejects_oversized_tool_call_set() {
        // More calls than MAX_TOOL_CALLS_PER_RESPONSE → whole-response refusal.
        let mut calls: Vec<serde_json::Value> = Vec::new();
        for i in 0..=MAX_TOOL_CALLS_PER_RESPONSE as usize {
            calls.push(serde_json::json!({
                "id": format!("call_{i}"),
                "type": "function",
                "function": { "name": "scene_select", "arguments": "{\"name\":\"x\"}" }
            }));
        }
        let body = serde_json::json!({
            "choices": [{ "message": { "content": null, "tool_calls": calls } }]
        });
        assert_eq!(
            parse_provider_reply(&body).unwrap_err(),
            ProviderError::ToolLoopLimit
        );
    }
}
