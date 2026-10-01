//! `broker-server` binary entry — loopback AI-egress server (S9.6-008).
//! Pure launcher; all logic lives in `lib.rs` so integration tests reuse it.

fn main() {
    broker_server::run_blocking();
}
