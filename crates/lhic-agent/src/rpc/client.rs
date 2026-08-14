//! omp RPC v2 client: drives the bundled omp engine (`--mode rpc`) over
//! newline-delimited JSON on stdio with lossless chunked transport,
//! id-correlated responses, normalized events, and lifecycle-aware turn
//! completion.
//!
//! Architecture:
//! - command requests are registered in a shared pending map **before** the
//!   write; each waiter is a oneshot channel, so multiple commands can be
//!   outstanding and responses may arrive out of order;
//! - a single reader task owns stdout parsing and chunk reassembly; it
//!   completes exactly the registered waiter for a response id and never
//!   blocks on the (bounded) event queue, so event floods cannot stall
//!   command responses;
//! - unknown/late response ids are routed to a diagnostic event instead of
//!   leaking into the pending map.
//!
//! Wire contract: <https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md>

use parking_lot::Mutex;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use super::codec::{decode_reassembled, ChunkReassembler};
use super::coordinator::TurnCoordinator;
use super::error::RpcError;
use super::types::*;

/// A registered command waiter keyed by request id.
pub(crate) type PendingMap =
    parking_lot::Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcError>>>>;

/// RAII registration of a pending request: removing the entry on drop makes
/// command-future cancellation leak-free. A completed response disarms the
/// guard by removing the entry first.
struct PendingRegistration<'a> {
    pending: &'a Arc<PendingMap>,
    id: String,
    armed: bool,
}

impl<'a> PendingRegistration<'a> {
    fn insert(
        pending: &'a Arc<PendingMap>,
        id: &str,
        tx: oneshot::Sender<Result<Value, RpcError>>,
    ) -> Result<Self, RpcError> {
        let mut guard = pending.lock();
        if guard.contains_key(id) {
            return Err(RpcError::Malformed {
                detail: format!("duplicate request id {id}"),
            });
        }
        guard.insert(id.to_string(), tx);
        Ok(Self {
            pending,
            id: id.to_string(),
            armed: true,
        })
    }

