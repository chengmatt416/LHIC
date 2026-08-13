//! Security: AES-256-GCM vault for API keys, and PII redaction.

use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result};
use rand::RngCore;
use regex::Regex;

const VAULT_FILE: &str = "vault.key";
const NONCE_LEN: usize = 12;

/// File-backed AES-256-GCM vault with a 0600 key file.
///
/// Secrets are encrypted at rest with a randomly generated vault key. The
/// vault key file is chmod 0600 and never leaves the machine.
#[derive(Clone)]
pub struct Vault {
    cipher: Aes256Gcm,
}

impl Vault {
    pub fn open(home: &Path) -> Result<Self> {
        let key_path = home.join(VAULT_FILE);
        let key_bytes: [u8; 32] = if key_path.exists() {
            let raw = fs::read(&key_path)
                .with_context(|| format!("reading vault key {}", key_path.display()))?;
            let decoded =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, raw)
                    .context("vault key is not valid base64")?;
            decoded
                .try_into()
                .map_err(|_| anyhow::anyhow!("vault key must be 32 bytes"))?
        } else {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let encoded =
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key);
            fs::write(&key_path, encoded)?;
            set_private(&key_path);
            key
        };
        Ok(Self {
            cipher: Aes256Gcm::new_from_slice(&key_bytes)
                .context("invalid AES-256 key material")?,
        })
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|error| anyhow::anyhow!("vault encryption failed: {error}"))?;
        let mut payload = nonce_bytes.to_vec();
        payload.extend_from_slice(&ciphertext);
        Ok(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            payload,
        ))
    }

    pub fn decrypt(&self, sealed: &str) -> Result<String> {
        let payload =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, sealed)
                .context("sealed value is not valid base64")?;
        if payload.len() < NONCE_LEN {
            return Err(anyhow::anyhow!("sealed value is truncated"));
        }
        let (nonce_bytes, ciphertext) = payload.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|error| anyhow::anyhow!("vault decryption failed: {error}"))?;
        String::from_utf8(plaintext).context("decrypted value is not UTF-8")
    }
}

/// Deterministic PII redactor. Patterns mirror the TypeScript redaction set:
/// email addresses, phone numbers, IPv4 addresses, and long API keys.
pub struct Redactor;

impl Redactor {
    pub fn redact(input: &str) -> String {
        let mut out = input.to_string();
        for (pattern, replacement) in [
            (EMAIL, "[email]"),
            (PHONE, "[phone]"),
            (IPV4, "[ip]"),
            (API_KEY, "[key]"),
        ] {
            out = Regex::new(pattern)
                .expect("static redaction pattern")
                .replace_all(&out, replacement)
                .into_owned();
        }
        out
    }
}

const EMAIL: &str = r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}";
const PHONE: &str = r"\+?[0-9][0-9 ()\-]{7,}[0-9]";
const IPV4: &str = r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}";
const API_KEY: &str = r"(?:sk|pk|gk|rk|ak)-[A-Za-z0-9_\-]{16,}";

fn set_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lhic-vault-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn vault_round_trip() {
        let home = temp_home();
        let vault = Vault::open(&home).unwrap();
        let sealed = vault.encrypt("sk-openai-test-123456").unwrap();
        assert_ne!(sealed, "sk-openai-test-123456");
        assert_eq!(vault.decrypt(&sealed).unwrap(), "sk-openai-test-123456");
        let reopened = Vault::open(&home).unwrap();
        assert_eq!(reopened.decrypt(&sealed).unwrap(), "sk-openai-test-123456");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn vault_rejects_tampering() {
        let home = temp_home();
        let vault = Vault::open(&home).unwrap();
        let sealed = vault.encrypt("value").unwrap();
        let mut bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, sealed)
                .unwrap();
        bytes[NONCE_LEN] ^= 0xff;
        let tampered = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        assert!(vault.decrypt(&tampered).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn redactor_masks_pii_and_keeps_plain_text() {
        let input = "contact alice@example.com or +1 (555) 123-4567 from 10.0.0.8 using sk-abcdefghijklmnopqrstuvwx";
        let out = Redactor::redact(input);
        assert!(out.contains("[email]"));
        assert!(out.contains("[phone]"));
        assert!(out.contains("[ip]"));
        assert!(out.contains("[key]"));
        assert!(!out.contains("alice@example.com"));
        assert!(!out.contains("sk-abcdefghijklmnopqrstuvwx"));

        let plain = "run the build and report failures";
        assert_eq!(Redactor::redact(plain), plain);
    }
}
