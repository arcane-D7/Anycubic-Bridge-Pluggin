//! S9.18-001 — integration tests for the operation discovery catalog
//! (`GET /operations` + `GET /operations/{id}`). Strict origin guard,
//! structured unknown errors, backend-owned availability state.

use axum::body::{to_bytes, Body};
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use broker::{BackendCapabilityState, Scope};
use broker_server::{router_with_state, AppState, EgressConfig, ALLOWED_ORIGIN_DEV};
use tower::ServiceExt as _; // oneshot

fn dev_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, ALLOWED_ORIGIN_DEV.parse().unwrap());
    headers
}

fn evil_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, "http://evil.example".parse().unwrap());
    headers
}

async fn get_json(uri: &str, headers: HeaderMap, state: AppState) -> (StatusCode, String) {
    let mut builder = Request::builder().method(Method::GET).uri(uri);
    for (name, value) in headers.iter() {
        builder = builder.header(name.clone(), value.clone());
    }
    let response = router_with_state(state)
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 256 * 1024).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn wired_state(revoked: &[&str]) -> AppState {
    AppState::from_config(EgressConfig::default()).with_capabilities(BackendCapabilityState {
        granted_scopes: vec![Scope::DeviceControl, Scope::DeviceUpload, Scope::PrintJob],
        device_control_wired: true,
        job_transport_wired: true,
        snapshot_resolver_wired: true,
        revoked_actions: revoked.iter().map(|s| (*s).to_owned()).collect(),
    })
}

#[tokio::test]
async fn operations_from_allowed_origin_lists_13_unavailable_entries() {
    let (status, body) = get_json(
        "/operations",
        dev_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["schemaVersion"], 1);
    let operations = json["operations"].as_array().expect("operations array");
    assert_eq!(operations.len(), 13, "all known writer actions are listed");
    for entry in operations {
        assert!(entry["id"].is_string(), "every entry has an id");
        assert_eq!(entry["schemaVersion"], 1);
        assert!(entry["effect"].is_string());
        assert!(entry["requiredScope"].is_string());
        assert_eq!(entry["approvalPolicy"], "one_use_approval");
        assert!(entry["handler"].is_string());
        let input = entry["inputSchema"]
            .as_object()
            .expect("inputSchema object");
        assert_eq!(input["type"], "object");
        assert_eq!(input["additionalProperties"], false, "closed schema");
        // Default backend: no session, no wired transport, no resolver —
        // every writer entry is unavailable with the precise stable reason.
        assert_eq!(entry["available"], false);
        assert_eq!(entry["availabilityReason"], "backend-not-wired");
    }
    // The catalog must never leak secrets, provider URLs or account paths.
    for forbidden in [
        "://",
        "Users",
        "AppData",
        "api_key",
        "Bearer",
        "token",
        "access_token",
    ] {
        assert!(
            !body.contains(forbidden),
            "catalog must not leak {forbidden:?}"
        );
    }
}

#[tokio::test]
async fn operations_rejects_unknown_origin() {
    let (status, body) = get_json(
        "/operations",
        evil_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("Origin not allowed"));
}

#[tokio::test]
async fn operation_by_id_returns_the_registry_entry() {
    let (status, body) = get_json(
        "/operations/nozzle",
        dev_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["id"], "nozzle");
    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["requiredScope"], "device_control");
    assert_eq!(json["effect"], "thermal");
    assert_eq!(json["handler"], "dispatch_device_control");
    assert_eq!(json["available"], false);
    assert_eq!(json["availabilityReason"], "backend-not-wired");
    assert_eq!(
        json.pointer("/inputSchema/properties/nozzle/maximum"),
        Some(&serde_json::json!(320.0)),
        "single-operation schema agrees with the dispatch window"
    );
}