    /// Disarms before delivering a response (the reader already removed it).
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingRegistration<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.pending.lock().remove(&self.id);
        }
    }
}

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
///
/// All command methods take `&self` and are safe to drive concurrently with
/// event consumption; the command and event paths are decoupled.
pub struct OmpRpcClient {
    /// Child process handle (shared so `stop` works with `&self`).
    child: Option<Arc<tokio::sync::Mutex<Option<Child>>>>,
    /// Serialized writes to the engine's stdin (None until start()).
    writer: Option<AsyncMutex<tokio::process::ChildStdin>>,
    /// Event stream. Shared so `next_event` and `command` can operate
    /// concurrently (both take `&self`). Tokio mutex: the guard is Send
    /// across awaits so clients can be driven from spawned tasks.
    events: Arc<tokio::sync::Mutex<mpsc::Receiver<AgentEvent>>>,
    /// Registered request id -> waiter. Inserted before the request is
    /// written; removed by the waiter on completion/timeout/cancellation.
    pending: Arc<PendingMap>,
    /// Request id counter (atomic: concurrent commands).
    next_id: Arc<AtomicU64>,
    /// Effective v2 reassembly cap: `min(local_cap, server_advertised)`.
    reassembly_cap: Arc<parking_lot::Mutex<usize>>,
    /// Shared bounded stderr tail maintained by the collector task.
    stderr_tail: Arc<parking_lot::Mutex<String>>,
    /// Non-lossy turn-coordination state (terminal events never dropped).
    turn_coordinator: TurnCoordinator,
    config: RpcConfig,
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
            writer: None,
            events: Arc::new(tokio::sync::Mutex::new(
                mpsc::channel(EVENT_QUEUE_CAPACITY).1,
            )),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(0)),
            reassembly_cap: Arc::new(Mutex::new(LOCAL_MAX_REASSEMBLED_FRAME_BYTES)),
            stderr_tail: Arc::new(Mutex::new(String::new())),
            turn_coordinator: TurnCoordinator::new(),
            config,
        }
    }

    pub fn with_extension_root(mut self, root: &str) -> Self {
        self.config.extension_roots.push(root.to_string());
        self
    }

    /// Spawns the engine, waits for the `ready` frame, negotiates protocol
    /// v2, and starts the reader/event tasks.
    pub async fn start(&mut self) -> Result<()> {
        if self.child.is_some() {
            return Err(anyhow::anyhow!("omp RPC client is already started"));
        }
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
        self.events = Arc::new(tokio::sync::Mutex::new(event_rx));
        let pending = self.pending.clone();
        let reassembly_cap = self.reassembly_cap.clone();
        let stderr_tail = self.stderr_tail.clone();
        let turn_coordinator = self.turn_coordinator.clone();
        let chunk_stale_timeout = self.config.chunk_stale_timeout;

        // Stderr collector: maintains a shared bounded tail independently of
        // the event stream and surfaces log events best-effort.
        {
            let event_tx = event_tx.clone();
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim_end().to_string();
                            push_tail(&tail, &trimmed, STDERR_TAIL_CAP);
                            let _ = event_tx.try_send(AgentEvent::Log(trimmed));
                        }
                    }
                }
            });
        }

        // Stdout reader: parses frames, reassembles v2 chunks, completes
        // registered waiters, and forwards normalized events without ever
        // blocking on the event queue.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let mut reassembler = ChunkReassembler::new(*reassembly_cap.lock());
            let mut stale_tick = tokio::time::interval(Duration::from_secs(1));
            stale_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                line.clear();
                tokio::select! {
                    read = reader.read_line(&mut line) => {

                        match read {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                let trimmed = line.trim();
                                if trimmed.is_empty() {
                                    continue;
                                }
                                if let Err(e) = handle_line(
                                    trimmed,
                                    &mut reassembler,
                                    &pending,
                                    &turn_coordinator,
                                    &reassembly_cap,
                                    &event_tx,
                                ).await {
                                    turn_coordinator.mark_protocol_error(&e.to_string());
                                    let _ = event_tx.try_send(AgentEvent::ProtocolError {
                                        detail: e.to_string(),
                                    });
                                }
                            }
                        }
                    }
                    _ = stale_tick.tick(), if reassembler.is_active() => {
                        let cap = *reassembly_cap.lock();
                        reassembler.set_max_frame_bytes(cap);
                        if let Err(e) = reassembler.check_stale(chunk_stale_timeout) {
                            turn_coordinator.mark_protocol_error(&e.to_string());
                            let _ = event_tx.try_send(AgentEvent::ProtocolError {
                                detail: e.to_string(),
                            });
                        }
                    }
                }
            }
            // EOF / process exit: fail every pending waiter immediately and
            // mark the turn coordinator (non-lossy terminal state).
            turn_coordinator.mark_child_closed();
            let mut guard = pending.lock();
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err(RpcError::ConnectionClosed));
            }
            drop(guard);
            let _ = event_tx.try_send(AgentEvent::ChildClosed);
        });

        self.child = Some(Arc::new(tokio::sync::Mutex::new(Some(child))));
        self.writer = Some(AsyncMutex::new(stdin));

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
                 Rust LHIC requires OMP RPC v2 (expected omp >= {OMP_VERSION})",
                ready.supported_protocol_versions
            ));
        }

        // Effective v2 logical-frame cap = min(local, server advertised),
        // applied before protocol negotiation so the reader rejects any
        // oversize chunk sequence from its very first chunk.
        if let Some(advertised) = ready.max_reassembled_frame_bytes {
            let mut cap = self.reassembly_cap.lock();
            *cap = (*cap).min(advertised);
        }

        // Protocol negotiation (v2 enables lossless chunked transport).
        self.command_raw(
            "protocol-1",
            json!({ "type": "negotiate_protocol", "protocolVersion": RPC_PROTOCOL_VERSION }),
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(())
    }

    async fn wait_for_ready(&mut self) -> Result<ReadyFrame> {
        loop {
            match self.next_event().await? {
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
                        format_stderr_tail(&self.stderr_tail())
                    ));
                }
                Some(AgentEvent::Log(line)) => {
                    tracing::debug!("omp stderr: {line}");
                }
                Some(_) => {}
                None => {
                    return Err(anyhow::anyhow!(
                        "omp closed before ready{}",
                        format_stderr_tail(&self.stderr_tail())
                    ));
                }
            }
        }
    }

    /// Sends a command and waits for the correlated response `data`.
    ///
    /// Safe to call concurrently: each call registers its own waiter before
    /// writing, so responses may arrive in any order.
    pub async fn command(&self, command_type: &str, params: Value) -> Result<Value, RpcError> {
        let id = format!("req_{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let mut payload = params;
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("type".to_string(), json!(command_type));
        } else {
            payload = json!({ "type": command_type, "value": payload });
        }
        self.command_raw(&id, payload).await
    }

    async fn command_raw(&self, id: &str, payload: Value) -> Result<Value, RpcError> {
        let (tx, rx) = oneshot::channel();
        let mut registration = PendingRegistration::insert(&self.pending, id, tx)?;

        let mut request = payload;
        if let Some(obj) = request.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
        }
        let mut line = request.to_string();
        line.push('\n');

        let write_result = async {
            let mut stdin = self.writer_guard().await?;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|_| RpcError::ConnectionClosed)?;
            stdin.flush().await.map_err(|_| RpcError::ConnectionClosed)
        }
        .await;
        if let Err(e) = write_result {
            // Registration guard removes the entry on drop.
            drop(registration);
            return Err(e);
        }

        let seconds = self.config.command_timeout.as_secs();
        let result = tokio::time::timeout(self.config.command_timeout, rx).await;
        match result {
            Ok(Ok(result)) => {
                registration.disarm();
                result
            }
            Ok(Err(_)) => {
                // Waiter dropped without a value (e.g. child closed): the
                // reader completed it with ConnectionClosed.
                registration.disarm();
                Err(RpcError::ConnectionClosed)
            }
            Err(_) => {
                // Timeout: the guard removes the entry on drop.
                drop(registration);
                Err(RpcError::Timeout {
                    command: request
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("?")
                        .to_string(),
                    seconds,
                })
            }
        }
    }

    /// Number of registered pending requests (introspection for tests).
    pub fn pending_len(&self) -> usize {
        self.pending.lock().len()
    }

    /// Registered pending request ids (introspection for tests).
    pub fn pending_entries(&self) -> Vec<String> {
        self.pending.lock().keys().cloned().collect()
    }

    /// Polls for the next normalized event. Returns `None` when the engine
    /// closed cleanly; protocol failures are returned as errors.
    ///
    /// Takes `&self` so it can be driven concurrently with commands.
    pub async fn next_event(&self) -> Result<Option<AgentEvent>> {
        let mut receiver = self.events.lock().await;
        match receiver.recv().await {
            Some(event) => Ok(Some(event)),
            None => Ok(None),
        }
    }

    /// Stops the engine process and fails any pending requests. Safe to call
    /// multiple times.
    pub async fn stop(&self) -> Result<()> {
        if let Some(handle) = &self.child {
            let mut guard = handle.lock().await;
            if let Some(mut child) = guard.take() {
                drop(guard);
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        self.fail_all_pending();
        Ok(())
    }

    fn fail_all_pending(&self) {
        let mut guard = self.pending.lock();
        for (_, tx) in guard.drain() {
            let _ = tx.send(Err(RpcError::ConnectionClosed));
        }
    }

    pub fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().clone()
    }

    /// Non-lossy turn-coordination state shared with the reader.
    pub fn turn_coordinator(&self) -> TurnCoordinator {
        self.turn_coordinator.clone()
    }

    /// Replies to an `extension_ui_request` dialog.
    pub async fn respond_ui(&self, response: UiResponse) -> Result<(), RpcError> {
        let line = serde_json::to_string(&response).map_err(|e| RpcError::Malformed {
            detail: format!("ui response serialization: {e}"),
        })?;
        self.write_line(&line).await
    }

    /// Registers host-owned tools with the engine (`set_host_tools`).
    pub async fn set_host_tools(&self, tools: &[HostToolDefinition]) -> Result<Value, RpcError> {
        self.command("set_host_tools", json!({ "tools": tools }))
            .await
    }

    /// Registers host-owned URI schemes (`set_host_uri_schemes`).
    pub async fn set_host_uri_schemes(
        &self,
        schemes: &[HostUriSchemeDefinition],
    ) -> Result<Value, RpcError> {
        self.command("set_host_uri_schemes", json!({ "schemes": schemes }))
            .await
    }

    /// Delivers a host-tool result for a pending `host_tool_call`.
    pub async fn respond_host_tool(
        &self,
        id: &str,
        result: Value,
        is_error: bool,
    ) -> Result<(), RpcError> {
        let frame = json!({
            "type": "host_tool_result",
            "id": id,
            "isError": is_error,
            "result": result,
        });
        self.write_line(&frame.to_string()).await
    }

    /// Sends an inbound `host_tool_update` progress frame.
    pub async fn host_tool_update(&self, id: &str, partial: Value) -> Result<(), RpcError> {
        let frame = json!({
            "type": "host_tool_update",
            "id": id,
            "partialResult": partial,
        });
        self.write_line(&frame.to_string()).await
    }

    /// Delivers a host-URI result for a pending `host_uri_request`.
    pub async fn respond_host_uri(&self, id: &str, result: HostUriResult) -> Result<(), RpcError> {
        let mut frame = serde_json::to_value(&result).map_err(|e| RpcError::Malformed {
            detail: format!("host uri result serialization: {e}"),
        })?;
        if let Some(obj) = frame.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
        }
        self.write_line(&frame.to_string()).await
    }

    /// Sends a prompt and returns the immediate acknowledgement.
    pub async fn prompt(&self, message: &str) -> Result<Value, RpcError> {
        self.command("prompt", json!({ "message": message })).await
    }

    /// Sends a prompt tracked by the turn coordinator so a correlated late
    /// scheduling failure or terminal lifecycle event completes the turn
    /// immediately. Returns the ack and the request id.
    pub(crate) async fn prompt_tracked(&self, message: &str) -> Result<(Value, String), RpcError> {
        let id = format!("req_{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        self.turn_coordinator.register(&id);
        let mut payload = json!({ "message": message, "type": "prompt" });
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
        }
        let ack = self.command_raw(&id, payload).await?;
        Ok((ack, id))
    }

    pub async fn get_state(&self) -> Result<Value, RpcError> {
        self.command("get_state", json!({})).await
    }

    pub async fn get_available_models(&self) -> Result<Value, RpcError> {
        self.command("get_available_models", json!({})).await
    }

    pub async fn set_model(&self, provider: &str, model_id: &str) -> Result<Value, RpcError> {
        self.command(
            "set_model",
            json!({ "provider": provider, "modelId": model_id }),
        )
        .await
    }

    pub async fn get_login_providers(&self) -> Result<Value, RpcError> {
        self.command("get_login_providers", json!({})).await
    }

    pub async fn login(&self, provider_id: &str) -> Result<Value, RpcError> {
        self.command("login", json!({ "providerId": provider_id }))
            .await
    }

    pub async fn get_available_commands(&self) -> Result<Value, RpcError> {
        self.command("get_available_commands", json!({})).await
    }

    /// Aborts the current turn (`abort` command).
    pub async fn abort(&self) -> Result<Value, RpcError> {
        self.command("abort", json!({})).await
    }

    /// Queues a steering message while the agent is running.
    pub async fn steer(&self, message: &str) -> Result<Value, RpcError> {
        self.command("steer", json!({ "message": message })).await
    }

    /// Queues a follow-up message (post-turn).
    pub async fn follow_up(&self, message: &str) -> Result<Value, RpcError> {
        self.command("follow_up", json!({ "message": message }))
            .await
    }

    async fn write_line(&self, line: &str) -> Result<(), RpcError> {
        let mut stdin = self.writer_guard().await?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|_| RpcError::ConnectionClosed)?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|_| RpcError::ConnectionClosed)?;
        stdin.flush().await.map_err(|_| RpcError::ConnectionClosed)
    }

    /// Returns the stdin guard, or an error when the client is not started.
    async fn writer_guard(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, tokio::process::ChildStdin>, RpcError> {
        match &self.writer {
            Some(mutex) => Ok(mutex.lock().await),
            None => Err(RpcError::ConnectionClosed),
        }
    }
}

