//! lhic-agent: the omp engine client and model management for the Rust
//! rewrite of LHIC.

pub mod models;
pub mod rpc;

pub use models::{resolve_omp_binary, ProviderKeyStore};
pub use rpc::{
    prompt_and_wait, AgentEvent, OmpRpcClient, PromptOutcome, RpcConfig, RpcError, UiResponse,
    OMP_VERSION,
};

use std::path::Path;

use anyhow::Result;

/// Session state for a running engine.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentState {
    pub running: bool,
    pub model: Option<String>,
    pub message_count: u64,
}

/// High-level agent manager: owns the key store and starts/stops the engine.
#[derive(Clone)]
pub struct AgentManager {
    pub keys: ProviderKeyStore,
    workspace_root: String,
    session_dir: String,
    binary: String,
}

impl AgentManager {
    pub fn open(home: &Path, workspace_root: &Path) -> Result<Self> {
        Ok(Self {
            keys: ProviderKeyStore::open(home)?,
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            session_dir: home.join("omp-sessions").to_string_lossy().into_owned(),
            binary: resolve_omp_binary()?,
        })
    }

    /// Starts the engine with the configured provider keys.
    pub async fn start_client(&self) -> Result<OmpRpcClient> {
        let env = self.keys.build_env()?;
        let client = OmpRpcClient::new(
            self.binary.clone(),
            self.workspace_root.clone(),
            self.session_dir.clone(),
            env,
        );
        let mut client = client;
        client.start().await?;
        Ok(client)
    }

    pub fn binary(&self) -> &str {
        &self.binary
    }

    pub fn session_dir(&self) -> &str {
        &self.session_dir
    }
}
