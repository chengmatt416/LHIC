//! LHIC Control Center (Rust rewrite, alpha): egui desktop app with Agent,
//! Memory, Browser, and Settings panels.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::mpsc::{self, Receiver, Sender};

use anyhow::Result;

use lhic_agent::{models::ProviderKeyStatus, AgentManager};
use lhic_core::lhic_home;

#[derive(Default, PartialEq)]
enum Tab {
    #[default]
    Agent,
    Memory,
    Browser,
    Settings,
}

struct App {
    tab: Tab,
    runtime: tokio::runtime::Runtime,
    manager: AgentManager,
    keys: Vec<ProviderKeyStatus>,
    // Agent panel
    prompt: String,
    agent_output: String,
    agent_busy: bool,
    // Memory panel
    memory_query: String,
    memory_results: String,
    // Browser panel
    browser_url: String,
    browser_result: String,
    // Settings panel
    settings_provider: String,
    settings_key: String,
    settings_notice: String,
    tx: Sender<String>,
    rx: Receiver<String>,
}

impl App {
    fn new(
        cc: &eframe::CreationContext<'_>,
        manager: AgentManager,
        keys: Vec<ProviderKeyStatus>,
    ) -> Self {
        cc.egui_ctx.set_visuals(egui::Visuals::light());
        let (tx, rx) = mpsc::channel();
        Self {
            tab: Tab::Agent,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime"),
            manager,
            keys,
            prompt: String::new(),
            agent_output: String::new(),
            agent_busy: false,
            memory_query: String::new(),
            memory_results: String::new(),
            browser_url: "https://example.com".to_string(),
            browser_result: String::new(),
            settings_provider: "openai".to_string(),
            settings_key: String::new(),
            settings_notice: String::new(),
            tx,
            rx,
        }
    }

    fn drain(&mut self) {
        while let Ok(line) = self.rx.try_recv() {
            if line == "\u{0}DONE" {
                self.agent_busy = false;
                continue;
            }
            self.agent_output.push_str(&line);
            self.agent_output.push('\n');
        }
    }

    fn spawn_prompt(&mut self, message: String) {
        if self.agent_busy {
            return;
        }
        self.agent_busy = true;
        let tx = self.tx.clone();
        let (busy_tx, busy_rx) = tokio::sync::oneshot::channel::<()>();
        let manager = self.manager.clone();
        self.runtime.spawn(async move {
            let result = async {
                let mut client = manager.start_client().await?;
                let state = client.get_state().await?;
                let model = state
                    .get("model")
                    .and_then(|m| m.get("id"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unset")
                    .to_string();
                // Stream the full turn to terminal completion instead of
                // stopping after prompt acceptance.
                let outcome = lhic_agent::prompt_and_wait(
                    &mut client,
                    &message,
                    std::time::Duration::from_secs(600),
                )
                .await?;
                client.stop().await?;
                Ok::<_, anyhow::Error>(format!(
                    "model: {model}\nagent_invoked: {}\n\n{}",
                    outcome.agent_invoked, outcome.streamed_text
                ))
            }
            .await;
            let _ = tx.send(match result {
                Ok(text) => text,
                Err(error) => format!("error: {error}"),
            });
            let _ = busy_tx.send(());
        });
        // The busy flag stays set until the spawned task completes.
        let tx2 = self.tx.clone();
        self.runtime.spawn(async move {
            let _ = busy_rx.await;
            let _ = tx2.send("\u{0}DONE".to_string());
        });
    }

    fn spawn_browser(&mut self, url: String, mode: BrowserMode) {
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let result: anyhow::Result<String> = async {
                match mode {
                    BrowserMode::Open => {
                        let (browser, mut tab) = lhic_core::browser::launch_with_tab(&url).await?;
                        let title = tab.title().await?;
                        drop(tab);
                        drop(browser);
                        Ok(format!("title: {title}"))
                    }
                    BrowserMode::Screenshot(path) => {
                        let (browser, mut tab) = lhic_core::browser::launch_with_tab(&url).await?;
                        tab.screenshot(&path).await?;
                        drop(tab);
                        drop(browser);
                        Ok(format!("saved: {}", path.display()))
                    }
                }
            }
            .await;
            let _ = tx.send(match result {
                Ok(text) => text,
                Err(error) => format!("error: {error}"),
            });
        });
    }

