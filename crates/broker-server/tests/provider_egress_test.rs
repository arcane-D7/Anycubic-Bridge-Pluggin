//! S9.18-001 — provider egress transport integration tests.
//!
//! The pair in this file is structured around ONE cheap disconfirm:
//!
//!   "a configured fake provider server receives ZERO requests before the
//!    fix" (the current `chat_handler` ignores its `EgressConfig` entirely).
//!
//! `configured_provider_streams_real_reply` spins a real local fake HTTP
//! provider (plain tokio listener, no extra deps) that COUNTS requests. On
//! the pre-fix tree the assertion `count == 1` fails with `got 0` — the
//! captured failure is the evidence. After S9.18-001 lands the handler
//! actually calls the provider and the same test passes.
//!
//! The rest of the suite pins the post-fix contract: URL/endpoint validation
//! matrices, `Debug` api-key redaction, budgets (≤64 messages / ≤256KiB
//! request / ≤4MiB response, timeout clamped 1–60s), error policy (fixed
//! reasons, SSE `error` chunk, NO offline echo fallback when egress is
//! enabled), unsupported tool_calls, redirect-not-followed, and the
//! `/provider/status` matrix (demo/configured/unavailable). All fixtures are
//! fake (tests/ is SKIP_DIRS in the sanitizer).

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, Request};
use broker_server::{
    chat_handler, provider_status_for, router_with, validate_endpoint, validate_model_url,
    AppState, ChatRequest, EgressConfig, ProviderMode, ALLOWED_ORIGIN_DEV,
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt as _; // oneshot

/// One captured incoming provider request (for COUNT + content asserts).
#[derive(Debug, Clone)]
struct CapturedRequest {
    #[allow(dead_code)] // recorded for future transport asserts
    method: String,
    #[allow(dead_code)] // recorded for future transport asserts
    path: String,
    authorization: Option<String>,
    body: String,
}

/// What the fake provider script answers (per test, chosen at spawn).
enum FakeReply {
    /// `200 OK` with this exact JSON body.
    Ok(String),
    /// Non-2xx status with a plain body (provider 400/refused paths).
    Status(u16),
    /// `302 Found` — the redirect must NOT be followed.
    Redirect302,
    /// Sleep then answer `200 OK` (slow provider → timeout under a tight
    /// client timeout).
    SleepThenOk(Duration, String),
    /// `200 OK` streamed as `chunked` WITHOUT a Content-Length (the client
    /// must apply its OWN bounded read). `total_bytes` exceeds the client's
    /// response budget, so a bounded client drops the connection mid-body and
    /// the provider records `stream_aborted`; an unbounded client reads the
    /// whole body and the write completes. An optional per-chunk delay lets
    /// the reply outlive the request timeout (body-iteration timeout
    /// coverage).
    Chunked {
        chunk_size: usize,
        total_bytes: usize,
        per_chunk_delay: Option<Duration>,
    },
}

/// Minimal local HTTP fake provider. Serves any number of requests until
/// dropped; records (method, path, authorization, body) so tests can assert
/// exactly how many times the broker talked to it and with what payload.
struct FakeProvider {
    addr: SocketAddr,
    hits: Arc<Mutex<Vec<CapturedRequest>>>,
    stream_aborted: Arc<Mutex<bool>>,
}

impl FakeProvider {
    async fn spawn(reply: FakeReply) -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits: Arc<Mutex<Vec<CapturedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let stream_aborted: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
        let provider = Arc::new(FakeProvider {
            addr,
            hits,
            stream_aborted,
        });
        let this = provider.clone();
        // The reply is shared across the accept loop (each connection may read
        // it) — the accept task ends when the listener is dropped (test end).
        let reply = Arc::new(reply);
        tokio::spawn(async move {
            loop {
                let (mut sock, _peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(_) => break,
                };
                let this = this.clone();
                let reply = reply.clone();
                tokio::spawn(async move {
                    // Read the request head (until CRLFCRLF) into `buf`.
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 2048];
                    let header_end = loop {
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break pos + 4;
                        }
                        if buf.len() > 1_048_576 {
                            return;
                        }
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                    // Read the body per Content-Length.
                    let content_length = head
                        .lines()
                        .find_map(|line| {
                            let lower = line.to_ascii_lowercase();
                            lower
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    let body_start = header_end;
                    while buf.len() < body_start + content_length {
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let body =
                        String::from_utf8_lossy(&buf[body_start..body_start + content_length])
                            .into_owned();
                    let mut lines = head.lines();
                    let request_line = lines.next().unwrap_or_default().to_string();
                    let mut parts = request_line.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_string();
                    let path = parts.next().unwrap_or_default().to_string();
                    let authorization = lines
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .starts_with("authorization:")
                                .then(|| line.split_once(':').map(|x| x.1.trim().to_string()))
                                .flatten()
                        });
                    this.hits.lock().unwrap().push(CapturedRequest {
                        method,
                        path,
                        authorization,
                        body,
                    });
                    let (status_line, response_head) = match reply.as_ref() {
                        FakeReply::Ok(json) => ("HTTP/1.1 200 OK", format!("content-length: {}\r\n", json.len())),
                        FakeReply::Status(code) => (
                            &format!("HTTP/1.1 {code} Provider Error")[..],
                            format!("content-length: {}\r\n", format!("provider error body {code}").len()),
                        ),
                        FakeReply::Redirect302 => (
                            "HTTP/1.1 302 Found",
                            "content-length: 0\r\n".to_string(),
                        ),
                        FakeReply::SleepThenOk(sleep, json) => {
                            tokio::time::sleep(*sleep).await;
                            ("HTTP/1.1 200 OK", format!("content-length: {}\r\n", json.len()))
                        }
                        FakeReply::Chunked {
                            chunk_size,
                            total_bytes,
                            per_chunk_delay,
                        } => {
                            // Stream a chunked body with NO Content-Length —
                            // the client must bound the read itself. If a
                            // write fails, the client dropped the connection
                            // before the body ended (bounded-read proof).
                            let _ = sock
                                .write_all(
                                    b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                                )
                                .await;
                            let mut written = 0usize;
                            while written < *total_bytes {
                                if let Some(delay) = per_chunk_delay {
                                    tokio::time::sleep(*delay).await;
                                }
                                let chunk_len = (*chunk_size).min(*total_bytes - written);
                                let chunk = vec![b'x'; chunk_len];
                                let head = format!("{chunk_len:x}\r\n");
                                let write_ok = sock.write_all(head.as_bytes()).await.is_ok()
                                    && sock.write_all(&chunk).await.is_ok()
                                    && sock.write_all(b"\r\n").await.is_ok();
                                if !write_ok {
                                    *this.stream_aborted.lock().unwrap() = true;
                                    return;
                                }
                                written += chunk_len;
                            }
                            let _ = sock.write_all(b"0\r\n\r\n").await;
                            let _ = sock.shutdown().await;
                            return;
                        }
                    };
                    let response = format!(
                        "{status_line}\r\ncontent-type: application/json\r\n{response_head}connection: close\r\n\r\n{}",
                        match reply.as_ref() {
                            FakeReply::Ok(json) => json.clone(),
                            FakeReply::Status(code) => format!("provider error body {code}"),
                            FakeReply::Redirect302 => String::new(),
                            FakeReply::SleepThenOk(_, json) => json.clone(),
                            FakeReply::Chunked { .. } => unreachable!(),
                        }
                    );
                    let _ = sock.write_all(response.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        provider
    }

    fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn count(&self) -> usize {
        self.hits.lock().unwrap().len()
    }

    fn first(&self) -> Option<CapturedRequest> {
        self.hits.lock().unwrap().first().cloned()
    }

    /// True when a chunked reply write failed — the client dropped the
    /// connection BEFORE the body finished (bounded-read proof).
    fn stream_aborted(&self) -> bool {
        *self.stream_aborted.lock().unwrap()
    }

    /// Polls until the provider observes the aborted write, or the deadline
    /// elapses. The client-side drop surfaces as a write error asynchronously
    /// (loopback reset), so the assertion must WAIT for it instead of racing
    /// the first check. Returns the final stream_aborted state.
    async fn wait_stream_aborted(&self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.stream_aborted() {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn chat_request_json() -> broker_server::ChatRequest {
    serde_json::from_value(serde_json::json!({
        "id": "conversation-1",
        "messages": [{"id":"m0","role":"user","parts":[{"type":"text","text":"hello provider"}]}],
        "trigger": "submit-message",
        "messageId": null
    }))
    .unwrap()
}

fn dev_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, ALLOWED_ORIGIN_DEV.parse().unwrap());
    headers
}

fn egress_with(fake: &FakeProvider, key: Option<&str>) -> EgressConfig {
    EgressConfig {
        enabled: true,
        model_url: Some(fake.url()),
        api_key: key.map(|k| k.to_string()),
        endpoint: None,
        timeout: Duration::from_secs(5),
        model: Some("FAKE_MODEL".into()),
        allowed_origins: Vec::new(),
    }
}

/// Enabled egress pinned at a NON-loopback http URL (config-level SSRF test).
fn egress_http_remote() -> EgressConfig {
    EgressConfig {
        enabled: true,
        model_url: Some("http://192.168.3.50:9988".into()),
        api_key: None,
        endpoint: None,
        timeout: Duration::from_secs(5),
        model: Some("FAKE_MODEL".into()),
        allowed_origins: Vec::new(),
    }
}

/// Parse the SSE body into the JSON event payloads (skipping `[DONE]`).
fn sse_events(body: &str) -> Vec<serde_json::Value> {
    body.split("\n\n")
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|payload| {
            if payload == "[DONE]" {
                None
            } else {
                serde_json::from_str::<serde_json::Value>(payload).ok()
            }
        })
        .collect()
}

/// The `errorText` of the FIRST `error` chunk, if any.
fn first_error_text(body: &str) -> Option<String> {
    sse_events(body)
        .into_iter()
        .find(|event| event.get("type").and_then(|t| t.as_str()) == Some("error"))
        .and_then(|event| event.get("errorText").and_then(|t| t.as_str()).map(String::from))
}

fn assert_error_stream(
    body: &str,
    expected_reason: &str,
    disallowed: &[&str],
    label: &str,
) {
    assert!(
        body.ends_with("data: [DONE]\n\n"),
        "{label}: stream must be [DONE]-terminated. Body: {body}"
    );
    // Finish with reason "error", never a success echo.
    assert!(
        body.contains(r#""finishReason":"error""#),
        "{label}: finish must be error. Body: {body}"
    );
    let reason = first_error_text(body);
    assert_eq!(
        reason.as_deref(),
        Some(expected_reason),
        "{label}: expected errorText {expected_reason}. Body: {body}"
    );
    for needle in disallowed {
        assert!(
            !body.contains(needle),
            "{label}: forbidden content leaked '{needle}'. Body: {body}"
        );
    }
}

// ---------------------------------------------------------------------------
// S9.18-001 — the cheap disconfirm (probe) + provider transport contract
// ---------------------------------------------------------------------------

/// S9.18-001 — CHEAP DISCONFIRM. Pre-fix this test FAILED with `count == 0`:
/// the handler answered the demo echo and never talked to the configured
/// provider (captured failure: `assertion failed: left: 0, right: 1`). After
/// the fix the same call reaches the provider EXACTLY once and the REAL reply
/// streams back (no echo).
#[tokio::test]
async fn configured_provider_streams_real_reply() {
    let provider = FakeProvider::spawn(FakeReply::Ok(
        r#"{"choices":[{"message":{"content":"provider-real-reply"}}]}"#.to_string(),
    ))
    .await;
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(egress_with(&provider, Some("sk-test")))),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);

    assert_eq!(
        provider.count(),
        1,
        "configured fake provider must be called exactly once (pre-fix: 0)"
    );

    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 2 * 1024 * 1024).await.unwrap())
        .into_owned();
    assert!(text.contains("provider-real-reply"), "got: {text}");
    assert!(!text.contains("Broker loopback echo"), "offline echo leaked: {text}");
    assert!(text.contains(r#""finishReason":"stop""#));
    assert!(text.ends_with("data: [DONE]\n\n"));

    // Outgoing request JSON: closed chat-completions shape, model from config,
    // the user's actual text, stream:false, and the BYOK bearer key.
    let req = provider.first().expect("captured request");
    assert!(req.body.contains(r#""model":"FAKE_MODEL""#), "body: {}", req.body);
    assert!(req.body.contains(r#""hello provider""#), "body: {}", req.body);
    assert!(req.body.contains(r#""stream":false"#), "body: {}", req.body);
    assert_eq!(
        req.authorization.as_deref(),
        Some("Bearer sk-test"),
        "BYOK key must ride the bearer header"
    );
}

/// Egress DISABLED → the EXPLICIT demo echo (provider-mode demo signal in the
/// stream metadata — a data-provider flag, never a fake AI success).
#[tokio::test]
async fn egress_disabled_streams_pure_demo_echo() {
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(EgressConfig::default())),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert!(text.contains("Broker loopback echo"), "got: {text}");
    assert!(text.contains(r#""type":"message-metadata""#));
    assert!(text.contains(r#""provider":{"mode":"demo"}"#), "got: {text}");
    assert!(text.contains(r#""finishReason":"stop""#));
    assert!(first_error_text(&text).is_none(), "demo lane must never error: {text}");
    assert!(text.ends_with("data: [DONE]\n\n"));
}

/// `Debug` must NOT leak the api_key.
#[test]
fn debug_redacts_api_key() {
    let config = EgressConfig {
        enabled: true,
        model_url: Some("https://provider.example".into()),
        api_key: Some("super-secret-key-abc123".into()),
        endpoint: None,
        timeout: Duration::from_secs(60),
        model: Some("FAKE_MODEL".into()),
        allowed_origins: Vec::new(),
    };
    let rendered = format!("{config:?}");
    assert!(
        !rendered.contains("super-secret-key-abc123"),
        "Debug leaked the api_key: {rendered}"
    );
    assert!(rendered.contains("[REDACTED]"), "Debug must flag key presence");
}

// ---------------------------------------------------------------------------
// Pinned-base URL + endpoint validation matrices
// ---------------------------------------------------------------------------

#[test]
fn model_url_validation_matrix() {
    // https remote is allowed …
    assert!(validate_model_url("https://provider.example.com"));
    assert!(validate_model_url("https://provider.example.com/v1"));
    // … loopback http is allowed (local test gateways) …
    assert!(validate_model_url("http://127.0.0.1:11434"));
    assert!(validate_model_url("http://localhost:8080"));
    assert!(validate_model_url("http://[::1]:8080"));
    // … but http to a NON-loopback host is SSRF-rejected …
    assert!(!validate_model_url("http://192.168.3.50:9988"));
    assert!(!validate_model_url("http://provider.example.com"));
    // other schemes, userinfo, query/fragment are all rejected.
    assert!(!validate_model_url("ws://127.0.0.1:8080"));
    assert!(!validate_model_url("ftp://127.0.0.1"));
    assert!(!validate_model_url("https://user:pass@provider.example.com"));
    assert!(!validate_model_url("https://provider.example.com?api_key=1"));
    assert!(!validate_model_url("https://provider.example.com/#frag"));
}

#[test]
fn endpoint_validation_matrix() {
    assert!(validate_endpoint("/v1/chat/completions"));
    assert!(validate_endpoint("/v1/embeddings"));
    // "/" alone, "", absolute URLs, // authority, ? #, whitespace, ".." → no.
    assert!(!validate_endpoint("/"));
    assert!(!validate_endpoint(""));
    assert!(!validate_endpoint("v1/chat"));
    assert!(!validate_endpoint("http://evil.example/v1"));
    assert!(!validate_endpoint("//evil.example/v1"));
    assert!(!validate_endpoint("/v1?key=1"));
    assert!(!validate_endpoint("/v1#frag"));
    assert!(!validate_endpoint("/v1 /x"));
    assert!(!validate_endpoint("/v1/../admin"));
}

// ---------------------------------------------------------------------------
// Provider status matrix (demo / configured / unavailable)
// ---------------------------------------------------------------------------

#[test]
fn provider_status_matrix() {
    // demo
    let status = provider_status_for(&EgressConfig::default());
    assert_eq!(status.mode, ProviderMode::Demo);
    assert!(!status.configured);
    assert_eq!(status.reason, "demo");

    // configured (valid loopback-base env)
    let mut config = EgressConfig {
        enabled: true,
        model_url: Some("http://127.0.0.1:11434".into()),
        ..Default::default()
    };    let status = provider_status_for(&config);
    assert_eq!(status.mode, ProviderMode::Configured);
    assert!(status.configured);
    assert_eq!(status.reason, "configured");

    // unavailable: enabled but invalid model URL (http non-loopback)
    config.model_url = Some("http://192.168.3.50:9988".into());
    let status = provider_status_for(&config);
    assert_eq!(status.mode, ProviderMode::Unavailable);
    assert!(!status.configured);
    assert_eq!(status.reason, "invalid-model-url");

    // unavailable: enabled, valid URL, invalid endpoint
    config.model_url = Some("http://127.0.0.1:11434".into());
    config.endpoint = Some("//evil.example/v1".into());
    let status = provider_status_for(&config);
    assert_eq!(status.mode, ProviderMode::Unavailable);
    assert_eq!(status.reason, "invalid-endpoint");
}

/// `GET /provider/status` over the real router for the three modes.
#[tokio::test]
async fn status_endpoint_matrix() {
    async fn status_mode(config: EgressConfig) -> (String, bool, String) {
        let res = router_with(config)
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/provider/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (
            v["mode"].as_str().unwrap().to_string(),
            v["configured"].as_bool().unwrap(),
            v["reason"].as_str().unwrap().to_string(),
        )
    }

    let (mode, configured, reason) = status_mode(EgressConfig::default()).await;
    assert_eq!((mode.as_str(), configured, reason.as_str()), ("demo", false, "demo"));

    let (mode, configured, reason) = status_mode(egress_http_remote()).await;
    assert_eq!(
        (mode.as_str(), configured, reason.as_str()),
        ("unavailable", false, "invalid-model-url")
    );

    let provider = FakeProvider::spawn(FakeReply::Ok(r#"{"choices":[{"message":{"content":"x"}}]}"#.to_string()))
        .await;
    let (mode, configured, reason) = status_mode(egress_with(&provider, None)).await;
    assert_eq!(
        (mode.as_str(), configured, reason.as_str()),
        ("configured", true, "configured")
    );
    // "configured" must NOT imply a call hit the provider (no warmup).
    assert_eq!(provider.count(), 0, "status must never contact the provider");
}

// ---------------------------------------------------------------------------
// Provider failure policy — fixed reasons, NO offline echo fallback
// ---------------------------------------------------------------------------

#[tokio::test]
async fn provider_missing_content_is_error() {
    let provider = FakeProvider::spawn(FakeReply::Ok(
        r#"{"choices":[{"message":{"content":null}}]}"#.to_string(),
    ))
    .await;
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(egress_with(&provider, None))),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(&text, "malformed-response", &["Broker loopback echo"], "null content");
}

#[tokio::test]
async fn provider_tool_calls_are_unsupported_error() {
    // The tool loop is the NEXT slice (S9.18-002) — a tool_call must surface
    // as a FIXED error, never be silently dropped, never echo.
    let provider = FakeProvider::spawn(FakeReply::Ok(
        r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"set_temp","arguments":"{}"}}]}}]}"#
            .to_string(),
    ))
    .await;
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(egress_with(&provider, None))),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(
        &text,
        "unsupported-tools",
        &["Broker loopback echo"],
        "tool_calls present",
    );
}

#[tokio::test]
async fn provider_http_400_is_upstream_error_no_body_leak() {
    let provider = FakeProvider::spawn(FakeReply::Status(400)).await;
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(egress_with(&provider, Some("sk-x")))),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    // Fixed reason; the provider's raw body is redacted to a generic reason.
    assert_error_stream(
        &text,
        "upstream-status",
        &["Broker loopback echo", "provider error body 400"],
        "HTTP 400",
    );
}

#[tokio::test]
async fn provider_redirect_is_not_followed() {
    let provider = FakeProvider::spawn(FakeReply::Redirect302).await;
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(egress_with(&provider, Some("sk-x")))),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(&text, "upstream-status", &["Broker loopback echo"], "redirect 302");
    // redirect::Policy::none ⇒ exactly ONE request, never a follow-up hop.
    assert_eq!(provider.count(), 1, "302 must not be followed");
}

#[tokio::test]
async fn provider_timeout_is_error() {
    // Slow provider (2s) + tight client timeout (100ms) ⇒ fixed "timeout".
    let provider = FakeProvider::spawn(FakeReply::SleepThenOk(
        Duration::from_secs(2),
        r#"{"choices":[{"message":{"content":"late"}}]}"#.to_string(),
    ))
    .await;
    let mut config = egress_with(&provider, None);
    config.timeout = Duration::from_millis(100);
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(config)),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(&text, "timeout", &["Broker loopback echo"], "provider timeout");
}

/// Invalid endpoint ⇒ SSE error BEFORE any request; provider never contacted.
#[tokio::test]
async fn endpoint_invalid_reports_unavailable_no_call() {
    let provider = FakeProvider::spawn(FakeReply::Ok(
        r#"{"choices":[{"message":{"content":"x"}}]}"#.to_string(),
    ))
    .await;
    let mut config = egress_with(&provider, None);
    config.endpoint = Some("//evil.example/v1".into());
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(config)),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(
        &text,
        "invalid-endpoint",
        &["Broker loopback echo"],
        "invalid endpoint",
    );
    assert_eq!(provider.count(), 0, "invalid config must never hit the provider");
}

/// More than 64 input messages ⇒ budget error, zero provider traffic.
#[tokio::test]
async fn too_many_messages_is_budget_error() {
    let provider = FakeProvider::spawn(FakeReply::Ok(
        r#"{"choices":[{"message":{"content":"x"}}]}"#.to_string(),
    ))
    .await;
    let mut messages: Vec<serde_json::Value> = Vec::new();
    for i in 0..65 {
        messages.push(serde_json::json!({
            "id": format!("m{i}"),
            "role": "user",
            "parts": [{"type": "text", "text": format!("msg {i}")}]
        }));
    }
    let req: ChatRequest = serde_json::from_value(serde_json::json!({
        "id": "c-budget",
        "messages": messages,
        "trigger": "submit-message",
        "messageId": null
    }))
    .unwrap();
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(egress_with(&provider, None))),
        axum::Json(req),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(
        &text,
        "too-many-messages",
        &["Broker loopback echo"],
        "budget 64 messages",
    );
    assert_eq!(provider.count(), 0, "budget breach must never hit the provider");
}

// ---------------------------------------------------------------------------
// S9.18-001 hardening — bounded body read, body-iteration timeout, busy lane
// ---------------------------------------------------------------------------

/// Chunked response with NO Content-Length and a total size ABOVE
/// MAX_RESPONSE_BODY. THE counter-evidence: if the client read the whole body
/// (`bytes().await`) the fake provider would have completed its write; with a
/// bounded accumulation the client must abort the body once the cap is
/// crossed → `stream_aborted` true and the SSE stream surfaces the fixed
/// "response-too-large" error. This pins the fix that made the read bounded.
#[tokio::test]
async fn chunked_over_limit_aborts_bounded_and_reports_response_too_large() {
    let provider = FakeProvider::spawn(FakeReply::Chunked {
        chunk_size: 256 * 1024,
        // Far above MAX_RESPONSE_BODY (4 MiB) and far above any loopback OS
        // socket buffer: with the unbounded `bytes().await` the provider would
        // deliver the whole body and `stream_aborted` stays false; with the
        // bounded chunk loop the client drops the response at 4 MiB and the
        // provider's next write fails — a deterministic proof the read stops.
        total_bytes: 64 * 1024 * 1024,
        per_chunk_delay: Some(Duration::from_millis(1)),
    })
    .await;
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(egress_with(&provider, None))),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 1 * 1024 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(
        &text,
        "response-too-large",
        &["Broker loopback echo", "xxxx"],
        "chunked body over the response budget",
    );
    assert_eq!(provider.count(), 1, "exactly one provider request");
    assert!(
        provider.wait_stream_aborted(Duration::from_secs(5)).await,
        "client must abort the chunked body at the 4 MiB cap (bounded read)"
    );
}

/// Chunked body streamed more slowly than the request timeout: reqwest's
/// `timeout()` MUST cover the whole body iteration (`chunk().await` included)
/// — a slow drip must surface "timeout", not an unbounded wait. This is the
/// red test for the `while let Some(chunk) = response.chunk().await` loop
/// running under the same total deadline.
#[tokio::test]
async fn slow_chunked_body_times_out_during_body_iteration() {
    let provider = FakeProvider::spawn(FakeReply::Chunked {
        chunk_size: 512,
        total_bytes: 512 * 64,
        per_chunk_delay: Some(Duration::from_millis(120)),
    })
    .await;
    let mut config = egress_with(&provider, None);
    config.timeout = Duration::from_millis(300); // each chunk takes 120ms → drift
    let res = chat_handler(
        dev_headers(),
        State(AppState::from_config(config)),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 512 * 1024).await.unwrap())
        .into_owned();
    assert_error_stream(
        &text,
        "timeout",
        &["Broker loopback echo"],
        "slow chunked body must time out (total deadline covers body iteration)",
    );
}

/// Two SIMULTANEOUS provider-calls with one in-flight permit: the serially
/// queued second request must NOT sit waiting forever replacing a queue of
/// unbounded futures — with `try_acquire_owned` it fails fast with the typed
/// "provider-busy" SSE error and ZERO extra provider traffic, and the busy
/// lane is released after the first call completes (no sticky lock).
#[tokio::test]
async fn concurrent_requests_busy_second_fails_fast_with_provider_busy() {
    let provider = FakeProvider::spawn(FakeReply::SleepThenOk(
        Duration::from_millis(400),
        r#"{"choices":[{"message":{"content":"busy-lane-reply"}}]}"#.to_string(),
    ))
    .await;
    let state = AppState::from_config(egress_with(&provider, None));
    let state_second = state.clone();
    let (res_a, res_b) = tokio::join!(
        chat_handler(dev_headers(), State(state.clone()), axum::Json(chat_request_json())),
        chat_handler(dev_headers(), State(state_second), axum::Json(chat_request_json())),
    );
    let text_a =
        String::from_utf8_lossy(&to_bytes(res_a.into_body(), 512 * 1024).await.unwrap())
            .into_owned();
    let text_b =
        String::from_utf8_lossy(&to_bytes(res_b.into_body(), 512 * 1024).await.unwrap())
            .into_owned();
    // Exactly ONE of the two reaches the provider; the other is provider-busy.
    assert_eq!(
        provider.count(),
        1,
        "concurrent second request must not reach the provider",
    );
    let successes = [&text_a, &text_b]
        .iter()
        .filter(|t| t.contains(r#""finishReason":"stop""#))
        .count();
    let busies = [&text_a, &text_b]
        .iter()
        .filter(|t| first_error_text(t).as_deref() == Some("provider-busy"))
        .count();
    assert_eq!(successes, 1, "exactly one request succeeds");
    assert_eq!(busies, 1, "exactly one request is provider-busy (fast-fail, no wait)");
    for text in [&text_a, &text_b] {
        assert!(!text.contains("Broker loopback echo"), "no demo echo on busy: {text}");
    }

    // After the first call completes the lane must be released: a THIRD
    // request on the SAME state reaches the provider (permit not leaked).
    let res_c = chat_handler(
        dev_headers(),
        State(state),
        axum::Json(chat_request_json()),
    )
    .await;
    let text_c = String::from_utf8_lossy(&to_bytes(res_c.into_body(), 512 * 1024).await.unwrap())
        .into_owned();
    assert_eq!(provider.count(), 2, "lane must be released after completion");
    assert!(text_c.contains(r#""finishReason":"stop""#), "third call succeeds: {text_c}");
}