impl Drop for OmpRpcClient {
    fn drop(&mut self) {
        // Best-effort synchronous kill: tokio's Child::start_kill is not
        // async and works without a runtime.
        if let Some(handle) = &self.child {
            if let Ok(mut guard) = handle.try_lock() {
                if let Some(mut child) = guard.take() {
                    let _ = child.start_kill();
                }
            }
        }
    }
}

fn push_tail(tail: &Mutex<String>, line: &str, cap: usize) {
    let mut guard = tail.lock();
    if guard.len() + line.len() + 1 > cap {
        let drop = guard.len() + line.len() + 1 - cap;
        let cut = guard
            .char_indices()
            .nth(drop)
            .map(|(i, _)| i)
            .unwrap_or(guard.len());
        guard.drain(..cut);
    }
    guard.push_str(line);
    guard.push('\n');
}

fn format_stderr_tail(tail: &str) -> String {
    let tail = tail.trim();
    if tail.is_empty() {
        String::new()
    } else {
        format!(": {tail}")
    }
}

/// Handles one physical stdout line: plain JSON frame or `rpc_chunk`.
/// Rejects ordinary frames that interrupt an active chunk sequence.
async fn handle_line(
    line: &str,
    reassembler: &mut ChunkReassembler,
    pending: &Arc<PendingMap>,
    coordinator: &TurnCoordinator,
    reassembly_cap: &Arc<parking_lot::Mutex<usize>>,
    event_tx: &mpsc::Sender<AgentEvent>,
) -> Result<(), RpcError> {
    let value: Value = serde_json::from_str(line).map_err(|_| RpcError::Parse {
        line: line.to_string(),
    })?;
    let frame_type = value.get("type").and_then(Value::as_str).unwrap_or("");

    if frame_type == "rpc_chunk" {
        let chunk: RpcChunk = serde_json::from_value(value).map_err(|e| RpcError::Chunk {
            detail: format!("bad chunk frame: {e}"),
        })?;
        // The effective negotiated cap is read immediately before every
        // feed so a lowered server-advertised ceiling applies to the very
        // first chunk of a sequence.
        reassembler.set_max_frame_bytes(*reassembly_cap.lock());
        if let Some(bytes) = reassembler.feed(&chunk)? {
            let frame = decode_reassembled(bytes)?;
            dispatch_frame(&frame, pending, coordinator, event_tx).await?;
        }
        return Ok(());
    }

    // An ordinary frame while a chunk sequence is active interrupts it.
    if reassembler.is_active() {
        let detail = format!(
            "chunk sequence interrupted by ordinary frame type {frame_type:?}; \
             sequence rejected"
        );
        reassembler.reset_interrupted();
        return Err(RpcError::Chunk { detail });
    }

    dispatch_frame(&value, pending, coordinator, event_tx).await?;
    Ok(())
}

