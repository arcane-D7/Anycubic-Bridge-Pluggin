//! Egress-pinned HTTP client for provider calls — S9-001.
//!
//! The transport is decoupled from the registry so it can be tested with a
//! stub server or fully offline. Every request URL MUST start with the
//! provider's pinned base URL or it is denied before any I/O.

use crate::provider::{Provider, ProviderError, ProviderKind};

pub type BoxBody = String;

/// Minimal transport abstraction (kept dependency-free; the real Tauri/Rust
/// caller may substitute reqwest/ureq). Implementations must not log secrets.
pub trait HttpTransport {
    fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> Result<HttpResponse, String>;
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Static post-implementation used as the default in-memory tester.
#[derive(Default)]
pub struct StubTransport {
    pub response: HttpResponse,
}

impl HttpTransport for StubTransport {
    fn post(
        &self,
        _url: &str,
        _headers: &[(String, String)],
        _body: &str,
    ) -> Result<HttpResponse, String> {
        Ok(self.response.clone())
    }
}

/// Validate a URL against a provider's pinned base. Fails closed on any
/// non-prefix match (scheme + host + path prefix).
pub fn assert_pinned(url: &str, provider: &Provider) -> Result<(), ProviderError> {
    let base = provider.pinned_base_url();
    if !url.starts_with(base) {
        return Err(ProviderError::EgressDenied {
            provider: provider.id.clone(),
            url: url.to_string(),
        });
    }
    Ok(())
}

/// Build the chat/completions request for an OpenAI-compatible endpoint.
pub fn build_chat_url(provider: &Provider) -> String {
    format!(
        "{}/chat/completions",
        provider.pinned_base_url().trim_end_matches('/')
    )
}

/// Universal chat request body for OpenAI-compatible dialects.
#[derive(Debug, serde::Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Send a chat completion with full egress pinning. `api_key` is injected by
/// the CALLER from the keystore (never held by the registry).
pub fn call_chat(
    transport: &dyn HttpTransport,
    provider: &Provider,
    api_key: &str,
    request: &ChatRequest,
) -> Result<HttpResponse, ProviderError> {
    let url = build_chat_url(provider);
    assert_pinned(&url, provider)?;
    if provider.kind == ProviderKind::Local
        && !crate::provider::is_loopback(provider.pinned_base_url())
    {
        return Err(ProviderError::NonLoopbackForLocal(
            provider.pinned_base_url().to_string(),
        ));
    }
    let body = serde_json::to_string(request).map_err(|e| ProviderError::EgressDenied {
        provider: provider.id.clone(),
        url: e.to_string(),
    })?;
    let headers = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("authorization".to_string(), format!("Bearer {api_key}")),
    ];
    transport
        .post(&url, &headers, &body)
        .map_err(|e| ProviderError::EgressDenied {
            provider: provider.id.clone(),
            url: e,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prov(id: &str, url: &str, kind: ProviderKind) -> Provider {
        Provider {
            id: id.to_string(),
            display_name: id.to_string(),
            base_url: url.to_string(),
            model: "m".to_string(),
            dialect: "openai-compatible".to_string(),
            kind,
            quota_usd_cents: 0,
            cost_per_1k_tokens_usd: 0.0,
            revoked: false,
        }
    }

    #[test]
    fn pinned_url_must_prefix_base() {
        let p = prov("p", "https://api.example.com/v1", ProviderKind::Remote);
        assert!(assert_pinned("https://api.example.com/v1/chat/completions", &p).is_ok());
        assert_eq!(
            assert_pinned("https://evil.example.com/v1/chat/completions", &p),
            Err(ProviderError::EgressDenied {
                provider: "p".into(),
                url: "https://evil.example.com/v1/chat/completions".into()
            })
        );
        assert_eq!(
            assert_pinned("https://api.example.com.evil.io/chat", &p),
            Err(ProviderError::EgressDenied {
                provider: "p".into(),
                url: "https://api.example.com.evil.io/chat".into()
            })
        );
    }

    #[test]
    fn call_transport_error_maps_to_egress_denied() {
        let p = prov("p", "https://api.example.com/v1", ProviderKind::Remote);
        struct Fail;
        impl HttpTransport for Fail {
            fn post(
                &self,
                _url: &str,
                _headers: &[(String, String)],
                _body: &str,
            ) -> Result<HttpResponse, String> {
                Err("io: connection refused".to_string())
            }
        }
        let r = call_chat(
            &Fail,
            &p,
            "k",
            &ChatRequest {
                model: "m".into(),
                messages: vec![],
                temperature: None,
                max_tokens: None,
            },
        );
        assert!(matches!(r, Err(ProviderError::EgressDenied { .. })));
    }

    #[test]
    fn call_ok_and_url_built() {
        let p = prov("p", "http://127.0.0.1:1234/v1", ProviderKind::Local);
        let t = StubTransport {
            response: HttpResponse {
                status: 200,
                body: r#"{"choices":[{"message":{"content":"hi"}}]}"#.into(),
            },
        };
        let r = call_chat(
            &t,
            &p,
            "k",
            &ChatRequest {
                model: "m".into(),
                messages: vec![ChatMessage {
                    role: "user".into(),
                    content: "hi".into(),
                }],
                temperature: None,
                max_tokens: None,
            },
        );
        assert_eq!(r.unwrap().status, 200);
    }

    #[test]
    fn local_provider_loopback_enforced_on_call() {
        let p = Provider {
            base_url: "http://10.0.0.9:11434".into(),
            ..prov("l", "http://127.0.0.1:11434", ProviderKind::Local)
        };
        let t = StubTransport {
            response: HttpResponse {
                status: 200,
                body: "{}".into(),
            },
        };
        let r = call_chat(
            &t,
            &p,
            "k",
            &ChatRequest {
                model: "m".into(),
                messages: vec![],
                temperature: None,
                max_tokens: None,
            },
        );
        assert!(matches!(r, Err(ProviderError::NonLoopbackForLocal(_))));
    }
}
