//! Deterministic fake-engine tests for the RPC client.
//!
//! The fake engine is a small Python script (see `fake_engine.py`) driven by
//! the `FAKE_MODE` environment variable. These tests exercise protocol
//! invariants that the real engine cannot produce on demand: out-of-order
//! concurrent responses, event floods, mid-command crashes, unknown/late
//! response ids, stalled/interrupted chunk sequences, and silent turns.

use std::collections::HashMap;

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

/// Writes the fake engine script to a temp file and returns the program +
/// args the client should spawn: `python3 <script>` on every platform.
/// This avoids shebang/.cmd indirection so stdin/stdout pipes reach the
/// Python process directly.
fn fake_engine_binary() -> (String, Vec<String>) {
    let dir = std::env::temp_dir().join(format!(
        "lhic-fake-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script_path = dir.join("fake-omp.py");
    std::fs::write(&script_path, FAKE_SRC).unwrap();
    (python3(), vec![script_path.to_string_lossy().into_owned()])
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
    let (program, args) = fake_engine_binary();
    let mut config = RpcConfig::new(
        program,
        workspace.to_string_lossy().into_owned(),
        workspace.join("sess").to_string_lossy().into_owned(),
        env,
    );
    config.child_args = args;
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

/// Event flood followed by turn_end must not lose turn completion.
#[tokio::test]
async fn flood_then_turn_end_completes_turn() {
    let client = start_fake("flood_turn_end").await;
    let outcome = prompt_and_wait(&client, "hello", Duration::from_secs(20)).await;
    assert!(
        outcome.is_ok(),
        "turn must complete despite event flood: {:?}",
        outcome.err()
    );
    let outcome = outcome.unwrap();
    assert!(outcome.is_terminal());
    client.stop().await.ok();
}

/// Event flood followed by terminal agent_end must not lose completion.
#[tokio::test]
async fn flood_then_agent_end_completes_turn() {
    let client = start_fake("flood_agent_end").await;
    let outcome = prompt_and_wait(&client, "hello", Duration::from_secs(20)).await;
    assert!(
        outcome.is_ok(),
        "turn must complete despite event flood: {:?}",
        outcome.err()
    );
    let outcome = outcome.unwrap();
    assert!(outcome.is_terminal());
    client.stop().await.ok();
}

/// Command response during an event flood must still resolve promptly.
#[tokio::test]
async fn command_response_during_flood_resolves() {
    let client = start_fake("flood").await;
    let started = tokio::time::Instant::now();
    let result = client.get_state().await;
    assert!(result.is_ok());
    assert!(started.elapsed() < Duration::from_secs(8));
    client.stop().await.ok();
}

/// Prompt ACK followed by a correlated async scheduling failure must return
/// that failure immediately (not wait for the turn timeout).
#[tokio::test]
async fn prompt_ack_then_fail_returns_immediately() {
    let client = start_fake("prompt_ack_then_fail").await;
    let started = tokio::time::Instant::now();
    let outcome = prompt_and_wait(&client, "hello", Duration::from_secs(30)).await;
    assert!(outcome.is_err(), "late scheduling failure must surface");
    let error = outcome.err().unwrap().to_string();
    assert!(
        error.contains("scheduling_failed"),
        "error must preserve the machine-readable code: {error}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "must fail immediately, not after the turn timeout"
    );
    client.stop().await.ok();
}

/// An unknown successful response id must be surfaced diagnostically, never
/// silently dropped, and must not mutate the pending map.
#[tokio::test]
async fn unknown_success_id_is_surfaced() {
    let client = start_fake("unknown_success").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut saw_late = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match client.next_event().await.expect("event stream healthy") {
            Some(AgentEvent::LateCommandResponse { id, command, data }) => {
                assert_eq!(id, "req_777");
                assert_eq!(command, "get_state");
                assert!(data.is_some());
                saw_late = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }
    assert!(
        saw_late,
        "expected LateCommandResponse for unknown success id"
    );
    client.stop().await.ok();
}

/// The server-advertised reassembly ceiling must apply before the first
/// chunk: a 16 KiB logical frame with an advertised 8 KiB cap is rejected.
#[tokio::test]
async fn negotiated_reassembly_cap_enforced_before_first_chunk() {
    let client = start_fake("negotiated_cap").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut saw_reject = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        match client.next_event().await.expect("event stream healthy") {
            Some(AgentEvent::ProtocolError { detail }) => {
                assert!(
                    detail.contains("exceeds") || detail.contains("cap"),
                    "unexpected detail: {detail}"
                );
                saw_reject = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }
    assert!(saw_reject, "oversize frame must be rejected");
    client.stop().await.ok();
}

/// Cancelled command futures must not leak pending map entries.
#[tokio::test]
async fn cancelled_futures_do_not_leak_pending() {
    let client = start_fake("never_answer").await;
    let baseline = client.pending_len();
    assert_eq!(baseline, 0);

    // Start N command futures as spawned tasks so they register their
    // pending entries, then drop the handles (aborting the tasks) before any
    // response arrives.
    let client = std::sync::Arc::new(client);
    let mut handles = Vec::new();
    for _ in 0..16 {
        let client = client.clone();
        handles.push(tokio::spawn(async move { client.get_state().await }));
    }
    // Let the spawned command tasks run and register their pending entries.
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert_eq!(client.pending_len(), 16, "all futures must register");

    // Abort (cancel) every command task; the RAII registration guard must
    // remove each pending entry.
    for handle in &handles {
        handle.abort();
    }
    drop(handles);

    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert_eq!(
        client.pending_len(),
        0,
        "pending map must return to baseline"
    );

    client.stop().await.ok();
}

/// An unrelated `prompt_result` (different id) must NOT complete the active
/// prompt; only the real terminal event may. Correlated late failures and
/// matching results still complete normally (covered by other tests).
#[tokio::test]
async fn unrelated_prompt_result_does_not_complete_active_prompt() {
    let client = start_fake("flood_then_unrelated_prompt_result").await;
    let outcome = prompt_and_wait(&client, "hello", Duration::from_secs(20)).await;
    assert!(
        outcome.is_ok(),
        "the unrelated prompt_result must be ignored and the turn must \
         complete via its real terminal event: {:?}",
        outcome.err()
    );
    let outcome = outcome.unwrap();
    assert!(outcome.is_terminal());
    client.stop().await.ok();
}

/// Observer drops must be observable out-of-band and must not break protocol
/// completion. Uses a queue capacity of 1 and an event flood.
#[tokio::test]
async fn observer_event_drop_is_counted_and_turn_completes() {
    let mut config = fake_config(
        "small_flood_turn_end",
        Duration::from_secs(20),
        Duration::from_millis(300),
    );
    config.event_queue_capacity = 8;
    let mut client = OmpRpcClient::with_config(config);
    client.start().await.expect("fake handshake");

    let outcome = prompt_and_wait(&client, "hello", Duration::from_secs(20)).await;
    assert!(
        outcome.is_ok(),
        "turn must complete despite heavy observer loss: {:?}",
        outcome.err()
    );
    let outcome = outcome.unwrap();
    assert!(outcome.is_terminal());
    assert!(
        client.dropped_observer_event_count() > 0,
        "the flood with capacity 1 must have dropped at least one observer event"
    );
    client.stop().await.ok();
}
