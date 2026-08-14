//! lhic-mcp: Model Context Protocol stdio server exposing LHIC tools.
//!
//! Implements the MCP stdio transport (Content-Length framed JSON-RPC 2.0)
//! with tools for memory, browser, agent, and security.

use std::io::{BufRead, Read, Write};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use lhic_core::browser::{Browser, BrowserTab};
use lhic_core::lhic_home;
use lhic_core::memory::MemoryStore;
use lhic_core::security::Redactor;

/// One stdio MCP session. The browser is started lazily on first use.
pub struct McpServer {
    memory: Option<MemoryStore>,
    browser: Option<Browser>,
    tab: Option<BrowserTab>,
    memory_path: std::path::PathBuf,
}

impl McpServer {
    pub fn new() -> Result<Self> {
        let home = lhic_home()?;
        Ok(Self {
            memory: None,
            browser: None,
            tab: None,
            memory_path: home.join("memory.sqlite"),
        })
    }

    fn memory(&mut self) -> Result<&mut MemoryStore> {
        if self.memory.is_none() {
            self.memory = Some(MemoryStore::open(&self.memory_path)?);
        }
        Ok(self.memory.as_mut().expect("memory initialized"))
    }

    pub async fn handle_call(&mut self, tool: &str, args: &Value) -> Result<Value> {
        match tool {
            "memory.search" => {
                let query = required_string(args, "query")?;
                let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(20);
                let results = self.memory()?.search(&query, limit)?;
                Ok(json!({ "results": serde_json::to_value(&results)? }))
            }
            "memory.store" => {
                let content = Redactor::redact(&required_string(args, "content")?);
                let role = args.get("role").and_then(Value::as_str).unwrap_or("user");
                let sessions = self.memory()?.list_sessions(1)?;
                let session_id = match sessions.first() {
                    Some(session) => session.id,
                    None => self.memory()?.create_session("default")?.id,
                };
                let message = self.memory()?.append_message(session_id, role, &content)?;
                Ok(json!({ "stored": serde_json::to_value(&message)? }))
            }
            "browser.navigate" => {
                let url = required_string(args, "url")?;
                if let Some(tab) = self.tab.as_mut() {
                    tab.navigate(&url).await?;
                    let title = tab.title().await?;
                    Ok(json!({ "title": title, "url": url }))
                } else {
                    let (browser, mut tab) = lhic_core::browser::launch_with_tab(&url).await?;
                    tab.navigate(&url).await?;
                    let title = tab.title().await?;
                    self.browser = Some(browser);
                    self.tab = Some(tab);
                    Ok(json!({ "title": title, "url": url }))
                }
            }
            "browser.screenshot" => {
                let tab = self
                    .tab
                    .as_mut()
                    .context("no browser tab; navigate first")?;
                let path = required_string(args, "path")?;
                tab.screenshot(std::path::Path::new(&path)).await?;
                Ok(json!({ "saved": path }))
            }
            "browser.title" => {
                let tab = self
                    .tab
                    .as_mut()
                    .context("no browser tab; navigate first")?;
                let title = tab.title().await?;
                Ok(json!({ "title": title }))
            }
            "security.redact" => {
                let text = required_string(args, "text")?;
                Ok(json!({ "redacted": Redactor::redact(&text) }))
            }
            "agent.prompt" => {
                let message = required_string(args, "message")?;
                let home = lhic_home()?;
                let workspace = args
                    .get("workspace")
                    .and_then(Value::as_str)
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
                let manager = lhic_agent::AgentManager::open(&home, &workspace)?;
                let client = manager.start_client().await?;
                let outcome = lhic_agent::prompt_and_wait(
                    &client,
                    &message,
                    std::time::Duration::from_secs(300),
                )
                .await?;
                Ok(json!({
                    "accepted": outcome.accepted,
                    "agentInvoked": outcome.agent_invoked,
                    "text": outcome.streamed_text,
                    "message": message,
                }))
            }
            other => Err(anyhow::anyhow!("unknown tool: {other}")),
        }
    }

    pub fn tool_definitions() -> Value {
        json!([
            {
                "name": "memory.search",
                "description": "Search the LHIC workflow memory",
                "inputSchema": { "type": "object", "properties": {
                    "query": { "type": "string" }, "limit": { "type": "integer" } },
                    "required": ["query"] }
            },
            {
                "name": "memory.store",
                "description": "Store a message in the LHIC workflow memory",
                "inputSchema": { "type": "object", "properties": {
                    "content": { "type": "string" }, "role": { "type": "string" } },
                    "required": ["content"] }
            },
            {
                "name": "browser.navigate",
                "description": "Launch headless Chromium and navigate to a URL",
                "inputSchema": { "type": "object", "properties": {
                    "url": { "type": "string" } }, "required": ["url"] }
            },
            {
                "name": "browser.title",
                "description": "Get the current tab title",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "browser.screenshot",
                "description": "Capture a PNG screenshot of the current tab",
                "inputSchema": { "type": "object", "properties": {
                    "path": { "type": "string" } }, "required": ["path"] }
            },
            {
                "name": "security.redact",
                "description": "Redact PII from text",
                "inputSchema": { "type": "object", "properties": {
                    "text": { "type": "string" } }, "required": ["text"] }
            },
            {
                "name": "agent.prompt",
                "description": "Send a prompt to the omp agent engine",
                "inputSchema": { "type": "object", "properties": {
                    "message": { "type": "string" }, "workspace": { "type": "string" } },
                    "required": ["message"] }
            },
        ])
    }
}

fn required_string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .with_context(|| format!("missing string argument: {key}"))
}

/// Runs the stdio loop until EOF.
pub async fn run_stdio() -> Result<()> {
    let mut server = McpServer::new()?;
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();

    loop {
        let content_length = match read_content_length(&mut reader) {
            Some(length) => length,
            None => return Ok(()),
        };
        let mut body = vec![0u8; content_length];
        reader
            .read_exact(&mut body)
            .context("reading MCP message body")?;
        let request: Value = serde_json::from_slice(&body).context("parsing MCP message")?;
        let response = handle_message(&mut server, request).await;
        let framed = frame_message(&response);
        writer.write_all(&framed)?;
        writer.flush()?;
    }
}

async fn handle_message(server: &mut McpServer, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str);
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    match method {
        Some("initialize") => json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "lhic-mcp-rust", "version": env!("CARGO_PKG_VERSION") }
            }
        }),
        Some("notifications/initialized") | Some("initialized") => {
            json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null })
        }
        Some("tools/list") => json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": McpServer::tool_definitions() }
        }),
        Some("tools/call") => {
            let tool = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            match server.handle_call(tool, &args).await {
                Ok(result) => json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [ { "type": "text", "text": result.to_string() } ] }
                }),
                Err(error) => json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32000, "message": error.to_string() }
                }),
            }
        }
        Some(other) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("method not found: {other}") }
        }),
        None => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32600, "message": "invalid request" }
        }),
    }
}

fn read_content_length(reader: &mut impl BufRead) -> Option<usize> {
    let mut length = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            length = value.trim().parse::<usize>().ok();
        }
    }
    length
}

fn frame_message(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).expect("message serializes");
    let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    framed.extend_from_slice(&body);
    framed
}
