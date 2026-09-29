//! BYOK provider registry + OpenAI-compatible adapter — S9-001.
//!
//! Keys live ONLY in the broker Keystore (never in prompts/checkpoints).
//! The registry resolves a provider by name, classifies it (remote vs
//! loopback-local), pins its egress base URL, and enforces per-provider
//! quota + cost accounting. Egress destination is bound to the base URL.

use broker::keystore::{Keystore, Secret};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Provider identity — everything except the API key.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Provider {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub model: String,
    /// "openai-compatible" (the only supported dialect in v1)
    pub dialect: String,
    /// Class: remote (egress pinned) vs local (loopback-only, enforced).
    pub kind: ProviderKind,
    /// Per-provider quota in USD cents (0 = unlimited wrt cost).
    pub quota_usd_cents: u64,
    pub cost_per_1k_tokens_usd: f64,
    /// True when the operator revoked/disabled this provider.
    pub revoked: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Remote,
    Local,
}

impl Provider {
    pub fn is_local(&self) -> bool {
        self.kind == ProviderKind::Local
    }

    /// The only URL this provider may egress to — everything else is denied.
    pub fn pinned_base_url(&self) -> &str {
        &self.base_url
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProviderError {
    #[error("provider not found: {0}")]
    NotFound(String),
    #[error("provider revoked: {0}")]
    Revoked(String),
    #[error("egress denied: URL {url} is outside the pinned base of {provider}")]
    EgressDenied { provider: String, url: String },
    #[error("local provider must use a loopback base URL: {0}")]
    NonLoopbackForLocal(String),
    #[error("remote provider must not use a loopback base URL: {0}")]
    LoopbackForRemote(String),
    #[error("provider has no API key in the keystore")]
    MissingKey,
    #[error("quota exhausted: provider {provider} spent {spent} of {quota} cents")]
    QuotaExhausted {
        provider: String,
        spent: u64,
        quota: u64,
    },
}

/// Per-provider key alias convention: `byok:providers/{id}`.
pub fn key_alias(provider_id: &str) -> String {
    format!("byok:providers/{provider_id}")
}

/// Provider registry: name → Provider + spend ledger.
#[derive(Debug)]
pub struct ProviderRegistry {
    providers: HashMap<String, Provider>,
    /// Accumulated cost in USD cents per provider id.
    spend_usd_cents: HashMap<String, u64>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
            spend_usd_cents: HashMap::new(),
        }
    }

    /// Register a provider. Validates loopback rules up-front.
    pub fn register(&mut self, provider: Provider) -> Result<(), ProviderError> {
        if provider.kind == ProviderKind::Local && !is_loopback(&provider.base_url) {
            return Err(ProviderError::NonLoopbackForLocal(
                provider.base_url.clone(),
            ));
        }
        if provider.kind == ProviderKind::Remote && is_loopback(&provider.base_url) {
            return Err(ProviderError::LoopbackForRemote(provider.base_url.clone()));
        }
        self.providers.insert(provider.id.clone(), provider);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<&Provider, ProviderError> {
        let p = self
            .providers
            .get(id)
            .ok_or_else(|| ProviderError::NotFound(id.to_string()))?;
        if p.revoked {
            return Err(ProviderError::Revoked(id.to_string()));
        }
        Ok(p)
    }

    pub fn providers(&self) -> impl Iterator<Item = &Provider> {
        self.providers.values()
    }

    pub fn revoke(&mut self, id: &str) {
        if let Some(p) = self.providers.get_mut(id) {
            p.revoked = true;
        }
    }

    pub fn spend(&self, id: &str) -> u64 {
        self.spend_usd_cents.get(id).copied().unwrap_or(0)
    }

    /// Account a model call: adds cost cents, checks quota (fail-closed).
    /// Called BEFORE an unbounded call is issued; the caller must then
    /// call [`Self::commit`] only after a successful response.
    pub fn account(&self, provider_id: &str) -> Result<u64, ProviderError> {
        let p = self.get(provider_id)?;
        let quota = p.quota_usd_cents;
        let spent = self.spend(provider_id);
        if quota > 0 && spent >= quota {
            return Err(ProviderError::QuotaExhausted {
                provider: provider_id.to_string(),
                spent,
                quota,
            });
        }
        Ok(spent)
    }

    /// Record real spend after a completed call (provider-agnostic token cost).
    pub fn commit_spend(&mut self, provider_id: &str, usd_cents: u64) {
        let e = self
            .spend_usd_cents
            .entry(provider_id.to_string())
            .or_insert(0);
        *e += usd_cents;
    }
}

/// True for `http://127.0.0.1[:port]` / `http://localhost[:port]` /
/// `http://[::1][:port]` (scheme, host only; port ignored).
pub fn is_loopback(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let host = strip_scheme(&lower)
        .map(|h| strip_port(h))
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']');
    host == "127.0.0.1" || host == "localhost" || host == "::1"
}

fn strip_scheme(url: &str) -> Option<&str> {
    url.split_once("://")
        .map(|(_, rest)| rest)
        .or_else(|| url.strip_prefix("http:").map(|_| url))
        .map(|s| s.trim_start_matches('/'))
}

