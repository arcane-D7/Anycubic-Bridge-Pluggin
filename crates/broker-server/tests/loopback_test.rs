//! S9.6-008 — integration tests for the broker-server loopback.

use axum::body::{to_bytes, Body};
use axum::http::{header, HeaderMap, Method, Request};
use axum::Extension;
use broker_server::{
    chat_handler, router, sse_body_for, ALLOWED_ORIGIN_DEV, ChatRequest, EgressConfig,
    UiMessageChunk, UI_STREAM_HEADER,
};
use tower::ServiceExt as _; // oneshot

fn chat_request_json() -> ChatRequest {
    serde_json::from_value(serde_json::json!({
        "id": "conversation-1",
        "messages": [{"id":"m0","role":"user","parts":[{"type":"text","text":"hello"}]}],
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

#[tokio::test]
async fn health_ok() {
    let res = router()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("broker-server ok"));
}

#[tokio::test]
async fn loopback_echo_streams_ui_protocol() {
    let body_text = sse_body_for(
        &serde_json::from_str::<Vec<serde_json::Value>>(
            r#"[{"id":"m0","role":"user","parts":[{"type":"text","text":"hello"}]}]"#,
        )
        .unwrap(),
        "resp_1",
        "text-1",
    );
    assert!(body_text.contains("data: "));
    assert!(body_text.contains(r#""type":"start""#));
    assert!(body_text.contains(r#""messageId":"resp_1""#));
    assert!(body_text.contains(r#""type":"text-delta""#));
    assert!(!body_text.contains("finiReason"));
    assert!(body_text.contains(r#""finishReason":"stop""#));
    assert!(body_text.ends_with("data: [DONE]\n\n"));
    // Order contract: start → text-start → text-delta → text-end → finish → [DONE]
    let idx = |needle: &str| body_text.find(needle).expect(needle);
    assert!(idx(r#""type":"start""#) < idx(r#""type":"text-start""#));
    assert!(idx(r#""type":"text-start""#) < idx(r#""type":"text-delta""#));
    assert!(idx(r#""type":"text-delta""#) < idx(r#""type":"text-end""#));
    assert!(idx(r#""type":"text-end""#) < idx(r#""type":"finish""#));
    assert!(idx(r#""type":"finish""#) < idx("data: [DONE]"));
}

#[tokio::test]
async fn chat_handler_streams_sse_with_headers() {
    let res = chat_handler(
        dev_headers(),
        Extension(EgressConfig::default()),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap(),
        "text/event-stream; charset=utf-8"
    );
    assert_eq!(
        res.headers().get(UI_STREAM_HEADER).unwrap().to_str().unwrap(),
        "v1"
    );
    // CORS vem do layer — o handler não os duplica (testado no router).
    assert_eq!(res.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN), None);
    let text = String::from_utf8_lossy(&to_bytes(res.into_body(), 128 * 1024).await.unwrap())
        .into_owned();
    assert!(text.contains(r#""type":"start""#));
    assert!(text.contains(r#""finishReason":"stop""#));
    assert!(text.ends_with("data: [DONE]\n\n"));
}

#[tokio::test]
async fn chat_handler_rejects_unknown_origin() {
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, "http://evil.example".parse().unwrap());
    let res = chat_handler(
        headers,
        Extension(EgressConfig::default()),
        axum::Json(chat_request_json()),
    )
    .await;
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn stream_resume_is_204_when_idle() {
    let res = router()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/chat/conversation-1/stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
}

#[tokio::test]
async fn router_cors_headers_attached_on_origin() {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/chat")
        .header(header::ORIGIN, ALLOWED_ORIGIN_DEV)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"id":"c1","messages":[],"trigger":"submit-message","messageId":null}"#,
        ))
        .unwrap();
    let res = router().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap()
            .to_str()
            .unwrap(),
        ALLOWED_ORIGIN_DEV
    );
}

#[test]
fn ui_chunk_serialization_roundtrip() {
    let start = UiMessageChunk::start("resp_1");
    let json = serde_json::to_string(&start).unwrap();
    assert!(json.contains(r#""type":"start""#));
    assert!(json.contains(r#""messageId":"resp_1""#));
    let delta = UiMessageChunk::text_delta("text-1", "hi");
    let json = serde_json::to_string(&delta).unwrap();
    assert!(json.contains(r#""type":"text-delta""#));
    assert!(json.contains(r#""id":"text-1""#));
    assert!(json.contains(r#""delta":"hi""#));
}
