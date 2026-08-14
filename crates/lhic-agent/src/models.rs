//! Model management: provider API keys stored in the vault, and omp
//! environment construction.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use lhic_core::security::Vault;

const KEYS_FILE: &str = "keys.json";

/// Provider id -> omp environment variable name.
pub const PROVIDER_ENV: &[(&str, &str)] = &[
    ("openai", "OPENAI_API_KEY"),
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("groq", "GROQ_API_KEY"),
    ("xai", "XAI_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("mistral", "MISTRAL_API_KEY"),
    ("together", "TOGETHER_API_KEY"),
    ("perplexity", "PERPLEXITY_API_KEY"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderKeyStatus {
    pub provider: String,
    pub env_var: String,
    pub has_key: bool,
    pub storage: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct KeyFile {
    schema_version: String,
    /// Provider id -> vault-sealed key.
    keys: HashMap<String, String>,
}

/// Provider keys persisted (sealed) under the LHIC vault.
#[derive(Clone)]
pub struct ProviderKeyStore {
    vault: Vault,
    path: std::path::PathBuf,
}

impl ProviderKeyStore {
    pub fn open(home: &Path) -> Result<Self> {
        std::fs::create_dir_all(home)?;
        Ok(Self {
            vault: Vault::open(home)?,
            path: home.join(KEYS_FILE),
        })
    }

    pub fn set_key(&self, provider: &str, key: &str) -> Result<()> {
        if !PROVIDER_ENV.iter().any(|(id, _)| *id == provider) {
            return Err(anyhow::anyhow!("unknown provider: {provider}"));
        }
        let mut file = self.read_file();
        file.keys
            .insert(provider.to_string(), self.vault.encrypt(key)?);
        self.write_file(&file)
    }

    pub fn remove_key(&self, provider: &str) -> Result<()> {
        let mut file = self.read_file();
        file.keys.remove(provider);
        self.write_file(&file)
    }

    pub fn get_key(&self, provider: &str) -> Result<Option<String>> {
        let file = self.read_file();
        match file.keys.get(provider) {
            Some(sealed) => self.vault.decrypt(sealed).map(Some),
            None => Ok(None),
        }
    }

    pub fn status(&self) -> Result<Vec<ProviderKeyStatus>> {
        let file = self.read_file();
        Ok(PROVIDER_ENV
            .iter()
            .map(|(provider, env_var)| ProviderKeyStatus {
                provider: (*provider).to_string(),
                env_var: (*env_var).to_string(),
                has_key: file.keys.contains_key(*provider),
                storage: "vault".to_string(),
            })
            .collect())
    }

    /// Builds the omp child environment from configured provider keys.
    pub fn build_env(&self) -> Result<HashMap<String, String>> {
        let file = self.read_file();
        let mut env = HashMap::new();
        for (provider, env_var) in PROVIDER_ENV {
            if let Some(sealed) = file.keys.get(*provider) {
                let key = self.vault.decrypt(sealed)?;
                env.insert((*env_var).to_string(), key);
            }
        }
        Ok(env)
    }

    fn read_file(&self) -> KeyFile {
        match std::fs::read_to_string(&self.path) {
            Ok(content) => serde_json::from_str::<KeyFile>(&content).unwrap_or_default(),
            Err(_) => KeyFile {
                schema_version: "lhic-provider-keys-v1".to_string(),
                keys: HashMap::new(),
            },
        }
    }

    fn write_file(&self, file: &KeyFile) -> Result<()> {
        let payload = serde_json::to_string_pretty(file)?;
        std::fs::write(&self.path, payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                &self.path,
                std::fs::Permissions::from_mode(0o600),
            )?;
        }
        Ok(())
    }
}

/// Resolves the omp engine binary: `OMP_BINARY` env override, then the
/// bundled path inside this workspace, then `omp` on PATH.
pub fn resolve_omp_binary() -> Result<String> {
    if let Ok(explicit) = std::env::var("OMP_BINARY") {
        if std::path::Path::new(&explicit).exists() {
            return Ok(explicit);
        }
        return Err(anyhow::anyhow!("OMP_BINARY does not exist: {explicit}"));
    }
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("apps/desktop/vendor/omp/current/omp"));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/omp"));
        candidates.push(home.join(".cargo/bin/omp"));
    }
    if let Some(from_path) = which("omp") {
        candidates.push(from_path);
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err(anyhow::anyhow!(
        "omp binary not found; set OMP_BINARY or run from the repository root"
    ))
    .with_context(|| "resolving omp")
}

fn which(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_home() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lhic-keys-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn key_store_lifecycle() {
        let home = temp_home();
        let store = ProviderKeyStore::open(&home).unwrap();
        assert!(store.get_key("openai").unwrap().is_none());

        store.set_key("openai", "sk-test-secret-12345").unwrap();
        assert_eq!(
            store.get_key("openai").unwrap().as_deref(),
            Some("sk-test-secret-12345")
        );

        let env = store.build_env().unwrap();
        assert_eq!(
            env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-test-secret-12345")
        );

        store.remove_key("openai").unwrap();
        assert!(store.get_key("openai").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&home);
    }
}