    fn spawn_memory_search(&mut self, query: String) {
        let tx = self.tx.clone();
        let home = lhic_home().expect("lhic home");
        self.runtime.spawn(async move {
            let result = lhic_core::memory::MemoryStore::open(&home.join("memory.sqlite"))
                .and_then(|store| store.search(&query, 20))
                .map(|messages| {
                    messages
                        .iter()
                        .map(|m| format!("[{}] {}: {}", m.session_id, m.role, m.content))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
            let _ = tx.send(match result {
                Ok(text) if text.is_empty() => "no matches".to_string(),
                Ok(text) => text,
                Err(error) => format!("error: {error}"),
            });
        });
    }

    fn spawn_set_key(&mut self, provider: String, key: String) {
        let tx = self.tx.clone();
        let home = lhic_home().expect("lhic home");
        self.runtime.spawn(async move {
            let result = lhic_agent::ProviderKeyStore::open(&home)
                .and_then(|store| store.set_key(&provider, &key));
            let _ = tx.send(match result {
                Ok(()) => format!("stored key for {provider}"),
                Err(error) => format!("error: {error}"),
            });
        });
    }
}

enum BrowserMode {
    Open,
    Screenshot(std::path::PathBuf),
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain();
        egui::TopBottomPanel::top("tabs").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.tab, Tab::Agent, "Agent");
                ui.selectable_value(&mut self.tab, Tab::Memory, "Memory");
                ui.selectable_value(&mut self.tab, Tab::Browser, "Browser");
                ui.selectable_value(&mut self.tab, Tab::Settings, "Settings");
            });
        });
        egui::CentralPanel::default().show(ctx, |ui| match self.tab {
            Tab::Agent => self.agent_panel(ui),
            Tab::Memory => self.memory_panel(ui),
            Tab::Browser => self.browser_panel(ui),
            Tab::Settings => self.settings_panel(ui),
        });
    }
}

impl App {
    fn agent_panel(&mut self, ui: &mut egui::Ui) {
        ui.heading("Agent Studio");
        ui.label("Configured providers:");
        for status in &self.keys {
            ui.label(format!(
                "{} ({}) — {}",
                status.provider,
                status.env_var,
                if status.has_key {
                    "key stored"
                } else {
                    "no key"
                }
            ));
        }
        ui.add_space(6.0);
        ui.text_edit_multiline(&mut self.prompt);
        ui.horizontal(|ui| {
            if ui
                .add_enabled(!self.agent_busy, egui::Button::new("Send prompt"))
                .clicked()
            {
                let message = std::mem::take(&mut self.prompt);
                self.spawn_prompt(message);
            }
            if self.agent_busy {
                ui.spinner();
            }
        });
        ui.separator();
        ui.add(
            egui::TextEdit::multiline(&mut self.agent_output)
                .desired_rows(12)
                .font(egui::TextStyle::Monospace),
        );
    }

    fn memory_panel(&mut self, ui: &mut egui::Ui) {
        ui.heading("Workflow memory");
        ui.horizontal(|ui| {
            ui.text_edit_singleline(&mut self.memory_query);
            if ui.button("Search").clicked() {
                let query = std::mem::take(&mut self.memory_query);
                self.spawn_memory_search(query);
            }
        });
        ui.separator();
        ui.add(
            egui::TextEdit::multiline(&mut self.memory_results)
                .desired_rows(16)
                .font(egui::TextStyle::Monospace),
        );
    }

    fn browser_panel(&mut self, ui: &mut egui::Ui) {
        ui.heading("Headless browser (CDP)");
        ui.horizontal(|ui| {
            ui.text_edit_singleline(&mut self.browser_url);
            if ui.button("Open").clicked() {
                let url = self.browser_url.clone();
                self.spawn_browser(url, BrowserMode::Open);
            }
            if ui.button("Screenshot").clicked() {
                let url = self.browser_url.clone();
                self.spawn_browser(
                    url,
                    BrowserMode::Screenshot(std::path::PathBuf::from("/tmp/lhic-desktop-shot.png")),
                );
            }
        });
        ui.separator();
        ui.add(
            egui::TextEdit::multiline(&mut self.browser_result)
                .desired_rows(10)
                .font(egui::TextStyle::Monospace),
        );
    }

    fn settings_panel(&mut self, ui: &mut egui::Ui) {
        ui.heading("Model management");
        ui.horizontal(|ui| {
            ui.label("Provider:");
            egui::ComboBox::from_id_salt("provider")
                .selected_text(&self.settings_provider)
                .show_ui(ui, |ui| {
                    for (provider, env_var) in lhic_agent::models::PROVIDER_ENV {
                        ui.selectable_value(
                            &mut self.settings_provider,
                            (*provider).to_string(),
                            format!("{provider} ({env_var})"),
                        );
                    }
                });
        });
        ui.horizontal(|ui| {
            ui.label("API key:");
            ui.add(
                egui::TextEdit::singleline(&mut self.settings_key)
                    .password(true)
                    .desired_width(280.0),
            );
            if ui.button("Save key").clicked() {
                let provider = self.settings_provider.clone();
                let key = std::mem::take(&mut self.settings_key);
                self.spawn_set_key(provider, key);
            }
        });
        ui.label(&self.settings_notice);
    }
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();
    let home = lhic_home()?;
    let workspace = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let manager = AgentManager::open(&home, &workspace)?;
    let keys = manager.keys.status()?;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([960.0, 640.0])
            .with_title("LHIC Control Center (Rust alpha)"),
        ..Default::default()
    };
    eframe::run_native(
        "lhic-control-center-rust",
        options,
        Box::new(move |cc| Ok(Box::new(App::new(cc, manager, keys)))),
    )
    .map_err(|error| anyhow::anyhow!("eframe failed: {error}"))?;
    Ok(())
}
