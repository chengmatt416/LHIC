//! Chromium browser control over the Chrome DevTools Protocol.
//!
//! Rust-native replacement for the Playwright browser layer: launches
//! Chromium with remote debugging, attaches over a websocket, and drives
//! navigation, evaluation, screenshots, and DOM interaction.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::process::{Child as TokioChild, Command as TokioCommand};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// Discovers a Chromium/Chrome binary: explicit env, then the Playwright
/// cache, then PATH (PATH-first would hit snap stubs like
/// `/usr/bin/chromium-browser` that exit immediately).
pub fn discover_chromium() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("LHIC_CHROMIUM") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let cache = home.join(".cache/ms-playwright");
        if let Ok(entries) = std::fs::read_dir(&cache) {
            let mut matches: Vec<PathBuf> = entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("chromium"))
                .filter_map(|entry| {
                    let dir = entry.path();
                    let chrome = dir.join("chrome-linux/chrome");
                    chrome.exists().then_some(chrome)
                })
                .collect();
            matches.sort();
            if let Some(latest) = matches.pop() {
                return Some(latest);
            }
        }
    }
    for name in ["google-chrome", "chromium", "chromium-browser", "chrome"] {
        if let Some(path) = which(name) {
            return Some(path);
        }
    }
    None
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

async fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// A connected CDP session for one browser tab.
pub struct BrowserTab {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next_id: u64,
}

impl BrowserTab {
    pub async fn connect(web_socket_url: &str) -> Result<Self> {
        let (ws, _) = connect_async(web_socket_url)
            .await
            .with_context(|| format!("connecting to CDP {web_socket_url}"))?;
        Ok(Self { ws, next_id: 1 })
    }

    pub async fn command(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({ "id": id, "method": method, "params": params });
        self.ws
            .send(Message::Text(frame.to_string()))
            .await
            .context("CDP send failed")?;
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text)?;
                    if value.get("id").and_then(Value::as_u64) == Some(id) {
                        if let Some(error) = value.get("error") {
                            return Err(anyhow::anyhow!(
                                "CDP {method} error: {}",
                                error["message"].as_str().unwrap_or("unknown")
                            ));
                        }
                        let result = value.get("result").cloned().unwrap_or(Value::Null);
                        return Ok(result);
                    }
                    // Events from other sessions are ignored in alpha.
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    return Err(anyhow::anyhow!("CDP socket error: {error}"));
                }
                None => {
                    return Err(anyhow::anyhow!("CDP connection closed"));
                }
            }
        }
    }

    pub async fn navigate(&mut self, url: &str) -> Result<()> {
        self.command("Page.navigate", json!({ "url": url })).await?;
        self.wait_ready().await
    }

    pub async fn title(&mut self) -> Result<String> {
        let value = self.eval("document.title").await?;
        Ok(value.as_str().unwrap_or("").to_string())
    }

    pub async fn eval(&mut self, expression: &str) -> Result<Value> {
        let result = self
            .command(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        if result["exceptionDetails"].is_object() {
            return Err(anyhow::anyhow!(
                "page evaluation failed: {}",
                result["exceptionDetails"]["text"]
                    .as_str()
                    .unwrap_or("exception")
            ));
        }
        Ok(result["result"]["value"].clone())
    }

    pub async fn screenshot(&mut self, path: &Path) -> Result<()> {
        let result = self
            .command(
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true }),
            )
            .await?;
        let data = result["data"]
            .as_str()
            .context("CDP returned no screenshot data")?;
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data)
            .context("screenshot is not valid base64")?;
        std::fs::write(path, bytes)?;
        Ok(())
    }

    pub async fn click(&mut self, selector: &str) -> Result<()> {
        let expression = format!(
            "(() => {{ const el = document.querySelector({:?}); if (!el) throw new Error('selector not found'); el.click(); return true; }})()",
            selector
        );
        self.eval(&expression).await?;
        Ok(())
    }

    pub async fn type_text(&mut self, selector: &str, text: &str) -> Result<()> {
        let expression = format!(
            "(() => {{
                const el = document.querySelector({:?});
                if (!el) throw new Error('selector not found');
                el.focus();
                const proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) {{
                    setter.call(el, {:?});
                }} else {{
                    el.value = {:?};
                }}
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return true;
            }})()",
            selector, text, text
        );
        self.eval(&expression).await?;
        Ok(())
    }

    async fn wait_ready(&mut self) -> Result<()> {
        let mut delay = Duration::from_millis(10);
        for _ in 0..50 {
            if self
                .command(
                    "Runtime.evaluate",
                    json!({ "expression": "document.readyState", "returnByValue": true }),
                )
                .await
                .map(|v| {
                    v["result"]["value"].as_str() == Some("complete")
                        || v["result"]["value"].as_str() == Some("interactive")
                })
                .unwrap_or(false)
            {
                return Ok(());
            }
            tokio::time::sleep(delay).await;
            if delay < Duration::from_millis(100) {
                delay += Duration::from_millis(10);
            }
        }
        Ok(())
    }
}
/// Owns a headless Chromium instance and creates tabs for it.
pub struct Browser {
    #[allow(dead_code)] // held alive for the lifetime of the browser
    process: TokioChild,
    port: u16,
    user_data: PathBuf,
}

