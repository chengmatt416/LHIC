//! `lhic-rust` — the LHIC CLI (Rust rewrite, alpha).

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::json;

use lhic_agent::{AgentManager, AgentState};
use lhic_core::browser;
use lhic_core::controller::{self};
use lhic_core::memory::MemoryStore;
use lhic_core::skills::SkillsClient;
use lhic_core::{lhic_home, security::Redactor};

#[derive(Parser)]
#[command(name = "lhic-rust", version, about = "LHIC (Rust rewrite, alpha)")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Create the LHIC data directory.
    Init,
    /// Print engine and configuration status.
    Status,
    /// omp agent engine commands.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// Workflow memory commands.
    Memory {
        #[command(subcommand)]
        command: MemoryCommand,
    },
    /// Headless browser commands.
    Browser {
        #[command(subcommand)]
        command: BrowserCommand,
    },
    /// Shared-skill library commands.
    Skills {
        #[command(subcommand)]
        command: SkillsCommand,
    },
    /// Show the routing decision for an intent.
    Route { intent: String },
    /// Redact PII from text.
    Redact { text: String },
    /// Run the MCP stdio server.
    Mcp,
}

#[derive(Subcommand)]
enum AgentCommand {
    /// Send a prompt to the agent engine.
    Prompt { message: String },
    /// Set a provider API key.
    KeySet { provider: String, key: String },
    /// List provider key status.
    KeyList,
    /// Remove a provider API key.
    KeyRemove { provider: String },
    /// Switch the active model.
    ModelSet { selector: String },
}