#[tokio::test]
async fn operation_unknown_id_is_a_structured_404_without_echo() {
    // Non-empty plausible unknown ids reach the handler → the structured
    // error. The body is STATIC: the caller-supplied id is never echoed
    // (unbounded/possibly-sensitive input never reflects into the response).
    for id in ["does-not-exist", "job.anything", "device.command", "nozzle-extra"] {
        let (status, body) = get_json(
            &format!("/operations/{id}"),
            dev_headers(),
            AppState::from_config(EgressConfig::default()),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id}");
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["error"], "operation-not-found", "{id}");
        assert!(
            json.get("id").is_none(),
            "{id}: not-found body must not carry an id key"
        );
        assert!(
            !body.contains(id),
            "{id}: caller-supplied id must never be echoed"
        );
    }
    // Implausible ids (oversized / off-charset / empty) are bounded BEFORE
    // the registry lookup and answer the EXACT same static body — still no
    // echo, still structured. Off-charset input is percent-encoded so the
    // URI stays valid; axum decodes `%2F`/`%00`/`%20` back into the id, which
    // then hits `is_plausible_operation_id`.
    let oversized = "x".repeat(4096);
    let off_charset = ["Nozzle", "nozzle%2F", "nozzle%00x", "a%20b", "nozzle%2e%2e"];
    for id in ["x".repeat(64), oversized.clone()] {
        let (status, body) = get_json(
            &format!("/operations/{id}"),
            dev_headers(),
            AppState::from_config(EgressConfig::default()),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id}");
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["error"], "operation-not-found");
        assert!(json.get("id").is_none(), "no id key for implausible input");
        assert!(!body.contains(&oversized), "oversized input is never echoed");
    }
    for id in off_charset {
        let (status, body) = get_json(
            &format!("/operations/{id}"),
            dev_headers(),
            AppState::from_config(EgressConfig::default()),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id:?}");
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["error"], "operation-not-found", "{id:?}");
        assert!(json.get("id").is_none(), "{id:?}: no id key");
        assert!(!body.contains("nozzle"), "{id:?}: no decoded echo");
    }
    // An empty trailing segment never reaches the handler — the router's own
    // 404 still applies (no widening, no fallback entry).
    let (status, _) = get_json(
        "/operations/",
        dev_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn injected_backend_state_flips_availability_honestly() {
    // Everything wired + a session → device-control AND job writers become
    // available (start/stop included — the resolver is wired too).
    let (status, body) = get_json("/operations/nozzle", dev_headers(), wired_state(&[])).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], true, "wired nozzle must be available");
    assert_eq!(json["availabilityReason"], "");

    let (_, body) = get_json("/operations/job.start", dev_headers(), wired_state(&[])).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(
        json["available"], true,
        "wired start (snapshot resolver present)"
    );

    // A backend-revoked action reports the stable "revoked" reason even in a
    // fully-wired backend — revocation beats every other gate.
    let (_, body) = get_json("/operations/bed", dev_headers(), wired_state(&["bed"])).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], false);
    assert_eq!(json["availabilityReason"], "revoked");

    // Siblings are untouched by the revocation list.
    let (_, body) = get_json("/operations/nozzle", dev_headers(), wired_state(&["bed"])).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], true, "sibling action stays available");

    // Default backend (no session, no wiring) — the honest baseline.
    let (_, body) = get_json(
        "/operations/job.start",
        dev_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], false);
    assert_eq!(json["availabilityReason"], "backend-not-wired");
    let (_, body) = get_json(
        "/operations/upload",
        dev_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], false);
    assert_eq!(json["availabilityReason"], "backend-not-wired");
}

#[tokio::test]
async fn operations_missing_session_reports_no_session_behind_wiring() {
    // Transport wired but NO granted scopes → the entry is honest about the
    // scope gate (never "available" from a transport alone; no-session is
    // the single stable reason for both absent session and missing scope).
    let state =
        AppState::from_config(EgressConfig::default()).with_capabilities(BackendCapabilityState {
            granted_scopes: vec![],
            device_control_wired: true,
            job_transport_wired: true,
            snapshot_resolver_wired: true,
            revoked_actions: vec![],
        });
    let (status, body) = get_json("/operations/speed", dev_headers(), state.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], false);
    assert_eq!(json["availabilityReason"], "no-session");
    // Same for a job writer and the upload writer.
    for id in ["job.queue", "upload", "nozzle"] {
        let (_, body) = get_json(
            &format!("/operations/{id}"),
            dev_headers(),
            state.clone(),
        )
        .await;
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["available"], false, "{id}");
        assert_eq!(json["availabilityReason"], "no-session", "{id}");
    }
}

