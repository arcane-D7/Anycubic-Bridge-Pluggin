//! auth-service loopback process — S6-006.
//!
//! Separable, loopback-only service. Communicates over framed stdio JSON
//! (one JSON object per line, both directions) — no fixed ports, no network.
//! The editor core spawns this process; when it is absent or killed the
//! editor falls back to `Anonymous` fail-closed (empty results, never another
//! user).
//!
//! Ops (request):   {"op":"who"}
//!                  {"op":"scopes"}
//!                  {"op":"sync","scope":"<name>"}
//!                  {"op":"grant","user":"<id>","scope":"<name>"}
//!                  {"op":"record_sync","user":"<id>","scope":"<name>","revision":<u64>}
//! Reply (either):  {"ok":true,"data":...}
//!                  {"ok":false,"error":"..."}

use std::io::{self, BufRead, Write};

use auth_service::api::{Scope, SyncState};
use auth_service::db::AuthDb;
use auth_service::principal::Principal;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `--db <path>` overrides $AUTH_DB, which overrides "auth.db".
    let mut db_path = std::env::var("AUTH_DB").unwrap_or_else(|_| "auth.db".to_string());
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--db" {
            if let Some(p) = args.next() {
                db_path = p;
            }
        }
    }

    let mut db = AuthDb::open(&db_path)?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let req: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let value = serde_json::json!({ "ok": false, "error": format!("json: {e}") });
                send(&mut out, value)?;
                continue;
            }
        };
        let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let reply = handle(&mut db, op, &req);
        send(&mut out, reply)?;
    }
    Ok(())
}

fn handle(db: &mut AuthDb, op: &str, req: &serde_json::Value) -> serde_json::Value {
    match op {
        "who" => json_ok(match db.users() {
            Ok(users) => users,
            Err(e) => return json_err("who", &format!("{e}")),
        }),
        "scopes" => {
            let principal = principal_of(req);
            match db.scopes_for(&principal) {
                Ok(scopes) => json_ok(scopes.iter().map(|s| scope_name(*s)).collect::<Vec<_>>()),
                Err(e) => json_err("scopes", &format!("{e}")),
            }
        }
        "sync" => {
            let principal = principal_of(req);
            let scope = req.get("scope").and_then(|v| v.as_str()).unwrap_or("");
            let state = db
                .sync_state(&principal, scope)
                .unwrap_or(SyncState::Unavailable);
            serde_json::json!({ "ok": true, "state": sync_name(state) })
        }
        "grant" => {
            let user = req.get("user").and_then(|v| v.as_str()).unwrap_or("");
            let scope = req.get("scope").and_then(|v| v.as_str()).unwrap_or("");
            if user.is_empty() || scope.is_empty() {
                return json_err("grant", "user and scope required");
            }
            // The loopback must be self-sufficient: upsert the user (id as
            // display name placeholder) so FK constraints hold without a
            // separate register op.
            if let Err(e) = db.upsert_user(user, user) {
                return json_err("grant", &format!("{e}"));
            }
            match db.grant_scope(user, scope_from_name(scope)) {
                Ok(()) => serde_json::json!({ "ok": "granted", "user": user, "scope": scope }),
                Err(e) => json_err("grant", &format!("{e}")),
            }
        }
        "record_sync" => {
            let user = req.get("user").and_then(|v| v.as_str()).unwrap_or("");
            let scope = req.get("scope").and_then(|v| v.as_str()).unwrap_or("");
            let revision = req.get("revision").and_then(|v| v.as_u64()).unwrap_or(0);
            if user.is_empty() || scope.is_empty() {
                return json_err("record_sync", "user, scope and revision required");
            }
            if let Err(e) = db.upsert_user(user, user) {
                return json_err("record_sync", &format!("{e}"));
            }
            let principal = Principal::Local {
                user_id: user.to_string(),
            };
            match db.record_sync(&principal, scope, revision) {
                Ok(()) => {
                    serde_json::json!({ "ok": "recorded", "scope": scope, "revision": revision })
                }
                Err(e) => json_err("record_sync", &format!("{e}")),
            }
        }
        _ => json_err("unknown op", op),
    }
}

fn principal_of(req: &serde_json::Value) -> Principal {
    match req.get("user").and_then(|v| v.as_str()) {
        Some(u) if !u.is_empty() => Principal::Local {
            user_id: u.to_string(),
        },
        _ => Principal::Anonymous,
    }
}

fn json_ok(value: impl serde::Serialize) -> serde_json::Value {
    serde_json::json!({ "ok": true, "data": value })
}

fn json_err(op: &str, msg: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": format!("{op}: {msg}") })
}

fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::LocalProject => "local_project",
        Scope::CloudSynced => "cloud_synced",
    }
}

fn scope_from_name(name: &str) -> Scope {
    if name == "cloud_synced" {
        Scope::CloudSynced
    } else {
        Scope::LocalProject
    }
}

fn sync_name(state: SyncState) -> &'static str {
    match state {
        SyncState::Unavailable => "unavailable",
        SyncState::Empty => "empty",
        SyncState::Synced { .. } => "synced",
    }
}

fn send(out: &mut impl Write, value: serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    writeln!(out, "{}", value)?;
    out.flush()?;
    Ok(())
}