#[derive(Subcommand)]
enum MemoryCommand {
    /// List recent sessions.
    List {
        #[arg(long, default_value_t = 10)]
        limit: i64,
    },
    /// Search message content.
    Search {
        query: String,
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    /// Append a message to the default session.
    Add { content: String },
}

#[derive(Subcommand)]
enum BrowserCommand {
    /// Navigate and print the page title.
    Open { url: String },
    /// Capture a PNG screenshot.
    Screenshot { url: String, path: PathBuf },
}

#[derive(Subcommand)]
enum SkillsCommand {
    List {
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    Search {
        query: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();
    let cli = Cli::parse();
    let home = lhic_home()?;
    let workspace = std::env::current_dir()?;

    match cli.command {
        Commands::Init => {
            std::fs::create_dir_all(&home)?;
            println!("initialized LHIC data directory: {}", home.display());
        }
        Commands::Status => print_status(&home, &workspace)?,
        Commands::Agent { command } => agent(&home, &workspace, command).await?,
        Commands::Memory { command } => memory(&home, command)?,
        Commands::Browser { command } => browser_command(command).await?,
        Commands::Skills { command } => skills(command).await?,
        Commands::Route { intent } => {
            let memory = MemoryStore::open(&home.join("memory.sqlite"))?;
            let skills = match SkillsClient::from_env() {
                Ok(client) => client.list(20, 0).await.unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            let decision = controller::route(&intent, &skills, &memory);
            print_json(&decision)?;
        }
        Commands::Redact { text } => println!("{}", Redactor::redact(&text)),
        Commands::Mcp => lhic_mcp::run_stdio().await?,
    }
    Ok(())
}

fn print_status(home: &std::path::Path, workspace: &std::path::Path) -> Result<()> {
    let manager = AgentManager::open(home, workspace)?;
    let keys = manager.keys.status()?;
    println!("LHIC Rust alpha");
    println!("  data dir:  {}", home.display());
    println!(
        "  omp:       {} ({})",
        manager.binary(),
        lhic_agent::OMP_VERSION
    );
    println!("  providers:");
    for status in keys {
        println!(
            "    {:<12} {:<22} {}",
            status.provider,
            status.env_var,
            if status.has_key {
                "key stored"
            } else {
                "no key"
            }
        );
    }
    Ok(())
}

async fn agent(
    home: &std::path::Path,
    workspace: &std::path::Path,
    command: AgentCommand,
) -> Result<()> {
    let manager = AgentManager::open(home, workspace)?;
    match command {
        AgentCommand::KeySet { provider, key } => {
            manager.keys.set_key(&provider, &key)?;
            println!("stored key for {provider} in the vault.");
        }
        AgentCommand::KeyList => {
            for status in manager.keys.status()? {
                println!(
                    "{:<12} {:<22} {}",
                    status.provider,
                    status.env_var,
                    if status.has_key { "stored" } else { "-" }
                );
            }
        }
        AgentCommand::KeyRemove { provider } => {
            manager.keys.remove_key(&provider)?;
            println!("removed key for {provider}.");
        }
        AgentCommand::ModelSet { selector } => {
            let client = manager.start_client().await?;
            let (provider, model) = split_selector(&selector);
            let result = client.set_model(provider, model).await?;
            println!("model set: {}", pretty(&result));
            client.stop().await?;
        }
        AgentCommand::Prompt { message } => {
            let client = manager.start_client().await?;
            let state = client.get_state().await.unwrap_or(json!({}));
            let model = state
                .get("model")
                .and_then(|m| m.get("id"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unset");
            println!("agent model: {model}");

            // Run the turn to terminal completion. Completion is driven by
            // engine lifecycle semantics (agent_end/turn_end/prompt_result),
            // never by a fixed wall-clock guess.
            let outcome =
                lhic_agent::prompt_and_wait(&client, &message, std::time::Duration::from_secs(600))
                    .await?;
            if !outcome.streamed_text.trim().is_empty() {
                println!("\n{}", outcome.streamed_text);
            } else {
                println!("prompt completed (agent_invoked={})", outcome.agent_invoked);
            }
            client.stop().await?;
        }
    }
    Ok(())
}

fn memory(home: &std::path::Path, command: MemoryCommand) -> Result<()> {
    let mut store = MemoryStore::open(&home.join("memory.sqlite"))?;
    match command {
        MemoryCommand::List { limit } => {
            for session in store.list_sessions(limit)? {
                println!("[{}] {} ({})", session.id, session.name, session.updated_at);
            }
        }
        MemoryCommand::Search { query, limit } => {
            for message in store.search(&query, limit)? {
                println!(
                    "[{}] {}: {}",
                    message.session_id, message.role, message.content
                );
            }
        }
        MemoryCommand::Add { content } => {
            let session_id = match store.list_sessions(1)?.first() {
                Some(session) => session.id,
                None => store.create_session("default")?.id,
            };
            let redacted = Redactor::redact(&content);
            let message = store.append_message(session_id, "user", &redacted)?;
            println!("stored message #{} in session {}", message.id, session_id);
        }
    }
    Ok(())
}

async fn browser_command(command: BrowserCommand) -> Result<()> {
    match command {
        BrowserCommand::Open { url } => {
            let (browser, mut tab) = browser::launch_with_tab(&url).await?;
            println!("title: {}", tab.title().await?);
            drop(tab);
            drop(browser);
        }
        BrowserCommand::Screenshot { url, path } => {
            let (browser, mut tab) = browser::launch_with_tab(&url).await?;
            tab.screenshot(&path).await?;
            println!("saved: {}", path.display());
            drop(tab);
            drop(browser);
        }
    }
    Ok(())
}

async fn skills(command: SkillsCommand) -> Result<()> {
    let client = SkillsClient::from_env()?;
    let documents = match command {
        SkillsCommand::List { limit } => client.list(limit, 0).await?,
        SkillsCommand::Search { query } => client.search(&query, 20).await?,
    };
    if documents.is_empty() {
        println!("no skills found (is the Appwrite configuration set?)");
    }
    for document in documents {
        println!(
            "{} — {} ({})",
            document.id, document.name, document.description
        );
    }
    Ok(())
}

fn split_selector(selector: &str) -> (&str, &str) {
    match selector.split_once('/') {
        Some((provider, model)) => (provider, model),
        None => (selector, "default"),
    }
}

fn pretty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[allow(dead_code)]
fn _unused(state: AgentState) {
    let _ = state;
}
