//! omp RPC client: drives the bundled omp engine (`--mode rpc`) over
//! newline-delimited JSON on stdio, mirroring the protocol used by the
//! TypeScript `@lhic/omp-rpc` package.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

pub const OMP_VERSION: &str = "17.2.15";

/// Frames emitted by the engine that are not command responses.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// A non-response JSON frame (event, ui_request, command_update, ...).
    Frame(Value),
    /// A stderr log line from the engine.
    Log(String),
}

/// Newline-delimited JSON RPC client for `omp --mode rpc`.
pub struct OmpRpcClient {
    child: Option<Child>,
    stdin: Option<tokio::process::ChildStdin>,
    events: mpsc::Receiver<AgentEvent>,
    request_counter: u64,
    workspace_root: String,
    session_dir: String,
    extension_roots: Vec<String>,
    env: HashMap<String, String>,
    binary: String,
    stderr_tail: String,
    exited: bool,
}

impl OmpRpcClient {
    pub fn new(
        binary: String,
        workspace_root: String,
        session_dir: String,
        env: HashMap<String, String>,
    ) -> Self {
        Self {
            child: None,
            stdin: None,
            events: mpsc::channel(256).1,
            request_counter: 0,
            workspace_root,
            session_dir,
            extension_roots: Vec::new(),
            env,
            binary,
            stderr_tail: String::new(),
            exited: false,
        }
    }

    pub fn with_extension_root(mut self, root: &str) -> Self {
        self.extension_roots.push(root.to_string());
        self
    }

    pub async fn start(&mut self) -> Result<()> {
        let mut command = Command::new(&self.binary);
        command
            .args([
                "--mode",
                "rpc",
                "--cwd",
                &self.workspace_root,
                "--session-dir",
                &self.session_dir,
                "--no-pty",
                "--hide-thinking",
                "--approval-mode",
                "write",
            ])
            .envs(self.env.clone())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for root in &self.extension_roots {
            command.args(["--extension", root]);
        }
        let mut child = command.spawn().context("spawning omp")?;
        let stdin = child.stdin.take().context("omp stdin unavailable")?;
        let stdout = child.stdout.take().context("omp stdout unavailable")?;
        let stderr = child.stderr.take().context("omp stderr unavailable")?;

        let (event_tx, event_rx) = mpsc::channel(256);
        self.events = event_rx;

        // stdout reader: newline-delimited JSON frames, all into the channel.
        let tx = event_tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
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
                            Ok(frame) => {
                                if tx.send(AgentEvent::Frame(frame)).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => {
                                if tx
                                    .send(AgentEvent::Log(format!("bad frame: {trimmed}")))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            let _ = tx.send(AgentEvent::Frame(json!({"type": "child_closed"}))).await;
        });

        // stderr collector: surfaced as log events and kept as a tail for
        // diagnostics when the engine exits (e.g. "No models available").
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if event_tx
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
        tokio::time::timeout(Duration::from_secs(20), self.wait_for_ready())
            .await
            .context("timed out waiting for omp ready")??;

        // Protocol negotiation (mirrors the TypeScript client).
        self.send_raw(
            "protocol-1",
            &json!({ "type": "negotiate_protocol", "protocolVersion": 2 }),
        )
        .await?;
        Ok(())
    }

    async fn wait_for_ready(&mut self) -> Result<()> {
        loop {
            match self.next_event().await {
                Some(AgentEvent::Frame(frame)) => {
                    if frame.get("type").and_then(Value::as_str) == Some("ready") {
                        return Ok(());
                    }
                }
                Some(AgentEvent::Log(line)) => {
                    self.stderr_tail = line.clone();
                    tracing::debug!("omp stderr: {line}");
                }
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
        if self.exited {
            return Err(anyhow::anyhow!("omp RPC process is not running"));
        }
        // omp echoes the request id in its response, so it must be part of
        // the payload (correlating purely client-side leaves it missing).
        let mut request = payload.clone();
        if let Some(obj) = request.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
        }
        let stdin = self.stdin.as_mut().context("omp stdin is closed")?;
        let mut line = request.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;

        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                match self.next_event().await {
                    Some(AgentEvent::Frame(frame)) => {
                        if frame.get("id").and_then(Value::as_str) == Some(id) {
                            if frame.get("success").and_then(Value::as_bool) == Some(false)
                                || frame.get("error").is_some()
                            {
                                let message = frame
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .or_else(|| {
                                        frame.get("data").and_then(Value::as_str)
                                    })
                                    .unwrap_or("omp command failed");
                                return Err(anyhow::anyhow!("{message}"));
                            }
                            return Ok(frame
                                .get("data")
                                .cloned()
                                .unwrap_or(Value::Null));
                        }
                    }
                    Some(AgentEvent::Log(line)) => {
                        self.stderr_tail = line.clone();
                    }
                    None => {
                        return Err(anyhow::anyhow!("omp RPC process closed"));
                    }
                }
            }
        })
        .await
        .context("omp command timed out")?
    }

    /// Polls for the next non-response frame or log line.
    pub async fn next_event(&mut self) -> Option<AgentEvent> {
        self.events.recv().await
    }

    pub async fn stop(&mut self) -> Result<()> {
        self.exited = true;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Ok(())
    }

    pub fn stderr_tail(&self) -> &str {
        &self.stderr_tail
    }
}

// Convenience command builders used by the CLI, MCP, and desktop.
impl OmpRpcClient {
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
        self.command("login", json!({ "providerId": provider_id })).await
    }

    pub async fn get_available_commands(&mut self) -> Result<Value> {
        self.command("get_available_commands", json!({})).await
    }
}
