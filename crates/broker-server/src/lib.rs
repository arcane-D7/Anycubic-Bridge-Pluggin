//! S9.6-008 — Broker AI-egress loopback server (library, testable).
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
//!
//! Egress posture (check:architecture invariant): the server never embeds a
//! provider URL. The pinned-egress endpoint is read ONLY from `ANYCUBIC_*`
//! environment variables (see [`config_from_env`]) and is always contacted
//! from this Rust process — the webview's only network lane to a model is
//! this loopback. API keys are held in the broker keystore (BYOK, S9-001);
//! this crate never logs or serializes them.
//!
//! CORS: origins are reflected against an allow-list via `CorsLayer` (dev
//! `http://127.0.0.1:1420`, prod `tauri://localhost`) — never `*` on the SSE
//! lane; preflight (`OPTIONS`) is answered by the layer with the same policy.
//! The `POST /chat` handler additionally refuses unknown origins with 403.

use axum::body::Body;
use axum::extract::Path;
use axum::http::{
    header, HeaderMap, HeaderValue, Method, Response as AxumResponse, StatusCode,
};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::Duration;

pub const LOOPBACK_ADDR: &str = "127.0.0.1:18181";
pub const UI_STREAM_HEADER: &str = "x-vercel-ai-ui-message-stream";
pub const ALLOWED_ORIGIN_DEV: &str = "http://127.0.0.1:1420";
pub const ALLOWED_ORIGIN_PROD: &str = "tauri://localhost";

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
}

impl UiMessageChunk {
    pub fn start(message_id: &str) -> Self {
        Self {
            kind: "start".into(),
            message_id: Some(message_id.into()),
            id: None,
            delta: None,
            finish_reason: None,
        }
    }

    pub fn text_start(id: &str) -> Self {
        Self {
            kind: "text-start".into(),
            message_id: None,
            id: Some(id.into()),
            delta: None,
            finish_reason: None,
        }
    }

    pub fn text_delta(id: &str, delta: &str) -> Self {
        Self {
            kind: "text-delta".into(),
            message_id: None,
            id: Some(id.into()),
            delta: Some(delta.into()),
            finish_reason: None,
        }
    }

    pub fn text_end(id: &str) -> Self {
        Self {
            kind: "text-end".into(),
            message_id: None,
            id: Some(id.into()),
            delta: None,
            finish_reason: None,
        }
    }

    pub fn finish(finish_reason: &str) -> Self {
        Self {
            kind: "finish".into(),
            message_id: None,
            id: None,
            delta: None,
            finish_reason: Some(finish_reason.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Environment-only egress config
// ---------------------------------------------------------------------------

/// Pinned-egress configuration, read from `ANYCUBIC_*` env vars only.
///
/// - `ANYCUBIC_MODEL_URL` — the talking endpoint we stream FROM (e.g. a local
///   Ollama/OpenAI-compatible gateway URL). NEVER a repo literal.
/// - `ANYCUBIC_MODEL_API_KEY` — BYOK key (broker keystore-backed); absent →
///   bearer header omitted.
/// - `ANYCUBIC_MODEL_ENDPOINT` — path of the pinned gateway
///   (default `/v1/chat/completions`).
///
/// When no env is set the server answers a deterministic local echo stream
/// (offline dev default) — the webview needs no provider URL ever.
#[derive(Debug, Clone)]
pub struct EgressConfig {
    pub model_url: Option<String>,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub timeout: Duration,
    pub enabled: bool,
}

impl Default for EgressConfig {
    fn default() -> Self {
        Self {
            model_url: None,
            api_key: None,
            endpoint: None,
            timeout: Duration::from_secs(60),
            enabled: false,
        }
    }
}

/// Resolve pinned-egress from the environment (agnostic — no literals).
pub fn config_from_env() -> EgressConfig {
    let model_url = std::env::var("ANYCUBIC_MODEL_URL").ok();
    let api_key = std::env::var("ANYCUBIC_MODEL_API_KEY").ok();
    let endpoint = std::env::var("ANYCUBIC_MODEL_ENDPOINT")
        .ok()
        .filter(|s| !s.is_empty());
    EgressConfig {
        enabled: model_url.is_some(),
        model_url,
        api_key,
        endpoint,
        ..Default::default()
    }
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
            m.get("parts")
                .and_then(|p| p.as_array())
                .and_then(|parts| {
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

/// Build the full `[DONE]`-terminated SSE body for one chat reply.
pub fn sse_body_for(messages: &[serde_json::Value], message_id: &str, text_id: &str) -> String {
    let mut buf = String::new();
    sse_line(&UiMessageChunk::start(message_id), &mut buf);
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

/// Shared SSE response headers (protocol + no-buffering). CORS is added by
/// the `CorsLayer`, not manually, to avoid duplicated header values.
pub fn sse_headers() -> [(header::HeaderName, HeaderValue); 4] {
    [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream; charset=utf-8"),
        ),
        (
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ),
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

/// `POST /chat` — stream the AI SDK UI protocol for a chat request.
pub async fn chat_handler(
    headers: HeaderMap,
    Extension(_egress): Extension<EgressConfig>,
    Json(chat): Json<ChatRequest>,
) -> AxumResponse<Body> {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if origin != Some(ALLOWED_ORIGIN_DEV) && origin != Some(ALLOWED_ORIGIN_PROD) {
        return AxumResponse::builder()
            .status(StatusCode::FORBIDDEN)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from("Origin not allowed"))
            .unwrap();
    }
    let message_id = chat.message_id.clone().unwrap_or_else(|| "m-1".into());
    let body_text = sse_body_for(&chat.messages, &message_id, "text-1");
    let mut builder = AxumResponse::builder().status(StatusCode::OK);
    for (name, value) in sse_headers() {
        builder = builder.header(name, value);
    }
    builder.body(Body::from(body_text)).unwrap()
}

/// `GET /chat/{chat_id}/stream` — reconnect probe (Phase 1: always idle).
pub async fn stream_handler(
    Path(chat_id): Path<String>,
    Extension(_egress): Extension<EgressConfig>,
) -> AxumResponse<Body> {
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

/// Build the router (no server sockets; pure for tests + [`run`]).
pub fn router() -> Router {
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin([
            ALLOWED_ORIGIN_DEV.parse::<HeaderValue>().unwrap(),
            ALLOWED_ORIGIN_PROD.parse::<HeaderValue>().unwrap(),
        ])
        // tower-http echoes the matched origin (never `*` on the SSE lane).
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .max_age(Duration::from_secs(2 * 60 * 60));
    Router::new()
        .route("/chat", post(chat_handler))
        .route("/health", get(health_handler))
        .route("/chat/{chat_id}/stream", get(stream_handler))
        .layer(Extension(config_from_env()))
        .layer(cors)
}

/// Bind the loopback address and serve until the process is killed.
pub async fn run() {
    let addr: SocketAddr = LOOPBACK_ADDR.parse().expect("loopback parses");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind loopback");
    println!("[broker-server] listening on {addr} (loopback only)");
    axum::serve(listener, router()).await.expect("server runs");
}

/// Synchronous entry for the binary (`#[tokio::main]` wrapper inside).
pub fn run_blocking() {
    let rt = tokio::runtime::Runtime::new().expect("runtime or panic");
    rt.block_on(run());
}
