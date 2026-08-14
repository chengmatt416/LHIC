//! omp RPC v2 client: drives the bundled omp engine (`--mode rpc`) over
//! newline-delimited JSON on stdio with lossless chunked transport,
//! id-correlated responses, normalized events, and lifecycle-aware turn
//! completion.
//!
//! Wire contract: <https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md>

pub mod codec;
pub mod error;
pub mod host;
pub mod lifecycle;
pub mod types;

pub use codec::ChunkReassembler;
pub use error::RpcError;
pub use host::{HostToolDefinition, HostToolRequest, HostToolResult, HostUriRequest, HostUriResult, HostUriSchemeDefinition};
pub use lifecycle::{AgentTask, PromptOutcome};
pub use types::{
    AgentEvent, HostToolDefinition as _HostToolDefinition, PromptResult, ReadyFrame, RpcChunk,
    RpcResponse, UiRequest, UiResponse, RPC_PROTOCOL_VERSION,
};

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Notify};

/// The engine version this client is built and validated against.
pub const OMP_VERSION: &str = "17.2.15";

/// Default timeout for a single command response.
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// Default timeout for the engine to emit its `ready` frame.
pub const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Default timeout for an unfinished `rpc_chunk` sequence.
pub const DEFAULT_CHUNK_STALE_TIMEOUT: Duration = Duration::from_secs(30);

/// Bounded event queue capacity between the reader task and consumers.
const EVENT_QUEUE_CAPACITY: usize = 256;
/// Stderr tail kept for diagnostics when the engine exits.
const STDERR_TAIL_CAP: usize = 32 * 1024;

/// Client configuration.
#[derive(Debug, Clone)]
pub struct RpcConfig {
    /// Path to the omp executable.
    pub binary: String,
    /// Workspace directory (`--cwd`).
    pub workspace_root: String,
    /// Session directory (`--session-dir`).
    pub session_dir: String,
    /// Extra environment variables (provider keys).
    pub env: HashMap<String, String>,
    /// Extension roots (`--extension`, repeatable).
    pub extension_roots: Vec<String>,
    /// Command response timeout.
    pub command_timeout: Duration,
    /// Ready-frame timeout.
    pub ready_timeout: Duration,
    /// Stale chunk-sequence timeout.
    pub chunk_stale_timeout: Duration,
}

impl RpcConfig {
    pub fn new(
        binary: String,
        workspace_root: String,
        session_dir: String,
        env: HashMap<String, String>,
    ) -> Self {
        Self {
            binary,
            workspace_root,
            session_dir,
            env,
            extension_roots: Vec::new(),
            command_timeout: DEFAULT_COMMAND_TIMEOUT,
            ready_timeout: DEFAULT_READY_TIMEOUT,
            chunk_stale_timeout: DEFAULT_CHUNK_STALE_TIMEOUT,
        }
    }

    pub fn with_extension_root(mut self, root: &str) -> Self {
        self.extension_roots.push(root.to_string());
        self
    }
}

/// Streaming client for `omp --mode rpc`.
pub struct OmpRpcClient {
    child: Option<Child>,
    stdin: Option<tokio::process::ChildStdin>,
    events: mpsc::Receiver<AgentEvent>,
    /// Responses waiting on a command id; the reader task fills them in.
    pending: std::sync::Arc<std::sync::Mutex<HashMap<String, Option<Result<Value, RpcError>>>>>,
    wake: std::sync::Arc<Notify>,
    config: RpcConfig,
    request_counter: u64,
    stderr_tail: String,
    chunk_stale_timeout: Duration,
}

impl OmpRpcClient {
    pub fn new(
        binary: String,
        workspace_root: String,
        session_dir: String,
        env: HashMap<String, String>,
    ) -> Self {
        Self::with_config(RpcConfig::new(binary, workspace_root, session_dir, env))
    }

