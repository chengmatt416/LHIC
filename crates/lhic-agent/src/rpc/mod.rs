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
pub use host::{
    HostToolDefinition, HostToolRequest, HostToolResult, HostUriRequest, HostUriResult,
    HostUriSchemeDefinition,
};
pub use lifecycle::{prompt_and_wait, PromptOutcome};
pub use types::{
    AgentEvent, PromptResult, ReadyFrame, RpcChunk, RpcResponse, UiRequest, UiResponse,
    DEFAULT_MAX_REASSEMBLED_FRAME_BYTES, RPC_PROTOCOL_VERSION,
};

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

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
    pending: std::sync::Arc<std::sync::Mutex<HashMap<String, Result<Value, RpcError>>>>,
    config: RpcConfig,
    request_counter: u64,
    stderr_tail: String,
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
        Self {
            child: None,
            stdin: None,
            events: mpsc::channel(EVENT_QUEUE_CAPACITY).1,
            pending: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
            config,
            request_counter: 0,
            stderr_tail: String::new(),
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
        let stderr_tx = event_tx.clone();

        // Stdout reader: parses frames, reassembles v2 chunks, correlates
        // command responses and forwards normalized events.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let mut reassembler = ChunkReassembler::new(DEFAULT_MAX_REASSEMBLED_FRAME_BYTES);
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let value: Value = match serde_json::from_str(trimmed) {
                            Ok(value) => value,
                            Err(_) => {
                                if event_tx
                                    .send(AgentEvent::Unknown {
                                        raw: json!({
                                            "type": "parse_error",
                                            "line": trimmed
                                        }),
                                    })
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                                continue;
                            }
                        };
                        if value.get("type").and_then(Value::as_str) == Some("rpc_chunk") {
                            let chunk: RpcChunk = match serde_json::from_value(value) {
                                Ok(chunk) => chunk,
                                Err(e) => {
                                    if event_tx
                                        .send(AgentEvent::Unknown {
                                            raw: json!({
                                                "type": "rpc_error",
                                                "error": format!("bad chunk: {e}")
                                            }),
                                        })
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                    continue;
                                }
                            };
                            match reassembler.feed(&chunk) {
                                Ok(Some(bytes)) => match codec::decode_reassembled(bytes) {
                                    Ok(frame) => {
                                        if dispatch_frame(&frame, &pending, &event_tx)
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Err(e) => {
                                        if event_tx
                                            .send(AgentEvent::Unknown {
                                                raw: json!({
                                                    "type": "rpc_error",
                                                    "error": e.to_string()
                                                }),
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                },
                                Ok(None) => {}
                                Err(e) => {
                                    if event_tx
                                        .send(AgentEvent::Unknown {
                                            raw: json!({
                                                "type": "rpc_error",
                                                "error": e.to_string()
                                            }),
                                        })
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                        } else {
                            if dispatch_frame(&value, &pending, &event_tx).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            let _ = event_tx.send(AgentEvent::ChildClosed).await;
        });

        // Stderr collector: surfaced as Log events and kept as a tail for
        // diagnostics when the engine exits.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if stderr_tx
                            .send(AgentEvent::Log(line.trim_end().to_string()))
                            .await
                            .is_err()
                        {
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
        if !ready
            .supported_protocol_versions
            .contains(&RPC_PROTOCOL_VERSION)
        {
            return Err(anyhow::anyhow!(
                "omp engine does not support protocol v{RPC_PROTOCOL_VERSION} (supports: {:?}); \
                 expected omp >= {OMP_VERSION}",
                ready.supported_protocol_versions
            ));
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
            let event = self.next_event().await?;
            match event {
                Some(AgentEvent::Unknown { raw }) => {
                    if raw.get("type").and_then(Value::as_str) == Some("ready") {
                        let ready: ReadyFrame = serde_json::from_value::<ReadyFrame>(raw)
                            .map_err(|e| anyhow::anyhow!("malformed ready frame: {e}"))?;
                        return Ok(ready);
                    }
                }
                Some(AgentEvent::ChildClosed) => {
                    return Err(anyhow::anyhow!(
                        "omp closed before ready{}",
                        format_stderr_tail(&self.stderr_tail)
                    ));
                }
                Some(AgentEvent::Log(line)) => {
                    self.stderr_tail = line;
                    tracing::debug!("omp stderr: {}", self.stderr_tail);
                }
                Some(_) => {}
                None => {
                    return Err(anyhow::anyhow!(
                        "omp closed before ready{}",
                        format_stderr_tail(&self.stderr_tail)
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

        let deadline = tokio::time::Instant::now() + self.config.command_timeout;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                self.pending.lock().unwrap().remove(id);
                return Err(anyhow::anyhow!(
                    "omp command timed out after {}s",
                    self.config.command_timeout.as_secs()
                ));
            }
            let response = self.pending.lock().unwrap().remove(id);
            match response {
                Some(Ok(data)) => return Ok(data),
                Some(Err(e)) => return Err(anyhow::anyhow!("{e}")),
                None => {}
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Polls for the next normalized event. Returns `None` when the engine
    /// closed cleanly; protocol failures are returned as errors.
    pub async fn next_event(&mut self) -> Result<Option<AgentEvent>> {
        let result = self.events.recv().await;
        match result {
            Some(event) => Ok(Some(event)),
            None => Ok(None),
        }
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
        self.command("set_host_tools", json!({ "tools": tools }))
            .await
    }

    /// Registers host-owned URI schemes (`set_host_uri_schemes`).
    pub async fn set_host_uri_schemes(
        &mut self,
        schemes: &[HostUriSchemeDefinition],
    ) -> Result<Value> {
        self.command("set_host_uri_schemes", json!({ "schemes": schemes }))
            .await
    }

    /// Delivers a host-tool result for a pending `host_tool_call`.
    pub async fn respond_host_tool(
        &mut self,
        id: &str,
        result: Value,
        is_error: bool,
    ) -> Result<()> {
        let frame = json!({
            "type": "host_tool_result",
            "id": id,
            "isError": is_error,
            "result": result,
        });
        self.write_line(&frame.to_string()).await
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

    /// Delivers a host-URI result for a pending `host_uri_request`.
    pub async fn respond_host_uri(&mut self, id: &str, result: HostUriResult) -> Result<()> {
        let mut frame = serde_json::to_value(&result)?;
        if let Some(obj) = frame.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
        }
        self.write_line(&frame.to_string()).await
    }

    /// Sends a prompt and returns the immediate acknowledgement.
    pub async fn prompt(&mut self, message: &str) -> Result<Value> {
        self.command("prompt", json!({ "message": message })).await
    }

    pub async fn get_state(&mut self) -> Result<Value> {
        self.command("get_state", json!({})).await
    }

    pub async fn get_available_models(&mut self) -> Result<Value> {
        self.command("get_available_models", json!({})).await
    }

    pub async fn set_model(&mut self, provider: &str, model_id: &str) -> Result<Value> {
        self.command(
            "set_model",
            json!({ "provider": provider, "modelId": model_id }),
        )
        .await
    }

    pub async fn get_login_providers(&mut self) -> Result<Value> {
        self.command("get_login_providers", json!({})).await
    }

    pub async fn login(&mut self, provider_id: &str) -> Result<Value> {
        self.command("login", json!({ "providerId": provider_id }))
            .await
    }

    pub async fn get_available_commands(&mut self) -> Result<Value> {
        self.command("get_available_commands", json!({})).await
    }

    /// Aborts the current turn (`abort` command).
    pub async fn abort(&mut self) -> Result<Value> {
        self.command("abort", json!({})).await
    }

    /// Queues a steering message while the agent is running.
    pub async fn steer(&mut self, message: &str) -> Result<Value> {
        self.command("steer", json!({ "message": message })).await
    }

    /// Queues a follow-up message (post-turn).
    pub async fn follow_up(&mut self, message: &str) -> Result<Value> {
        self.command("follow_up", json!({ "message": message }))
            .await
    }

    async fn write_line(&mut self, line: &str) -> Result<()> {
        let stdin = self.stdin.as_mut().context("omp stdin is closed")?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }
}

impl Drop for OmpRpcClient {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}

fn format_stderr_tail(tail: &str) -> String {
    let tail = tail.trim();
    if tail.is_empty() {
        String::new()
    } else {
        format!(": {tail}")
    }
}

/// Routes one decoded JSON frame: command responses go to the pending map,
/// everything else becomes a normalized event. Returns `Err` when the event
/// channel closed (reader should stop).
async fn dispatch_frame(
    frame: &Value,
    pending: &std::sync::Mutex<HashMap<String, Result<Value, RpcError>>>,
    event_tx: &mpsc::Sender<AgentEvent>,
) -> Result<(), mpsc::error::SendError<AgentEvent>> {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    match frame_type {
        "response" => {
            let id = frame.get("id").and_then(Value::as_str).unwrap_or("");
            let command = frame.get("command").and_then(Value::as_str).unwrap_or("?");
            let success = frame
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
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
            if id.is_empty() {
                // Unknown-command/parse failures carry no id; surface as event.
                return event_tx
                    .send(AgentEvent::Unknown { raw: frame.clone() })
                    .await;
            }
            pending.lock().unwrap().insert(id.to_string(), result);
            Ok(())
        }
        "ready" => {
            event_tx
                .send(AgentEvent::Unknown { raw: frame.clone() })
                .await
        }
        "rpc_chunk" => unreachable!("chunks are reassembled before dispatch"),
        "extension_ui_request" => {
            if let Ok(ui) = serde_json::from_value::<UiRequest>(frame.clone()) {
                event_tx.send(AgentEvent::UiRequested(ui)).await
            } else {
                event_tx
                    .send(AgentEvent::Unknown { raw: frame.clone() })
                    .await
            }
        }
        "host_tool_call" | "host_tool_cancel" => {
            if let Ok(req) = serde_json::from_value::<HostToolRequest>(frame.clone()) {
                event_tx.send(AgentEvent::HostToolRequested(req)).await
            } else {
                event_tx
                    .send(AgentEvent::Unknown { raw: frame.clone() })
                    .await
            }
        }
        "host_uri_request" | "host_uri_cancel" => {
            if let Ok(req) = serde_json::from_value::<HostUriRequest>(frame.clone()) {
                event_tx.send(AgentEvent::HostUriRequested(req)).await
            } else {
                event_tx
                    .send(AgentEvent::Unknown { raw: frame.clone() })
                    .await
            }
        }
        "available_commands_update" => {
            event_tx
                .send(AgentEvent::CommandsUpdated { raw: frame.clone() })
                .await
        }
        "prompt_result" => {
            event_tx
                .send(AgentEvent::PromptResolved(PromptResult {
                    frame_type: "prompt_result".to_string(),
                    id: frame.get("id").and_then(Value::as_str).map(str::to_string),
                    agent_invoked: frame
                        .get("agentInvoked")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }))
                .await
        }
        "extension_error" => {
            event_tx
                .send(AgentEvent::ExtensionError { raw: frame.clone() })
                .await
        }
        "agent_start" => {
            event_tx
                .send(AgentEvent::AgentStarted { raw: frame.clone() })
                .await
        }
        "agent_end" => {
            let is_terminal = frame
                .get("isTerminal")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            event_tx
                .send(AgentEvent::AgentEnded {
                    is_terminal,
                    raw: frame.clone(),
                })
                .await
        }
        "turn_start" => {
            event_tx
                .send(AgentEvent::TurnStarted { raw: frame.clone() })
                .await
        }
        "turn_end" => {
            event_tx
                .send(AgentEvent::TurnEnded { raw: frame.clone() })
                .await
        }
        "message_start" => {
            event_tx
                .send(AgentEvent::MessageStarted { raw: frame.clone() })
                .await
        }
        "message_update" => {
            event_tx
                .send(AgentEvent::MessageUpdated { raw: frame.clone() })
                .await
        }
        "message_end" => {
            event_tx
                .send(AgentEvent::MessageEnded { raw: frame.clone() })
                .await
        }
        "tool_execution_start" => {
            event_tx
                .send(AgentEvent::ToolStarted { raw: frame.clone() })
                .await
        }
        "tool_execution_update" => {
            event_tx
                .send(AgentEvent::ToolUpdated { raw: frame.clone() })
                .await
        }
        "tool_execution_end" => {
            event_tx
                .send(AgentEvent::ToolEnded { raw: frame.clone() })
                .await
        }
        "auto_compaction_start" => {
            event_tx
                .send(AgentEvent::CompactionStarted { raw: frame.clone() })
                .await
        }
        "auto_compaction_end" => {
            event_tx
                .send(AgentEvent::CompactionEnded { raw: frame.clone() })
                .await
        }
        "auto_retry_start" => {
            event_tx
                .send(AgentEvent::RetryStarted { raw: frame.clone() })
                .await
        }
        "auto_retry_end" => {
            event_tx
                .send(AgentEvent::RetryEnded { raw: frame.clone() })
                .await
        }
        "model_changed" => {
            event_tx
                .send(AgentEvent::ModelChanged { raw: frame.clone() })
                .await
        }
        "subagent_lifecycle" | "subagent_progress" | "subagent_event" => {
            event_tx
                .send(AgentEvent::SubagentEvent { raw: frame.clone() })
                .await
        }
        _ => {
            // command_output / session_info_update / config_update / notice /
            // irc_message / todo_reminder / goal_updated / ttsr_triggered ...
            event_tx
                .send(AgentEvent::SideChannel { raw: frame.clone() })
                .await
        }
    }
}
