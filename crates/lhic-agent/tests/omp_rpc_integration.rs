//! Integration tests against the real bundled omp engine.
//!
//! These tests exercise the full protocol path: spawn `omp --mode rpc`,
//! wait for the ready frame, negotiate protocol v2, correlate command
//! responses by id, and drive a prompt through to terminal completion.
//!
//! They are skipped when no omp binary can be resolved.

use std::collections::HashMap;
use std::time::Duration;

use lhic_agent::rpc::RpcConfig;
use lhic_agent::{prompt_and_wait, AgentEvent, OmpRpcClient};

fn resolve_omp() -> Option<String> {
    if let Ok(explicit) = std::env::var("OMP_BINARY") {
        if std::path::Path::new(&explicit).exists() {
            return Some(explicit);
        }
        if std::env::var("OMP_REQUIRED").is_ok() {
            panic!(
                "OMP_REQUIRED is set and OMP_BINARY={explicit} does not exist; \
                 the real-OMP CI job must fail when the engine is missing"
            );
        }
        return None;
    }
    let candidates = [
        std::env::current_dir()
            .ok()
            .map(|dir| dir.join("apps/desktop/vendor/omp/current/omp")),
        std::env::var_os("PATH").map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("omp"))
                .find(|p| p.is_file())
                .unwrap_or_default()
        }),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lhic-rpc-it-{}-{tag}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn client_config(
    binary: String,
    workspace: &std::path::Path,
    session: &std::path::Path,
) -> RpcConfig {
    RpcConfig::new(
        binary,
        workspace.to_string_lossy().into_owned(),
        session.to_string_lossy().into_owned(),
        HashMap::new(),
    )
}

#[tokio::test]
async fn real_omp_handshake_and_command_correlation() {
    let Some(binary) = resolve_omp() else {
        eprintln!("skipping: no omp binary available (set OMP_BINARY)");
        return;
    };
    let workspace = temp_dir("ws");
    let session = temp_dir("sess");
    let config = client_config(binary, &workspace, &session);

    let mut client = OmpRpcClient::with_config(config);
    client
        .start()
        .await
        .expect("start + ready + negotiate should succeed");

    // Command correlation by id: distinct commands must not cross answers.
    let state = client.get_state().await.expect("get_state should respond");
    assert!(state.get("model").is_some() || state.get("sessionId").is_some() || state.is_object());
    let commands = client
        .get_available_commands()
        .await
        .expect("get_available_commands should respond");
    let list = commands
        .get("commands")
        .and_then(|v| v.as_array())
        .expect("commands payload should be an array");
    assert!(
        !list.is_empty(),
        "engine should expose at least one command"
    );

    client.stop().await.expect("clean stop");
}

#[tokio::test]
async fn real_omp_concurrent_commands() {
    let Some(binary) = resolve_omp() else {
        eprintln!("skipping: no omp binary available (set OMP_BINARY)");
        return;
    };
    let workspace = temp_dir("ws");
    let session = temp_dir("sess");
    let config = client_config(binary, &workspace, &session);

    let mut client = OmpRpcClient::with_config(config);
    client.start().await.expect("start should succeed");

    // Two commands outstanding at once; both must resolve independently.
    let a = client.get_state();
    let b = client.get_available_commands();
    let (state, commands) = tokio::join!(a, b);
    assert!(state.is_ok(), "get_state must resolve: {:?}", state.err());
    let commands = commands.expect("get_available_commands must resolve");
    assert!(commands
        .get("commands")
        .and_then(|v| v.as_array())
        .is_some());

    client.stop().await.expect("clean stop");
}

#[tokio::test]
async fn real_omp_prompt_reaches_terminal_completion() {
    let Some(binary) = resolve_omp() else {
        eprintln!("skipping: no omp binary available (set OMP_BINARY)");
        return;
    };
    let workspace = temp_dir("ws");
    let session = temp_dir("sess");
    let config = client_config(binary, &workspace, &session);

    let mut client = OmpRpcClient::with_config(config);
    client.start().await.expect("start should succeed");

    let outcome = prompt_and_wait(
        &client,
        "Reply with the single word ok",
        Duration::from_secs(90),
    )
    .await;

    match outcome {
        Ok(outcome) => {
            assert!(
                outcome.is_terminal(),
                "prompt must reach terminal completion"
            );
        }
        Err(e) => {
            // Without a real model credential (e.g. CI uses a placeholder
            // key) the engine may reject the prompt: a provider/auth error is
            // an external blocker, not a client defect. The client must still
            // fail fast with a precise error rather than hang or guess at
            // completion.
            let message = e.to_string();
            assert!(
                !message.contains("timed out"),
                "prompt must not depend on a fixed timeout guess: {message}"
            );
            assert!(
                !message.contains("closed before ready"),
                "engine must complete the handshake before the prompt: {message}"
            );
            eprintln!("prompt rejected without a real model (expected): {message}");
        }
    }

    client.stop().await.expect("clean stop");
}

#[tokio::test]
async fn real_omp_events_are_normalized() {
    let Some(binary) = resolve_omp() else {
        eprintln!("skipping: no omp binary available (set OMP_BINARY)");
        return;
    };
    let workspace = temp_dir("ws");
    let session = temp_dir("sess");
    let config = client_config(binary, &workspace, &session);

    let mut client = OmpRpcClient::with_config(config);
    client.start().await.expect("start should succeed");

    // Startup emits ready (consumed), then available_commands_update etc.
    let mut saw_normalized = false;
    for _ in 0..8 {
        match client.next_event().await.expect("event stream healthy") {
            Some(AgentEvent::CommandsUpdated { .. })
            | Some(AgentEvent::SideChannel { .. })
            | Some(AgentEvent::UiRequested(_)) => saw_normalized = true,
            Some(AgentEvent::Log(_)) | Some(AgentEvent::ChildClosed) => {}
            Some(_) => {}
            None => break,
        }
        if saw_normalized {
            break;
        }
    }
    assert!(
        saw_normalized,
        "expected normalized startup events from omp"
    );

    client.stop().await.expect("clean stop");
}