    pub fn with_config(config: RpcConfig) -> Self {
        let chunk_stale_timeout = config.chunk_stale_timeout;
        Self {
            child: None,
            stdin: None,
            events: mpsc::channel(EVENT_QUEUE_CAPACITY).1,
            pending: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
            wake: std::sync::Arc::new(Notify::new()),
            config,
            request_counter: 0,
            stderr_tail: String::new(),
            chunk_stale_timeout,
        }
    }

    pub fn with_extension_root(mut self, root: &str) -> Self {
        self.config.extension_roots.push(root.to_string());
        self
    }

    /// Spawns the engine, waits for the `ready` frame, negotiates protocol
    /// v2, and starts the reader/event tasks.
    pub async fn start(&mut self) -> Result<()> {
        let mut command = Command::new(&self.config.binary);
        command
            .args([
                "--mode",
                "rpc",
                "--cwd",
                &self.config.workspace_root,
                "--session-dir",
                &self.config.session_dir,
                "--no-pty",
                "--hide-thinking",
                "--approval-mode",
                "write",
            ])
            .envs(self.config.env.clone())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for root in &self.config.extension_roots {
            command.args(["--extension", root]);
        }
        let mut child = command.spawn().context("spawning omp")?;
        let stdin = child.stdin.take().context("omp stdin unavailable")?;
        let stdout = child.stdout.take().context("omp stdout unavailable")?;
        let stderr = child.stderr.take().context("omp stderr unavailable")?;

        let (event_tx, event_rx) = mpsc::channel(EVENT_QUEUE_CAPACITY);
        self.events = event_rx;
        let pending = self.pending.clone();
        let wake = self.wake.clone();

        // Stdout reader: parses frames, reassembles v2 chunks, correlates
        // command responses and forwards normalized events.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let mut reassembler = ChunkReassembler::new(super::types::DEFAULT_MAX_REASSEMBLED_FRAME_BYTES);
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(Value::Object(map)) if map.get("type").and_then(Value::as_str) == Some("rpc_chunk") => {
                                match serde_json::from_value::<super::types::RpcChunk>(Value::Object(map)) {
                                    Ok(chunk) => match reassembler.feed(&chunk) {
                                        Ok(Some(bytes)) => match super::codec::decode_reassembled(bytes) {
                                            Ok(frame) => {
                                                dispatch_frame(&frame, &pending, &wake, &event_tx).await;
                                            }
                                            Err(e) => {
                                                if event_tx.send(AgentEvent::Unknown { raw: json!({"type": "rpc_error", "error": e.to_string()}) }).await.is_err() {
                                                    break;
                                                }
                                            }
                                        },
                                        Ok(None) => {}
                                        Err(e) => {
                                            if event_tx.send(AgentEvent::Unknown { raw: json!({"type": "rpc_error", "error": e.to_string()}) }).await.is_err() {
                                                break;
                                            }
                                        }
                                    },
                                    Err(e) => {
                                        if event_tx.send(AgentEvent::Unknown { raw: json!({"type": "rpc_error", "error": format!("bad chunk: {e}")}) }).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            Ok(frame) => {
                                dispatch_frame(&frame, &pending, &wake, &event_tx).await;
                            }
                            Err(_) => {
                                if event_tx.send(AgentEvent::Unknown { raw: json!({"type": "parse_error", "line": trimmed}) }).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            let _ = event_tx.send(AgentEvent::ChildClosed).await;
        });

        // Stderr collector: surfaced as Log events and kept as a tail for
        // diagnostics when the engine exits.
        let tx = event_tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if tx.send(AgentEvent::Log(line.trim_end().to_string())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        self.child = Some(child);
        self.stdin = Some(stdin);

        // Wait for the ready frame (bounded).
        let ready = tokio::time::timeout(self.config.ready_timeout, self.wait_for_ready())
            .await
            .context("timed out waiting for omp ready")??;
        if !ready.supported_protocol_versions.contains(&RPC_PROTOCOL_VERSION) {
            return Err(anyhow::anyhow!(
                "omp engine does not support protocol v{RPC_PROTOCOL_VERSION} (supports: {:?}); \
                 expected omp >= {OMP_VERSION}",
                ready.supported_protocol_versions
            ));
        }
        if let Some(max) = ready.max_reassembled_frame_bytes {
            // Informational: the reassembler already enforces its own cap.
            let _ = max;
        }

        // Protocol negotiation (v2 enables lossless chunked transport).
        self.send_raw(
            "protocol-1",
            &json!({ "type": "negotiate_protocol", "protocolVersion": RPC_PROTOCOL_VERSION }),
        )
        .await?;
        Ok(())
    }

    async fn wait_for_ready(&mut self) -> Result<ReadyFrame> {
        loop {
            match self.next_event().await? {
                Some(AgentEvent::Unknown { raw }) => {
                    if raw.get("type").and_then(Value::as_str) == Some("ready") {
                        let ready: ReadyFrame = serde_json::from_value(raw)
                            .map_err(|e| anyhow::anyhow!("malformed ready frame: {e}"))?;
                        return Ok(ready);
                    }
                }
                Some(AgentEvent::ChildClosed) => {
                    let tail = self.stderr_tail.trim();
                    return Err(anyhow::anyhow!(
                        "omp closed before ready{}{}",
                        if tail.is_empty() { "" } else { ": " },
                        tail
                    ));
                }
                Some(AgentEvent::Log(line)) => {
                    self.stderr_tail = line;
                    tracing::debug!("omp stderr: {}", self.stderr_tail);
                }
                Some(_) => {}
                None => {
                    let tail = self.stderr_tail.trim();
                    return Err(anyhow::anyhow!(
                        "omp closed before ready{}{}",
                        if tail.is_empty() { "" } else { ": " },
                        tail
                    ));
                }
            }
        }
    }

    /// Sends a raw command and waits for the correlated response `data`.
    pub async fn command(&mut self, command_type: &str, params: Value) -> Result<Value> {
        let id = format!("req_{}", self.request_counter);
        self.request_counter += 1;
        let mut payload = params;
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("type".to_string(), json!(command_type));
        } else {
            payload = json!({ "type": command_type, "value": payload });
        }
        self.send_raw(&id, &payload).await
    }

    async fn send_raw(&mut self, id: &str, payload: &Value) -> Result<Value> {
        let mut request = payload.clone();
        if let Some(obj) = request.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
        }
        let stdin = self.stdin.as_mut().context("omp stdin is closed")?;
        let mut line = request.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;

        self.wait_for_response(id).await
    }

    async fn wait_for_response(&mut self, id: &str) -> Result<Value> {
        let deadline = tokio::time::Instant::now() + self.config.command_timeout;
        let pending = self.pending.clone();
        let wake = self.wake.clone();
        let pending_id = id.to_string();

        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                pending.lock().unwrap().remove(&pending_id);
                return Err(anyhow::anyhow!(
                    "omp command timed out after {}s",
                    self.config.command_timeout.as_secs()
                ));
            }
            let wait = deadline - now;
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = wake.notified() => {}
            }
            let response = pending.lock().unwrap().remove(&pending_id);
            match response {
                Some(Some(Ok(data))) => return Ok(data),
                Some(Some(Err(e))) => return Err(anyhow::anyhow!("{e}")),
                Some(None) => {
                    // Response frame arrived; a consumer will fill it. This
                    // should not happen (we own the map), so treat as error.
                    return Err(anyhow::anyhow!("omp command {id} response lost"));
                }
                None => {}
            }
        }
    }

    /// Polls for the next normalized event. Returns `None` when the engine
    /// closed cleanly; protocol failures are returned as errors.
    pub async fn next_event(&mut self) -> Result<Option<AgentEvent>> {
        self.events.recv().await.map(Some).or(Ok(None))
    }

    /// Stops the engine process. Safe to call multiple times.
    pub async fn stop(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.stdin = None;
        Ok(())
    }

    pub fn stderr_tail(&self) -> &str {
        &self.stderr_tail
    }

    /// Replies to an `extension_ui_request` dialog.
    pub async fn respond_ui(&mut self, response: UiResponse) -> Result<()> {
        let line = serde_json::to_string(&response)?;
        self.write_line(&line).await
    }

    /// Registers host-owned tools with the engine (`set_host_tools`).
    pub async fn set_host_tools(&mut self, tools: &[HostToolDefinition]) -> Result<Value> {
        self.command(
            "set_host_tools",
            json!({ "tools": tools }),
        )
        .await
    }

    /// Registers host-owned URI schemes (`set_host_uri_schemes`).
    pub async fn set_host_uri_schemes(&mut self, schemes: &[HostUriSchemeDefinition]) -> Result<Value> {
        self.command(
            "set_host_uri_schemes",
            json!({ "schemes": schemes }),
        )
        .await
    }

    /// Delivers a host-tool result for a pending `host_tool_call`.
    pub async fn respond_host_tool(&mut self, id: &str, result: Value, is_error: bool) -> Result<()> {
        let frame = json!({
            "type": "host_tool_result",
            "id": id,
            "isError": is_error,
            "result": result,
        });
        self.write_line(&frame.to_string()).await
    }

    /// Delivers a host-URI result for a pending `host_uri_request`.
    pub async fn respond_host_uri(&mut self, id: &str, result: HostUriResult) -> Result<()> {
        let frame = serde_json::to_value(&result)?;
        self.write_line(&frame.to_string()).await
    }

    async fn write_line(&mut self, line: &str) -> Result<()> {
        let stdin = self.stdin.as_mut().context("omp stdin is closed")?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Sends an inbound `host_tool_update` progress frame.
    pub async fn host_tool_update(&mut self, id: &str, partial: Value) -> Result<()> {
        let frame = json!({
            "type": "host_tool_update",
            "id": id,
            "partialResult": partial,
        });
        self.write_line(&frame.to_string()).await
    }
}