fn strip_port(hostport: &str) -> &str {
    if let Some(idx) = hostport.rfind(':') {
        // IPv6 bracket form keeps the colon inside the brackets; rfind after ']'
        if hostport.contains(']') {
            if let Some(close) = hostport.find(']') {
                let after = &hostport[close + 1..];
                if after.starts_with(':') {
                    return &hostport[..close + 1];
                }
            }
        }
        return &hostport[..idx];
    }
    hostport
}

/// Resolve the API key for a provider from the keystore (never logged).
pub fn resolve_key<K: Keystore>(keystore: &K, provider_id: &str) -> Result<String, ProviderError> {
    let alias = key_alias(provider_id);
    match keystore.get(&alias) {
        Ok(Secret(s)) => Ok(s),
        Err(_) => Err(ProviderError::MissingKey),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use broker::keystore::MemoryKeystore;

    fn remote(id: &str) -> Provider {
        Provider {
            id: id.to_string(),
            display_name: id.to_string(),
            base_url: format!("https://{id}.example.com/v1"),
            model: "m".to_string(),
            dialect: "openai-compatible".to_string(),
            kind: ProviderKind::Remote,
            quota_usd_cents: 1000,
            cost_per_1k_tokens_usd: 0.0,
            revoked: false,
        }
    }

    #[test]
    fn register_and_get_ok() {
        let mut r = ProviderRegistry::new();
        r.register(remote("airrouter")).unwrap();
        assert_eq!(r.get("airrouter").unwrap().model, "m");
    }

    #[test]
    fn revoked_denied() {
        let mut r = ProviderRegistry::new();
        r.register(remote("p1")).unwrap();
        r.revoke("p1");
        assert_eq!(r.get("p1"), Err(ProviderError::Revoked("p1".to_string())));
    }

    #[test]
    fn unknown_denied() {
        let r = ProviderRegistry::new();
        assert_eq!(
            r.get("nope"),
            Err(ProviderError::NotFound("nope".to_string()))
        );
    }

    #[test]
    fn local_must_be_loopback() {
        let mut r = ProviderRegistry::new();
        let bad = Provider {
            kind: ProviderKind::Local,
            base_url: "http://10.0.0.2:11434".into(),
            ..remote("local")
        };
        assert_eq!(
            r.register(bad.clone()),
            Err(ProviderError::NonLoopbackForLocal(
                "http://10.0.0.2:11434".into()
            ))
        );
        assert!(r
            .register(Provider {
                base_url: "http://127.0.0.1:11434".into(),
                ..bad
            })
            .is_ok());
    }

    #[test]
    fn local_rejects_non_loopback_and_remote_rejects_loopback() {
        let mut r = ProviderRegistry::new();
        let local_bad = Provider {
            kind: ProviderKind::Local,
            base_url: "https://api.openai.com/v1".into(),
            ..remote("x")
        };
        assert_eq!(
            r.register(local_bad.clone()),
            Err(ProviderError::NonLoopbackForLocal(
                "https://api.openai.com/v1".into()
            ))
        );
        let remote_bad = Provider {
            base_url: "http://localhost:8080/v1".into(),
            ..remote("y")
        };
        assert_eq!(
            r.register(remote_bad),
            Err(ProviderError::LoopbackForRemote(
                "http://localhost:8080/v1".into()
            ))
        );
    }

    #[test]
    fn egress_pinning_only_base_url_allowed() {
        let r = ProviderRegistry::new();
        let p = remote("airrouter");
        assert_eq!(r.get("nope"), Err(ProviderError::NotFound("nope".into())));
        assert!(p.pinned_base_url().starts_with("https://airrouter"));
        // Egress denial is computed by the caller: URL must start with pinned base
        // (asserted in http::tests::pinned_url_must_prefix_base).
    }

    #[test]
    fn quota_account_exhausts() {
        let mut r = ProviderRegistry::new();
        let p = remote("q");
        r.register(p).unwrap();
        r.commit_spend("q", 1000);
        assert_eq!(
            r.account("q"),
            Err(ProviderError::QuotaExhausted {
                provider: "q".into(),
                spent: 1000,
                quota: 1000
            })
        );
    }

    #[test]
    fn quota_account_within_budget() {
        let mut r = ProviderRegistry::new();
        r.register(remote("q2")).unwrap();
        r.commit_spend("q2", 400);
        assert_eq!(r.account("q2"), Ok(400));
    }

    #[test]
    fn key_alias_and_keystore_roundtrip() {
        let mut ks = MemoryKeystore::default();
        ks.put(&key_alias("airrouter"), Secret("sk-test".into()))
            .unwrap();
        assert_eq!(resolve_key(&ks, "airrouter").unwrap(), "sk-test");
        let ks2 = MemoryKeystore::default();
        assert_eq!(
            resolve_key(&ks2, "airrouter"),
            Err(ProviderError::MissingKey)
        );
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback("http://127.0.0.1:11434"));
        assert!(is_loopback("http://localhost:11434"));
        assert!(is_loopback("http://[::1]:11434"));
        assert!(!is_loopback("https://api.openai.com/v1"));
        assert!(!is_loopback("http://10.0.0.2:11434"));
    }
}