/// Routes one decoded JSON frame: command responses complete the registered
/// waiter, everything else becomes a normalized event.
async fn dispatch_frame(
    frame: &Value,
    pending: &Arc<PendingMap>,
    coordinator: &TurnCoordinator,
    event_tx: &mpsc::Sender<AgentEvent>,
) -> Result<(), RpcError> {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    match frame_type {
        "response" => {
            let id = frame.get("id").and_then(Value::as_str).unwrap_or("");
            let command = frame.get("command").and_then(Value::as_str).unwrap_or("?");
            let success = frame
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if id.is_empty() {
                // Unknown-command/parse failures carry no id.
                let _ = event_tx.try_send(AgentEvent::Unknown { raw: frame.clone() });
                return Ok(());
            }
            if success {
                let result = frame.get("data").cloned().unwrap_or(Value::Null);
                if !complete_waiter(pending, id, Ok(result)) {
                    // Unknown/late successful response: surface diagnostically,
                    // never silently drop.
                    let _ = event_tx.try_send(AgentEvent::LateCommandResponse {
                        id: id.to_string(),
                        command: command.to_string(),
                        data: frame.get("data").cloned(),
                    });
                }
            } else {
                let code = frame
                    .get("code")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let error = frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_string();
                let failure = Err(RpcError::CommandFailed {
                    command: command.to_string(),
                    code: code.clone(),
                    error: error.clone(),
                });
                if !complete_waiter(pending, id, failure) {
                    // Late failure for an already-completed request (e.g. a
                    // prompt that was acknowledged and later failed during
                    // async scheduling): correlate with the turn coordinator
                    // so prompt_and_wait fails immediately, and surface the
                    // diagnostic event.
                    coordinator.mark_late_failure(id, command, code.clone(), &error);
                    let _ = event_tx.try_send(AgentEvent::LateCommandFailure {
                        id: id.to_string(),
                        command: command.to_string(),
                        code,
                        error,
                    });
                }
            }
            Ok(())
        }
        "rpc_chunk" => unreachable!("chunks are reassembled before dispatch"),
        "ready" => try_send_event(event_tx, AgentEvent::Unknown { raw: frame.clone() }),
        "extension_ui_request" => match serde_json::from_value::<UiRequest>(frame.clone()) {
            Ok(ui) => try_send_event(event_tx, AgentEvent::UiRequested(ui)),
            Err(e) => try_send_event(
                event_tx,
                AgentEvent::ProtocolError {
                    detail: format!("ui request decode: {e}"),
                },
            ),
        },
        "host_tool_call" => match serde_json::from_value::<HostToolCall>(frame.clone()) {
            Ok(req) => try_send_event(event_tx, AgentEvent::HostToolCall(req)),
            Err(e) => try_send_event(
                event_tx,
                AgentEvent::ProtocolError {
                    detail: format!("host_tool_call decode: {e}"),
                },
            ),
        },
        "host_tool_cancel" => match serde_json::from_value::<HostToolCancel>(frame.clone()) {
            Ok(req) => try_send_event(event_tx, AgentEvent::HostToolCancel(req)),
            Err(e) => try_send_event(
                event_tx,
                AgentEvent::ProtocolError {
                    detail: format!("host_tool_cancel decode: {e}"),
                },
            ),
        },
        "host_uri_request" => match serde_json::from_value::<HostUriRequest>(frame.clone()) {
            Ok(req) => try_send_event(event_tx, AgentEvent::HostUriRequest(req)),
            Err(e) => try_send_event(
                event_tx,
                AgentEvent::ProtocolError {
                    detail: format!("host_uri_request decode: {e}"),
                },
            ),
        },
        "host_uri_cancel" => match serde_json::from_value::<HostUriCancel>(frame.clone()) {
            Ok(req) => try_send_event(event_tx, AgentEvent::HostUriCancel(req)),
            Err(e) => try_send_event(
                event_tx,
                AgentEvent::ProtocolError {
                    detail: format!("host_uri_cancel decode: {e}"),
                },
            ),
        },
        "available_commands_update" => {
            try_send_event(event_tx, AgentEvent::CommandsUpdated { raw: frame.clone() })
        }
        "prompt_result" => match serde_json::from_value::<PromptResult>(frame.clone()) {
            Ok(result) => {
                if let Some(id) = result.id.as_deref() {
                    coordinator.mark_prompt_result(id, result.agent_invoked);
                }
                try_send_event(event_tx, AgentEvent::PromptResolved(result))
            }
            Err(e) => try_send_event(
                event_tx,
                AgentEvent::ProtocolError {
                    detail: format!("prompt_result decode: {e}"),
                },
            ),
        },
        "extension_error" => {
            try_send_event(event_tx, AgentEvent::ExtensionError { raw: frame.clone() })
        }
        "agent_start" => try_send_event(event_tx, AgentEvent::AgentStarted { raw: frame.clone() }),
        "agent_end" => {
            let is_terminal = frame
                .get("isTerminal")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if is_terminal {
                coordinator.mark_terminal();
            }
            try_send_event(
                event_tx,
                AgentEvent::AgentEnded {
                    is_terminal,
                    raw: frame.clone(),
                },
            )
        }
        "turn_start" => try_send_event(event_tx, AgentEvent::TurnStarted { raw: frame.clone() }),
        "turn_end" => {
            coordinator.mark_terminal();
            try_send_event(event_tx, AgentEvent::TurnEnded { raw: frame.clone() })
        }
        "message_start" => {
            try_send_event(event_tx, AgentEvent::MessageStarted { raw: frame.clone() })
        }
        "message_update" => {
            try_send_event(event_tx, AgentEvent::MessageUpdated { raw: frame.clone() })
        }
        "message_end" => try_send_event(event_tx, AgentEvent::MessageEnded { raw: frame.clone() }),
        "tool_execution_start" => {
            try_send_event(event_tx, AgentEvent::ToolStarted { raw: frame.clone() })
        }
        "tool_execution_update" => {
            try_send_event(event_tx, AgentEvent::ToolUpdated { raw: frame.clone() })
        }
        "tool_execution_end" => {
            try_send_event(event_tx, AgentEvent::ToolEnded { raw: frame.clone() })
        }
        "auto_compaction_start" => try_send_event(
            event_tx,
            AgentEvent::CompactionStarted { raw: frame.clone() },
        ),
        "auto_compaction_end" => {
            try_send_event(event_tx, AgentEvent::CompactionEnded { raw: frame.clone() })
        }
        "auto_retry_start" => {
            try_send_event(event_tx, AgentEvent::RetryStarted { raw: frame.clone() })
        }
        "auto_retry_end" => try_send_event(event_tx, AgentEvent::RetryEnded { raw: frame.clone() }),
        "model_changed" => {
            try_send_event(event_tx, AgentEvent::ModelChanged { raw: frame.clone() })
        }
        "subagent_lifecycle" | "subagent_progress" | "subagent_event" => {
            try_send_event(event_tx, AgentEvent::SubagentEvent { raw: frame.clone() })
        }
        _ => {
            // command_output / session_info_update / config_update / notice /
            // irc_message / todo_reminder / goal_updated / ttsr_triggered ...
            try_send_event(event_tx, AgentEvent::SideChannel { raw: frame.clone() })
        }
    }
}

/// Completes the registered waiter for `id`, if any. Returns `false` when
/// the id was not registered (unknown or late response).
fn complete_waiter(pending: &Arc<PendingMap>, id: &str, result: Result<Value, RpcError>) -> bool {
    let waiter = pending.lock().remove(id);
    match waiter {
        Some(tx) => {
            let _ = tx.send(result);
            true
        }
        None => false,
    }
}

/// Forwards an event without ever blocking the reader on a full queue.
/// Drops are reported once as a protocol diagnostic so consumers know the
/// stream is lossy under overload rather than silently missing events.
fn try_send_event(event_tx: &mpsc::Sender<AgentEvent>, event: AgentEvent) -> Result<(), RpcError> {
    match event_tx.try_send(event) {
        Ok(()) => Ok(()),
        Err(mpsc::error::TrySendError::Full(_)) => {
            let _ = event_tx.try_send(AgentEvent::ProtocolError {
                detail: "event queue full; events dropped (bounded backpressure)".to_string(),
            });
            Ok(())
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Err(RpcError::ConnectionClosed),
    }
}