#[tokio::test]
async fn operations_missing_snapshot_resolver_pins_device_control_and_job_families() {
    // Everything wired + full scopes, but NO trusted snapshot resolver →
    // device-control writers are pinned exactly like start/stop
    // (no-trusted-snapshot): the owning Tauri path also revalidates against
    // a trusted snapshot. queue/upload need no resolver and stay available.
    let state =
        AppState::from_config(EgressConfig::default()).with_capabilities(BackendCapabilityState {
            granted_scopes: vec![Scope::DeviceControl, Scope::DeviceUpload, Scope::PrintJob],
            device_control_wired: true,
            job_transport_wired: true,
            snapshot_resolver_wired: false,
            revoked_actions: vec![],
        });
    for id in ["nozzle", "bed", "part_fan", "speed", "job.start", "job.stop"] {
        let (_, body) = get_json(&format!("/operations/{id}"), dev_headers(), state.clone()).await;
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["available"], false, "{id}");
        assert_eq!(json["availabilityReason"], "no-trusted-snapshot", "{id}");
    }
    let (_, body) = get_json("/operations/job.queue", dev_headers(), state.clone()).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], true, "queue needs no snapshot resolver");
    let (_, body) = get_json("/operations/upload", dev_headers(), state).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], true, "upload needs no snapshot resolver");
}

#[tokio::test]
async fn operations_scoped_backend_matches_scope_and_snapshot_gates() {
    fn scoped(granted: &[Scope], snapshot: bool) -> AppState {
        AppState::from_config(EgressConfig::default()).with_capabilities(BackendCapabilityState {
            granted_scopes: granted.to_vec(),
            device_control_wired: true,
            job_transport_wired: true,
            snapshot_resolver_wired: snapshot,
            revoked_actions: vec![],
        })
    }
    // deviceOnly: device control available; upload + every job action need
    // their own scope → no-session.
    let state = scoped(&[Scope::DeviceControl], true);
    for id in ["nozzle", "bed", "speed", "light_brightness"] {
        let (_, body) = get_json(&format!("/operations/{id}"), dev_headers(), state.clone()).await;
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["available"], true, "{id}");
        assert_eq!(json["availabilityReason"], "", "{id}");
    }
    for id in ["upload", "job.queue", "job.start", "job.stop"] {
        let (_, body) = get_json(&format!("/operations/{id}"), dev_headers(), state.clone()).await;
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["available"], false, "{id}");
        assert_eq!(json["availabilityReason"], "no-session", "{id}");
    }
    // uploadOnly: only upload.
    let (_, body) = get_json("/operations/upload", dev_headers(), scoped(&[Scope::DeviceUpload], true)).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], true);
    let (_, body) = get_json("/operations/job.queue", dev_headers(), scoped(&[Scope::DeviceUpload], true)).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["available"], false);
    assert_eq!(json["availabilityReason"], "no-session");
    // jobScopeOnly: every job action available; device + upload not.
    let state = scoped(&[Scope::PrintJob], true);
    for id in ["job.queue", "job.start", "job.stop"] {
        let (_, body) = get_json(&format!("/operations/{id}"), dev_headers(), state.clone()).await;
        let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(json["available"], true, "{id}");
    }
    let (_, body) = get_json("/operations/upload", dev_headers(), state).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(json["availabilityReason"], "no-session");
}

#[tokio::test]
async fn catalog_body_is_bounded() {
    let (status, body) = get_json(
        "/operations",
        dev_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // The 13-entry catalog is small by construction (constant closed
    // schemas) — assert a generous hard bound so a future unbounded growth
    // fails loudly.
    assert!(
        body.len() < 256 * 1024,
        "catalog body must stay far below the 256 KiB request budget: {}",
        body.len()
    );
}

#[tokio::test]
async fn operations_route_does_not_shadow_existing_routes() {
    // Regression: /operations must not interfere with /provider/status or
    // /health routing.
    let (_, body) = get_json(
        "/provider/status",
        dev_headers(),
        AppState::from_config(EgressConfig::default()),
    )
    .await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert!(json["mode"].is_string());
    let response = router_with_state(AppState::from_config(EgressConfig::default()))
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("broker-server ok"));
}