impl Browser {
    /// Launches headless Chromium and waits for its DevTools endpoint.
    ///
    /// Chromium is started through `sh -c '... &'`: under qemu-user binary
    /// emulation a directly spawned chromium never initializes its networking
    /// stack, while a shell-backgrounded one binds within seconds.
    pub async fn launch() -> Result<Self> {
        let chromium =
            discover_chromium().context("no chromium binary found (set LHIC_CHROMIUM)")?;
        let port = free_port().await?;
        let user_data = std::env::temp_dir().join(format!("lhic-chromium-{}", std::process::id()));
        let pid_file = std::env::temp_dir().join(format!("lhic-chromium-{port}.pid"));
        let script = format!(
            "{} --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
             --remote-debugging-port={} --user-data-dir={} about:blank \
             >/dev/null 2>&1 & echo $! > {}",
            chromium.display(),
            port,
            user_data.display(),
            pid_file.display()
        );
        let mut command = TokioCommand::new("sh");
        command
            .arg("-c")
            .arg(&script)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.spawn().context("spawning chromium launcher")?;

        let base = format!("http://127.0.0.1:{port}");
        for _ in 0..150 {
            if let Ok(response) = reqwest::get(format!("{base}/json/version")).await {
                if response.status().is_success() {
                    let _ = std::fs::remove_file(&pid_file);
                    return Ok(Self {
                        // A synthetic handle so the browser owns a child;
                        // real cleanup happens in Drop by user-data dir.
                        process: TokioCommand::new("true")
                            .spawn()
                            .context("synthetic handle")?,
                        port,
                        user_data,
                    });
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let _ = std::fs::remove_file(&pid_file);
        Err(anyhow::anyhow!(
            "chromium devtools endpoint did not come up"
        ))
    }

    pub async fn new_tab(&self, url: &str) -> Result<BrowserTab> {
        let endpoint = if url.is_empty() || url == "about:blank" {
            format!("http://127.0.0.1:{}/json/new", self.port)
        } else {
            format!("http://127.0.0.1:{}/json/new?{}", self.port, url)
        };
        let response: Value = reqwest::Client::new()
            .put(&endpoint)
            .send()
            .await
            .context("creating tab")?
            .json()
            .await?;
        let ws_url = response["webSocketDebuggerUrl"]
            .as_str()
            .context("tab response has no websocket url")?;
        let mut tab = BrowserTab::connect(ws_url).await?;
        if !url.is_empty() && url != "about:blank" {
            tab.navigate(url).await?;
        }
        Ok(tab)
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        // The chromium process was shell-backgrounded, so terminate it by its
        // unique profile directory rather than a pid we do not own.
        let _ = std::process::Command::new("pkill")
            .arg("-f")
            .arg(format!("user-data-dir={}", self.user_data.display()))
            .status();
        let _ = std::fs::remove_dir_all(&self.user_data);
    }
}

/// Launches Chromium and returns the browser plus one attached tab.
pub async fn launch_with_tab(url: &str) -> Result<(Browser, BrowserTab)> {
    let browser = Browser::launch().await?;
    let tab = browser.new_tab(url).await?;
    Ok((browser, tab))
}