impl Drop for OmpRpcClient {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}

/// Routes one decoded JSON frame: command responses go to the pending map,
/// everything else becomes a normalized event.
async fn dispatch_frame(
    frame: &Value,
    pending: &std::sync::Mutex<HashMap<String, Option<Result<Value, RpcError>>>>,
    wake: &Notify,
    event_tx: &mpsc::Sender<AgentEvent>,
) {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    match frame_type {
        "response" => {
            let id = frame.get("id").and_then(Value::as_str).unwrap_or("");
            let command = frame.get("command").and_then(Value::as_str).unwrap_or("?");
            let success = frame.get("success").and_then(Value::as_bool).unwrap_or(false);
            let result = if success {
                Ok(frame.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(RpcError::CommandFailed {
                    command: command.to_string(),
                    error: frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string(),
                })
            };
            let mut guard = pending.lock().unwrap();
            if id.is_empty() {
                // Unknown-command/parse failures carry no id; surface as event.
                drop(guard);
                let _ = event_tx
                    .send(AgentEvent::Unknown { raw: frame.clone() })
                    .await;
                return;
            }
            guard.insert(id.to_string(), Some(result));
            drop(guard);
            wake.notify_waiters();
        }
        "ready" => {
            let _ = event_tx
                .send(AgentEvent::Unknown { raw: frame.clone() })
                .await;
        }
        "rpc_chunk" => unreachable!("chunks are reassembled before dispatch"),
        "extension_ui_request" => {
            if let Ok(ui) = serde_json::from_value::<UiRequest>(frame.clone()) {
                let _ = event_tx.send(AgentEvent::UiRequested(ui)).await;
            } else {
                let _ = event_tx.send(AgentEvent::Unknown { raw: frame.clone() }).await;
            }
        }
        "host_tool_call" | "host_tool_cancel" => {
            if let Ok(req) = serde_json::from_value::<HostToolRequest>(frame.clone()) {
                let _ = event_tx.send(AgentEvent::HostToolRequested(req)).await;
            } else {
                let _ = event_tx.send(AgentEvent::Unknown { raw: frame.clone() }).await;
            }
        }
        "host_uri_request" | "host_uri_cancel" => {
            if let Ok(req) = serde_json::from_value::<HostUriRequest>(frame.clone()) {
                let _ = event_tx.send(AgentEvent::HostUriRequested(req)).await;
            } else {
                let _ = event_tx.send(AgentEvent::Unknown { raw: frame.clone() }).await;
            }
        }
        "available_commands_update" => {
            let _ = event_tx.send(AgentEvent::CommandsUpdated { raw: frame.clone() }).await;
        }
        "prompt_result" => {
            let _ = event_tx
                .send(AgentEvent::PromptResolved(PromptResult {
                    frame_type: "prompt_result".to_string(),
                    id: frame.get("id").and_then(Value::as_str).map(str::to_string),
                    agent_invoked: frame
                        .get("agentInvoked")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }))
                .await;
        }
        "extension_error" => {
            let _ = event_tx.send(AgentEvent::ExtensionError { raw: frame.clone() }).await;
        }
        "agent_start" => {
            let _ = event_tx.send(AgentEvent::AgentStarted { raw: frame.clone() }).await;
        }
        "agent_end" => {
            let is_terminal = frame
                .get("isTerminal")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let _ = event_tx.send(AgentEvent::AgentEnded { is_terminal, raw: frame.clone() }).await;
        }
        "turn_start" => {
            let _ = event_tx.send(AgentEvent::TurnStarted { raw: frame.clone() }).await;
        }
        "turn_end" => {
            let _ = event_tx.send(AgentEvent::TurnEnded { raw: frame.clone() }).await;
        }
        "message_start" => {
            let _ = event_tx.send(AgentEvent::MessageStarted { raw: frame.clone() }).await;
        }
        "message_update" => {
            let _ = event_tx.send(AgentEvent::MessageUpdated { raw: frame.clone() }).await;
        }
        "message_end" => {
            let _ = event_tx.send(AgentEvent::MessageEnded { raw: frame.clone() }).await;
        }
        "tool_execution_start" => {
            let _ = event_tx.send(AgentEvent::ToolStarted { raw: frame.clone() }).await;
        }
        "tool_execution_update" => {
            let _ = event_tx.send(AgentEvent::ToolUpdated { raw: frame.clone() }).await;
        }
        "tool_execution_end" => {
            let _ = event_tx.send(AgentEvent::ToolEnded { raw: frame.clone() }).await;
        }
        "auto_compaction_start" => {
            let _ = event_tx.send(AgentEvent::CompactionStarted { raw: frame.clone() }).await;
        }
        "auto_compaction_end" => {
            let _ = event_tx.send(AgentEvent::CompactionEnded { raw: frame.clone() }).await;
        }
        "auto_retry_start" => {
            let _ = event_tx.send(AgentEvent::RetryStarted { raw: frame.clone() }).await;
        }
        "auto_retry_end" => {
            let _ = event_tx.send(AgentEvent::RetryEnded { raw: frame.clone() }).await;
        }
        "model_changed" => {
            let _ = event_tx.send(AgentEvent::ModelChanged { raw: frame.clone() }).await;
        }
        "subagent_lifecycle" | "subagent_progress" | "subagent_event" => {
            let _ = event_tx.send(AgentEvent::SubagentEvent { raw: frame.clone() }).await;
        }
        _ => {
            // command_output / session_info_update / config_update / notice /
            // irc_message / todo_reminder / goal_updated / ttsr_triggered ...
            let _ = event_tx
                .send(AgentEvent::SideChannel { raw: frame.clone() })
                .await;
        }
    }
}
