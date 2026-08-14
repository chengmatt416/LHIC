//! Deterministic fake-engine tests for the RPC client.
//!
//! The fake engine is a small Python script (see `fake_engine.py`) driven by
//! the `FAKE_MODE` environment variable. These tests exercise protocol
//! invariants that the real engine cannot produce on demand: out-of-order
//! concurrent responses, event floods, mid-command crashes, unknown/late
//! response ids, stalled/interrupted chunk sequences, and silent turns.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use lhic_agent::rpc::RpcConfig;
use lhic_agent::{prompt_and_wait, AgentEvent, OmpRpcClient};

const FAKE_SRC: &str = include_str!("fake_engine.py");

fn python3() -> String {
    std::env::var("PYTHON3").unwrap_or_else(|_| {
        // Absolute interpreter path: exec of a shebang script requires the
        // interpreter itself to be an absolute path (POSIX shebang rule).
        std::process::Command::new("python3")
            .arg("-c")
            .arg("import sys; print(sys.executable)")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "python3".to_string())
    })
}

/// Writes the fake engine to a temp file with a python3 shebang and makes it
/// executable.
fn fake_engine_binary() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lhic-fake-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("fake-omp");
    let script = format!("#!{}\n{}", python3(), FAKE_SRC);
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn fake_config(mode: &str, command_timeout: Duration, chunk_stale: Duration) -> RpcConfig {
    let workspace = std::env::temp_dir().join(format!(
        "lhic-fake-ws-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&workspace).unwrap();
    let mut env = HashMap::new();
    env.insert("FAKE_MODE".to_string(), mode.to_string());
    let mut config = RpcConfig::new(
        fake_engine_binary().to_string_lossy().into_owned(),
        workspace.to_string_lossy().into_owned(),
        workspace.join("sess").to_string_lossy().into_owned(),
        env,
    );
    config.command_timeout = command_timeout;
    config.chunk_stale_timeout = chunk_stale;
    config
}

async fn start_fake(mode: &str) -> OmpRpcClient {
    let config = fake_config(mode, Duration::from_secs(10), Duration::from_millis(300));
    let mut client = OmpRpcClient::with_config(config);
    client
        .start()
        .await
        .expect("fake engine handshake should succeed");
    client
}

/// Two commands outstanding simultaneously, answered in reverse order: both
/// futures must resolve with their own responses (no cross-consumption).
#[tokio::test]
async fn concurrent_commands_resolve_out_of_order() {
    let client = start_fake("reverse2").await;

    let first = client.command("cmd_a", serde_json::json!({}));
    let second = client.command("cmd_b", serde_json::json!({}));
    let (a, b) = tokio::join!(first, second);

    let a = a.expect("req_a must resolve");
    let b = b.expect("req_b must resolve");
    // Response data carries no distinguishing payload here; the important
    // assertion is that BOTH resolve (reversed replies, no hang, no
    // cross-consumption of the pending entries).
    assert!(a.is_null() || a.is_object());
    assert!(b.is_null() || b.is_object());

    client.stop().await.ok();
}

/// A flood of >256 events before the response must not stall the command.
#[tokio::test]
async fn event_flood_does_not_stall_command() {
    let client = start_fake("flood").await;
    let started = tokio::time::Instant::now();
    let result = client.get_state().await;
    assert!(result.is_ok(), "response must resolve despite event flood");
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "command must not be blocked by the event queue"
    );
    client.stop().await.ok();
}

/// Child exit while a command is pending must fail the waiter immediately.
#[tokio::test]
async fn child_close_fails_pending_command_immediately() {
    let client = start_fake("close").await;
    let started = tokio::time::Instant::now();
    let result = client.get_state().await;
    assert!(result.is_err(), "pending command must fail on child close");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "failure must be immediate, not a full command timeout"
    );
    let _ = client.stop().await;
}

/// A response for an unregistered id is routed to a diagnostic event and
/// never leaks into the pending map.
#[tokio::test]
async fn unknown_response_id_becomes_diagnostic_event() {
    let client = start_fake("unknown_id").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut saw_late = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match client.next_event().await.expect("event stream healthy") {
            Some(AgentEvent::LateCommandFailure { id, .. }) => {
                assert_eq!(id, "req_999");
                saw_late = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }
    assert!(
        saw_late,
        "expected LateCommandFailure for unknown response id"
    );
    client.stop().await.ok();
}

/// A chunk sequence that stalls must fail safely via the live reader timer.
#[tokio::test]
async fn stalled_chunk_sequence_fails_safely() {
    let client = start_fake("stale_chunk").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut saw_protocol_error = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match client.next_event().await.expect("event stream healthy") {
            Some(AgentEvent::ProtocolError { detail }) => {
                assert!(
                    detail.contains("stalled") || detail.contains("stale"),
                    "unexpected detail: {detail}"
                );
                saw_protocol_error = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }
    assert!(
        saw_protocol_error,
        "stale chunk sequence must surface an error"
    );
    client.stop().await.ok();
}

/// An ordinary frame interrupting a chunk sequence rejects the sequence.
#[tokio::test]
async fn interrupted_chunk_sequence_is_rejected() {
    let client = start_fake("interrupted").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut saw_interrupt = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match client.next_event().await.expect("event stream healthy") {
            Some(AgentEvent::ProtocolError { detail }) => {
                assert!(
                    detail.contains("interrupted"),
                    "unexpected detail: {detail}"
                );
                saw_interrupt = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }
    assert!(
        saw_interrupt,
        "interrupted chunk sequence must surface an error"
    );
    client.stop().await.ok();
}

/// A silent engine (ack + no events) must hit the configured turn deadline.
#[tokio::test]
async fn turn_timeout_is_enforced_on_silent_engine() {
    let mut config = fake_config(
        "prompt_hang",
        Duration::from_secs(10),
        Duration::from_millis(300),
    );
    config.command_timeout = Duration::from_secs(5);
    let mut client = OmpRpcClient::with_config(config);
    client.start().await.expect("fake handshake");

    let started = tokio::time::Instant::now();
    let outcome = prompt_and_wait(&client, "hello", Duration::from_millis(300)).await;
    assert!(
        outcome.is_err(),
        "silent engine must produce a turn timeout error"
    );
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(250) && elapsed < Duration::from_secs(4),
        "timeout must fire around the configured deadline, got {elapsed:?}"
    );
    client.stop().await.ok();
}
